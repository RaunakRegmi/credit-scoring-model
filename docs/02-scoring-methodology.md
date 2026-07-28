# Scoring Methodology — As Implemented

Maps every scoring rule in the implementation back to its clause in the AICS Technical &
Functional Document, and records every place the implementation departs from the document, with
the reason.

Read this alongside `apps/api/src/scoring/scorecard.service.ts`, which is written to be readable
in the same order.

---

## 1. Score scale: 0–1,000

`Tech Stack.md` specified a 300–900 range. The governing business document builds everything on
0–1,000 — the four pillar maxima (300 + 250 + 200 + 250), the §5.1 risk bands, the §5.2 rate card
and the §9.3 provisioning table are all internally consistent on that scale.

**Resolution: 0–1,000.** The 300–900 range was a generic FICO-style placeholder; adopting it would
have required re-deriving every threshold in the business document.

Enforced by a test: the pillar maxima must sum to `COMPOSITE_MAX_SCORE`.

---

## 2. Pillar weighting

§4.1 lists both maximum points and percentage weights. These express the same thing: 300/1,000 *is*
30%. The implementation applies the weighting through the pillar maxima and does not multiply by
the percentages as well — doing both would apply the weighting twice.

| Pillar | Max points | Equivalent weight | Primary source |
|---|---|---|---|
| Financial | 300 | 30% | Bank statements |
| Professional | 250 | 25% | Resume / CV |
| Social | 200 | 20% | Resume + KYC |
| Behavioral | 250 | 25% | Bank statements + Resume |

---

## 3. Documented ambiguities and how they were resolved

The source document has four places where the stated rules cannot all hold simultaneously. Each is
resolved in code with the reasoning stated at the point of use, and listed here for review.

### 3.1 Total years of experience (§4.3, 50 points)

> "Linear 0-20 yrs; bonus +5pts for 25+ yrs" — against a stated maximum of 50.

A linear scale that already reaches 50 at 20 years leaves no room for a +5 bonus.

**Resolved as:** linear to 45 points across 0–20 years, with the +5 long-career bonus taking a
25-year veteran to the full 50. Both stated rules are preserved and the maximum is respected.

### 3.2 International travel history (§4.4, 40 points)

> "5pts per 3 countries visited; visa type premium (Schengen/US/UK = 2x)" — top score at 15+
> countries.

15 countries at 5 points per 3 yields 25 points, not 40.

**Resolved as:** the document's own 2× premium is applied as an *effective country count*, so a
high-scrutiny visa counts twice. The stated per-country rate is preserved, and a well-travelled
applicant with premium visas reaches the 40-point maximum.

### 3.3 Income diversification (§4.5, 50 points)

> "3+ independent income streams" earns the maximum.

A purely linear scale from zero would score a salaried applicant with one well-evidenced salary at
16 of 50 on a *stability* measure.

**Resolved as:** stepped — 1 stream = 20, 2 = 35, 3+ = 50. A single verified income is the normal
case for a salaried applicant and is treated as the baseline, not a deficiency.

### 3.4 Repayment track record (§4.5, 50 points)

Derived from statement behaviour. An applicant with no observable credit obligations has no track
record in either direction.

**Resolved as:** the neutral midpoint (25 of 50), with the reason surfaced in the sub-score detail
as "thin file". Awarding full marks would credit a discipline never demonstrated; awarding zero
would penalise the absence of adverse evidence — and would work directly against the financial
inclusion objective in §1.1.

A consequence worth knowing: **a maximal applicant with no credit history scores 975, not 1,000.**
The last 25 points require having serviced real obligations on time. This is asserted in the test
suite so it cannot be changed silently.

---

## 4. Fair lending — the nationality adjustment

**SOP-002 step 25 specifies a nationality-based score penalty** (Myanmar −45, other SAARC −15,
OECD 0).

**This directly contradicts §10.2 of the same document**, which commits the model to demographic
neutrality and commits the business to quarterly disparate-impact testing. A blanket penalty on
national origin is national-origin discrimination in lending.

### How it is implemented

- Externalised to `apps/api/policy/scoring-policy.json`, not hardcoded.
- Ships `"enabled": false`.
- Gated on `requiresLegalSignOff: true` with `legalSignOffReference: null`.
- **Evaluated on every application regardless**, and written to `PolicyRuleEvaluation` with
  outcome `SKIPPED_DISABLED` and `pointsApplied: 0`. That row is the positive evidence Compliance
  needs to demonstrate the engine did not price national origin — silence would prove nothing.
- Logged at boot. If it is ever enabled, the startup log carries a warning naming the fair-lending
  exposure and the sign-off reference.

### Defensible country risk

Country risk *is* legitimately handled — through AML/CFT sanctions and watchlist screening under
§10.3, applied per applicant against a specific list, rather than as a blanket penalty on
nationality. That control is implemented and fires as an override.

### Recommendation

Withdraw step 25 from the SOP rather than leaving it dormant in configuration. A disabled
discriminatory rule is still a discriminatory rule in the policy file, and its presence is
something an auditor will ask about.

### Structural guarantees

