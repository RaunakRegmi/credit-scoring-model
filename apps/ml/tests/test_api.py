"""API contract tests.

The rejection cases matter as much as the happy path: the boundary exists to refuse inputs the
model must not score, and each refusal corresponds to a real failure the NestJS engine degrades
from rather than a theoretical one.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.manifest import load_manifest, manifest_default_vector
from app.model import ARTIFACT_DIR

HAS_MODEL = (ARTIFACT_DIR / "pd_model.ubj").is_file()


@pytest.fixture(scope="module")
def client() -> TestClient:
    # The context manager runs the lifespan handler, which loads the model.
    with TestClient(app) as test_client:
        yield test_client


def _request(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "featureSetVersion": load_manifest().version,
        "applicationRef": "ONE-20260501-TEST01",
        "features": manifest_default_vector(),
    }
    payload.update(overrides)
    return payload


def test_healthz_never_depends_on_the_model(client: TestClient) -> None:
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_readyz_reports_model_state(client: TestClient) -> None:
    response = client.get("/readyz")
    body = response.json()
    assert body["featureSetVersion"] == load_manifest().version
    if HAS_MODEL:
        assert response.status_code == 200
        assert body["status"] == "ready"
    else:
        assert response.status_code == 503
        assert body["status"] == "unavailable"


@pytest.mark.skipif(not HAS_MODEL, reason="no trained artifact")
def test_predict_returns_a_calibrated_probability(client: TestClient) -> None:
    response = client.post("/predict", json=_request())
    assert response.status_code == 200

    body = response.json()
    assert 0.0 <= body["pDefault"] <= 1.0
    assert body["featureSetVersion"] == load_manifest().version
    assert body["provenance"] in {"SYNTHETIC_SEED", "HISTORICAL_OUTCOMES", "HYBRID"}
    assert body["inferenceMs"] >= 0


@pytest.mark.skipif(not HAS_MODEL, reason="no trained artifact")
def test_predict_surfaces_synthetic_provenance(client: TestClient) -> None:
    """The seed model must declare that it never saw a real repayment outcome."""
    response = client.post("/predict", json=_request())
    assert response.json()["provenance"] == "SYNTHETIC_SEED"


@pytest.mark.skipif(not HAS_MODEL, reason="no trained artifact")
def test_predict_returns_shap_factors_per_section_6_3(client: TestClient) -> None:
    body = client.post("/predict", json=_request()).json()
    assert len(body["positiveFactors"]) <= 5
    assert len(body["negativeFactors"]) <= 3
    for factor in body["positiveFactors"] + body["negativeFactors"]:
        assert factor["direction"] in {"INCREASES_RISK", "DECREASES_RISK"}
        assert factor["label"]
        assert factor["description"]


def test_feature_set_version_mismatch_is_409(client: TestClient) -> None:
    """A model must never silently score a vector from a different contract version."""
    response = client.post("/predict", json=_request(featureSetVersion="9.9.9"))
    assert response.status_code == 409
    assert "mismatch" in response.json()["detail"].lower()


def test_missing_feature_is_rejected(client: TestClient) -> None:
    features = manifest_default_vector()
    del features["dsr"]
    response = client.post("/predict", json=_request(features=features))
    assert response.status_code == 422
    assert "dsr" in response.text


def test_unknown_feature_is_rejected(client: TestClient) -> None:
    features = manifest_default_vector() | {"invented_feature": 1.0}
    response = client.post("/predict", json=_request(features=features))
    assert response.status_code == 422
    assert "invented_feature" in response.text


@pytest.mark.parametrize("literal", ["Infinity", "-Infinity", "NaN"])
def test_non_finite_feature_literal_is_rejected(client: TestClient, literal: str) -> None:
    """Infinity almost always means a division by zero upstream — never score it.

    Sent as a raw body rather than via ``json=``: non-finite floats are not valid JSON, so
    Python's encoder refuses to produce them and a compliant client cannot send one. The real
    exposure is a caller whose serialiser emits the bare ``Infinity``/``NaN`` tokens that
    JavaScript's older JSON dialects and several logging libraries still produce. That request
    does reach us, and it must be refused rather than scored as the worst possible applicant.
    """
    features = manifest_default_vector()
    parts = ", ".join(
        f'"{name}": {literal if name == "dsr" else value}' for name, value in features.items()
    )
    body = (
        f'{{"featureSetVersion": "{load_manifest().version}", '
        f'"applicationRef": "ONE-20260501-TEST01", "features": {{{parts}}}}}'
    )

    response = client.post(
        "/predict", content=body, headers={"Content-Type": "application/json"}
    )
    assert response.status_code in {400, 422}, response.text


def test_validator_rejects_non_finite_values_directly() -> None:
    """The guard itself, independent of what any HTTP client can encode."""
    from app.schemas import PredictRequest

    for bad in (float("inf"), float("-inf"), float("nan")):
        with pytest.raises(ValueError, match="finite"):
            PredictRequest(
                featureSetVersion=load_manifest().version,
                applicationRef="ONE-20260501-TEST01",
                features=manifest_default_vector() | {"dsr": bad},
            )


def test_extra_top_level_field_is_rejected(client: TestClient) -> None:
    response = client.post("/predict", json=_request(unexpected="value"))
    assert response.status_code == 422


def test_missing_application_ref_is_rejected(client: TestClient) -> None:
    payload = _request()
    del payload["applicationRef"]
    response = client.post("/predict", json=payload)
    assert response.status_code == 422


@pytest.mark.skipif(not HAS_MODEL, reason="no trained artifact")
def test_model_info_reports_lineage(client: TestClient) -> None:
    body = client.get("/model/info").json()
    assert body["featureSetVersion"] == load_manifest().version
    assert body["featureCount"] == len(load_manifest().features)
    assert body["trainedAt"]
    metrics = body["metrics"]
    for key in ("auc", "gini", "ks", "brier"):
        assert key in metrics


@pytest.mark.skipif(not HAS_MODEL, reason="no trained artifact")
def test_clamping_accepts_out_of_range_values(client: TestClient) -> None:
    """Extreme but real data is scored at the boundary, not refused."""
    features = manifest_default_vector() | {"avg_balance_6m": 9.9e12}
    response = client.post("/predict", json=_request(features=features))
    assert response.status_code == 200
