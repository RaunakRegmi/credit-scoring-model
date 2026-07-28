# Running the system, credentials, and the demo script

Everything needed to start the stack, sign in, and walk an audience through it. Written to be
followed literally — the commands and the credentials in here were executed and verified against a
running stack on 2026-07-28.

> **Scope.** This is a local demo environment. Every credential below is a development credential
> for a database containing only synthetic fixtures. None of it is a production secret, and none of
> it should ever become one.

---

## 1. Credentials

Four staff accounts exist in the local database. All four are verified working.

| Email | Password | Role | What you use it for in the demo |
|---|---|---|---|
| `underwriter@fintara.com.np` | `Underwriter-Perm-2026!` | `UNDERWRITER` | **Your main account.** Submitting applications and reviewing referrals. Start here. |
| `creditmanager@fintara.com.np` | `Manager-Perm-2026!` | `CREDIT_MANAGER` | The **co-signer** for a lenient override. You type these into the dual-authorisation box; you never sign in as it. |
| `admin@fintara.com.np` | `Adm1n-Permanent-2026!` | `ADMIN` | The **Staff** page — creating accounts, resetting passwords, deactivating users. Cannot touch credit. |
| `compliance@fintara.com.np` | `Compliance-Perm-2026!` | `COMPLIANCE_OFFICER` | Showing read-only oversight — sees every decision, can record none. |

### Where these came from, and why they are not in the repo

`.env` holds `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD`. **That password no longer works.**
The bootstrap admin ships with `mustChangePassword` set, so the first sign-in consumed it and
replaced it with `Adm1n-Permanent-2026!`.

The other three were never in the repo at all, by design. `prisma/seed-staff.ts` deliberately seeds
**no** underwriter, credit manager or compliance login:

> a seeded account with a password printed in a repository is a backdoor, and the SOP-004
> dual-authorisation control is meaningless if the co-signer's credentials ship with the source.

So they were created by hand through the Staff page. The consequence to plan for: **if the database
volume is destroyed, only the bootstrap admin comes back.** See §4.3.

### If a password stops working

Almost always account lockout. `.env` sets `LOGIN_MAX_ATTEMPTS=5` and `LOGIN_LOCKOUT_MINUTES=15`, so
five fumbled attempts freeze the account for fifteen minutes — and while it is frozen, **the correct
password is also refused**. Either wait it out, or sign in as admin and issue a new temporary
password from the Staff page.

Note that the error message is identical for a wrong password, an unknown email and a locked
account: `Email or password is incorrect.` That is intentional — it refuses to confirm which
addresses have accounts — but it does mean the UI will not tell you that you are locked out.

---

## 2. The five roles

`STAFF_ROLES` in `packages/contracts/src/staff.ts` defines five. Four have accounts;
`SENIOR_UNDERWRITER` does not, and you can create one live from the Staff page if you want to show
provisioning.

### `UNDERWRITER` — authority 1

Captures applications and records decisions from the review queue. Can enter a lenient override, but
cannot complete one alone — it needs a co-signature from someone else with credit authority.

### `SENIOR_UNDERWRITER` — authority 2

Identical permissions to `UNDERWRITER`, and deliberately **not** a permitted co-signer. SOP-004 asks
for "a second authoriser" without grading it, so the stricter reading shipped and the question was
left to Fintara's credit committee. Audits as `UNDERWRITER`; the exact grade is preserved separately
on `UnderwriterReview.reviewerRole`.

### `COMPLIANCE_OFFICER` — authority 3

Reads everything, decides nothing. Sees the queue, every referral's full assessment, and the audit
trail — and is excluded from co-signing, because a compliance officer who co-signed an approval
cannot then independently examine it. Note it sits *above* the underwriting grades on the authority
ladder while holding *no* credit approval power: seniority and credit authority are separate axes,
which is the point of having both.

### `CREDIT_MANAGER` — authority 4

Full credit authority. Everything an underwriter can do, **plus** it is the only role that can
second-authorise a lenient override (`CAN_SECOND_AUTHORISE = ['CREDIT_MANAGER']`).

