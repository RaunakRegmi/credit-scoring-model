# Data Dictionary

Covers the PostgreSQL schema (§7.1 and the audit tables it does not enumerate) and the canonical
feature manifest.

Authoritative sources: `apps/api/prisma/schema.prisma` and
`packages/contracts/feature-set.v1.json`. This document explains the decisions behind them.

---

## 1. Conventions

| Convention | Reason |
|---|---|
| UUID primary keys | §7.1. No enumerable identifiers in URLs or logs. |
| Money as `Decimal(18,2)` in NPR | Never `Float`. Binary floating point and currency do not mix, and rounding drift in a loan ledger is a defect, not an approximation. |
| Ratios and scores as `Decimal` with explicit precision | Same reason. A DSR that reads `0.30000000000000004` is a reporting bug waiting to happen. |
| Cascade delete from `LoanApplication` / `Applicant` | Makes the §10.1 retention purge one delete instead of a bespoke script that will drift out of date. |
| PII columns suffixed `Enc` | Written only through `PiiCodec`. Suffix makes an unencrypted write visible in review. |
| Dates built in UTC | Nepal is UTC+5:45. A local-time `Date` reassigns a 1st-of-month transaction to the previous month and corrupts every monthly aggregate. |

---

## 2. Core tables

### `applicant_profile` — master identity

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `fullName`, `fatherName` | varchar | §3.1 personal identity |
| `nidEnc` | text | AES-256-GCM ciphertext. Randomised — never appears in a `WHERE`. |
| `nidHash` | char(64) **unique** | HMAC-SHA256, normalised. Carries all equality lookups and duplicate detection. |
| `passportEnc`, `panEnc` | text | Optional, encrypted |
| `email`, `phone` | varchar, indexed | |
| `nationality` | char(2) | **Sanctions screening and the disabled policy rule only.** Absent from the feature manifest. |
| `dateOfBirth`, `gender` | date, varchar | **§10.2 disparate-impact testing only.** Absent from the feature manifest. |
| `residenceStatus` | enum | §4.4 — owner-occupied weighted above rented |
| `kycFaceMatchScore` | Decimal(5,4) nullable | `null` = no selfie submitted, which is *not* a failed match |
| `nidVerificationStatus` | enum | Tri-state: `NOT_ATTEMPTED` / `VERIFIED` / `FAILED` |
| `amlWatchlistHit`, `isPep` | boolean | §10.3 |

**Why the encryption is split two ways.** AES-GCM is randomised, so the same national ID encrypts
differently every time — which is the point, but it also means the column cannot appear in a
`WHERE`, an `ORDER BY`, a unique constraint or a raw query. The `nidHash` column exists so lookups
never need the ciphertext. Decryption is transparent (lazy computed fields on the Prisma client);
encryption is explicit (`PiiCodec`), so "where does the national ID get written" is answerable with
grep.

The hash key is **separate** from the encryption key. The lookup key is used in far more places,
and compromising it must not also decrypt the data.

**Why the hash normalises.** `12-345-678` and `12345678` collapse to the same digest. Without that,
a returning applicant who types their citizenship number differently becomes a second applicant and
duplicate detection silently fails.

### `loan_application`

| Column | Notes |
|---|---|
| `arn` | unique, `ONE-YYYYMMDD-XXXXXX`. SOP-001 step 11. Sortable, and readable over the phone. |
| `productType`, `requestedAmountNpr`, `tenureMonths` | §1.2 |
| `consentDataProcessing`, `consentCreditBureauPull`, `consentAutomatedAssessment` | Three separate booleans plus `consentedAt`. SOP-001 step 5 lists them individually; under the Individual Privacy Act 2075 one bundled tick is not meaningful consent to three distinct processing activities. |
| `activeLoanCount`, `hasActiveBankruptcy`, `documentFraudFlag` | §5.3 inputs from systems outside the uploaded documents |

### `document`

Content-addressed storage: the key is `<applicationId>/<sha256>.bin`, so no part of the path derives
from a user-supplied filename. `purgeAfter` is set to decision + 90 days (§10.1) at decision time —
retention that depends on someone remembering to run a script is not a retention policy.

### Resume tables

`resume_profile` (1:1 with application) plus `employment_history`, `professional_reference`,
`certification` and `award` (1:N).

`employment_history.seniorityRank` (1–10) is the regressand for the §4.3 career progression
regression. `professional_reference.contactEnc` is encrypted — a referee's phone number is
third-party personal data.

### Bank statement tables

`bank_account` → `transaction` → `monthly_financial_summary`, with `bank_statement` as the upload
aggregate.

`transaction` is the high-volume table (thousands per applicant): indexed on `(accountId, txnDate)`
and `(accountId, aiCategory)`, with `recurringGroupId` linking a detected recurring series.

Debit and credit are **two columns** rather than one signed amount, so the aggregate SQL reads the
way the statement does.

`monthly_financial_summary` exists so the scorecard never scans raw transactions. The definitions
in `monthly-aggregation.ts` — what counts as income, what counts as an obligation, how average daily
balance is computed — *are* the definitions the score is built on.

