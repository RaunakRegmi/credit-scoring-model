"""Trains the seed probability-of-default model.

Run: ``python -m train.train`` from ``apps/ml``.

Three decisions here matter more than the hyperparameters:

**Monotonicity.** Every constraint comes from the shared manifest and is passed to XGBoost as
``monotone_constraints``. This is the single most important property for a regulated credit
model: it guarantees that raising the debt service ratio, holding everything else fixed, can
never be shown to have *lowered* the applicant's assessed risk. Without it, a gradient-boosted
tree will happily learn locally non-monotone quirks from noise, and no amount of SHAP output
will make the resulting decision defensible to NRB or to an applicant.

**Calibration.** Raw boosted-tree scores are not probabilities. §5.1 maps PD ranges to bands and
§9.3 maps them to capital provisions, so a PD that is merely rank-ordered is not enough — 3.5%
has to mean 3.5%. An isotonic regression on a held-out fold fixes this, and the Brier score
reports whether it worked.

**Honest metrics.** AUC is computed against the noisy Bernoulli labels the model actually saw,
not against the latent probabilities used to generate them. Scoring against ground-truth
probabilities would report an AUC no real credit model achieves.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import xgboost as xgb
from sklearn.calibration import IsotonicRegression
from sklearn.metrics import brier_score_loss, roc_auc_score
from sklearn.model_selection import train_test_split

from app.manifest import load_manifest
from train.synthetic import generate

ARTIFACT_DIR = Path(__file__).resolve().parents[1] / "artifacts"
MODEL_PATH = ARTIFACT_DIR / "pd_model.ubj"
CALIBRATOR_PATH = ARTIFACT_DIR / "pd_calibrator.json"
METADATA_PATH = ARTIFACT_DIR / "model_metadata.json"

MODEL_NAME = "aics-pd-xgboost"
MODEL_VERSION = "1.0.0-synthetic-seed"
PROVENANCE = "SYNTHETIC_SEED"


def kolmogorov_smirnov(labels: np.ndarray, scores: np.ndarray) -> float:
    """KS statistic — the §6.4 monitoring metric.

    The maximum separation between the cumulative distributions of scores for defaulters and
    non-defaulters. Reported alongside AUC because credit risk teams read KS by convention.
    """
    positives = scores[labels == 1]
    negatives = scores[labels == 0]
    if positives.size == 0 or negatives.size == 0:
        return 0.0

    thresholds = np.unique(scores)
    # Cap the sweep: with tens of thousands of unique float scores the exact KS gains nothing
    # over a fine grid and costs a quadratic scan.
    if thresholds.size > 2_000:
        thresholds = np.quantile(scores, np.linspace(0.0, 1.0, 2_000))

    best = 0.0
    for threshold in thresholds:
        true_positive_rate = float((positives <= threshold).mean())
        false_positive_rate = float((negatives <= threshold).mean())
        best = max(best, abs(true_positive_rate - false_positive_rate))
    return best


def verify_monotonicity(
    booster: xgb.XGBClassifier,
    baseline: np.ndarray,
    feature_names: tuple[str, ...],
    constraints: tuple[int, ...],
) -> list[str]:
    """Empirically checks that the fitted model honours its constraints.

    XGBoost enforces monotonicity during tree construction, so this should always pass. It is
    checked anyway, because the constraint tuple is positional: a manifest reordering that
    slipped past the shared-loader design would silently apply the wrong constraint to the
    wrong column, and the model would still train cleanly. This assertion is what would catch
    that.
    """
    violations: list[str] = []
    manifest = load_manifest()

    for index, (name, direction) in enumerate(zip(feature_names, constraints, strict=True)):
        if direction == 0:
            continue
        definition = manifest.by_name(name)
        if definition is None:
            continue

        # Sweep this feature across its range with every other feature held at the baseline.
        sweep = np.tile(baseline, (25, 1))
        sweep[:, index] = np.linspace(definition.minimum, definition.maximum, 25)
        predictions = booster.predict_proba(sweep)[:, 1]

        differences = np.diff(predictions)
        # Tolerance absorbs float noise in the tree traversal, not real violations.
        tolerance = 1e-9
        if direction == 1 and np.any(differences < -tolerance):
            violations.append(f"{name}: expected non-decreasing PD, found a decrease")
        if direction == -1 and np.any(differences > tolerance):
            violations.append(f"{name}: expected non-increasing PD, found an increase")

    return violations


def main() -> None:
    parser = argparse.ArgumentParser(description="Train the AICS seed PD model")
    parser.add_argument("--rows", type=int, default=24_000, help="synthetic population size")
    parser.add_argument("--seed", type=int, default=20260501, help="PRNG seed")
    parser.add_argument("--trees", type=int, default=400, help="number of boosting rounds")
    args = parser.parse_args()

    manifest = load_manifest()
    feature_names = manifest.names
    constraints = manifest.monotone_constraints

    print(f"Feature set v{manifest.version} — {len(feature_names)} features")
    constrained = sum(1 for direction in constraints if direction != 0)
    print(f"Monotonicity constraints on {constrained}/{len(constraints)} features")

    matrix, labels, true_pd = generate(rows=args.rows, seed=args.seed)
    print(f"Generated {matrix.shape[0]:,} rows · observed default rate {labels.mean():.3%}")

    # Three-way split: fit / calibrate / evaluate. The calibrator must not see the evaluation
    # fold, or the reported Brier score measures the calibrator fitting its own test data.
    x_fit, x_hold, y_fit, y_hold, _, pd_hold = train_test_split(
        matrix, labels, true_pd, test_size=0.40, random_state=args.seed, stratify=labels
    )
    x_cal, x_test, y_cal, y_test, pd_cal, pd_test = train_test_split(
        x_hold, y_hold, pd_hold, test_size=0.50, random_state=args.seed, stratify=y_hold
    )
    del pd_cal
    print(f"Split — fit {len(y_fit):,} · calibrate {len(y_cal):,} · test {len(y_test):,}")

    model = xgb.XGBClassifier(
        n_estimators=args.trees,
        max_depth=4,
        learning_rate=0.05,
        subsample=0.85,
        colsample_bytree=0.85,
        min_child_weight=12,
        reg_lambda=2.0,
        reg_alpha=0.5,
        objective="binary:logistic",
        eval_metric="auc",
        # THE line that makes this model defensible. Positional against feature_names, which
        # is why `verify_monotonicity` exists below.
        monotone_constraints=tuple(constraints),
        tree_method="hist",
        random_state=args.seed,
        n_jobs=-1,
    )

    model.fit(x_fit, y_fit, eval_set=[(x_cal, y_cal)], verbose=False)

    raw_test = model.predict_proba(x_test)[:, 1]
    auc = float(roc_auc_score(y_test, raw_test))
    gini = 2.0 * auc - 1.0
    ks = kolmogorov_smirnov(y_test, raw_test)

    # The ceiling any model can reach on this data: AUC of the true probabilities against the
    # noisy labels they generated. Labels are Bernoulli draws, so even a perfect model cannot
    # separate a 12% borrower who defaulted from an 11% borrower who did not. Reporting AUC
    # without this reference invites the wrong conclusion — that a model close to the Bayes
    # ceiling is underperforming, when it has in fact extracted all available signal.
    bayes_auc = float(roc_auc_score(y_test, pd_test))

    # Isotonic calibration: monotone, so it cannot disturb the rank ordering the constraints
    # were there to protect, and non-parametric, so it does not assume a logistic link.
    calibrator = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)
    calibrator.fit(model.predict_proba(x_cal)[:, 1], y_cal)

    calibrated_test = calibrator.predict(raw_test)
    brier_raw = float(brier_score_loss(y_test, raw_test))
    brier_calibrated = float(brier_score_loss(y_test, calibrated_test))

    # How closely did we recover the ground-truth probabilities we generated from?
    recovery_mae = float(np.mean(np.abs(calibrated_test - pd_test)))

    print()
    print(f"AUC-ROC              {auc:.4f}")
    print(f"  Bayes ceiling       {bayes_auc:.4f}   best achievable against these noisy labels")
    print(f"  signal captured     {auc / bayes_auc:.1%} of the ceiling")
    print(f"Gini                 {gini:.4f}")
    print(f"KS statistic         {ks:.4f}")
    print(f"Brier (raw)          {brier_raw:.5f}")
    print(f"Brier (calibrated)   {brier_calibrated:.5f}")
    print(f"Mean |PD error|      {recovery_mae:.5f}   vs generated ground truth")

    baseline = np.median(matrix, axis=0)
    violations = verify_monotonicity(model, baseline, feature_names, constraints)
    if violations:
        # Refuse to ship a model that breaks its own constraints. A non-monotone credit model
        # cannot be explained to a regulator, so this is a hard failure rather than a warning.
        raise SystemExit(
            "Monotonicity verification FAILED — refusing to write the artifact:\n  "
            + "\n  ".join(violations)
        )
    print(f"Monotonicity verified across {constrained} constrained features")

    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    model.save_model(MODEL_PATH)

    # Persist the isotonic step function as plain arrays rather than pickling the estimator:
    # a pickle ties the artifact to this exact scikit-learn build, and an unpicklable model
    # file is an outage.
    CALIBRATOR_PATH.write_text(
        json.dumps(
            {
                "x": calibrator.X_thresholds_.tolist(),
                "y": calibrator.y_thresholds_.tolist(),
            }
        ),
        encoding="utf-8",
    )

    metadata = {
        "modelName": MODEL_NAME,
        "modelVersion": MODEL_VERSION,
        "provenance": PROVENANCE,
        "featureSetVersion": manifest.version,
        "featureCount": len(feature_names),
        "featureNames": list(feature_names),
        "monotoneConstraints": list(constraints),
        "trainedAt": datetime.now(timezone.utc).isoformat(),
        "trainingRows": int(matrix.shape[0]),
        "observedDefaultRate": float(labels.mean()),
        "metrics": {
            "auc": auc,
            "bayesCeilingAuc": bayes_auc,
            "signalCapturedPct": auc / bayes_auc if bayes_auc > 0 else 0.0,
            "gini": gini,
            "ks": ks,
            "brier": brier_calibrated,
            "brierRaw": brier_raw,
            "pdRecoveryMae": recovery_mae,
        },
        "hyperparameters": {
            "nEstimators": args.trees,
            "maxDepth": 4,
            "learningRate": 0.05,
            "minChildWeight": 12,
        },
        "warning": (
            "Trained on a SYNTHETIC population calibrated to the §5.1 PD bands. This model has "
            "never seen a real repayment outcome. It runs in shadow mode only; the "
            "deterministic four-pillar scorecard is authoritative until §6.4 promotion on at "
            "least 500 labelled outcomes."
        ),
    }
    METADATA_PATH.write_text(json.dumps(metadata, indent=2), encoding="utf-8")

    print()
    print(f"Wrote {MODEL_PATH.name}, {CALIBRATOR_PATH.name}, {METADATA_PATH.name}")
    print(f"Model {MODEL_NAME} v{MODEL_VERSION} · provenance {PROVENANCE}")


if __name__ == "__main__":
    main()
