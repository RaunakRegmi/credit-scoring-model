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

Staff-operated, and closed by default: every API route requires an authenticated session with a
sufficient role, and the dashboard renders a sign-in screen until one resolves. See
[`docs/04-bank-deployment-readiness.md`](docs/04-bank-deployment-readiness.md) §2.

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
printf 'FIELD_ENCRYPTION_KEY=%s\nFIELD_HASH_KEY=%s\nJWT_SECRET=%s\n' \
  "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" >> .env

# The first administrator. Provisioned with `mustChangePassword`, so this credential can only be
# used to set a real one — it cannot approve credit and cannot co-sign an override.
printf 'BOOTSTRAP_ADMIN_EMAIL=admin@fintara.com.np\nBOOTSTRAP_ADMIN_PASSWORD=%s\n' \
  "$(openssl rand -base64 18)" >> .env

docker compose up -d --build
docker compose exec api npx prisma migrate deploy
docker compose exec api node dist/prisma/seed.js
```

Sign in at <http://localhost:3000> as the bootstrap administrator, set a password, then create an
underwriter and a credit manager from the **Staff** page. Both are needed: SOP-004 dual
authorisation requires two people with credit authority, because a reviewer cannot co-sign their own
decision. There are deliberately no seeded underwriter logins — a co-signature is worthless if the
co-signer's password ships in the repository.

Dashboard on <http://localhost:3000>, API on <http://localhost:4000>, model on
<http://localhost:8000>.

### Sharing a demo link

```bash
brew install cloudflared      # once
./scripts/demo-tunnel.sh
```

Prints a public HTTPS URL for the dashboard. Ctrl-C closes it and restores the stack to localhost.

Two tunnels are opened, not one, because the dashboard calls the API from the browser — so the API
needs its own public origin. That creates a circular dependency the script exists to resolve: the
web bundle needs the API's public URL (Next inlines `NEXT_PUBLIC_API_URL` at **build** time and it
cannot be supplied at runtime), while the API needs the dashboard's public URL in `CORS_ORIGINS`.
Neither exists until its tunnel is up, so both tunnels start first and both containers are then
rebuilt against the harvested URLs. The script verifies the CORS preflight through the public origin
before printing the link, because that is the failure that otherwise shows up as a dashboard that
loads and cannot sign in.

The URL lives only as long as the script runs. **Synthetic data only** — this deployment has no WAF
and no ingress you control; see [`docs/04-bank-deployment-readiness.md`](docs/04-bank-deployment-readiness.md) §2.

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
  src/staff.ts                Roles, authority tables, the SOP-004 lenient-override predicate
apps/api/                   NestJS — extraction, features, scorecard, decisioning, persistence
  prisma/schema.prisma        20 tables (§7.1 + audit, governance, staff identity)
  policy/scoring-policy.json  Live credit policy — thresholds movable without a deploy
  src/auth/                   JWT + RBAC, global guard, staff provisioning
  src/underwriter/            SOP-004 review queue and its enforcement
apps/ml/                    FastAPI — XGBoost PD model + SHAP attribution
apps/web/                   Next.js — Credit Assessment Dashboard, review queue, staff admin
docs/                       Data dictionary, scoring methodology, 2026 model landscape,
                            bank deployment readiness
```

### Document formats

| Format | Resume / CV | Bank statement |
|---|---|---|
| **PDF** (text layer) | Yes — single-column, two-column sidebar, and banner-plus-columns layouts all score identically to plain text | Yes — tabular PDF |
| **DOCX** | Yes | Yes |
| **CSV / TSV** | — | Yes, header-row driven |
| **TXT** | Yes | Yes |
| **PDF** (image-only scan) | Needs OCR: set `LLAMA_CLOUD_API_KEY` to route through LlamaParse. Without it, extraction fails loudly — three degradation flags and a referral, never a score derived from nothing | same |

PDF is the format that requires real work, because a PDF has no lines — only positioned glyph runs.
Two things follow from that, and both changed a score before they were fixed:

- **Columns.** Content-stream order in a two-column CV interleaves the sidebar into the work
  history, and the resume parser reads a line's meaning from the heading above it. Cost: 28
  composite points on the fixture CV, 25 of them Professional.
- **Wrapping.** A PDF stores a hard break wherever the text wrapped, so a work-history entry whose
  date range breaks across the wrap stops being recognisable as a role. Cost: a further 16 points,
  and this one affects *every* PDF, not only multi-column ones.

`apps/api/src/extraction/pdf-layout.ts` rebuilds the reading order from glyph geometry: runs are
assigned to vertical bands, each band's lines are grouped independently, and lines the measure
wrapped are rejoined. Because no geometric test can distinguish two-column prose from a two-column
`Label: value` table, the reflow is offered as a *candidate* rather than imposed — the resume path
parses both readings and keeps whichever recovers more structure, which turns an unanswerable
question into a measured one.

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
npm test                                  # 305 tests — contracts + API
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
- **Closed by default** — an undecorated route with no credential is refused; a forged `alg:none`
  token and every malformed bearer scheme are refused.
- **SOP-004 dual authorisation** — a lenient override with no co-signer, a self-co-signature, a
  co-signer without credit authority, and a limit above the §1.2 product ceiling are each refused,
  and nothing is written when they are. A *harsher* decision than the engine's needs no co-signature.
- **Separation of duties** — administration and credit authority are disjoint, asserted against the
  authority tables themselves.
- **No credential in an audit record** — the co-signer's identity is stored, their password is not.
- **Document layout does not change a score** — a CV as plain text, as a single-column PDF, as a
  two-column PDF and as a banner-plus-columns PDF all score identically, and so does a bank
  statement as CSV or as a tabular PDF.

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
| SSO/OIDC against a bank identity provider | Password auth is implemented; `StaffUser` is shaped so SSO adds a subject column rather than replacing the access model. |
| SLA escalation for referrals nearing 48h | The queue surfaces wait time and breach count; nothing *notifies* anyone. Needs a mail/alerting channel. |

---

## Documentation

**Start here if you want the whole picture:**
[`PROJECT-OVERVIEW.md`](PROJECT-OVERVIEW.md) — what this is, how the scoring works, what is proven,
what is deliberately not built, and what to do next. Written for a non-engineering reader.

Then, for detail:

- [`docs/01-data-dictionary.md`](docs/01-data-dictionary.md) — schema and feature manifest, with the
  reasoning behind each decision
- [`docs/02-scoring-methodology.md`](docs/02-scoring-methodology.md) — every scoring rule mapped to
  its clause, and every documented ambiguity and how it was resolved
- [`docs/03-ai-model-landscape-2026.md`](docs/03-ai-model-landscape-2026.md) — what the leading
  lenders actually use, with sources
- [`docs/04-bank-deployment-readiness.md`](docs/04-bank-deployment-readiness.md) — what changes
  between a pilot and a real bank deployment: the underwriter review queue, security hardening,
  NRB compliance posture, HA/DR
- [`docs/05-running-and-credentials.md`](docs/05-running-and-credentials.md) — how to start the
  stack, the local demo logins and what each role can do, and a scene-by-scene demo script

---

**CONFIDENTIAL** — Fintara Solutions Pvt Ltd. Contains no real applicant data; all fixtures are
synthetic.