- `nationality` exists on `Applicant` **solely** for sanctions screening and the disabled rule. It
  is absent from the feature manifest.
- `gender` and `dateOfBirth` are stored **solely** for the §10.2 quarterly disparate-impact test.
  Both are absent from the feature manifest.
- The manifest codegen **fails the build** if a feature name contains a token resembling a
  protected characteristic. Tests assert the same on both the TypeScript and Python sides.

---

## 5. Overrides beat scores, and only ever tighten

§5.3: *"Regardless of composite score, the following conditions trigger a mandatory Decline or
Hold."*

The decision is assembled as:

```
final = strictest( band decision, every triggered override, degradation downgrade )
```

`strictestDecision` can only move an outcome in the conservative direction. Nothing in the decision
engine can produce an outcome more generous than the §5.1 band table allows — the ceiling is
structural, not a matter of getting every branch right. That property is what makes the §12.1 board
delegation of auto-approval authority safe to grant.

### Missing evidence is not an adverse finding

Three §5.3 conditions distinguish "we checked and it failed" from "we have not checked":

| Condition | Failed | Not attempted |
|---|---|---|
| KYC face match | Below 90% → refer | No selfie submitted → **not a failure**; priced by the §4.4 completeness sub-score |
| NID verification | `FAILED` → decline | `NOT_ATTEMPTED` → **not a failure**; degraded flag, held for review |
| Debt service ratio | Above 60% → refer | Income unverifiable → **not a breach**; `INSUFFICIENT_INCOME_DATA` degraded flag |

This was a real bug during development. `nidVerified` was originally a boolean, and because a newly
created applicant defaults to `false`, **every application was declined** before the KYC pipeline
could run — a §5.3 decline issued on a finding that had never been made. It is now a tri-state
`KycVerificationStatus`, and the migration deliberately maps a legacy `false` to `NOT_ATTEMPTED`
rather than `FAILED`, because the old column could not distinguish the two.

---

## 6. Degradation never approves

Any of these makes the assessment less than fully reliable, and **withholds automated approval
regardless of score**:

| Flag | Cause |
|---|---|
| `INSUFFICIENT_INCOME_DATA` | Income could not be verified; DSR undefined |
| `INSUFFICIENT_STATEMENT_HISTORY` | Fewer than 6 months (§3.2) |
| `KYC_NOT_VERIFIED` | Identity verification has not run |
| `LOW_EXTRACTION_CONFIDENCE` | Below the policy floor of 0.85 (SOP-002 step 20) |
| `RESUME_EXTRACTION_EMPTY` / `STATEMENT_EXTRACTION_EMPTY` | Document yielded no usable text |
| `ML_SERVICE_UNAVAILABLE` / `ML_SERVICE_TIMEOUT` | Model unreachable or too slow |
| `ML_FEATURE_VERSION_MISMATCH` | Model serves a different feature contract |
| `SCORECARD_ML_DIVERGENCE` | The two artefacts disagree beyond threshold |
| `NO_EMPLOYMENT_HISTORY` / `NO_BANK_ACCOUNT` | Required evidence absent |

**Verified end to end:** with the model running, the Prime fixture auto-approves at 778. Stop the
model container and the same applicant scores identically but returns `REFER_UNDERWRITER` with
`ML_SERVICE_UNAVAILABLE` — *and still receives a complete 5-positive/3-negative explanation*,
derived from the scorecard's sub-scores rather than from SHAP.

---

## 7. No ratio is computed with bare division

Every financial ratio passes through `safeRatio`, which returns `null` rather than `Infinity` or
`NaN`. A `null` raises a degraded flag and leaves the manifest default in the feature vector.

**Missing data is never converted into a bad score.** Substituting a worst-case value would
silently turn "unknown" into "bad" — unfair to the applicant, and unexplainable to a regulator who
asks why a specific number was used.

The feature vector schema rejects non-finite values outright on both sides of the wire. If one ever
reaches the boundary it is a computation bug upstream, and failing loudly is correct.

---

## 8. Model governance as built

| §6.4 requirement | Status |
|---|---|
| AUC-ROC, Gini, KS monitoring | Computed at training, stored in `ModelVersion.metrics`, served at `/model/info` |
| Champion/challenger | `ModelVersion` registry with `isChampion`; a second algorithm is a Phase-2 task |
| PSI drift detection | **Not implemented** — requires a production score distribution to compare against |
| Quarterly retraining | Training pipeline is reproducible and seeded; scheduling is an ops task |
| Version-controlled lineage | Every `CreditScore` carries `scorecardVersion`, `featureSetVersion`, `mlModelVersion`, `mlProvenance` |

### Train/serve skew

The failure mode that silently destroys ML systems: features computed in TypeScript, consumed in
Python, two chances to disagree about what column 12 means. It raises no error and degrades every
prediction.

Mitigated structurally. `packages/contracts/feature-set.v1.json` is one ordered array read by three
consumers — the TypeScript codegen, the Python service, and the training job. Column order at fit
time is provably column order at predict time. The version travels on every request and a mismatch
returns **409**, never a silently misaligned score.

A test asserts the checked-in generated TypeScript and the JSON manifest agree on order, so drift
between them fails the build rather than production.
