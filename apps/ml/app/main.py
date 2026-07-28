"""ONE BNPL AICS — scoring microservice (§6.1 "Financial Scorer" / meta-learner).

Run: ``uvicorn app.main:app --port 8000`` from ``apps/ml``.

The service is a deliberately small surface: score a feature vector, explain the score, and
report what model produced it. It holds no state and owns no policy — banding, pricing and the
decision itself live in the NestJS engine, because those are auditable business rules rather
than model outputs.
"""

from __future__ import annotations

import logging
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.manifest import load_manifest
from app.model import ModelNotLoadedError, pd_model
from app.schemas import (
    HealthResponse,
    ModelInfoResponse,
    ModelMetrics,
    PredictRequest,
    PredictResponse,
    ReadinessResponse,
    ShapFactor,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
)
logger = logging.getLogger("aics.ml")


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    """Loads the manifest and model once, at startup.

    The manifest is mandatory — without it the service has no input contract and must not
    start. The model artifact is not: a fresh deployment before the first training run should
    report itself unready, not crash-loop.
    """
    manifest = load_manifest()
    logger.info(
        "Feature set v%s — %d features, %d monotonicity constraints",
        manifest.version,
        len(manifest.features),
        sum(1 for direction in manifest.monotone_constraints if direction != 0),
    )

    if pd_model.load():
        logger.info("Scoring service ready")
    else:
        logger.warning("Scoring service started WITHOUT a model — /predict will return 503")

    yield


app = FastAPI(
    title="ONE BNPL — AICS Scoring Service",
    description=(
        "Probability-of-default scoring with SHAP attribution for the ONE BNPL AI Credit "
        "Scoring Model. The deterministic four-pillar scorecard in the NestJS engine remains "
        "authoritative; this service runs in shadow mode until §6.4 promotion."
    ),
    version="1.0.0",
    lifespan=lifespan,
)


@app.get("/healthz", response_model=HealthResponse)
async def healthz() -> HealthResponse:
    """Liveness. Never touches the model, so a cold artifact does not trigger a restart."""
    return HealthResponse(status="ok")


@app.get("/readyz", response_model=ReadinessResponse)
async def readyz() -> JSONResponse:
    """Readiness. Unready without a loaded model, since /predict cannot serve."""
    manifest = load_manifest()
    ready = pd_model.ready

    body = ReadinessResponse(
        status="ready" if ready else "unavailable",
        modelLoaded=ready,
        featureSetVersion=manifest.version,
        detail=None if ready else "No model artifact. Run `python -m train.train` in apps/ml.",
    )
    return JSONResponse(
        status_code=status.HTTP_200_OK if ready else status.HTTP_503_SERVICE_UNAVAILABLE,
        content=body.model_dump(),
    )


@app.get("/model/info", response_model=ModelInfoResponse)
async def model_info() -> ModelInfoResponse:
    """Model lineage, recorded on every decision for §10.4 audit."""
    if not pd_model.ready:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="No model artifact loaded",
        )

    metadata = pd_model.metadata
    metrics = metadata.get("metrics", {})

    return ModelInfoResponse(
        modelVersion=metadata.get("modelVersion", "unknown"),
        featureSetVersion=metadata.get("featureSetVersion", pd_model.manifest.version),
        provenance=metadata.get("provenance", "SYNTHETIC_SEED"),
        trainedAt=metadata.get("trainedAt", ""),
        featureCount=metadata.get("featureCount", len(pd_model.manifest.features)),
        metrics=ModelMetrics(
            auc=float(metrics.get("auc", 0.0)),
            gini=float(metrics.get("gini", 0.0)),
            ks=float(metrics.get("ks", 0.0)),
            brier=float(metrics.get("brier", 0.0)),
        ),
    )


