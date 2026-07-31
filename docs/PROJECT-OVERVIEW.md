# ONE BNPL — AI Credit Scoring Model

## Project Overview

**Prepared for:** Fintara Solutions Pvt Ltd — Board & Senior Management
**Status:** Built, tested, running. Ready for pilot (Phase 3 of the roadmap).
**Document purpose:** Explain what was built, how it works, what is proven, and what is not.

---

## 1. The problem, in one paragraph

Nepal's lending market runs on collateral. If you don't have property to pledge, you generally
don't get credit — regardless of whether you earn NPR 285,000 a month as a bank manager. There is
no deep credit bureau to fall back on, so lenders have no cheap way to tell a good borrower from a
bad one, and they default to demanding security.

That leaves a large, genuinely creditworthy population unserved: salaried professionals, digital
workers, small business owners, young graduates.

**The insight this system is built on:** those people already generate a detailed, verifiable
record of their financial behaviour every month. It's called a bank statement. And they already
document their earning capacity in a CV. If you can read those two documents properly, you can
assess someone without collateral and without a bureau file.

That is what this system does.

---

## 2. What it does, from the applicant's side

1. A product is chosen (BNPL, Personal Loan, Hire Purchase, Auto Loan), with an amount and a tenure.
2. Basic details are entered, and three separate consents recorded — data processing, credit bureau
   enquiry, and automated assessment.
3. Two documents are uploaded: a CV, and six months of bank statements. PDF, Word, or a spreadsheet
   export — see section 10 on what the system can and cannot read.
4. **Under one second later**, there is a decision: approved with a specific limit and interest
   rate, approved with conditions, referred to a human, or declined — and in every case, the
   specific reasons.

No branch visit, no 3–7 day wait.

**One clarification on who operates this.** As built, the intake screen is used by your staff — a
credit officer sits with the applicant, or works from documents the applicant has sent in. It is not
yet a self-service portal an applicant logs into themselves, and it should not be pointed at the
public as though it were: every authenticated member of staff can read every assessment, which is
correct for internal use and completely wrong for an applicant-facing site.

Turning it into self-service is a genuine piece of work, not a configuration change — applicants
need their own accounts, and each must be able to see their own application and nobody else's. The
decision engine underneath is unaffected; it is the front door that would be new.

---

## 3. How the score works

Everything is scored out of **1,000 points**, across four pillars. Each pillar answers a different
question about the applicant.

| Pillar | Points | The question it answers | Read from |
|---|---|---|---|
| **Financial** | 300 | Can they afford it? | Bank statements |
| **Professional** | 250 | Is their income durable? | CV |
| **Social** | 200 | Are they who they say, and are they rooted? | CV + KYC documents |
| **Behavioral** | 250 | How do they actually handle money? | Bank statements + CV |

### What's actually measured

Not vague impressions — 38 specific, defined quantities. A sample:

**Financial (300 pts)** — average balance over six months, how many of those six months show a
verified salary credit, debt service ratio (existing loan payments ÷ income), savings rate,
bounced cheques, days in overdraft, late payments.

**Professional (250 pts)** — employer category (a multinational scores differently from an informal
employer), total years of experience, whether their seniority is *rising* over time, salary growth
against an 8%/year benchmark, education level, professional certifications.

**Social (200 pts)** — countries travelled, high-scrutiny visas held (a US or Schengen visa means
someone else already ran a demanding financial check on them), seniority of their professional
references, years at their current address, how complete their identity documents are.

**Behavioral (250 pts)** — average time spent per employer, how many independent income streams
they have, whether existing instalments were paid on time, discretionary vs essential spending,
how much of their spending is untraceable cash withdrawals, whether they save in most months.

### From score to decision

| Band | Score | Default risk | Decision | BNPL limit | Term loan limit |
|---|---|---|---|---|---|
| Elite Prime | 900–1000 | under 1% | Auto approve | NPR 10,00,000 | NPR 50,00,000 |
| Prime | 750–899 | 1–3.5% | Auto approve | NPR 5,00,000 | NPR 25,00,000 |
| Near Prime | 600–749 | 3.5–8% | Approve, standard | NPR 2,50,000 | NPR 10,00,000 |
| Subprime | 450–599 | 8–20% | Approve with conditions | NPR 75,000 | NPR 3,00,000 |
| High Risk | 300–449 | 20–40% | Refer to underwriter | NPR 25,000* | Refer only |
| Reject | under 300 | over 40% | Decline | — | — |