### `ADMIN` — authority 5

Highest authority number, and **no credit authority whatsoever.** This is the single most
counter-intuitive thing to explain, and the most worth explaining — see §5, Scene 5.

### Authority matrix

| | Underwriter | Senior UW | Compliance | Credit mgr | Admin |
|---|:-:|:-:|:-:|:-:|:-:|
| Create an application | ✅ | ✅ | ❌ | ✅ | ❌ |
| View the review queue | ✅ | ✅ | ✅ | ✅ | ✅ |
| Record a decision | ✅ | ✅ | ❌ | ✅ | ❌ |
| Co-sign a lenient override | ❌ | ❌ | ❌ | ✅ | ❌ |
| Read the audit trail | ❌ | ❌ | ✅ | ✅ | ✅ |
| Manage staff accounts | ❌ | ❌ | ❌ | ❌ | ✅ |

The two blanks that matter: **admin cannot lend, and compliance cannot co-sign.** Everything else
follows from those.

---

## 3. What runs where

| URL | Service | Container | Check |
|---|---|---|---|
| <http://localhost:3000> | Next.js dashboard | `aics-web` | loads a sign-in screen |
| <http://localhost:4000> | NestJS API | `aics-api` | `/readyz` → `"status":"ready"` |
| <http://localhost:8000> | FastAPI + XGBoost | `aics-ml` | `/readyz` |
| `localhost:5432` | PostgreSQL 16 | `aics-postgres` | — |

The API is the only one you point a browser at directly, and only for `/readyz`.

---

## 4. Commands

### 4.1 Every time — starting up

```bash
cd "/Users/raunak/Documents/Credit Scoring Model"
docker compose up -d
```

Then wait for health and confirm before you present:

```bash
docker compose ps                        # all four Up, api and ml (healthy)
curl -s http://localhost:4000/readyz     # "status":"ready"
```

`readyz` is the one check worth running in front of nobody. It returns:

```json
{"status":"ready","database":true,
 "mlService":{"reachable":true,"circuit":"CLOSED","modelVersion":"1.0.0-synthetic-seed",
              "provenance":"SYNTHETIC_SEED"},
 "versions":{"scorecard":"1.0.0","featureSet":"1.0.0","policy":"1.0.0"}}
```

`"status":"degraded"` means the model is down but the API is deliberately still serving — the
scorecard decides without it. `"unavailable"` means the database is unreachable, and nothing will
work.

If you changed code since the last run, rebuild: `docker compose up -d --build`.

### 4.2 Verifying it actually works before you present

Two minutes, and worth it every single time:

```bash
# 1. Every account can still sign in.
for pair in "underwriter@fintara.com.np|Underwriter-Perm-2026!" \
            "creditmanager@fintara.com.np|Manager-Perm-2026!" \
            "admin@fintara.com.np|Adm1n-Permanent-2026!" \
            "compliance@fintara.com.np|Compliance-Perm-2026!"; do
  IFS='|' read -r em pw <<<"$pair"
  printf '%-32s %s\n' "$em" \
    "$(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:4000/api/auth/login \
        -H 'Content-Type: application/json' -d "{\"email\":\"$em\",\"password\":\"$pw\"}")"
done
# Four 200s. Anything else, fix it now — see §1.

# 2. The queue has something in it.
curl -s http://localhost:4000/api/underwriter/queue \
  -H "Authorization: Bearer $(curl -s -X POST http://localhost:4000/api/auth/login \
     -H 'Content-Type: application/json' \
     -d '{"email":"underwriter@fintara.com.np","password":"Underwriter-Perm-2026!"}' \
     | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).accessToken))')" \
  | head -c 200
```

Do **not** run the login loop more than once in a sitting with a typo in it — five failures locks
the account for fifteen minutes.

### 4.3 A clean database — destructive, read this first

```bash
docker compose down -v      # -v DESTROYS the database volume
docker compose up -d --build
docker compose exec api npx prisma migrate deploy
docker compose exec api node dist/prisma/seed.js
```