@app.post("/predict", response_model=PredictResponse)
async def predict(request: PredictRequest) -> PredictResponse:
    """Scores one applicant.

    Returns 409 on a feature-set version mismatch rather than scoring anyway. That is the whole
    purpose of the shared manifest: a model fitted on v1.0.0 columns silently scoring a v1.1.0
    vector loses accuracy with no error anywhere, which is the worst failure mode an ML service
    has. Better a loud refusal that the caller degrades from.
    """
    manifest = pd_model.manifest

    if request.featureSetVersion != manifest.version:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"Feature set version mismatch: caller sent {request.featureSetVersion}, this "
                f"service serves {manifest.version}. Refusing to score — the columns may not "
                "mean what the model expects."
            ),
        )

    started = time.perf_counter()
    try:
        prediction = pd_model.predict(request.features)
    except ModelNotLoadedError as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)
        ) from error

    elapsed_ms = (time.perf_counter() - started) * 1000.0
    metadata = pd_model.metadata

    logger.info(
        "[%s] PD %.4f in %.1fms",
        request.applicationRef,
        prediction.p_default,
        elapsed_ms,
    )

    def to_factor(attribution: object) -> ShapFactor:
        # Attribution is a frozen slots dataclass; read fields explicitly for clarity.
        return ShapFactor(
            feature=attribution.feature,  # type: ignore[attr-defined]
            label=attribution.label,  # type: ignore[attr-defined]
            description=attribution.description,  # type: ignore[attr-defined]
            shapValue=attribution.shap_value,  # type: ignore[attr-defined]
            featureValue=attribution.feature_value,  # type: ignore[attr-defined]
            direction=attribution.direction,  # type: ignore[attr-defined]
        )

    return PredictResponse(
        pDefault=prediction.p_default,
        modelVersion=metadata.get("modelVersion", "unknown"),
        featureSetVersion=manifest.version,
        provenance=metadata.get("provenance", "SYNTHETIC_SEED"),
        positiveFactors=[to_factor(item) for item in prediction.positive_factors],
        negativeFactors=[to_factor(item) for item in prediction.negative_factors],
        baseValue=prediction.base_value,
        inferenceMs=elapsed_ms,
    )


@app.exception_handler(RequestValidationError)
async def validation_error_handler(
    request: Request, exception: RequestValidationError
) -> JSONResponse:
    """Returns validation failures without echoing the submitted values.

    Two reasons this replaces FastAPI's default handler, both discovered the hard way:

    1. **PII.** The default body includes an ``input`` field carrying the value that failed. Here
       that value is a feature derived from an applicant's bank statement or CV, so the default
       behaviour reflects personal financial data back to the caller and into any log or error
       tracker that records response bodies.

    2. **Non-finite values crash the encoder.** Python's ``json.loads`` accepts the non-standard
       ``Infinity`` and ``NaN`` literals, so such a request reaches the validator and is
       correctly rejected — but serialising the rejection *back* fails, because those values are
       not valid JSON output. The default handler therefore turns a clean 422 into an unhandled
       500 for precisely the malformed input we most want to reject cleanly.

    Only the field location, the message and the error type are returned.
    """
    errors = [
        {
            "loc": [str(part) for part in error.get("loc", ())],
            "msg": str(error.get("msg", "")),
            "type": str(error.get("type", "")),
        }
        for error in exception.errors()
    ]
    logger.warning(
        "Rejected %s %s: %d validation error(s)",
        request.method,
        request.url.path,
        len(errors),
    )
    # Literal 422 rather than a starlette constant: the name was renamed from
    # HTTP_422_UNPROCESSABLE_ENTITY to HTTP_422_UNPROCESSABLE_CONTENT, so either constant
    # emits a deprecation warning on one side of that change. The number is stable.
    return JSONResponse(status_code=422, content={"detail": errors})


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exception: Exception) -> JSONResponse:
    """Last resort. Logs the detail, returns none of it.

    Feature vectors are derived from an applicant's bank statement and CV. An exception message
    echoing one back to the caller is a PII disclosure, so the response says only that
    something failed.
    """
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"detail": "Internal scoring error"},
    )