*\*with a creditworthy guarantor*

The band also sets the interest rate and the capital provision the business must hold against the
loan — so one number drives pricing, limits and regulatory capital consistently.

---

## 4. The one decision that needs explaining

**The AI model does not make the lending decision. A deterministic scorecard does.**

That sounds backwards for a project called "AI Credit Scoring Model", so here is the reasoning.

An AI model learns from history. Specifically, a credit model learns from thousands of past loans
where you know who repaid and who didn't. **Fintara does not have that data yet** — the roadmap
collects it in Phase 2, and the governance policy requires 500 confirmed outcomes before a model
can be retrained.

So a model built today has never seen a single real default. It cannot have learned anything true
about who repays. Deploying it as the decision-maker would mean telling a regulator, a board and a
declined applicant that a lending decision was made by something that has never observed a
repayment.

What the system does instead:

- **The scorecard decides.** It implements the four-pillar point tables exactly as approved. It is
  fully auditable — you can re-derive any score by hand from the tables — and it is correct from
  the very first application, because it encodes credit judgement rather than learning it.
- **The AI model runs alongside on every application, in shadow mode.** Its risk estimate is
  recorded and monitored, but does not affect the outcome.
- **When the two disagree sharply, a human reviews it.** Two independently-derived assessments
  disagreeing about the same applicant is a real warning sign, and it's the one thing the shadow
  model contributes to decisions today.
- **When the data justifies it, the model gets promoted.** The whole pipeline — features,
  explainability, versioning, monitoring — is already built and running. Promotion becomes a
  configuration change, not a rebuild.

This is not a compromise. It's the sequence that lets you launch now, honestly, and get better as
real data arrives.

---

## 5. What makes it defensible to a regulator

Automated lending decisions are the most heavily scrutinised category of AI there is. Three things
were built specifically for that scrutiny.

### Every decision explains itself

For each assessment, the system produces the **top 5 factors supporting** the applicant and the
**top 3 factors counting against** them — in plain language, never as a technical field name.

A declined applicant gets sentences like *"Your existing loan and card obligations take up too
large a share of your income"* — which is what goes into the decline notice, and which tells them
what to fix. This is enforced in code: the system will not build if any factor lacks its
plain-language wording.

### Every decision can be reconstructed years later

The EU AI Act (August 2026) and equivalent rules require that an automated decision be
reconstructable after the fact. Logging a score does not satisfy that.

So for every decision the system stores an immutable record containing all 38 input values, the
scorecard version, the model version, the policy version and the full output — as plain data,
readable by anything, not just by this software. It is written in the same database transaction as
the score, so a decision can never exist without its audit trail.

*Verified: 8 decisions in the database, 8 audit records, zero missing.*

### The model cannot behave irrationally

Left unconstrained, an AI model will learn statistical quirks from noise — for instance, a small
region where *higher* debt somehow predicts *lower* risk. That is impossible to defend and
impossible to explain.

The model is therefore mathematically constrained on 37 of its 38 inputs: more debt can never
reduce assessed risk, a higher balance can never increase it. And the training process
**verifies these constraints and refuses to produce a model that violates them.**

### Fair lending is structural, not a promise

No decision input encodes gender, age, nationality, ethnicity, caste, religion or marital status.
This isn't a policy statement — the build **fails** if anyone adds a field whose name resembles a
protected characteristic, and tests assert it independently on both sides of the system.

Gender and date of birth *are* stored, for one purpose only: the quarterly test that checks the
model isn't accidentally disadvantaging a demographic group.

---

## 6. What I need to flag to you

Two things in the source specification could not both be true. I resolved each and want them on
the record.

### 6.1 The nationality penalty — a legal exposure

Your SOP specifies a score penalty based on nationality: Myanmar −45 points, other SAARC
countries −15.