**This deletes three of your four accounts.** After it, only the bootstrap admin exists, on the
`BOOTSTRAP_ADMIN_PASSWORD` in `.env` (`OP0i/+RcdpY1ABK4cVCFo7or`), and it will force a password
change on first sign-in. You then have to recreate the underwriter, credit manager and compliance
accounts from the Staff page — and you need at least the underwriter *and* the credit manager back
before the dual-authorisation demo works at all.

So: **never do this the morning of a demo.** If you only want to tidy the queue, don't — a cluttered
queue is harmless, and §6.4 explains how to talk about it.

The seed itself is safe to re-run without `down -v`. It deletes its own three fixture applicants by
NID hash before recreating them, so it does not accumulate duplicates.

One thing `down -v` no longer takes with it: **uploaded documents.** `storage/` is a bind mount into
your project (§7), not a Docker volume, so the files survive. What you lose is every database row
describing them — so the blobs remain on disk, orphaned. Delete `storage/` by hand if you want a
genuinely clean slate.

### 4.4 Tests

```bash
npm test                                  # 305 tests — contracts + API
cd apps/ml && .venv/bin/python -m pytest   # 46 tests — manifest, model, API
```

Run these from the host, not the container. `npm test` needs no database.

### 4.5 Shutting down

```bash
docker compose stop     # keeps data — what you want
docker compose down     # removes containers, keeps the volume
docker compose down -v  # destroys the database. See §4.3.
```

Use `stop`. Muscle memory for `down -v` is how you lose your accounts the night before a demo.

### 4.6 Useful one-liners

```bash
# What's in the queue, at a glance
docker compose exec -T postgres psql -U aics -d aics -c \
  'select count(*) from loan_application where status='"'"'UNDER_REVIEW'"'"';'

# Follow the API log while you click
docker compose logs -f api

# Who has an account
docker compose exec -T postgres psql -U aics -d aics -c \
  'select email, role, "isActive", "mustChangePassword" from staff_user;'
```

---

## 5. The demo script

Roughly fifteen minutes. Each scene has what to do, and what to say while doing it. Sign in as
**underwriter** and stay there until Scene 5.

### Scene 0 — Before they arrive

Stack up (§4.1), `/readyz` green, logins verified (§4.2), `samples/` folder open in Finder, browser
at <http://localhost:3000> already signed in as the underwriter. Have this document open on a second
screen.

### Scene 1 — Closed by default (30 seconds)

Open a private window to <http://localhost:3000>.

> "There's no landing page and no public form. Every route on the API requires an authenticated
> staff session with a sufficient role, and the dashboard renders a sign-in screen until one
> resolves. This is a bank tool operated by staff, not a consumer app — so an unauthenticated
> request doesn't get a friendlier page, it gets a 401."

Close the private window.

### Scene 2 — Submit an application (4 minutes)

On **New assessment**, fill in:

| Field | Value |
|---|---|
| Product | Personal Loan |
| Requested amount | `800000` |
| Tenure | `24` |
| Full name | `Demo Applicant` |
| Email | `demo@example.com` |
| Phone | `9800000123` |
| Citizenship / NID | `NID-DEMO-0002` |

Attach from `samples/`:

- Resume / CV → `prime-professional-resume.txt`
- Bank statement → `prime-professional-statement.csv`

Tick all three consent boxes. While you do:

> "Three separate consents — data processing, the credit bureau enquiry, and specifically consent to
> an automated AI-assisted assessment with a right to human review within fourteen days. That third
> one is the EU AI Act shape of the requirement, and it's a distinct checkbox because it's a
> distinct permission."

Submit. It returns in **well under a second**.

> "Under a second, end to end. That's parsing the CV, parsing six months of statements, classifying
> every transaction, aggregating monthly, computing thirty-eight features, running the scorecard,
> calling the ML model, applying policy overrides, and writing all of it in one transaction. The
> internal budget is four seconds; measured latency is around 80 to 120 milliseconds."

### Scene 3 — Read the result (4 minutes)

**The score.** ~726 of 1,000, Near Prime.

