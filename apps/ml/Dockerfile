# ONE BNPL AICS — scoring microservice.
#
# Python 3.12 rather than 3.13: shap depends on numba for its kernel explainers, and numba's
# 3.13 support requires numpy < 2.5. Pinning the interpreter one minor version back keeps the
# whole dependency set on wheels that exist, rather than forcing a source build of numba inside
# the image. Revisit when numba ships a release that lifts the numpy ceiling.
FROM python:3.12-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# libgomp is required by XGBoost's OpenMP runtime. Installed before the app layers so a code
# change does not invalidate the apt cache.
RUN apt-get update \
    && apt-get install --no-install-recommends -y libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Dependencies first: this layer only rebuilds when requirements.txt changes.
COPY apps/ml/requirements.txt ./requirements.txt
RUN pip install -r requirements.txt

COPY apps/ml/app ./app
COPY apps/ml/train ./train

# The feature manifest is the shared contract with the TypeScript side. Copied to the path
# `manifest.py` searches inside a container, so the service loads exactly the same definition
# the API computed its features against.
COPY packages/contracts/feature-set.v1.json ./contracts/feature-set.v1.json

# Train the seed model at build time so the image is immediately ready. In a real deployment the
# artifact comes from the model registry and this step is replaced by a download — a production
# image should never mint its own model.
RUN python -m train.train --rows 24000

# Non-root. The service reads a manifest and a model file and writes nothing.
RUN useradd --create-home --shell /usr/sbin/nologin aics \
    && chown -R aics:aics /app
USER aics

EXPOSE 8000

# Single worker: the SHAP TreeExplainer holds the model in memory, so replicas belong at the
# orchestrator level where they can be scheduled across hosts, not as forks sharing one CPU.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