**Section 10.2 of the same document commits the model to being demographically neutral**, with
quarterly discrimination testing. These directly contradict each other, and a blanket penalty on
national origin is unlawful discrimination in lending in most jurisdictions — including under the
fair-lending commitments your own document makes.

**How it ships:** as an external configuration rule, **switched off**, gated on written Legal
sign-off. It is still evaluated on every single application and recorded as
*"considered, deliberately not applied, zero points"* — because that record is the evidence
Compliance needs to prove national origin was not priced.

**Legitimate country risk is still handled** — through AML/CFT sanctions screening, applied per
applicant against actual watchlists. That's a defensible control; a blanket nationality penalty
is not.

**My recommendation:** formally withdraw the clause from the SOP rather than leave it dormant. A
disabled discriminatory rule is still a discriminatory rule sitting in your policy file, and an
auditor will ask about it.

### 6.2 The score scale

Your two documents disagreed — one said 300–900, the other 0–1,000. Everything downstream (bands,
interest rates, capital provisioning) is built on 1,000, so **0–1,000 is what's implemented**. The
300–900 figure appeared to be placeholder text.

---

## 7. What's proven, not just built

Three reference applicants are scored through the complete real pipeline — actual document
parsing, actual transaction classification, actual scoring. Nothing is pre-computed.

| Applicant profile | Score | Band | Outcome |
|---|---|---|---|
| Bank senior manager, 13 yrs experience, master's abroad, healthy finances | **778** | Prime | **Auto-approved** — NPR 25,00,000 at 1.00%/month |
| Freelance designer, 3 yrs experience, irregular income, thin file | **494** | Subprime | **Approved with conditions** — NPR 75,000 at 1.80%/month |
| Salary consumed by debt, 3 bounced cheques, 4 active loans | **296** | Reject | **Declined** |

The middle case matters most. That applicant would be refused by a collateral-based lender and
probably by a bureau-based one. Here they get a small, correctly-priced facility. **That is the
financial inclusion objective working in practice**, not in a mission statement.

### Performance

**72–120 milliseconds** end to end, against a specification budget of 4,000ms. Roughly forty times
faster than required.

### Resilience — tested by breaking it

I shut down the AI service mid-operation and re-ran the Prime applicant:

- Same score, computed identically
- Decision changed from **auto-approve** to **refer to underwriter**
- Flagged with the exact reason
- **Still produced a complete 5-and-3 factor explanation**, derived from the scorecard

That's the behaviour you want. A degraded system keeps working, refuses to approve on incomplete
information, and never hides that something was wrong.

### Test coverage

**351 automated tests.** Not coverage theatre — they pin down the things that matter:

- Every point in every scoring table, asserted against your document
- Overrides cannot be outscored — a perfect 1,000 with a sanctions match is still declined
- A degraded assessment never auto-approves, for every possible cause
- No financial ratio can ever produce an invalid number, for any input
- The nationality rule contributes zero and is still recorded
- A screen with no access rule written on it is closed, not open
- A generous override with no second signature writes nothing at all — and neither does a
  self-signed one, or one signed by someone without credit authority
- The powers to create staff and to approve credit never overlap
- A co-signer's password never reaches the audit record, though their identity always does
- A CV laid out in columns, or with a banner across the top, scores the same as plain text

On top of that, the access controls and the referral queue were exercised end to end against the
running system — 99 checks covering sign-in, lockout, session revocation, role separation, and the
full two-signature path from referral to recorded decision, including a check that the audit row
contains no password.

**The tests found seven real bugs during the build.** The most serious: every application was being
declined, because a newly created applicant defaults to "identity not yet verified", and the code
was treating *"we haven't checked"* as *"the check failed"*. That's a decline issued on a finding
nobody ever made — it would have rejected 100% of applicants in production, and it was caught by a
test rather than by a customer.

---

## 8. What is deliberately not built

I'd rather you hear this from me than discover it later.