**The four pillars.** Expand them.

> "Four pillars, and every one is a documented point table, not a model output. Financial is 300
> points from the bank statements, Professional 250 from the CV, Social 200, Behavioural 250. And
> each sub-score states its own arithmetic — this one says 'average daily balance NPR 9,12,390
> against the NPR 2,00,000 threshold for full marks', so 80 out of 80. An underwriter can
> reconstruct any of this by hand, which is what makes it defensible to a regulator."

Point at a line that lost points — payment punctuality at 0 of 40, "6 late or missed payments,
deducting 8 points each."

> "It tells you what it deducted and why. Not 'the model gave this a low weight'."

**The decision.** `REFER UNDERWRITER`, and the reason names `KYC_NOT_VERIFIED`.

> "Here's the part worth stopping on. The score is comfortably in approve territory, and the system
> refuses to approve it — because national ID verification hasn't returned `VERIFIED`. That's a
> third-party integration Fintara doesn't hold a contract for yet, so it's a stub.
>
> The rule is: a degraded assessment never approves, regardless of score. Unreadable documents, thin
> statement history, unverifiable income, an unreachable model — any one of them withholds automated
> approval and says precisely which one. The failure mode we designed against is a confident score
> derived from data we couldn't actually read."

**The explanation.** Five positive factors, three negative.

> "Every decision carries its explanation — top positive and negative contributors, in business
> language. And the complete feature vector, all version identifiers and the full SHAP payload are
> written in the same transaction as the score. Every decision is reconstructable, permanently."

**System status.** Point at the model provenance badge.

> "The model reports itself as `SYNTHETIC_SEED`, surfaced through the API into this UI. It has never
> seen a real default — it's trained on a synthetic population calibrated to the PD bands. AUC 0.772
> against a Bayes ceiling of 0.814, so about 95% of the signal available in its own data. The 0.85
> target belongs to a model trained on real outcomes and is deliberately not met.
>
> Which is why the model doesn't decide. The scorecard decides; the model runs alongside on every
> application, is recorded, and is compared. It takes over when it's been validated on at least 500
> real repayment outcomes — not before."

### Scene 4 — The review queue and dual authorisation (5 minutes) — **the centrepiece**

Go to **Queue**. Open the referral you just created.

> "Same payload the assessment view renders — the full score, pillars, factors, flags. Deliberately
> not an underwriter-specific summary, because a condensed version is a version that quietly drops
> the caveats."

Now select a decision **more lenient** than the engine's — pick `APPROVE_STANDARD` against a
`REFER_UNDERWRITER` recommendation. Type a justification (40 characters minimum):

```
Verified employment by phone with the HR department and confirmed the salary credits against
the payslips provided.
```

A **co-signer email and password** box appears. Stop and let them see it.

> "This is SOP-004. I'm about to release money the engine didn't agree to release, so I cannot do it
> alone. The system needs a second person with credit authority to authorise it, live, with their
> own password.
>
> And note when this appeared: only because my decision is *more lenient* than the engine's. If I
> were declining an application the engine wanted to approve, no co-signature — that costs the
> applicant an opportunity, not the bank a loss, and it's already fully recorded with its
> justification. The control is aimed specifically at the direction that loses money."

Now demonstrate the refusals. Each one is a real enforced rule:

1. **Your own credentials as co-signer** → refused. "A reviewer cannot co-sign their own decision."
2. **The compliance officer** (`compliance@fintara.com.np` / `Compliance-Perm-2026!`) → refused.
   "Compliance has authority 3, above both underwriting grades — and still cannot co-sign, because
   an officer who co-signed an approval can't then independently examine it."
3. **The credit manager with a wrong password** → refused. "It's a real authentication, not a
   dropdown of names."
4. **A limit above the product ceiling** → refused, even with a valid co-signature.

Then the real thing: `creditmanager@fintara.com.np` / `Manager-Perm-2026!`. Accepted.

> "Recorded now: my identity, my role, my justification, the credit manager's identity, their role,
> and the timestamp of the co-signature. What is *not* recorded anywhere is their password — the
> audit trail stores who authorised, never a credential."

