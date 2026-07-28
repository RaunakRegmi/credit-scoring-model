# From Pilot to Bank-Deployed — Readiness Checklist

**Prepared for:** Fintara Solutions Pvt Ltd — Board & Senior Management
**Purpose:** `PROJECT-OVERVIEW.md` §15 lists what blocks a *pilot*. This document is the next step:
what changes when the applicant is a bank's real customer and real money moves — access control,
security posture, regulation, and availability.

Everything below is checked against the current codebase, not against the spec documents. Where a
gap is asserted, the file that proves it is named; where one has since been closed, the section is
marked **BUILT** and kept rather than deleted, so the record of what was missing survives alongside
the fix.

**Where it stands.** The two engineering blockers — no authentication, and a referral queue that
existed only as a database table — are closed (§1, §2). What remains is a compliance decision (§3),
an environment and vendor exercise (§2 remainder, §4), and a core-banking integration (§5).

---

## 1. The underwriter review queue — **BUILT**

*Status: implemented. This section is retained as the record of what was missing and what closed
it.*

`REFER_UNDERWRITER` was a real decision path with nothing behind it: `decision.service.ts` returned
it and `decision-banner.tsx` told the applicant *"Referred to a human underwriter — decision within
2 business days (SOP-004)"*, but `UnderwriterReview` existed only as a table. No endpoint, no
service, no UI — the two-business-day promise had nothing that could fulfil it.

**What now exists**

| Piece | Where |
|---|---|
| `GET /api/underwriter/queue` — referrals oldest-first, paginated, with wait time and SLA state | `apps/api/src/underwriter/underwriter.controller.ts` |
| `GET /api/underwriter/applications/:id` — the full assessment plus review history | same |
| `POST /api/underwriter/applications/:id/review` — records the decision | same |
| SOP-004 enforcement | `apps/api/src/underwriter/underwriter.service.ts` |
| Queue and review UI | `apps/web/src/app/queue/`, `apps/web/src/components/review-form.tsx` |

**The controls, and where each is enforced.** All of them in the service, never only in the form —
a rule enforced in a UI holds until someone calls the API directly:

- **Written justification.** 40-character floor in the shared zod schema; substance re-checked
  server-side after trimming, because a schema cannot tell forty characters of reasoning from forty
  spaces.
- **Dual authorisation on a lenient override.** Triggered by `isLenientOverride()` in
  `@aics/contracts` — imported by *both* the form and the service, so the two cannot disagree about
  whether a second signature is required. Two things trigger it: a softer decision than the
  engine's, **and the same decision for more money**. The second case is easy to miss and is the
  same risk.
- **The co-signer re-authenticates.** They enter their own password, which is verified against
  their own account. An email field the first reviewer types in themselves would be evidence of
  nothing.
- **The co-signer must be a different person, and must hold credit authority.** Compliance is
  excluded (oversight is not approval), and so is `ADMIN` — see §2 on separation of duties.
- **Product ceilings are absolute.** A limit above §1.2's product maximum is refused no matter who
  co-signs. Dual authorisation is a control on judgement within the bank's stated limits, not a key
  that unlocks a number above them.
- **One decision per referral.** A review on an application no longer `UNDER_REVIEW` returns 409,
  so two reviewers with the page open cannot both decide it.
- **The engine's recommendation is stored on the review row** (`systemDecision`), alongside the
  reviewer's role and the co-signer's role at the time. One row answers the auditor's actual
  question without reconstructing the score history.
- **The audit record contains the co-signer's identity and never their credential** — asserted by
  a test that greps the serialised snapshot.

**SLA.** `REVIEW_SLA_HOURS = 48` in `@aics/contracts` is the number the API measures and the
dashboard displays, so the banner's claim and the queue's arithmetic come from one constant. Wait
time is shown on every row rather than only on late ones — an SLA you can only see once breached is
one nobody manages. `breachedCount` is computed across the whole queue, not the current page.

**Still open:** nothing *notifies* anyone when an item approaches 48 hours. The queue shows it to
whoever looks. A scheduled job that escalates by email is the remaining piece, and it needs a
mail/alerting channel this system does not currently have.

---

## 2. Security hardening — what changes between a demo stack and a bank's

The current stack is honest about being a local/pilot deployment; `docker-compose.yml` says so in
its own comments. None of the following is a defect in what was built — it's the list of what a
production bank environment adds on top.

### Authentication and RBAC — **BUILT**

*Status: implemented.* `apps/api/src/auth/` and the `AppShell` gate in `apps/web`.

The dashboard is no longer open. Every route in the API is closed by default: `JwtAuthGuard` is
registered as an `APP_GUARD` in `AuthModule`, so a new controller is protected the moment it is
written and opening one requires an explicit, greppable `@Public()`. Only `/healthz` and `/readyz`
carry it — they must, because Docker's health check holds no credential, and what they disclose is
bounded to component reachability and version strings.