| Not built | Why |
|---|---|
| **Two of the five specified AI models** (sequence model, graph network) | The graph model detects fraud rings across applicants — on day one your graph has one applicant in it. The sequence model needs long histories and real outcomes to train on. Both have their integration points ready and are the right Phase-2 conversation. |
| **Live identity verification, sanctions screening, national ID lookup** | These are third-party services requiring commercial contracts Fintara holds, not code. Each has a defined connection point; wiring a real vendor in is days, not weeks. |
| **Loan disbursement and core banking integration** | Out of scope for an assessment engine. |
| **Model drift monitoring** | Needs live production scores to compare against. Buildable the moment you have them. |
| **Single sign-on against a bank identity provider** | Logins and permissions are now built (section 9). Connecting them to a bank's own directory instead of this system's password store is the next step, and needs the bank's IT to be in the room. |
| **Automatic chasing of overdue referrals** | The review queue shows how long each application has been waiting and highlights anything past two business days. It does not yet *email* anyone about it — that needs a mail channel this system doesn't have. |
| **Reading scanned or photographed documents** | A PDF containing real text is read reliably whatever its layout (section 10). A photograph of a printed page contains no text to read, and extracting it needs a paid OCR service. The connection point is built; turning it on is a configuration setting and a contract. Until then, scans are refused clearly and sent to a human rather than half-read. |

---

## 9. Who can do what — and the referral queue

Two things that were missing when this document was first written are now built. Both were on the
"before any real applicant" list, and both are done.

### There is a login, and roles mean something

The system no longer opens to anyone who finds the address. Every screen and every request requires
a sign-in, and what a person can do depends on their role:

| Role | Can do |
|---|---|
| **Underwriter** | Capture applications, and decide referrals |
| **Senior underwriter** | The same, at a higher grade recorded on each decision |
| **Credit manager** | The same, plus co-sign another reviewer's generous override |
| **Compliance officer** | *Read* decisions, referrals and the staff list. Cannot decide or approve anything |
| **Administrator** | Create and revoke accounts. **Cannot approve credit or co-sign** |

That last line is deliberate and worth a sentence. If the person who creates user accounts could
also approve loans, they could invent an underwriter, approve a loan as them, and countersign it
themselves — which would make the two-signature rule decorative. Separating those two powers is what
makes the second signature mean something. The trade-off is that an administrator on their own cannot
lend; they set up the people who can.

Practical consequences worth knowing:

- Accounts are created with a temporary password and can do **nothing** until the holder replaces
  it. A password an administrator knows is not yet proof of who is acting.
- Revoking someone's access takes effect immediately, not whenever their browser session happens to
  expire. Same for changing someone's role.
- Five wrong passwords locks the account. An administrator can clear it.
- Nothing tells an attacker whether an email address belongs to a real member of staff.

### The referral queue exists

Section 3 said a referred applicant is told a human will decide within two business days. Until now
there was nothing behind that sentence — no queue, no screen, no way for an underwriter to act.

There is now. Referrals appear oldest-first, each showing how long it has been waiting and why the
engine referred it, with anything past 48 hours flagged. Opening one shows the underwriter *exactly*
what the engine produced — the same score, the same pillar breakdown, the same reasons, including
any warnings — rather than a tidied-up summary, because the caveats are the first thing a summary
drops.

To record a decision, the underwriter must write a justification. And if their decision is more
generous to the applicant than the engine's — a softer outcome, **or the same outcome for more
money** — a credit manager must co-sign it by entering their own password. Not their name typed in
by someone else: their own credential, checked against their own account. Refusing an application
the engine would have approved needs no second signature; that costs the applicant an opportunity,
not the bank a loss.

Product limits stay absolute. No combination of signatures can approve above the maximum your own
§1.2 sets for that product — that is a board decision, not an underwriting one.

Every review is stored with what the engine recommended, who decided, at what grade, who co-signed,
and the written reason. One record answers the question an auditor actually asks.

---

## 10. What documents it can read

Almost every CV and bank statement that will reach you is a PDF, so this deserves stating plainly.

| What you upload | Works? |
|---|---|
| PDF with real text in it — the normal output of Word, Google Docs, or a bank's online statement | **Yes** |
| Word document (.docx) | **Yes** |
| Spreadsheet export of a statement (.csv) | **Yes** |
| Plain text | **Yes** |
| **PDF that is really a photograph** — a phone snap or a flatbed scan of a printed page | **No, and it says so** |

