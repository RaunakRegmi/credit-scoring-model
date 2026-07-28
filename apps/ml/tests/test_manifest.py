"""Manifest contract tests.

These guard the shared-artefact design. If the Python side and the TypeScript side can ever
disagree about what column 12 means, every prediction silently degrades with no error raised
anywhere — so these are the highest-value tests in the service.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.manifest import load_manifest, manifest_default_vector

PROHIBITED_TOKENS = (
    "gender",
    "sex",
    "age",
    "dob",
    "birth",
    "nationality",
    "ethnic",
    "caste",
    "religion",
    "race",
    "marital",
)


def test_manifest_loads() -> None:
    manifest = load_manifest()
    assert manifest.version
    assert len(manifest.features) > 0


def test_names_are_unique_and_ordered() -> None:
    manifest = load_manifest()
    names = manifest.names
    assert len(set(names)) == len(names)
    # names must follow the declared array order exactly.
    assert names == tuple(feature.name for feature in manifest.features)


def test_positions_match_column_order() -> None:
    manifest = load_manifest()
    for index, name in enumerate(manifest.names):
        assert manifest.position_of(name) == index


def test_monotone_constraints_align_with_columns() -> None:
    """The constraint tuple is positional; a misalignment applies the wrong rule silently."""
    manifest = load_manifest()
    constraints = manifest.monotone_constraints
    assert len(constraints) == len(manifest.features)
    for index, feature in enumerate(manifest.features):
        assert constraints[index] == feature.monotone


def test_no_protected_characteristics() -> None:
    """§10.2 — the model must be demographically neutral."""
    manifest = load_manifest()
    for feature in manifest.features:
        lowered = feature.name.lower()
        for token in PROHIBITED_TOKENS:
            assert token not in lowered, f"{feature.name} looks like a protected characteristic"


def test_every_feature_has_adverse_action_wording() -> None:
    """§6.3 / SOP-003 — a declined applicant must get a sentence, not a column name."""
    manifest = load_manifest()
    for feature in manifest.features:
        assert len(feature.adverse_action) > 10, feature.name
        assert "_" not in feature.adverse_action, feature.name


def test_defaults_are_inside_declared_ranges() -> None:
    manifest = load_manifest()
    for feature in manifest.features:
        assert feature.minimum < feature.maximum, feature.name
        assert feature.minimum <= feature.default <= feature.maximum, feature.name


def test_clamp_bounds_values() -> None:
    manifest = load_manifest()
    dsr = manifest.by_name("dsr")
    assert dsr is not None
    assert manifest.clamp("dsr", 10_000.0) == dsr.maximum
    assert manifest.clamp("dsr", -50.0) == dsr.minimum


def test_clamp_rounds_integer_features() -> None:
    manifest = load_manifest()
    assert manifest.clamp("salary_consistency_months", 4.7) == 5.0


def test_default_vector_is_dense() -> None:
    manifest = load_manifest()
    vector = manifest_default_vector()
    assert set(vector) == set(manifest.names)


def test_typescript_and_python_read_the_same_file() -> None:
    """The single-source-of-truth guarantee, asserted rather than assumed.

    The generated TypeScript module inlines the manifest at build time. If the checked-in
    generated file has drifted from the JSON — someone edited one and forgot to run codegen —
    the two runtimes are on different contracts even though both "load the manifest".
    """
    repo_root = Path(__file__).resolve().parents[3]
    generated = repo_root / "packages" / "contracts" / "src" / "generated" / "features.generated.ts"
    if not generated.is_file():
        pytest.skip("TypeScript codegen output not present; run `npm run codegen`")

    manifest = load_manifest()
    source = generated.read_text(encoding="utf-8")

    assert f"FEATURE_SET_VERSION = '{manifest.version}'" in source

    # Extract the FEATURE_NAMES array and compare order element by element.
    start = source.index("export const FEATURE_NAMES = [")
    end = source.index("] as const;", start)
    block = source[start:end]
    ts_names = tuple(
        line.strip().strip(",").strip("'") for line in block.splitlines() if line.strip().startswith("'")
    )

    assert ts_names == manifest.names, (
        "TypeScript FEATURE_NAMES and the JSON manifest disagree on column order. "
        "Run `npm run codegen -w @aics/contracts`."
    )


def test_manifest_json_is_valid_and_matches_loader() -> None:
    repo_root = Path(__file__).resolve().parents[3]
    path = repo_root / "packages" / "contracts" / "feature-set.v1.json"
    raw = json.loads(path.read_text(encoding="utf-8"))

    manifest = load_manifest()
    assert raw["version"] == manifest.version
    assert len(raw["features"]) == len(manifest.features)