| Control | Implementation |
|---|---|
| Password storage | scrypt (N=2¹⁶, r=8, p=2) from `node:crypto`, PHC-style so the work factor travels with each credential and can be raised without a migration. Not bcrypt/argon2: both are native addons needing a compiler in a build image that deliberately has no toolchain. |
| Tokens | 15-minute HS256 access token (stateless, algorithm pinned, issuer/audience checked) + opaque refresh token stored as a SHA-256 digest in `staff_session`. Rotated on every use; **presenting a spent token terminates every session for that user**, since theft and ordinary use are indistinguishable at that point. |
| Revocation | Sessions are rows, not stateless tokens, because "terminate this person's access now" is a control a bank will actually exercise. Role change, deactivation and password change all revoke. |
| Brute force | Per-account lockout after 5 consecutive failures + a per-source throttle for attempts spread across many accounts. |
| Enumeration | Wrong password, unknown email, locked and deactivated accounts return one identical response — and an unknown email still pays the full hash cost, so the difference is not a timing measurement either. |
| Provisioned accounts | Every account is created with `mustChangePassword`. Until it is set, the guard permits only `/me`, `/change-password` and `/logout` — a seeded credential is not a working credential. |
| Roles | `UNDERWRITER`, `SENIOR_UNDERWRITER`, `CREDIT_MANAGER`, `COMPLIANCE_OFFICER`, `ADMIN`, with the authority tables in `@aics/contracts` so the API and dashboard cannot disagree. Membership, not seniority: `ADMIN` is not implicitly every permission. |

**Separation of duties.** `ADMIN` provisions accounts and **cannot approve credit or co-sign an
override**. If it could, one compromised administrator could mint an underwriter, approve a loan as
that underwriter, and co-sign it as itself — exactly the collusion SOP-004's dual authorisation
exists to prevent. This is asserted directly against the authority tables in
`apps/api/test/underwriter.service.spec.ts` so it cannot regress quietly.

**Browser session handling.** The access token is held in memory only; a token in `localStorage` is
readable by any script that reaches the page, so one XSS would become a stolen underwriter session
outliving the tab. The refresh token sits in `sessionStorage` — script-readable, which is why it is
the short-lived, single-use, server-revocable half of the pair. *The correct end state for a bank is
an httpOnly/Secure/SameSite=Strict refresh cookie from a same-origin backend*, which needs the
ingress work below; it is isolated in `apps/web/src/lib/auth-store.ts` so that change touches one
module.

**Still open on the identity side:** SSO/OIDC against the bank's identity provider. `StaffUser` is
shaped so this adds a subject column rather than rewriting the access model, and password auth
becomes the break-glass path.

### The rest of the hardening list

| Area | Current state | What a bank deployment needs |
|---|---|---|
| **Secrets** | `FIELD_ENCRYPTION_KEY`, `FIELD_HASH_KEY` and now `JWT_SECRET` are env vars, all three rejected at boot if left as placeholders (good instinct, wrong storage tier) | KMS/HSM-backed key management (AWS KMS, Azure Key Vault, or an on-prem HSM if NRB data-residency rules require it) with rotation and access-logged retrieval, not a `.env` file on a host |
| **Database transport** | `docker-compose.yml` sets `ALLOW_INSECURE_DB: 'true'`, TLS terminating only at the compose network boundary | `sslmode=verify-full` against Postgres, always, once this leaves a single trusted network |
| **Document storage** | Local filesystem volume (`api-storage`), purged 90 days post-decision per §10.1 | Object storage (S3-compatible) with server-side encryption and access logging; also see §3 on whether 90 days is the right retention window for the *documents* even if the *decision record* is kept longer |
| **Network exposure** | Three services on host-mapped ports, no reverse proxy/WAF in the compose file | TLS-terminating ingress and a WAF. Same-origin hosting of API and dashboard is the prerequisite for moving the refresh token into an httpOnly cookie |
| **Login throttle scope** | In-process, therefore per-replica: two API instances each allow the full budget | Redis-backed or ingress-level rate limiting once the API is horizontally scaled. Stated in `login-throttle.ts` rather than discovered later, because the code looks correct either way |
| **Dependency/pen testing** | 269 + 46 automated tests, including adversarial cases for the auth surface (forged `alg:none` tokens, malformed bearer schemes, credential leakage into audit snapshots) — but written by the implementer | A pre-launch penetration test by someone who did not build it, and a dependency/SCA scan in CI |

---

## 3. Regulatory posture specific to a licensed bank

`docs/03-ai-model-landscape-2026.md` already covers the EU AI Act and Colorado AI Act as the
international bar for explainability. A Nepali bank answers to a different, additional regulator:
**Nepal Rastra Bank (NRB)**. Two items need a compliance/legal read, not an engineering one:

- **Model risk management.** NRB's directives for licensed institutions generally expect a
  board-approved policy for any model that influences a credit decision, plus independent
  validation before and periodically after deployment. The shadow-mode design (§4 of
  `PROJECT-OVERVIEW.md`) is a strong starting position for this — the scorecard, not the model,
  currently decides — but the validation-and-sign-off *process* around it still needs to exist as
  a documented artifact NRB examiners can review, separate from the engineering documentation.