> **On TimescaleDB.** §7.1 mentions it. Prisma cannot manage hypertables, so native range
> partitioning on `txnDate` via a raw SQL migration is the pragmatic equivalent. At the stated
> volumes the composite index is sufficient; partitioning becomes worthwhile at portfolio scale.

### `financial_analytics` — the feature store

Holds the complete feature vector as JSONB plus `featureSetVersion`.

Hot columns (`avgBalance6mNpr`, `debtServiceRatio`, `savingsRate`, …) are duplicated out of the
JSONB deliberately: the §9.1 KRI dashboard and the §10.2 disparate-impact query filter on these, and
JSONB path predicates do not use a btree index the way plain columns do.

`debtServiceRatio` is **nullable**. `null` means income could not be verified — never `Infinity`.

### `credit_score_output`

Four pillar scores, composite, band, decision, PD, LGD, expected loss, provisioning, the priced
offer, `shapJson`, `pillarBreakdownJson`, ordered `reasons`, triggered `overrideCodes`,
`degradedFlags`, and full model lineage (`scorecardVersion`, `featureSetVersion`, `mlModelVersion`,
`mlProvenance`, `mlPDefaultShadow`, `modelDivergence`).

`pillarBreakdownJson` stores every sub-score with its explanation, so a decision can be re-explained
years later without re-running the scorecard — which by then may score differently.

---

## 3. Audit and governance tables

Not in §7.1, but required by §10.4 and §6.4.

### `decision_audit` — append-only

`inputSnapshot` holds the **complete feature vector** plus every version identifier as they were at
decision time; `outputSnapshot` holds the scores, decision, offer, overrides and SHAP payload.

This is what satisfies "reconstructable after the fact" — §10.4, and the EU AI Act from August 2026.
Logging a score does not satisfy it. Values are normalised to plain JSON scalars (`toJson`), because
these records must be readable by something that is not this codebase.

Written **in the same transaction** as the `CreditScore`. A score without its audit row is a
compliance defect, not a partial success.

### `policy_rule_evaluation`

Every policy and override rule the engine considered, **including those that did not fire**. A
`SKIPPED_DISABLED` row for the nationality adjustment is the positive evidence that the rule was
evaluated and deliberately not applied.

### `underwriter_review`

SOP-004. `justification` is mandatory; `dualAuthById` captures the second authoriser required to
approve above the AI recommendation.

### `model_version`

A lightweight MLflow stand-in: name, version, kind, `provenance`, `featureSetVersion`, metrics
JSONB (AUC/Gini/KS/Brier), `isChampion`, `trainedAt`, `artifactPath`.

---

## 4. Feature manifest — 38 features

`packages/contracts/feature-set.v1.json`. One ordered array; **the order is the model's column
order**. Append only, never reorder.

Each entry declares: name, label, dtype, unit, min, max, default, `monotone`, pillar, `reasonCode`
and `adverseAction`.

### Monotonicity

`monotone` constrains P(default): `+1` = increasing this must never *decrease* risk; `-1` = must
never *increase* it; `0` = unconstrained. **37 of 38 are constrained** (only `tenure_months` is
free — a longer tenure cuts both ways).

Passed straight to XGBoost, and empirically verified during training. This is what makes a
gradient-boosted credit model defensible: raising the debt service ratio can never be shown to have
lowered assessed risk.

### Feature summary

| Pillar | Count | Examples |
|---|---|---|
| `FINANCIAL` | 11 | `avg_balance_6m`, `salary_consistency_months`, `dsr`, `savings_rate`, `bounce_count_6m`, `late_payment_count_6m` |
| `PROFESSIONAL` | 7 | `employer_tier_score`, `total_experience_years`, `career_progression_slope`, `salary_growth_rate`, `education_level_score` |
| `SOCIAL` | 7 | `countries_traveled_count`, `premium_visa_count`, `reference_tier_score`, `residence_stability_years`, `kyc_completeness_pct` |
| `BEHAVIORAL` | 10 | `avg_employer_tenure_years`, `income_stream_count`, `emi_payment_punctuality`, `discretionary_spend_ratio`, `atm_withdrawal_ratio` |
| `APPLICATION` | 3 | `requested_amount_to_income_ratio`, `tenure_months`, `statement_months_available` |

`APPLICATION` features describe the *request*, not the applicant.

### Fair lending is structural

No feature encodes gender, age, date of birth, nationality, ethnicity, caste, religion, marital
status or disability. This is enforced three ways:

1. The codegen **fails the build** if a feature name contains a token resembling a protected
   characteristic.
2. A TypeScript test asserts it over the generated manifest.
3. A Python test asserts the same over the JSON.

### `adverseAction` is a required field

Every feature carries a plain-language sentence, because SOP-003 requires the top 3 adverse factors
to be communicated to a declined applicant. A notice reading `dsr` is unusable for that purpose, so
the wording is part of the contract and is tested for — including that it contains no underscores.

### Values are clamped, not rejected

Out-of-range values clamp to the declared bounds; integer-typed features round. An unusually large
balance is real data, and refusing to score someone because a value sat outside a modelling range
would be the wrong failure.

**Non-finite values are rejected outright** on both sides of the wire. `Infinity` almost always
means an upstream division by zero, and scoring it would rank the applicant as the worst possible
case by accident.
