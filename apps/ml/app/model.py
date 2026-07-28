"""Model loading, inference and SHAP attribution.

Loaded once at process start. The SHAP ``TreeExplainer`` in particular is expensive to build
and cheap to reuse; constructing it per request would blow the §6.2 latency budget on its own.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import shap
import xgboost as xgb

from app.manifest import FeatureManifest, load_manifest

logger = logging.getLogger(__name__)

ARTIFACT_DIR = Path(__file__).resolve().parents[1] / "artifacts"
MODEL_PATH = ARTIFACT_DIR / "pd_model.ubj"
CALIBRATOR_PATH = ARTIFACT_DIR / "pd_calibrator.json"
METADATA_PATH = ARTIFACT_DIR / "model_metadata.json"


class ModelNotLoadedError(RuntimeError):
    """Raised when inference is attempted before a model artifact is available."""


@dataclass(frozen=True, slots=True)
class Attribution:
    """One feature's contribution to a single prediction."""

    feature: str
    label: str
    description: str
    shap_value: float
    feature_value: float
    direction: str


@dataclass(frozen=True, slots=True)
class Prediction:
    p_default: float
    base_value: float
    positive_factors: tuple[Attribution, ...]
    negative_factors: tuple[Attribution, ...]


class IsotonicCalibrator:
    """Replays the isotonic step function fitted at training time.

    Stored and reloaded as two arrays rather than a pickled scikit-learn estimator: a pickle
    binds the artifact to the exact library build that wrote it, and an artifact that cannot be
    loaded after a dependency bump is an outage in a service that decides credit.
    """

    def __init__(self, thresholds_x: np.ndarray, thresholds_y: np.ndarray) -> None:
        self._x = thresholds_x
        self._y = thresholds_y

    @classmethod
    def load(cls, path: Path) -> IsotonicCalibrator | None:
        if not path.is_file():
            return None
        payload = json.loads(path.read_text(encoding="utf-8"))
        return cls(
            np.asarray(payload["x"], dtype=np.float64),
            np.asarray(payload["y"], dtype=np.float64),
        )

    def __call__(self, raw: np.ndarray) -> np.ndarray:
        # np.interp clamps at both ends, matching IsotonicRegression(out_of_bounds="clip").
        return np.clip(np.interp(raw, self._x, self._y), 0.0, 1.0)