**A CV's visual design does not affect the score.** This needed proving rather than assuming, so it
was measured: the same person's CV as plain text, as an ordinary single-column PDF, as a
two-column CV with a shaded sidebar, and as a CV with a coloured name banner across the top and two
columns beneath — all four produce **exactly the same score, to the point**. The same holds for a
bank statement supplied as a spreadsheet or as a PDF table.

That result is not free, and it is worth understanding why, because it was a genuine risk.

A PDF does not store lines of text. It stores individual pieces of text with a position on the page,
and the order they happen to be listed in is whatever the program that made the file chose. For a
two-column CV, that order commonly alternates between the columns — so read naively, the sidebar
gets shuffled into the middle of the work history. The system works out what a line means from the
heading above it, so shuffling destroys precisely the information it relies on.

There was a second, larger problem affecting *every* PDF, not just two-column ones. A PDF also
records a hard line break wherever the text happened to wrap at the edge of the page. So a job entry
that reads as one line in a Word document arrives split in two:

> Senior Manager - Corporate Credit, Nepal Investment Mega Bank Limited | Jan 2021 -
> **Present**

with the dates broken across the join — and a job whose dates cannot be read is not counted as a
job at all.

Together these were costing a real applicant up to 44 points out of 1,000 purely because of how
their CV was laid out. **That is enough to move someone across the Prime boundary at 750** and
change the rate and limit they are offered — and nothing in the output indicated the document's
design had anything to do with it. A silent mispricing is the worst kind, because nobody
investigates it.

The system now reconstructs the page from the position of the text rather than trusting the order,
and rejoins lines that the page edge broke. What it will *not* do is guess: where two readings of a
document are both plausible, it tries both and keeps the one that yields a coherent CV, rather than
committing to a rule that would be wrong on some layouts.

**On scans.** If someone photographs their CV, there is no text in the file to read — only pixels.
Reading those needs OCR, which is a paid third-party service; the connection point exists and is a
configuration setting away. Until then a scan is refused clearly, flagged three ways, and sent to a
human. It is never scored on whatever fragments could be salvaged, which is the failure that would
actually matter.

**What to do about it:** ask applicants for the PDF their bank or their word processor produced,
not a photograph of a printout. If a material share of your applicants can only supply scans, the
OCR service is worth contracting — but that is a volume question you can answer after the pilot,
not before.

---

## 11. What the launch model actually is

The AI model shipped today is trained on a **synthetically generated population** calibrated to
your own documented risk bands. It is tagged as such everywhere — in the database, in the API, and
visibly in the dashboard — so nobody can mistake it for a model trained on real lending outcomes.

It scores **0.77** on the standard discrimination measure, against a theoretical maximum of **0.81**
for its own data — meaning it extracts about 95% of the signal available to it. Your governance
document sets a target of 0.85, and I want to be explicit: **that target belongs to a model trained
on real repayment data, and this model does not meet it.** It isn't supposed to.

**The single highest-value thing to build next is capturing repayment outcomes.** Every
improvement to the AI side depends on it, and nothing else in the model roadmap can start without
it.

---

## 12. How it's put together

Four components, each doing one job.

```
   Applicant's browser
          │
   ┌──────▼───────┐   Dashboard — upload, score, explanation
   │   Next.js    │
   └──────┬───────┘
          │
   ┌──────▼───────┐   The engine — reads documents, computes the 38 measures,
   │   NestJS     │   runs the scorecard, applies policy, decides, records
   └───┬──────┬───┘
       │      │
┌──────▼──┐ ┌─▼─────────┐
│PostgreSQL│ │  Python   │  AI risk model + explanations
│ 20 tables│ │  FastAPI  │  (shadow mode)
└──────────┘ └───────────┘
```

**Why the AI is a separate service:** it can be scaled, updated, or replaced without touching the
decision engine — and when it fails, the engine keeps working. That separation is what made the
resilience test in section 7 pass.

### The piece I'm most confident about

The riskiest bug in any system like this is invisible. Financial measures are calculated in one
language and consumed by the AI model in another. If the two ever disagree about which value is
which — measure #12 means "savings rate" on one side and "debt ratio" on the other — **nothing
errors**. Every prediction just quietly becomes wrong, and you find out from your loss rate months
later.