### Scene 5 — Separation of duties (2 minutes)

Sign out. Sign in as **admin** (`admin@fintara.com.np` / `Adm1n-Permanent-2026!`).

Go to **Staff**. Show the four accounts, roles, last login, lock state, active session count.

> "The administrator provisions accounts, resets passwords, deactivates people. Highest authority
> number in the system — five."

Now go to **New assessment**.

> "And it cannot create an application. Not a bug — the substantive access-control decision in the
> codebase. Admin is deliberately excluded from credit authority.
>
> Think about why. If an administrator could also approve credit, one compromised admin account
> could mint an underwriter, approve a loan as that underwriter, and co-sign it as itself. That's
> exactly the collusion dual authorisation exists to prevent. Separating account administration from
> credit authority is what makes the co-signature meaningful instead of ceremonial.
>
> The practical consequence is intended: the bootstrap administrator cannot lend. It provisions the
> people who can."

Optionally try to deactivate or demote the admin itself — both refused, last-administrator
protection. Nobody can lock everyone out of the system.

### Scene 6 — The model can fail (2 minutes, optional but strong)

In a terminal:

```bash
docker compose stop ml
curl -s http://localhost:4000/readyz    # "status":"degraded", "reachable":false
```

Re-score the same applicant through the UI — same fields, same two files, a new NID.

Verified output with the model down: composite **726.53, identical to the run with the model up**,
flags `["KYC_NOT_VERIFIED","ML_SERVICE_UNAVAILABLE"]`, still 5 positive and 3 negative factors,
144 ms.

> "Model's gone. Identical score — to the decimal — because the scorecard never needed it. A second
> flag appears, `ML_SERVICE_UNAVAILABLE`, and it still returns a full five-positive, three-negative
> explanation, derived from the scorecard's sub-scores instead of SHAP.
>
> And the API reports itself *degraded*, not unavailable, because it's still doing its job. It just
> can't auto-approve while it's blind."

Don't promise the audience an open circuit breaker. `circuit` stays `CLOSED` here —
`ML_CIRCUIT_FAILURE_THRESHOLD=5`, so a single re-score doesn't trip it. `"reachable":false` is the
field to point at.

```bash
docker compose start ml     # restore before you finish
```

### Scene 7 — Close (1 minute)

> "Three properties the design holds onto. The scorecard decides and the model shadows, until
> there's real outcome data to validate against. A degraded assessment never approves, and always
> says why. And every decision is reconstructable — full feature vector, versions, SHAP payload,
> same transaction as the score.
>
> Verified by 351 tests. Not just that the pipeline runs — that every point table matches the
> document clause by clause, that a perfect 1,000 with a sanctions match still declines, that
> monotonicity holds empirically, that a CV scores identically as plain text and as a two-column
> PDF, and that every one of those dual-authorisation refusals you just watched writes nothing when
> it refuses.
>
> The highest-value next task is capturing real repayment outcomes. Everything else in the ML
> roadmap depends on it."

---

## 6. Gotchas

### 6.1 Nothing you submit live can say AUTO_APPROVE — but it can still approve

Anything created through the dashboard or the API carries a `KYC_NOT_VERIFIED` flag.
`credit-assessment.service.ts` raises it whenever `nidVerificationStatus !== 'VERIFIED'`, and
**nothing in `apps/api/src` ever writes that column** — NID verification is a stubbed third-party
port. The only code that sets `VERIFIED` is `prisma/seed.ts`.

What that flag does is narrower than "never approves", and the distinction is worth having straight
before someone asks. `decision.service.ts` escalates a degraded run to `REFER_UNDERWRITER` only when
the decision is an *automated* approval, and `isAutomatedApproval` means exactly `AUTO_APPROVE` or
`APPROVE_STANDARD`. So:

