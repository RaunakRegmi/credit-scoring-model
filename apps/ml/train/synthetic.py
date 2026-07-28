"""Synthetic training data for the seed PD model.

WHAT THIS IS, PLAINLY
---------------------
There is no labelled repayment history yet. The §11 roadmap collects 1,000+ historical cases
in Phase 2 and §6.4 requires 500 labelled outcomes before a retrain. Until then, any model
that claims to have learned default behaviour from data is fiction.

So this generator does something narrower and honest: it manufactures a population whose
feature distributions are plausible for the Nepali salaried and self-employed segments, and
labels it using a *latent risk index* built from the same weights the §4 scorecard uses. The
resulting model is therefore a smooth, monotone, differentiable approximation of the scorecard
— useful for three real things:

1. It exercises the whole serving path (SHAP, calibration, the version contract) against
   realistic inputs, so the day real labels arrive only the training data changes.
2. It provides a second opinion that can *disagree* with the scorecard. Divergence between two
   artefacts derived differently is a genuine signal that an application is unusual, and the
   decision engine routes those to a human.
3. It gives the §6.4 champion/challenger harness a champion to challenge.

What it is NOT is evidence about real default rates. Every artefact it produces is tagged
``SYNTHETIC_SEED`` and that tag travels through the API into the UI.

CALIBRATION
-----------
Default labels are drawn from the PD implied by the §5.1 risk band the latent score falls into,
so the model's base rate matches the documented band structure rather than an invented number.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from app.manifest import FeatureManifest, load_manifest

#: §5.1 risk bands: (inclusive score floor on 0–1000, PD floor, PD ceiling).
RISK_BANDS: tuple[tuple[int, float, float], ...] = (
    (900, 0.001, 0.010),
    (750, 0.010, 0.035),
    (600, 0.035, 0.080),
    (450, 0.080, 0.200),
    (300, 0.200, 0.400),
    (0, 0.400, 0.700),
)


@dataclass(frozen=True, slots=True)
class Archetype:
    """A population segment, with the feature distribution that characterises it."""

    name: str
    #: Share of the generated population.
    weight: float
    #: feature name -> (mean, standard deviation) before clamping.
    distributions: dict[str, tuple[float, float]]


#: Segments drawn from §1.2's target list: salaried professionals, self-employed, gig workers,
#: remittance-dependent households and the over-leveraged tail.
ARCHETYPES: tuple[Archetype, ...] = (
    Archetype(
        name="prime_salaried",
        weight=0.22,
        distributions={
            "avg_balance_6m": (320_000, 140_000),
            "min_monthly_balance_6m": (140_000, 80_000),
            "salary_consistency_months": (6.0, 0.3),
            "avg_monthly_income": (240_000, 90_000),
            "income_stability_cv": (0.08, 0.05),
            "dsr": (0.18, 0.09),
            "savings_rate": (0.28, 0.10),
            "cash_buffer_months": (4.2, 2.0),
            "bounce_count_6m": (0.02, 0.15),
            "overdraft_days_6m": (0.1, 0.6),
            "late_payment_count_6m": (0.05, 0.25),
            "employer_tier_score": (92, 8),
            "total_experience_years": (13, 5),
            "career_progression_slope": (0.42, 0.20),
            "salary_growth_rate": (0.11, 0.05),
            "education_level_score": (25, 4),
            "certification_score": (13, 5),
            "expected_to_past_salary_ratio": (1.12, 0.10),
            "countries_traveled_count": (9, 5),
            "premium_visa_count": (3, 2),
            "reference_tier_score": (82, 15),
            "institutional_tier_score": (80, 12),
            "residence_stability_years": (5.5, 3.0),
            "kyc_completeness_pct": (0.94, 0.10),
            "awards_score": (7, 6),
            "avg_employer_tenure_years": (4.2, 1.8),
            "job_changes_count": (2.4, 1.2),
            "income_stream_count": (2.3, 0.9),
            "emi_payment_punctuality": (0.99, 0.03),
            "discretionary_spend_ratio": (0.24, 0.10),
            "atm_withdrawal_ratio": (0.16, 0.09),
            "savings_months_count": (5.4, 0.9),
            "countries_worked_count": (1.5, 0.7),
            "insurance_premium_active": (0.8, 0.4),
            "credit_card_utilization_proxy": (0.14, 0.10),
            "requested_amount_to_income_ratio": (0.7, 0.4),
            "tenure_months": (36, 14),
            "statement_months_available": (6.0, 0.2),
        },
    ),
    Archetype(
        name="mid_salaried",
        weight=0.30,
        distributions={
            "avg_balance_6m": (95_000, 55_000),
            "min_monthly_balance_6m": (28_000, 22_000),
            "salary_consistency_months": (5.5, 0.9),
            "avg_monthly_income": (78_000, 28_000),
            "income_stability_cv": (0.14, 0.08),
            "dsr": (0.33, 0.13),
            "savings_rate": (0.15, 0.09),
            "cash_buffer_months": (1.6, 0.9),
            "bounce_count_6m": (0.3, 0.6),
            "overdraft_days_6m": (1.2, 2.5),
            "late_payment_count_6m": (0.5, 0.9),
            "employer_tier_score": (70, 15),
            "total_experience_years": (6.5, 3.2),
            "career_progression_slope": (0.22, 0.20),
            "salary_growth_rate": (0.07, 0.04),
            "education_level_score": (17, 4),
            "certification_score": (5, 4),
            "expected_to_past_salary_ratio": (1.25, 0.18),
            "countries_traveled_count": (3, 3),
            "premium_visa_count": (0.6, 1.0),
            "reference_tier_score": (52, 22),
            "institutional_tier_score": (58, 15),
            "residence_stability_years": (3.0, 2.2),
            "kyc_completeness_pct": (0.76, 0.18),
            "awards_score": (1.5, 2.5),
            "avg_employer_tenure_years": (2.6, 1.3),
            "job_changes_count": (2.8, 1.4),
            "income_stream_count": (1.4, 0.6),
            "emi_payment_punctuality": (0.93, 0.09),
            "discretionary_spend_ratio": (0.38, 0.14),
            "atm_withdrawal_ratio": (0.30, 0.13),
            "savings_months_count": (3.6, 1.4),
            "countries_worked_count": (1.1, 0.4),
            "insurance_premium_active": (0.45, 0.5),
            "credit_card_utilization_proxy": (0.30, 0.18),
            "requested_amount_to_income_ratio": (1.6, 0.9),
            "tenure_months": (36, 15),
            "statement_months_available": (6.0, 0.3),
        },
    ),
    Archetype(
        name="gig_thin_file",
        weight=0.22,
        distributions={
            "avg_balance_6m": (42_000, 30_000),
            "min_monthly_balance_6m": (7_000, 9_000),
            # The defining characteristic: income is real but not a salary.
            "salary_consistency_months": (0.5, 0.9),
            "avg_monthly_income": (52_000, 24_000),
            "income_stability_cv": (0.42, 0.18),
            "dsr": (0.20, 0.16),
            "savings_rate": (0.12, 0.12),
            "cash_buffer_months": (1.1, 0.8),
            "bounce_count_6m": (0.4, 0.8),
            "overdraft_days_6m": (2.5, 4.0),
            "late_payment_count_6m": (0.6, 1.0),
            "employer_tier_score": (38, 14),
            "total_experience_years": (3.4, 2.0),
            "career_progression_slope": (0.12, 0.25),
            "salary_growth_rate": (0.09, 0.10),
            "education_level_score": (15, 5),
            "certification_score": (4, 4),
            "expected_to_past_salary_ratio": (1.45, 0.30),
            "countries_traveled_count": (1.8, 2.0),
            "premium_visa_count": (0.2, 0.6),
            "reference_tier_score": (32, 22),
            "institutional_tier_score": (34, 16),
            "residence_stability_years": (1.6, 1.4),
            "kyc_completeness_pct": (0.58, 0.22),
            "awards_score": (0.6, 1.5),
            "avg_employer_tenure_years": (1.5, 1.0),
            "job_changes_count": (3.2, 1.8),
            "income_stream_count": (2.1, 1.0),
            "emi_payment_punctuality": (0.90, 0.13),
            "discretionary_spend_ratio": (0.34, 0.16),
            "atm_withdrawal_ratio": (0.40, 0.16),
            "savings_months_count": (2.8, 1.6),
            "countries_worked_count": (1.2, 0.5),
            "insurance_premium_active": (0.2, 0.4),
            "credit_card_utilization_proxy": (0.12, 0.16),
            "requested_amount_to_income_ratio": (1.9, 1.2),
            "tenure_months": (12, 6),
            "statement_months_available": (5.6, 0.9),
        },
    ),
    Archetype(
        name="remittance_household",
        weight=0.14,
        distributions={
            "avg_balance_6m": (70_000, 45_000),
            "min_monthly_balance_6m": (16_000, 15_000),
            "salary_consistency_months": (0.8, 1.2),
            "avg_monthly_income": (64_000, 26_000),
            "income_stability_cv": (0.26, 0.13),
            "dsr": (0.24, 0.14),
            "savings_rate": (0.22, 0.12),
            "cash_buffer_months": (1.9, 1.2),
            "bounce_count_6m": (0.2, 0.5),
            "overdraft_days_6m": (0.8, 2.0),
            "late_payment_count_6m": (0.3, 0.7),
            "employer_tier_score": (45, 18),
            "total_experience_years": (5.0, 3.5),
            "career_progression_slope": (0.15, 0.22),
            "salary_growth_rate": (0.06, 0.06),
            "education_level_score": (13, 5),
            "certification_score": (2.5, 3),
            "expected_to_past_salary_ratio": (1.30, 0.25),
            "countries_traveled_count": (2.5, 2.5),
            "premium_visa_count": (0.5, 0.9),
            "reference_tier_score": (40, 22),
            "institutional_tier_score": (40, 18),
            "residence_stability_years": (4.5, 3.0),
            "kyc_completeness_pct": (0.70, 0.20),
            "awards_score": (0.4, 1.2),
            "avg_employer_tenure_years": (2.8, 1.8),
            "job_changes_count": (2.2, 1.3),
            # Remittance plus something local: diversification is this segment's strength.
            "income_stream_count": (2.4, 0.9),
            "emi_payment_punctuality": (0.94, 0.09),
            "discretionary_spend_ratio": (0.30, 0.14),
            "atm_withdrawal_ratio": (0.44, 0.16),
            "savings_months_count": (4.0, 1.5),
            "countries_worked_count": (1.6, 0.9),
            "insurance_premium_active": (0.35, 0.48),
            "credit_card_utilization_proxy": (0.10, 0.13),
            "requested_amount_to_income_ratio": (1.5, 0.9),
            "tenure_months": (24, 12),
            "statement_months_available": (5.8, 0.6),
        },
    ),
    Archetype(
        name="overleveraged",
        weight=0.12,
        distributions={
            "avg_balance_6m": (18_000, 16_000),
            "min_monthly_balance_6m": (-6_000, 12_000),
            "salary_consistency_months": (5.0, 1.4),
            "avg_monthly_income": (72_000, 26_000),
            "income_stability_cv": (0.20, 0.12),
            # The defining characteristic.
            "dsr": (0.68, 0.18),
            "savings_rate": (-0.05, 0.10),
            "cash_buffer_months": (0.3, 0.3),
            "bounce_count_6m": (2.6, 1.6),
            "overdraft_days_6m": (16, 12),
            "late_payment_count_6m": (2.8, 1.7),
            "employer_tier_score": (58, 18),
            "total_experience_years": (5.5, 3.5),
            "career_progression_slope": (0.05, 0.22),
            "salary_growth_rate": (0.03, 0.05),
            "education_level_score": (15, 5),
            "certification_score": (3, 3.5),
            "expected_to_past_salary_ratio": (1.7, 0.45),
            "countries_traveled_count": (2, 2.2),
            "premium_visa_count": (0.3, 0.7),
            "reference_tier_score": (34, 24),
            "institutional_tier_score": (46, 18),
            "residence_stability_years": (2.0, 1.8),
            "kyc_completeness_pct": (0.68, 0.22),
            "awards_score": (0.5, 1.4),
            "avg_employer_tenure_years": (1.8, 1.1),
            "job_changes_count": (3.6, 1.9),
            "income_stream_count": (1.2, 0.5),
            "emi_payment_punctuality": (0.66, 0.18),
            "discretionary_spend_ratio": (0.52, 0.20),
            "atm_withdrawal_ratio": (0.42, 0.17),
            "savings_months_count": (1.2, 1.1),
            "countries_worked_count": (1.1, 0.4),
            "insurance_premium_active": (0.15, 0.36),
            "credit_card_utilization_proxy": (0.62, 0.28),
            "requested_amount_to_income_ratio": (2.6, 1.4),
            "tenure_months": (48, 14),
            "statement_months_available": (5.9, 0.4),
        },
    ),
)


#: Target share of the applicant population in each §5.1 band, best band first.
#:
#: Chosen so the resulting book satisfies the §9.1 key risk indicators rather than being an
#: arbitrary spread: 55% of applicants clear the §12.1 auto-approval threshold of 750, which
#: sits in the "green" 50–70% auto-approval range, and the implied default rate of the
#: auto-approved segment works out at roughly 1.8% — inside the §9.1 green NPA target of < 2%.
BAND_POPULATION_SHARES: tuple[float, ...] = (0.12, 0.43, 0.22, 0.14, 0.06, 0.03)


def _percentile_rank(values: np.ndarray) -> np.ndarray:
    """Maps values to their percentile position in [0, 1]."""
    order = values.argsort(kind="stable")
    ranks = np.empty(values.shape[0], dtype=np.float64)
    ranks[order] = np.arange(values.shape[0], dtype=np.float64)
    return ranks / max(1.0, float(values.shape[0] - 1))


def _latent_score(matrix: np.ndarray, manifest: FeatureManifest) -> np.ndarray:
    """A 0–1000 latent creditworthiness score for each row.

    Two stages, and the reason for each matters.

    **Stage 1 — direction comes from the manifest, magnitude from percentile rank.** Each
    constrained feature is converted to its percentile within the generated population, then
    flipped when the manifest says higher values mean higher risk, then averaged with the §4.1
    pillar weights. Percentile rather than min-max normalisation because the manifest's ``min``
    and ``max`` are guard rails, not distributions: ``avg_balance_6m`` is capped at NPR 100
    million so that a data error cannot overflow the model, but a realistic balance of NPR
    150,000 min-max normalises to 0.0015. Normalising that way pushes essentially every
    applicant to the bottom of the scale and manufactures a population where almost everyone
    defaults. Percentile rank is scale-free and immune to that.

    **Stage 2 — the composite is mapped onto a target band distribution.** An average of ~37
    percentiles concentrates tightly around 0.5 by the central limit theorem, so even a correct
    stage 1 yields a population where nearly everyone is Near Prime. Mapping the composite's
    rank onto ``BAND_POPULATION_SHARES`` produces the spread of a real applicant pool while
    preserving the ordering stage 1 established — which is all the model needs to learn from.

    Taking direction from the manifest keeps the generator honest: adding a feature or changing
    its monotonicity updates the label function automatically, so the synthetic population can
    never encode a relationship the served model is constrained against learning.
    """
    pillar_weights = {
        "FINANCIAL": 0.30,
        "PROFESSIONAL": 0.25,
        "SOCIAL": 0.20,
        "BEHAVIORAL": 0.25,
        # Application context describes the request, not the applicant's quality. It carries a
        # small weight so exposure relative to income still matters.
        "APPLICATION": 0.08,
    }

    pillar_totals: dict[str, np.ndarray] = {}
    pillar_counts: dict[str, int] = {}

    for index, feature in enumerate(manifest.features):
        if feature.monotone == 0:
            continue  # Unconstrained features carry no directional signal.

        percentile = _percentile_rank(matrix[:, index])
        # monotone == 1 means "higher is riskier", so goodness is the complement.
        goodness = 1.0 - percentile if feature.monotone == 1 else percentile

        pillar_totals[feature.pillar] = pillar_totals.get(feature.pillar, 0.0) + goodness
        pillar_counts[feature.pillar] = pillar_counts.get(feature.pillar, 0) + 1

    composite = np.zeros(matrix.shape[0], dtype=np.float64)
    weight_sum = 0.0
    for pillar, total in pillar_totals.items():
        count = pillar_counts[pillar]
        weight = pillar_weights.get(pillar, 0.0)
        if count == 0 or weight == 0.0:
            continue
        composite += weight * (total / count)
        weight_sum += weight

    if weight_sum > 0:
        composite /= weight_sum

    return _map_to_band_distribution(composite)


def _map_to_band_distribution(composite: np.ndarray) -> np.ndarray:
    """Maps composite quality onto 0–1000 so band membership matches the target shares."""
    # Percentile of quality; 1.0 is the strongest applicant.
    quality = _percentile_rank(composite)

    # Walk the bands from the best downwards, consuming their population share.
    band_bounds: list[tuple[float, float, float, float]] = []
    cumulative = 0.0
    for share, (floor, _, _) in zip(BAND_POPULATION_SHARES, RISK_BANDS, strict=True):
        ceiling = next(
            (other_floor - 1 for other_floor, _, _ in RISK_BANDS if other_floor > floor),
            1000,
        )
        # Applicants in the top `share` of what remains belong to this band.
        upper_quality = 1.0 - cumulative
        lower_quality = 1.0 - (cumulative + share)
        band_bounds.append((lower_quality, upper_quality, float(floor), float(ceiling)))
        cumulative += share

    # NaN-filled, not `empty_like`: uninitialised memory can be finite, which would make the
    # "did every row get a band" check below silently pass over an unassigned applicant.
    scores = np.full_like(quality, np.nan)
    for lower_quality, upper_quality, floor, ceiling in band_bounds:
        mask = (quality > lower_quality) & (quality <= upper_quality)
        if not mask.any():
            continue
        span = max(1e-9, upper_quality - lower_quality)
        # Position within the band, so scores are spread across it rather than stacked at a
        # boundary — the ML model needs a continuous target, not six discrete levels.
        position = (quality[mask] - lower_quality) / span
        scores[mask] = floor + position * (ceiling - floor)

    # The lowest band's lower bound is exclusive above, so the single weakest applicant can
    # fall through. Place them at the floor.
    unset = ~np.isfinite(scores)
    if unset.any():
        scores[unset] = 0.0

    return np.clip(scores, 0.0, 1000.0)


def _pd_from_score(scores: np.ndarray) -> np.ndarray:
    """Maps latent scores to the PD their §5.1 band implies, interpolating within the band."""
    probabilities = np.empty_like(scores, dtype=np.float64)

    for position, score in enumerate(scores):
        for floor, pd_min, pd_max in RISK_BANDS:
            if score >= floor:
                # Find the band ceiling to interpolate within.
                ceiling = next(
                    (other_floor - 1 for other_floor, _, _ in RISK_BANDS if other_floor > floor),
                    1000,
                )
                span = max(1.0, ceiling - floor)
                position_in_band = min(1.0, max(0.0, (score - floor) / span))
                # Higher within the band -> lower PD.
                probabilities[position] = pd_max - position_in_band * (pd_max - pd_min)
                break
        else:  # pragma: no cover - the table's last band starts at 0.
            probabilities[position] = RISK_BANDS[-1][2]

    return probabilities


def generate(
    rows: int = 24_000,
    seed: int = 20260501,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Generates a synthetic population.

    Returns ``(matrix, labels, true_pd)`` where ``matrix`` is in canonical manifest column
    order, ``labels`` are Bernoulli draws from the band-implied PD, and ``true_pd`` is that PD
    (retained so training can report how well the model recovered a known ground truth).
    """
    manifest = load_manifest()
    rng = np.random.default_rng(seed)

    weights = np.array([archetype.weight for archetype in ARCHETYPES], dtype=np.float64)
    weights /= weights.sum()
    assignment = rng.choice(len(ARCHETYPES), size=rows, p=weights)

    matrix = np.zeros((rows, len(manifest.features)), dtype=np.float64)

    for archetype_index, archetype in enumerate(ARCHETYPES):
        mask = assignment == archetype_index
        count = int(mask.sum())
        if count == 0:
            continue

        for column, feature in enumerate(manifest.features):
            mean, stddev = archetype.distributions.get(
                feature.name, (feature.default, abs(feature.default) * 0.25 + 0.1)
            )
            samples = rng.normal(mean, stddev, size=count)

            if feature.dtype == "int":
                samples = np.round(samples)
            samples = np.clip(samples, feature.minimum, feature.maximum)
            matrix[mask, column] = samples

    true_pd = _pd_from_score(_latent_score(matrix, manifest))

    # Bernoulli draw, so the model learns from noisy labels as it would from real outcomes.
    # Fitting on the exact probabilities would produce a model that looks far more accurate
    # than anything trained on real defaults ever will.
    labels = (rng.random(rows) < true_pd).astype(np.int8)

    return matrix, labels, true_pd