This is prevented structurally rather than by testing. There is exactly **one** file defining the
38 measures and their order. All three consumers — the engine, the AI service, and the training
process — read that same file. Disagreement isn't unlikely; it's impossible. And every request
carries a version stamp, so a mismatched model refuses to score rather than scoring wrongly.

---

## 13. Where things are

```
PROJECT-OVERVIEW.md          You are here
README.md                    How to run it
docs/
  01-data-dictionary.md      Every database field and measure, with reasoning
  02-scoring-methodology.md  Every scoring rule mapped to your document clause-by-clause,
                             and every ambiguity found and how it was resolved
  03-ai-model-landscape...md What the leading lenders (Klarna, Affirm) actually use in 2026,
                             with sources — answers your "find the latest AI models" question
  04-bank-deployment-readiness.md
                             What changes between this pilot and a real bank deployment.
                             Records what was missing, what has since been built (logins,
                             roles, the review queue), and what remains: NRB sign-off,
                             key custody, redundancy, core banking
samples/                     Three test applicants: CV + bank statement each
apps/api                     The decision engine
  src/auth/                    Logins, roles, staff accounts
  src/underwriter/             The referral queue and its two-signature rule
apps/ml                      The AI risk model
apps/web                     The dashboard
  src/app/queue/               The referral queue and review screens
  src/app/staff/               Staff account administration
packages/contracts           The shared definitions — the single source of truth
  src/staff.ts                 Roles, who may approve what, and the rule that decides
                               when a second signature is required
```

**Scale:** roughly 23,450 lines across 110 files. Zero known security vulnerabilities in anything
that ships to production.

---

## 14. Running it

```bash
docker compose up -d
```

Then open <http://localhost:3000>. The database and trained model persist between restarts.

You will be asked to sign in. The first time, the setup step creates a single administrator account
from credentials you put in the configuration file — it must set its own password before it can do
anything, and it cannot approve credit. Use it to create an underwriter and a credit manager; you
need both, because a generous override has to be co-signed by a second person.

Then test it with any matching pair from `samples/`. Full detail, including the exact commands, is in
`README.md`.

---

## 15. My recommendation on next steps

| Priority | Action | Why |
|---|---|---|
| ~~1~~ | ~~Add authentication and user roles~~ | **Done** — see section 9. |
| **1** | **Build repayment-outcome capture** | Now the top item. Everything on the AI roadmap depends on it, and it takes months to accumulate data — so the clock should start before anything else on this list. |
| **2** | Get Legal to formally withdraw the nationality clause | Removes a live fair-lending exposure from your policy. Costs a meeting, not a sprint. |
| **3** | Contract the three verification vendors | Identity, sanctions, national ID. Connection points are ready. |
| **4** | Run shadow mode with real applications | Your roadmap's Phase 3. The system generates scores, humans decide, and you measure agreement before delegating anything. The referral queue in section 9 is what the humans use. |
| **5** | Then promote the AI model | Once 500 real outcomes exist. Governance framework is already built. |

Before real customer data — as opposed to a controlled pilot — there is a separate infrastructure
list: proper key custody, encrypted database connections, a hardened front door, redundancy and
backups, and an independent penetration test. Those are environment and vendor decisions rather
than code, and they are set out in
[`docs/04-bank-deployment-readiness.md`](docs/04-bank-deployment-readiness.md).

---

## In summary

You have a working, tested, explainable credit decisioning engine that assesses an applicant from
a CV and a bank statement in under a fifth of a second, prices them against your approved risk
bands, and produces the audit trail a regulator will ask for.

It is honest about two things: the AI model has not yet earned the right to make decisions, and
three external verification services still need commercial contracts. Neither blocks a pilot.

The login screen and the referral queue that this document previously listed as blockers are built —
with roles, a two-signature rule on generous overrides, and an audit record behind every decision.

What it needs from you now: **a decision on the nationality clause, and a start on capturing
repayment outcomes.** The second one is the only item on the list that gets more expensive the
longer it waits, because no amount of engineering can retroactively create a year of repayment
history.

---

*CONFIDENTIAL — Fintara Solutions Pvt Ltd. Contains no real applicant data; all samples are
synthetic.*
