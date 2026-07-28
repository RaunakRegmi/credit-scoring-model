"""Feature manifest loader — the Python half of the train/serve contract.

Reads the same ``packages/contracts/feature-set.v1.json`` that the TypeScript codegen reads.
Everything the model needs about its inputs is derived from that one ordered array:

* the column order used to build the numpy matrix, at both fit time and predict time
* the monotonicity constraints handed to XGBoost
* the valid range each feature is clamped to
* the plain-language adverse-action wording attached to SHAP output

Because the ordering comes from a single shared artefact, train/serve column skew is
structurally impossible rather than merely tested for. It is the one class of bug in an ML
system that produces no error and silently degrades every prediction.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Literal

MANIFEST_FILENAME = "feature-set.v1.json"


def _search_paths() -> tuple[Path, ...]:
    """Candidate manifest locations, in priority order.

    Built as a function rather than a module-level tuple, and each ancestor index is bounds-checked
    against how deep this file actually sits. In the monorepo ``manifest.py`` is four levels below
    the repository root; in the Docker image it is two levels below ``/app``. Indexing ``parents[3]``
    unconditionally raises ``IndexError`` in the shallower layout — at import time, before any error
    handling — which is precisely how this broke the container build while working locally.
    """
    here = Path(__file__).resolve()
    ancestors = here.parents

    candidates: list[Path] = []

    # Monorepo: apps/ml/app/manifest.py -> <repo>/packages/contracts/
    if len(ancestors) > 3:
        candidates.append(ancestors[3] / "packages" / "contracts" / MANIFEST_FILENAME)

    # Container: /app/app/manifest.py -> /app/contracts/ (the Dockerfile copies it here).
    if len(ancestors) > 1:
        candidates.append(ancestors[1] / "contracts" / MANIFEST_FILENAME)
        candidates.append(ancestors[1] / MANIFEST_FILENAME)

    # Absolute fallbacks, independent of this file's location.
    candidates.append(Path("/app/contracts") / MANIFEST_FILENAME)
    candidates.append(Path.cwd() / "contracts" / MANIFEST_FILENAME)

    # An explicit override wins over everything, for deployments that mount it elsewhere.
    override = os.environ.get("AICS_FEATURE_MANIFEST")
    if override:
        return (Path(override), *candidates)

    return tuple(candidates)

Pillar = Literal["FINANCIAL", "PROFESSIONAL", "SOCIAL", "BEHAVIORAL", "APPLICATION"]


@dataclass(frozen=True, slots=True)
class FeatureDefinition:
    """One entry from the manifest."""

    name: str
    label: str
    dtype: Literal["int", "float"]
    unit: str
    minimum: float
    maximum: float
    default: float
    #: Constraint on P(default): +1 must not decrease risk, -1 must not increase it.
    monotone: int
    pillar: str
    reason_code: str
    adverse_action: str


@dataclass(frozen=True, slots=True)
class FeatureManifest:
    version: str
    features: tuple[FeatureDefinition, ...]
    #: Name -> definition, and name -> column position. Built once in ``__post_init__``
    #: because both are consulted per feature per request when attributing SHAP values;
    #: recomputing them on each access would make explanation O(n²) in the feature count.
    _index: dict[str, FeatureDefinition] = None  # type: ignore[assignment]
    _positions: dict[str, int] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        # object.__setattr__ is the supported way to populate derived state on a frozen
        # dataclass; the instance stays immutable to every other caller.
        object.__setattr__(self, "_index", {f.name: f for f in self.features})
        object.__setattr__(self, "_positions", {f.name: i for i, f in enumerate(self.features)})

    @property
    def names(self) -> tuple[str, ...]:
        """Canonical column order. This IS the model's column order."""
        return tuple(feature.name for feature in self.features)

    @property
    def monotone_constraints(self) -> tuple[int, ...]:
        """Constraints in column order, ready for XGBoost's ``monotone_constraints``."""
        return tuple(feature.monotone for feature in self.features)

    def by_name(self, name: str) -> FeatureDefinition | None:
        return self._index.get(name)

    def position_of(self, name: str) -> int | None:
        """Column index of a feature, or ``None`` if it is not in this manifest."""
        return self._positions.get(name)

    def clamp(self, name: str, value: float) -> float:
        """Bounds a value to its declared range.

        Clamping rather than rejecting: an unusually large balance is real data, and refusing
        to score an applicant because a value sat outside a modelling range would be the wrong
        failure. Non-finite values are rejected upstream by the request schema.
        """
        definition = self.by_name(name)
        if definition is None:
            return value
        bounded = min(definition.maximum, max(definition.minimum, value))
        return float(round(bounded)) if definition.dtype == "int" else float(bounded)


def _resolve_manifest_path() -> Path:
    candidates = _search_paths()
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    searched = "\n  ".join(str(path) for path in candidates)
    raise FileNotFoundError(
        f"Could not locate {MANIFEST_FILENAME}. Searched:\n  {searched}\n"
        "The scoring service cannot start without it — it defines the model's input contract."
    )


@lru_cache(maxsize=1)
def load_manifest() -> FeatureManifest:
    """Loads and validates the manifest. Cached: it is immutable for the process lifetime."""
    path = _resolve_manifest_path()
    raw = json.loads(path.read_text(encoding="utf-8"))

    version = raw.get("version")
    if not isinstance(version, str):
        raise ValueError(f"{path}: 'version' must be a string")

    entries = raw.get("features")
    if not isinstance(entries, list) or not entries:
        raise ValueError(f"{path}: 'features' must be a non-empty array")

    features: list[FeatureDefinition] = []
    seen: set[str] = set()

    for index, entry in enumerate(entries):
        name = entry.get("name")
        if not isinstance(name, str) or not name:
            raise ValueError(f"{path}: features[{index}] has no name")
        if name in seen:
            raise ValueError(f"{path}: duplicate feature '{name}'")
        seen.add(name)

        monotone = entry.get("monotone", 0)
        if monotone not in (-1, 0, 1):
            raise ValueError(f"{path}: features[{index}] ({name}) monotone must be -1, 0 or 1")

        features.append(
            FeatureDefinition(
                name=name,
                label=entry.get("label", name),
                dtype=entry.get("dtype", "float"),
                unit=entry.get("unit", ""),
                minimum=float(entry["min"]),
                maximum=float(entry["max"]),
                default=float(entry["default"]),
                monotone=int(monotone),
                pillar=entry.get("pillar", "APPLICATION"),
                reason_code=entry.get("reasonCode", name.upper()),
                adverse_action=entry.get("adverseAction", ""),
            )
        )

    return FeatureManifest(version=version, features=tuple(features))


def manifest_default_vector() -> dict[str, float]:
    """A dense vector of manifest defaults — the starting point for tests and fixtures."""
    manifest = load_manifest()
    return {feature.name: feature.default for feature in manifest.features}