class PdModel:
    """The probability-of-default model and its explainer."""

    def __init__(self) -> None:
        self.manifest: FeatureManifest = load_manifest()
        self._booster: xgb.XGBClassifier | None = None
        self._calibrator: IsotonicCalibrator | None = None
        self._explainer: shap.TreeExplainer | None = None
        self.metadata: dict[str, Any] = {}

    # -- lifecycle ---------------------------------------------------------

    def load(self) -> bool:
        """Loads the artifacts. Returns ``False`` when none have been trained yet.

        Deliberately non-fatal: the service still starts and reports itself unready, so a
        missing artifact surfaces as a clear readiness failure rather than a crash loop. The
        API is designed to be optional to the credit decision, and behaving that way on a cold
        deploy is part of that.
        """
        if not MODEL_PATH.is_file():
            logger.warning(
                "No model artifact at %s. Run `python -m train.train` to create one. "
                "/predict will return 503 until then.",
                MODEL_PATH,
            )
            return False

        booster = xgb.XGBClassifier()
        booster.load_model(MODEL_PATH)
        self._booster = booster

        self._calibrator = IsotonicCalibrator.load(CALIBRATOR_PATH)
        if self._calibrator is None:
            logger.warning(
                "Model loaded without a calibrator; probabilities will be raw model output and "
                "should not be used for §9.3 provisioning."
            )

        if METADATA_PATH.is_file():
            self.metadata = json.loads(METADATA_PATH.read_text(encoding="utf-8"))

        # Refuse to serve a model trained against a different feature contract. This is the
        # server-side half of the version check; the API also validates the version the caller
        # claims. Both exist because a silent mismatch degrades accuracy invisibly.
        trained_version = self.metadata.get("featureSetVersion")
        if trained_version is not None and trained_version != self.manifest.version:
            raise RuntimeError(
                f"Model was trained on feature set {trained_version} but this service loads "
                f"{self.manifest.version}. Retrain before serving."
            )

        trained_names = self.metadata.get("featureNames")
        if trained_names is not None and tuple(trained_names) != self.manifest.names:
            raise RuntimeError(
                "Model feature ORDER does not match the manifest. Serving would silently "
                "score the wrong column for every feature. Retrain."
            )

        self._explainer = shap.TreeExplainer(booster)
        logger.info(
            "Loaded %s v%s (provenance %s) — %d features, AUC %.4f",
            self.metadata.get("modelName", "model"),
            self.metadata.get("modelVersion", "?"),
            self.metadata.get("provenance", "?"),
            len(self.manifest.features),
            self.metadata.get("metrics", {}).get("auc", float("nan")),
        )
        return True

    @property
    def ready(self) -> bool:
        return self._booster is not None and self._explainer is not None

    # -- inference ---------------------------------------------------------

    def to_matrix(self, features: dict[str, float]) -> np.ndarray:
        """Builds the model input row in canonical manifest order.

        The ordering is taken from the manifest, never from the incoming dictionary's key
        order. A JSON object has no meaningful order, and relying on one would make the model's
        behaviour depend on how the caller happened to serialise its payload.
        """
        row = np.empty((1, len(self.manifest.features)), dtype=np.float64)
        for index, definition in enumerate(self.manifest.features):
            value = features.get(definition.name, definition.default)
            row[0, index] = self.manifest.clamp(definition.name, float(value))
        return row

    def predict(
        self,
        features: dict[str, float],
        top_positive: int = 5,
        top_negative: int = 3,
    ) -> Prediction:
        """Scores one applicant and attributes the result.

        §6.3 requires the top 5 supporting and top 3 adverse factors on every decision, so
        attribution is part of the prediction rather than an optional extra endpoint.
        """
        if self._booster is None or self._explainer is None:
            raise ModelNotLoadedError(
                "No model artifact loaded. Run `python -m train.train` in apps/ml."
            )

        matrix = self.to_matrix(features)

        raw = float(self._booster.predict_proba(matrix)[0, 1])
        p_default = (
            float(self._calibrator(np.array([raw]))[0]) if self._calibrator is not None else raw
        )

        shap_values = np.asarray(self._explainer.shap_values(matrix))
        # TreeExplainer returns (n, features) for binary XGBoost, but (n, features, classes)
        # for some configurations. Normalise to the positive class either way.
        if shap_values.ndim == 3:
            shap_values = shap_values[:, :, -1]
        contributions = shap_values[0]

        expected = self._explainer.expected_value
        base_value = float(np.asarray(expected).reshape(-1)[-1])

        attributions: list[Attribution] = []
        for index, definition in enumerate(self.manifest.features):
            contribution = float(contributions[index])
            attributions.append(
                Attribution(
                    feature=definition.name,
                    label=definition.label,
                    # Positive SHAP pushes towards default, so the adverse-action wording only
                    # applies in that direction. A favourable contribution is described by the
                    # feature's own label instead.
                    description=(
                        definition.adverse_action
                        if contribution > 0
                        else f"{definition.label} supports this application"
                    ),
                    shap_value=contribution,
                    feature_value=float(matrix[0, index]),
                    direction="INCREASES_RISK" if contribution > 0 else "DECREASES_RISK",
                )
            )

        risk_increasing = sorted(
            (item for item in attributions if item.shap_value > 0),
            key=lambda item: item.shap_value,
            reverse=True,
        )
        risk_reducing = sorted(
            (item for item in attributions if item.shap_value < 0),
            key=lambda item: item.shap_value,
        )

        return Prediction(
            p_default=p_default,
            base_value=base_value,
            positive_factors=tuple(risk_reducing[:top_positive]),
            negative_factors=tuple(risk_increasing[:top_negative]),
        )


#: Process-wide singleton, populated by the FastAPI lifespan handler.
pd_model = PdModel()