| Band from a live upload | Engine decision | Degraded outcome |
|---|---|---|
| Elite Prime / Prime | `AUTO_APPROVE` | → `REFER_UNDERWRITER` |
| Near Prime | `APPROVE_STANDARD` | → `REFER_UNDERWRITER` |
| Subprime | `APPROVE_WITH_CONDITIONS` | **stays an approval**, flags recorded |
| High Risk | `REFER_UNDERWRITER` | unchanged |
| Reject | `DECLINE` | unchanged |

`APPROVE_WITH_CONDITIONS` already means a human sets conditions, so degradation doesn't escalate it
— it just records the flags on the decision.

Both verified live, same session, same stack:

- `prime-professional-*` → 726.53 Near Prime → **referred** (`KYC_NOT_VERIFIED`)
- `thin-file-gig-worker-*` → 482.60 Subprime → **`APPROVE_WITH_CONDITIONS`**, approved on the spot

So if you want to show a live approval rather than a referral, **upload the gig-worker pair.** If you
want a referral to feed the dual-authorisation scene, upload the prime pair. Both are one-minute
demos and you can do both.

The one thing you genuinely cannot produce from a live upload is `AUTO_APPROVE`, because every band
that maps to it is an automated approval and gets escalated. For that, open a seeded application.

Consequence for the README: its headline table — 778 PRIME `AUTO_APPROVE`, 494 SUBPRIME, 296 DECLINE
— describes the three **seeded** reference applicants (Anjali Sharma, Prakash Gurung, Bibek
Adhikari), which is why the Prime row is not reproducible by hand. The Subprime row very nearly is:
you'll get 482.60 against the documented 493.60, same band, same decision.

If you must force an `AUTO_APPROVE` from a live upload, flip the flag and re-score:

```sql
UPDATE applicant_profile SET "nidVerificationStatus"='VERIFIED' WHERE "fullName"='Demo Applicant';
```

Frankly, the referral path is the better demo — it's what makes Scene 4 possible.

### 6.2 Dual authorisation needs two live accounts with credit authority

Underwriter **and** credit manager, both active, both with known passwords. A reviewer cannot
co-sign their own decision, so one account is not enough. This is the first thing to break after a
`down -v`, and it takes out the best part of the demo.

### 6.3 Access tokens expire in 15 minutes

`ACCESS_TOKEN_TTL_SECONDS=900`, with a 9-hour refresh session behind it. The dashboard refreshes
ahead of expiry, so a long demo is fine. But if you leave a tab open overnight, sign in again before
you start.

Also: changing a password revokes every existing session for that account immediately. Don't reset a
password mid-demo on an account you have open in another tab.

### 6.4 The queue has accumulated test data

At the time of writing, 39 applications with 15 awaiting review — mostly leftovers from development
test scripts, which is why you'll see several "UI Check Applicant" and "Chaos Check" rows and
repeated fixture names. Check the live number with the one-liner in §4.6.

Do not clean this up before a demo; `down -v` costs you your accounts (§4.3). If anyone asks, it is
genuinely a fair answer:

> "Development test data. The queue sorts oldest-first and tracks wait time and SLA breaches against
> a 48-hour commitment — so a backlog is exactly what it's built to surface."

### 6.5 Five wrong passwords locks the account for fifteen minutes

And while locked, the correct password is refused too, with the same generic message as a wrong one.
Copy and paste from §1 rather than typing. If you do lock yourself out, sign in as admin and reset it
from the Staff page — the reset clears the lockout.

### 6.6 "KYC documents on file" is a declaration, not an upload

Someone will click it expecting a file picker. It isn't one — the pills are toggle buttons
(`aria-pressed`), and the form sends a comma-joined list of document *type names*. The upload
interceptor accepts exactly two files, `resume` and `statement`, and caps at `files: 2`. Nothing you
tick there transmits a document.

What it means is "the branch holds these documents in the physical file", and what it does is feed
the §4.4 identity-completeness sub-score — **30 points in the Social pillar, −7 per missing
document**:

| Scored documents supplied | KYC points |
|---|---|
| 4 | 30 |
| 3 | 23 |
| 2 | 16 |
| 1 | 9 |
| 0 | 2 |