- **Record retention.** The 90-day document purge in `docker-compose.yml` is a sound data-
  minimization default for raw PII documents, but confirm it against NRB's retention requirement
  for credit file documentation, which is typically measured in years, not days, for the life of a
  loan plus a statutory tail. If the requirement is longer than 90 days, the fix is not to keep the
  raw CV/statement PDFs — it's to confirm `DecisionAudit` (§10.4, already retained indefinitely
  today) satisfies the documentation requirement on its own, or to extend the purge window for the
  source documents specifically.

Both of these are decisions for Fintara's legal/compliance function, informed by counsel with NRB
experience — not something to resolve in code. They're listed here because they gate a real bank
deployment the same way §1 and §2 do, and because the second one interacts directly with a retention
number already hard-coded into the infrastructure.

---

## 4. Availability and disaster recovery

The full stack today is `docker compose up -d` — one Postgres container, one API container, one ML
container, one web container, no replicas, no automated backup job visible in the compose file
beyond the named volume. That's appropriate for a pilot; a bank-facing production deployment adds:

- Managed Postgres (or a replicated self-hosted cluster) with point-in-time recovery and a tested
  restore procedure, not just a volume that survives a container restart.
- At least two replicas of the API and web services behind a load balancer, so a single node
  restart doesn't take the assessment engine down mid-application.
- A documented RTO/RPO the bank's operations team has actually signed off on — "the database and
  trained model persist between restarts" (`PROJECT-OVERVIEW.md` §14) is a fine property for a
  demo and not a disaster recovery plan.
- The existing chaos-tested behavior — the ML service can go down and the scorecard still decides,
  degrading to `REFER_UNDERWRITER` rather than failing closed or open — is the right pattern and
  should be the model for how Postgres unavailability is handled too, which today would simply take
  the whole system down.

---

## 5. Core banking and disbursement

Explicitly out of scope in both `README.md` and `PROJECT-OVERVIEW.md` §8 — this system assesses and
decides, it does not move money. For a real bank, an approved decision needs a connector into
whatever core banking platform the bank runs (Finacle, T24, or a domestic equivalent) to actually
disburse. That integration is scoped by the bank's core-banking vendor contract, not by this
codebase, but it's the last mile between "the system says approve" and "the applicant has funds."

---

## Priority order

| Priority | Item | Status |
|---|---|---|
| **1** | Authentication/RBAC (§2) | **Done.** JWT + role-based access, closed by default, separation of duties between administration and credit authority |
| **2** | Underwriter review queue (§1) | **Done.** Queue, review UI and SOP-004 enforcement including dual authorisation |
| **3** | NRB model-risk sign-off + retention confirmation (§3) | **Open — legal/compliance, not engineering.** Runs in parallel; blocks launch, not development |
| **4** | Secrets → KMS/HSM, DB TLS, object storage, TLS ingress + WAF (§2) | **Open.** Mechanical once an environment is chosen. Same-origin hosting also unlocks the httpOnly refresh cookie |
| **5** | SSO/OIDC against the bank's identity provider (§2) | **Open.** `StaffUser` is shaped for it; password auth becomes break-glass |
| **6** | HA/DR (§4) | **Open.** Matters once there is real applicant traffic to lose; not needed for a controlled pilot |
| **7** | SLA escalation for referrals approaching 48h (§1) | **Open.** Needs a mail/alerting channel the system does not yet have |
| **8** | Core banking connector (§5) | **Open, vendor-contract-gated.** Likely the longest lead time on this list — start the conversation early |
| **9** | Independent penetration test (§2) | **Open.** The adversarial tests that exist were written by the implementer, which is not the same thing |

Items 1 and 2 were the two engineering blockers. What remains is either someone else's decision
(3), an environment choice (4, 5, 6), or a vendor conversation (8).

This still sits downstream of `PROJECT-OVERVIEW.md` §15 — **outcome capture and the nationality
clause withdrawal remain the two highest-value items overall**, and neither is affected by the work
above. This document is what else is true by the time a real bank customer, not a pilot cohort, is
on the other end of a decision.

---

## Appendix — operating the access model

**First run.** Set `JWT_SECRET` (`openssl rand -hex 32`) plus `BOOTSTRAP_ADMIN_EMAIL` and
`BOOTSTRAP_ADMIN_PASSWORD` in `.env`, then `db:seed`. That creates one administrator, flagged
`mustChangePassword`, which can do nothing but set its own password. There are deliberately **no
seeded underwriter or compliance logins** — SOP-004's co-signature is worthless if the co-signer's
password ships in a repository. The administrator provisions the real accounts from the Staff page.

**Minimum viable staffing.** Dual authorisation needs two people with credit authority, at least one
a `CREDIT_MANAGER`, because a reviewer cannot co-sign their own decision. One underwriter and one
credit manager is the floor for a working queue.

**Leavers.** Deactivate the account. Sessions are revoked in the same operation, so access ends
within the request rather than at the end of the refresh window.

---

*CONFIDENTIAL — Fintara Solutions Pvt Ltd. Contains no real applicant data.*
