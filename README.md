# ONE BNPL — AI Credit Scoring Model (AICS)

Automated credit decisioning for unsecured lending in Nepal — BNPL, Personal Loan, Hire Purchase
and Auto Loan. An applicant uploads a CV and six months of bank statements; the system returns an
explainable, auditable credit decision in well under a second.

Implements the AICS Technical & Functional Document (`Credit Scoring Docs.md`) and the technical
brief (`Tech Stack.md`).

---

## What it does

```
upload ─► extract ─► classify ─► aggregate ─► features ─► scorecard ─┐
                                                    │               ├─► decision ─► persist
                                                    └─► ML (shadow) ─┘   (one transaction)
```

Four-pillar scorecard on a 0–1,000 scale (§4):

| Pillar | Max | Source |
|---|---|---|
| Financial | 300 | Bank statements |
| Professional | 250 | Resume / CV |
| Social | 200 | Resume + KYC |
| Behavioral | 250 | Bank statements + Resume |

The composite maps to a §5.1 risk band, which sets the decision, the credit limit, the interest
rate and the Basel provisioning rate.

### Three properties the design holds onto

1. **The scorecard decides; the ML model shadows.** There is no labelled repayment history yet, so
   the deterministic scorecard is authoritative and fully reproducible by hand. XGBoost runs
   alongside it on every application, is recorded and compared, and does not drive the outcome until
   validated on ≥500 real outcomes (§6.4). Where the two disagree sharply, a human looks.
2. **A degraded assessment never approves.** Unreadable documents, thin statement history,
   unverifiable income, an unreachable model — each withholds automated approval regardless of
   score, and each says precisely why.
3. **Every decision is reconstructable.** The complete feature vector, all version identifiers and
   the full SHAP payload are written in the same transaction as the score (§10.4; EU AI Act,
   August 2026).

---

## Quick start

### Docker (everything)

```bash
cp .env.example .env
# Generate real keys — the placeholders are rejected at boot, deliberately.
printf 'FIELD_ENCRYPTION_KEY=%s\nFIELD_HASH_KEY=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" >> .env

docker compose up -d --build
docker compose exec api npx prisma migrate deploy
docker compose exec api node dist/prisma/seed.js
```

Dashboard on <http://localhost:3000>, API on <http://localhost:4000>, model on
<http://localhost:8000>.

### Local development

Requires Node 22+, Python 3.12/3.13, PostgreSQL 16.

```bash
npm install
npm run build -w @aics/contracts        # must precede the apps — they compile against its output

# Database
createdb aics
cd apps/api && npx prisma migrate deploy && npx prisma generate && cd ../..

# Scoring service
cd apps/ml
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m train.train                       # trains the seed model
.venv/bin/uvicorn app.main:app --port 8000 &
cd ../..

# API and dashboard
npm run db:seed -w @aics/api            # scores three reference applicants end to end
npm run dev:api                          # :4000
npm run dev:web                          # :3000
```

> Python 3.12 is preferred. On 3.13, `shap` pulls `numba`, which caps `numpy < 2.5` — hence the
> numpy pin in `apps/ml/requirements.txt`. The Docker image pins 3.12 to avoid the question.

---

## Layout

```
packages/contracts/         Single source of truth
  feature-set.v1.json         ← THE feature manifest: 38 features, ordered, with monotonicity
  src/                        Domain enums, §5.1/§5.2/§9.3 tables, wire schemas, policy types
apps/api/                   NestJS — extraction, features, scorecard, decisioning, persistence
  prisma/schema.prisma        18 tables (§7.1 + audit and governance)
  policy/scoring-policy.json  Live credit policy — thresholds movable without a deploy
apps/ml/                    FastAPI — XGBoost PD model + SHAP attribution
apps/web/                   Next.js — Credit Assessment Dashboard
docs/                       Data dictionary, scoring methodology, 2026 model landscape
```

### The feature manifest is the spine

Features are computed in TypeScript and consumed in Python — two languages, two chances to disagree
about what column 12 means. That disagreement raises no error and silently degrades every
prediction, which makes it the worst failure mode an ML system has.

`packages/contracts/feature-set.v1.json` is one ordered array read by three consumers: the
TypeScript codegen, the Python service, and the training job. Column order at fit time is *provably*
column order at predict time. The version travels on every request and a mismatch returns **409**.