Three things about it that will come up:

**Only four types score.** `KYC_SCORED_DOCUMENTS` is `NID_FRONT`, `PASSPORT`, `PAN_CARD`,
`ADDRESS_PROOF`. **`NID_BACK` is offered in the UI and contributes nothing** — the form defaults to
`NID_FRONT` + `NID_BACK`, so the default state is 1 scored document, not 2.

**Passport can be credited without ticking it.** If the CV extraction found a passport number,
`PASSPORT` is added to the supplied set automatically. That is why an application with *nothing*
ticked still scores 9 rather than 2 on the prime fixture — its CV carries a passport number.

**It does not clear `KYC_NOT_VERIFIED`.** That flag reads `nidVerificationStatus`, a different column
that only the seed ever writes (§6.1). Declaring documents and verifying identity are separate
things, and the scorecard treats them separately.

Measured on the prime fixture, all three still referred:

| Ticked | KYC | Social | Composite | Decision |
|---|---|---|---|---|
| nothing | 9/30 | 114.67 | 726.53 | `REFER_UNDERWRITER` |
| NID front + back (default) | 16/30 | 121.67 | 733.53 | `REFER_UNDERWRITER` |
| all four scored | 30/30 | 135.67 | 747.53 | `REFER_UNDERWRITER` |

A 21-point swing, and no change to the outcome.

If a bank reviewer asks the sharp question — "so an operator can award 21 points by clicking four
buttons, with no evidence?" — the answer is yes, and it is the honest one. This is a self-declared
field with nothing validating it. In a real deployment those documents should be uploaded and
verified like the CV and the statement are, which is the same integration gap that leaves
`nidVerificationStatus` permanently unset. Worth saying before you're asked.

### 6.7 `docker compose down -v` destroys the database

Restated here because it is the only genuinely unrecoverable command in this document. `stop` is
almost always what you meant.

---

## 7. Where uploaded documents go, and how to get the data out

Every CV and bank statement anyone uploads is **already stored and kept**, along with everything
derived from it. No configuration needed — this has been on since the first upload.

### What is captured, per upload

| Where | What |
|---|---|
| **`storage/<applicationId>/<sha256>.bin`** in this project | the **raw file**, byte for byte |
| `document` table | original filename, MIME type, size, SHA-256, extraction status and confidence |
| `resume_profile`, `employment_history`, `award`, `certification`, `professional_reference` | the **parsed CV** as structured rows |
| `bank_statement`, `transaction`, `monthly_financial_summary`, `financial_analytics` | the **parsed statements**, down to individual transactions |
| `financial_analytics.features` | the complete **38-feature vector** as JSON — a training matrix as-is |
| `credit_score_output` | score, pillars, band, decision, PD, the full SHAP payload, every version identifier |

Blobs are content-addressed, so the same document uploaded twice occupies one blob. Verified: 171
blobs across 86 application folders, and a stored CV reads back byte-identical.

### `storage/` — the canonical store, in your project folder

`docker-compose.yml` bind-mounts `./storage` into the API at `/data/storage`. Uploads appear in your
project **the instant they're submitted** — no export step, no copy job. Verified: submitting one
application took the host blob count from 171 to 173, and the two new files were in
`storage/<applicationId>/` before the HTTP response finished.

This replaced the `api-storage` named volume, which is what made uploads invisible before — they were
inside Docker rather than on your disk. The 171 blobs that existed then were migrated across, so
nothing was lost. Two side benefits: the files now survive `docker compose down -v`, and they're
trivially backed up by copying a folder.

Files land as `storage/<applicationId>/<sha256>.bin`. Content-addressed on purpose — no
user-supplied text ever becomes a path, and the same document uploaded twice occupies one blob — so
you cannot tell a CV from a bank statement by looking at it. That's what the next section is for.

> `storage/` is gitignored and must stay that way. It holds raw applicant CVs and bank statements.

### `uploads/` — the browsable view, sorted by type

```bash
./scripts/organize-uploads.sh
```

