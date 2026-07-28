"""Model behaviour tests.

The monotonicity tests here are the ones that matter for regulatory defensibility. They assert
the property NRB and any fair-lending review will actually probe: that moving a single risk
factor in the adverse direction never improves the applicant's assessed risk.
"""

from __future__ import annotations

import numpy as np
import pytest

from app.manifest import load_manifest, manifest_default_vector
from app.model import ARTIFACT_DIR, PdModel

pytestmark = pytest.mark.skipif(
    not (ARTIFACT_DIR / "pd_model.ubj").is_file(),
    reason="No trained artifact; run `python -m train.train`",
)


@pytest.fixture(scope="module")
def model() -> PdModel:
    instance = PdModel()
    assert instance.load(), "model artifact failed to load"
    return instance


def test_model_loads_and_matches_manifest(model: PdModel) -> None:
    assert model.ready
    assert model.metadata["featureSetVersion"] == load_manifest().version
    assert tuple(model.metadata["featureNames"]) == load_manifest().names


def test_matrix_uses_manifest_order_not_dict_order(model: PdModel) -> None:
    """A JSON object has no meaningful key order; the matrix must not depend on one."""
    manifest = load_manifest()
    features = manifest_default_vector()

    forward = model.to_matrix(features)
    # Same data, reversed insertion order.
    reversed_features = dict(reversed(list(features.items())))
    backward = model.to_matrix(reversed_features)

    np.testing.assert_array_equal(forward, backward)

    # And the values must land in manifest positions.
    for index, name in enumerate(manifest.names):
        assert forward[0, index] == pytest.approx(manifest.clamp(name, features[name]))


def test_missing_feature_falls_back_to_declared_default(model: PdModel) -> None:
    manifest = load_manifest()
    features = manifest_default_vector()
    del features["dsr"]

    matrix = model.to_matrix(features)
    position = manifest.position_of("dsr")
    assert position is not None
    definition = manifest.by_name("dsr")
    assert definition is not None
    assert matrix[0, position] == pytest.approx(definition.default)


def test_prediction_is_a_probability(model: PdModel) -> None:
    prediction = model.predict(manifest_default_vector())
    assert 0.0 <= prediction.p_default <= 1.0


def test_prediction_is_deterministic(model: PdModel) -> None:
    """The same applicant must score identically every time. §10.4 audit depends on it."""
    features = manifest_default_vector()
    first = model.predict(features)
    second = model.predict(features)
    assert first.p_default == second.p_default


@pytest.mark.parametrize(
    "feature",
    ["dsr", "bounce_count_6m", "late_payment_count_6m", "discretionary_spend_ratio"],
)
def test_risk_increasing_features_are_monotone(model: PdModel, feature: str) -> None:
    """Raising a risk-increasing feature alone must never lower the predicted PD."""
    manifest = load_manifest()
    definition = manifest.by_name(feature)
    assert definition is not None and definition.monotone == 1

    features = manifest_default_vector()
    predictions = []
    for value in np.linspace(definition.minimum, definition.maximum, 12):
        probe = dict(features)
        probe[feature] = float(value)
        predictions.append(model.predict(probe).p_default)

    differences = np.diff(predictions)
    assert np.all(differences >= -1e-9), f"{feature} decreased PD: {predictions}"


@pytest.mark.parametrize(
    "feature",
    ["avg_balance_6m", "salary_consistency_months", "savings_rate", "avg_employer_tenure_years"],
)
def test_risk_reducing_features_are_monotone(model: PdModel, feature: str) -> None:
    """Raising a risk-reducing feature alone must never raise the predicted PD."""
    manifest = load_manifest()
    definition = manifest.by_name(feature)
    assert definition is not None and definition.monotone == -1

    features = manifest_default_vector()
    predictions = []
    for value in np.linspace(definition.minimum, definition.maximum, 12):
        probe = dict(features)
        probe[feature] = float(value)
        predictions.append(model.predict(probe).p_default)

    differences = np.diff(predictions)
    assert np.all(differences <= 1e-9), f"{feature} increased PD: {predictions}"


def test_strong_applicant_scores_below_weak_applicant(model: PdModel) -> None:
    """Sanity check on direction: the model must not be inverted."""
    strong = manifest_default_vector() | {
        "avg_balance_6m": 400_000.0,
        "salary_consistency_months": 6.0,
        "avg_monthly_income": 250_000.0,
        "dsr": 0.15,
        "savings_rate": 0.3,
        "bounce_count_6m": 0.0,
        "late_payment_count_6m": 0.0,
        "employer_tier_score": 95.0,
        "total_experience_years": 14.0,
        "emi_payment_punctuality": 1.0,
        "statement_months_available": 6.0,
    }
    weak = manifest_default_vector() | {
        "avg_balance_6m": 4_000.0,
        "salary_consistency_months": 1.0,
        "avg_monthly_income": 22_000.0,
        "dsr": 0.85,
        "savings_rate": -0.2,
        "bounce_count_6m": 5.0,
        "late_payment_count_6m": 4.0,
        "employer_tier_score": 30.0,
        "total_experience_years": 1.0,
        "emi_payment_punctuality": 0.5,
        "statement_months_available": 3.0,
    }

    assert model.predict(strong).p_default < model.predict(weak).p_default


def test_shap_factor_counts_match_section_6_3(model: PdModel) -> None:
    """§6.3 — top 5 supporting and top 3 adverse factors."""
    prediction = model.predict(manifest_default_vector())
    assert len(prediction.positive_factors) <= 5
    assert len(prediction.negative_factors) <= 3


def test_shap_directions_are_consistent_with_sign(model: PdModel) -> None:
    prediction = model.predict(manifest_default_vector())
    for factor in prediction.positive_factors:
        assert factor.shap_value < 0
        assert factor.direction == "DECREASES_RISK"
    for factor in prediction.negative_factors:
        assert factor.shap_value > 0
        assert factor.direction == "INCREASES_RISK"


def test_adverse_factors_carry_plain_language_wording(model: PdModel) -> None:
    """A decline notice must never contain a raw feature name (SOP-003)."""
    weak = manifest_default_vector() | {"dsr": 1.2, "bounce_count_6m": 6.0}
    prediction = model.predict(weak)
    assert prediction.negative_factors, "expected at least one adverse factor for a weak profile"
    for factor in prediction.negative_factors:
        assert len(factor.description) > 10
        assert "_" not in factor.description


def test_shap_values_reconcile_to_the_prediction(model: PdModel) -> None:
    """SHAP is additive: base value plus all contributions equals the raw model output.

    Verified on the raw margin rather than the calibrated probability, because the isotonic
    calibrator is applied after the additive decomposition and is not itself additive.
    """
    assert model._booster is not None and model._explainer is not None  # noqa: SLF001

    features = manifest_default_vector() | {"dsr": 0.7, "avg_balance_6m": 60_000.0}
    matrix = model.to_matrix(features)

    shap_values = np.asarray(model._explainer.shap_values(matrix))  # noqa: SLF001
    if shap_values.ndim == 3:
        shap_values = shap_values[:, :, -1]

    base = float(np.asarray(model._explainer.expected_value).reshape(-1)[-1])  # noqa: SLF001
    reconstructed_margin = base + float(shap_values[0].sum())

    actual_margin = float(
        model._booster.predict(matrix, output_margin=True)[0]  # noqa: SLF001
    )
    assert reconstructed_margin == pytest.approx(actual_margin, abs=1e-3)
