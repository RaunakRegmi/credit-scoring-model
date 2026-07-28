"""Request and response schemas, mirroring `packages/contracts/src/scoring.ts`.

Field names are camelCase to match the TypeScript contract exactly. Both sides are generated
from the same intent, so a rename on one side without the other is a 422 at the boundary rather
than a silently ignored field.
"""

from __future__ import annotations

import math
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.manifest import load_manifest


class PredictRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    #: Manifest version the caller computed features against. Mismatch is a 409.
    featureSetVersion: str = Field(min_length=1)
    #: Correlation id (the ARN), for tracing a prediction back to an application.
    applicationRef: str = Field(min_length=1)
    features: dict[str, float]

    @field_validator("features")
    @classmethod
    def validate_features(cls, value: dict[str, float]) -> dict[str, float]:
        """Requires a complete, finite, dense vector.

        Three separate checks, each catching a different real failure:

        * **Non-finite values.** ``Infinity`` almost always means an upstream division by zero —
          typically a debt service ratio computed against zero verified income. XGBoost would
          score it without complaint as the worst possible applicant. Rejecting it forces the
          caller to decide what unknown income means, which is a credit policy question.
        * **Missing features.** Silently substituting a default would score an applicant on data
          nobody supplied.
        * **Unknown features.** The caller is on a different manifest version than we are.
        """
        manifest = load_manifest()
        expected = set(manifest.names)
        received = set(value)

        missing = sorted(expected - received)
        unknown = sorted(received - expected)
        if missing or unknown:
            problems = []
            if missing:
                problems.append(f"missing {len(missing)}: {', '.join(missing[:8])}")
            if unknown:
                problems.append(f"unknown {len(unknown)}: {', '.join(unknown[:8])}")
            raise ValueError(
                "feature vector does not match the manifest — " + "; ".join(problems)
            )

        for name, raw in value.items():
            if not math.isfinite(raw):
                raise ValueError(
                    f"feature '{name}' is {raw}, which is not finite. This usually indicates a "
                    "division by zero in an upstream ratio; it must not be scored."
                )

        return value


class ShapFactor(BaseModel):
    feature: str
    label: str
    description: str
    shapValue: float
    featureValue: float
    direction: Literal["INCREASES_RISK", "DECREASES_RISK"]


class PredictResponse(BaseModel):
    pDefault: float = Field(ge=0.0, le=1.0)
    modelVersion: str
    featureSetVersion: str
    provenance: Literal["SYNTHETIC_SEED", "HISTORICAL_OUTCOMES", "HYBRID"]
    #: §6.3 — top 5 supporting factors.
    positiveFactors: list[ShapFactor]
    #: §6.3 — top 3 adverse factors, used verbatim in decline notices (SOP-003).
    negativeFactors: list[ShapFactor]
    baseValue: float
    inferenceMs: float = Field(ge=0.0)


class ModelMetrics(BaseModel):
    auc: float
    gini: float
    ks: float
    brier: float


class ModelInfoResponse(BaseModel):
    modelVersion: str
    featureSetVersion: str
    provenance: Literal["SYNTHETIC_SEED", "HISTORICAL_OUTCOMES", "HYBRID"]
    trainedAt: str
    featureCount: int
    metrics: ModelMetrics


class HealthResponse(BaseModel):
    status: Literal["ok"]


class ReadinessResponse(BaseModel):
    status: Literal["ready", "unavailable"]
    modelLoaded: bool
    featureSetVersion: str
    detail: str | None = None