```
uploads/
  CV/                40 file(s)      ONE-20260728-8FB473__Anjali-Sharma__resume.txt
  bank-statements/   40 file(s)      ONE-20260728-8FB473__Anjali-Sharma__statement.csv
```

Real filenames, grouped by document type, prefixed with the ARN and the applicant's name — open any
of them and you're looking at the CV that was uploaded. KYC documents, address proofs and employment
letters get their own folders if any are ever uploaded.

Re-run it any time; it rebuilds the tree from scratch, so it always matches the database. It
**copies** rather than moves — `storage/` stays authoritative, and deleting `uploads/` costs you
nothing. Also gitignored.

### Getting the structured data out

```bash
./scripts/export-data.sh              # → export/<UTC timestamp>/
./scripts/export-data.sh my-dataset   # → my-dataset/
```

Produces four things:

| File | Contents |
|---|---|
| `applications.csv` | one wide row per application — applicant, CV fields, statement analytics, score, decision. Open in Excel or Sheets. |
| `features.jsonl` | one JSON object per application: 38 features + score, band, decision, PD, ML shadow PD. `pandas.read_json(..., lines=True)` gives you the matrix directly. |
| `documents.csv` | full document manifest including the raw extraction JSON |
| `documents/` | the **actual uploaded files**, renamed `<ARN>__<TYPE>__<hash8>__<original name>` so they're navigable |

Verified run: 39 applications, 39 feature vectors, 78 documents recovered intact.

`export/` is gitignored — it contains raw CVs, bank statements and applicant PII.

### Three things to know before you rely on this

**Nothing is ever deleted, despite what the schema implies.** Every document row gets a `purgeAfter`
stamped 90 days past the decision, and `StorageService.remove()` exists — but nothing calls it. There
is no scheduled purge job and no scheduler package installed. Convenient if you're collecting data;
it is also an unmet §10.1 retention obligation, and it should be named as such rather than discovered
later. Building it is a small job: a cron entry over `where purgeAfter < now() and purgedAt is null`.

**Most applicant PII is stored in plaintext.** Only `nidEnc`, `passportEnc` and `panEnc` are
encrypted at rest. Name, email, phone and address are readable by anyone with database access, and
they land in `applications.csv` in the clear. Fine for synthetic fixtures. Before this touches one
real applicant, that is a decision someone has to make deliberately.

**`storage/` is the only copy, and it is not backed up.** Since the move to a bind mount it does
survive `docker compose down -v` — but that command still wipes the *database*, leaving files on disk
with no rows describing them. The reverse also happens: if blobs are deleted by hand, Postgres keeps
metadata pointing at files that no longer exist. Both export scripts report missing blobs when that's
the case, and `storage/` is a plain folder, so a backup is `cp -R`.

---

## 8. Quick reference

```
Dashboard   http://localhost:3000
API         http://localhost:4000       /readyz for status
Model       http://localhost:8000

Start       docker compose up -d
Check       docker compose ps && curl -s http://localhost:4000/readyz
Stop        docker compose stop
Logs        docker compose logs -f api
Tests       npm test          (305)
            cd apps/ml && .venv/bin/python -m pytest    (46)
Uploads     storage/                    ← raw files, saved here as they arrive
            ./scripts/organize-uploads.sh    → uploads/CV/ + uploads/bank-statements/
Export      ./scripts/export-data.sh         → CSVs + 38-feature matrix

underwriter@fintara.com.np      Underwriter-Perm-2026!     ← sign in as this
creditmanager@fintara.com.np    Manager-Perm-2026!         ← co-signer, don't sign in
admin@fintara.com.np            Adm1n-Permanent-2026!      ← Staff page only
compliance@fintara.com.np       Compliance-Perm-2026!      ← read-only

Samples     samples/prime-professional-{resume.txt,statement.csv}       → ~726 Near Prime
            samples/thin-file-gig-worker-*                              → Subprime
            samples/overleveraged-high-risk-*                           → Reject
```

---

**CONFIDENTIAL** — Fintara Solutions Pvt Ltd. Development credentials for an environment containing
only synthetic fixtures.