---

## Verification

```bash
npm test                                  # 231 tests — contracts + API
cd apps/ml && .venv/bin/python -m pytest  # 46 tests — manifest, model, API
```

What the suites actually pin down:

- **Every §4.2–4.5 point table**, asserted against the document (NPR 200k balance = 80 pts; 4
  bounces cap the Financial pillar at 180; DSR 45% = 20 pts).
- **Monotonicity**, empirically — raising `dsr` alone can never lower predicted PD. The training job
  refuses to write an artifact that violates its constraints.
- **Anti-skew** — the checked-in generated TypeScript and the JSON manifest must agree on column
  order.
- **Division by zero** — no feature is ever non-finite, for any input.
- **Overrides cannot be outscored** — a perfect 1,000 with a sanctions match is still declined.
- **Degradation never approves** — for every degradation cause.
- **Fair lending** — the nationality rule contributes zero and is still recorded.

### End-to-end, verified

Three reference applicants, scored through the real pipeline (parsing, classification, aggregation,
scoring, persistence — no pre-computed values):

| Fixture | Score | Band | Decision |
|---|---|---|---|
| Prime salaried professional | 778 | PRIME | AUTO_APPROVE — NPR 25,00,000 @ 1.00%/mo |
| Thin-file gig worker | 494 | SUBPRIME | APPROVE_WITH_CONDITIONS — NPR 75,000 @ 1.80%/mo |
| Over-leveraged, adverse events | 296 | REJECT | DECLINE |

Latency 78–120 ms against the §6.2 budget of 4,000 ms.

**Chaos check.** Stop the model container and re-score the Prime applicant: identical score,
decision becomes `REFER_UNDERWRITER` with `ML_SERVICE_UNAVAILABLE` — and it still returns a full
5-positive/3-negative explanation, derived from the scorecard's sub-scores rather than SHAP.

---

## Two things worth knowing before you read the code

### The nationality rule ships disabled

SOP-002 step 25 specifies a nationality-based score penalty. §10.2 of the same document commits the
model to demographic neutrality. Those cannot both be true.

It is implemented as external configuration, ships `enabled: false`, is gated on written Legal
sign-off, and is **evaluated and recorded on every application anyway** — a `SKIPPED_DISABLED` row
is the evidence Compliance needs that national origin was not priced. Country risk is handled
through AML/CFT sanctions screening (§10.3), which is a defensible per-applicant control.

Recommendation: withdraw the clause from the SOP rather than leave it dormant.

### The launch model has never seen a real default

It is trained on a synthetic population calibrated to the §5.1 PD bands, tagged `SYNTHETIC_SEED`,
and that tag is surfaced through the API into the dashboard. It reports **AUC 0.772 against a Bayes
ceiling of 0.814** — about 95% of the signal available in its own data. §9.1's 0.85 green threshold
belongs to a model trained on real outcomes and is not met, deliberately.

The highest-value next task is capturing repayment outcomes. Everything else in the ML roadmap
depends on it.

---

## Not built (named, not silently dropped)

| Component | Status |
|---|---|
| LSTM sequence model, GNN social graph (§6.1) | Interface slots exist; deferred until there is labelled outcome data and a populated entity graph. See `docs/03-ai-model-landscape-2026.md`. |
| KYC face match / liveness, AML watchlist, NID verification API | Ports with stub adapters — third-party integrations requiring contracts Fintara holds. |
| Core-banking disbursement (SOP-005) | Out of scope. |
| PSI drift detection (§6.4) | Requires a production score distribution to compare against. |
| Authentication / RBAC | The dashboard is unauthenticated. **Must not be exposed publicly as-is.** |

---

## Documentation

- [`docs/01-data-dictionary.md`](docs/01-data-dictionary.md) — schema and feature manifest, with the
  reasoning behind each decision
- [`docs/02-scoring-methodology.md`](docs/02-scoring-methodology.md) — every scoring rule mapped to
  its clause, and every documented ambiguity and how it was resolved
- [`docs/03-ai-model-landscape-2026.md`](docs/03-ai-model-landscape-2026.md) — what the leading
  lenders actually use, with sources

---

**CONFIDENTIAL** — Fintara Solutions Pvt Ltd. Contains no real applicant data; all fixtures are
synthetic.
