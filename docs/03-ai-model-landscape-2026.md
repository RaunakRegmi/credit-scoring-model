# AI Models in Consumer Credit — What the Leading Lenders Actually Use (2026)

**Prepared for:** Fintara Solutions Pvt Ltd — AI & Technology Division
**Purpose:** Answers the brief's requirement to *"find the latest AI models being used by the best
financing companies"*, and states plainly which of those choices the AICS Model adopts, which it
defers, and why.

---

## 1. The headline finding: the shift is in the *data*, not the algorithm

The most consequential change in consumer lending over the last few years is not a new model
architecture. It is **cash-flow underwriting** — assessing an applicant from their bank
transaction history rather than from a bureau score.

This is now the mainstream position rather than an experiment:

- **Affirm** underwrites at the point of sale from real-time transaction data, and has publicly
  credited cash-flow underwriting with driving Affirm Card adoption.
- **Klarna** combines a traditional soft credit check with in-journey purchase behaviour. The
  economics reported for this combined approach — roughly 70% approval at around 4% loss — are the
  benchmark a BNPL book is measured against.
- **Plaid**, **Nova Credit** (Cash Atlas) and **Heron Data** have productised transaction
  categorisation specifically so lenders can build underwriting variables from it.
- **FinRegLab** has published sustained research on cash-flow data in underwriting, and in April
  2026 issued a framework for managing ML underwriting models.
- In Europe, banks are building the capability against the **CCD2 compliance deadline in November
  2026**.

**What this means for ONE BNPL:** the AICS Model's core premise — score the applicant from six
months of bank statements plus a CV — is not a workaround for Nepal's thin bureau coverage. It is
the same direction the global market has moved in, and it happens to suit a market where bureau
files are sparse. §3.2 of the technical document is the strongest part of the design.

---

## 2. Algorithms: gradient boosting remains the standard for tabular credit risk

| Family | Where it genuinely earns its place | Verdict for AICS |
|---|---|---|
| **Gradient-boosted trees** (XGBoost, LightGBM, CatBoost) | Cross-sectional tabular data. The de facto standard; consistently matches or beats deep learning on tabular credit datasets, trains in minutes on CPU, and is straightforward to constrain and explain. | **Adopted.** XGBoost with monotonic constraints. |
| **Logistic regression / scorecards** | Small datasets, and anywhere the decision must be reconstructable by hand. Still the most practical production choice on thin data. | **Adopted as the primary decision-maker.** See §4. |
| **Sequence models** (LSTM, GRU, temporal transformers) | Genuinely sequential data that aggregation destroys. Results are real but mixed — some studies show tabular transformers matching or beating GBDT, others find GBDT ahead. | **Deferred.** See §5. |
| **Graph neural networks** | Fraud rings and entity-relationship risk, where the signal is in the graph and not in any single row. This is Ant Financial's territory. | **Deferred.** See §5. |
| **LLMs** | Document understanding — turning an unstructured CV or a scanned statement into structured fields. This is where LLMs are unambiguously the right tool. | **Adopted for extraction only** (§3.1), never for the credit decision. |

### Monotonic constraints are the practice that makes GBDT defensible

A gradient-boosted tree left unconstrained will learn locally non-monotone quirks from noise — a
region where a *higher* debt service ratio maps to a *lower* predicted default risk. That is
indefensible to a regulator and impossible to explain to an applicant, no matter how good the SHAP
output looks.

Monotonicity constraints solve this properly by encoding domain knowledge into the model
structure: higher DSR can never decrease predicted risk, higher balances can never increase it.
The industry treats this as the standard way to constrain ML credit models.

**AICS applies constraints to 37 of its 38 features**, taken directly from the shared feature
manifest, and the training job *empirically verifies* them before it will write a model artifact.
`train/train.py` fails the build rather than shipping a model that violates its own constraints.

### SHAP is the accepted explainability mechanism

SHAP-based feature attribution links a prediction to the applicant characteristics that produced
it, and is the recognised way to make tree ensembles auditable. §6.3's requirement for top-5
positive and top-3 negative factors is well-aligned with current practice.

One implementation detail worth stating: SHAP values are additive in **log-odds**, not in
probability. AICS therefore verifies additivity against the raw model margin, applies isotonic
calibration *after* the attribution step, and stores the full SHAP payload for inspection.

---

## 3. The regulatory environment has hardened, and it favours this design

Three developments make explainability a compliance requirement rather than a nice-to-have:

- **EU AI Act** — obligations effective **August 2026**. Credit scoring is high-risk; decisions
  must be reconstructable after the fact.
- **Colorado AI Act** — effective **June 2026**, with similar reconstruction duties.
- **FinRegLab's April 2026 framework** for managing ML underwriting models, which is becoming the
  reference for model risk management practice.

"Reconstructable after the fact" is a demanding requirement. It is not satisfied by logging a
score. It requires the input features, the model version, the policy version and the output to be
recoverable together, years later, by something that is not the original codebase.

**This is why `DecisionAudit.inputSnapshot` stores the complete feature vector alongside every
version identifier, as plain JSON scalars.** It is the single design decision in AICS most
directly driven by 2026 regulation.

---

## 4. Where AICS departs from the source document, and why

The technical document specifies five trained models (§6.1). Two departures were made
deliberately, and both were agreed before implementation.

### 4.1 The scorecard decides; the ML model shadows

**There is no labelled repayment history yet.** §11 collects 1,000+ historical cases in Phase 2;
§6.4 requires 500 labelled outcomes before a retrain. A gradient-boosting model trained today has
never seen a real default.

Shipping such a model as the decision-maker would be indefensible. Shipping *nothing* would waste
the pipeline. So AICS does both, honestly:

- The **deterministic four-pillar scorecard** decides. It is fully auditable, correct from the
  first application, and reproducible by hand from the §4.2–4.5 tables.
- The **XGBoost model** runs in shadow mode on every application. Its PD is recorded, monitored
  and compared, but does not drive the outcome.
- Where the two **disagree** beyond a configured threshold, the application goes to a human. Two
  artefacts derived by different means disagreeing about the same applicant is a real signal.
- Every artefact is tagged `SYNTHETIC_SEED`, and that tag is surfaced through the API into the
  dashboard. Nobody can mistake the launch model for a data-trained one.

This mirrors the shadow-mode discipline in §11 Phase 3 of the roadmap, applied to the model rather
than to the whole system.

### 4.2 Honest metrics for a synthetic model

The seed model reports **AUC 0.772** against a **Bayes ceiling of 0.814** — it captures ~95% of
the signal available in its own training data. §9.1 sets a green threshold of AUC > 0.85, and it is
important to be clear that **the seed model does not meet it and cannot be expected to**: that
threshold belongs to a model trained on real outcomes.

Reporting AUC without the ceiling would invite the wrong conclusion. Labels are Bernoulli draws,
so no model — however good — can separate a 12% borrower who defaulted from an 11% borrower who
did not.

---

## 5. What is deliberately deferred

| Component | Status | Rationale |
|---|---|---|
| **LSTM / temporal transformer** (§6.1 Sequence Analyser) | Interface slot exists; not implemented. | Well-engineered aggregate and trend features over six months capture most of the available signal, and GBDT handles them better. Sequence models earn their cost on longer, denser histories with labels to train against. Revisit after Phase 2. |
| **Graph neural network** (§6.1 Social Risk Engine) | Interface slot exists; not implemented. | A GNN needs a populated entity graph — shared addresses, employers, devices, references across many applicants. On day one that graph has one node. Its real value is fraud-ring detection, which becomes possible once the portfolio has volume. |
| **Live KYC face match / liveness** (§3.3.2) | Port with stub adapter. | Third-party vendor integration. |
| **AML/CFT watchlist screening** (§10.3) | Port with stub adapter. | Requires a sanctions data subscription. |
| **NID verification API** | Port with stub adapter; tri-state status modelled. | Requires a government integration. |

Every deferred item sits behind an interface, so adding it later does not touch its callers.

---

## 6. Practical recommendations for Phases 2–6

1. **Instrument outcomes from day one.** The single highest-value thing to build next is the
   repayment-outcome capture that turns the shadow model into a real one. Without labelled
   outcomes, no amount of model sophistication helps.
2. **Beware reject inference.** Once auto-approval is live, the model only observes approved
   applicants. Retraining naively on that population bakes in the current policy's blind spots.
   Plan for it before Phase 5.
3. **Add LightGBM as the challenger.** §6.4 requires champion/challenger. LightGBM supports the
   same monotonic constraints and trains faster, making it the natural counterpart to the
   incumbent XGBoost model.
4. **Track PSI per feature, not only overall.** §9.1 sets a PSI alert at 0.25. Aggregate PSI hides
   the case where one feature's distribution has shifted sharply while the total looks calm.
5. **Keep the scorecard even after the model is promoted.** It is the fallback that lets the system
   keep deciding when the model is unavailable, and the reference that makes divergence
   meaningful. Its ongoing value is operational, not just transitional.
6. **Revisit the fair-lending exception.** The nationality adjustment in SOP-002 step 25 ships
   disabled. It should be formally withdrawn from the SOP rather than left dormant in
   configuration — see `docs/02-scoring-methodology.md`.

---

## Sources

- [FinRegLab — Framework for Managing Machine Learning Models in Consumer Credit Underwriting (April 2026)](https://finreglab.org/wp-content/uploads/2026/04/FinRegLab_04-09-2026_Framework-for-Managing-Machine-Learning-Models.pdf)
- [FinRegLab — Machine Learning Underwriting Models & Cash-Flow Data](https://finreglab.org/research/machine-learning-underwriting-models-cash-flow-data/)
- [FinRegLab — AI FAQs: Explainability in Credit Underwriting](https://finreglab.org/research/ai-faqs-explainability-in-credit-underwriting/)
- [Provenir — Constraining Machine Learning Credit Decision Models](https://www.provenir.com/blog-constraining-machine-learning-credit-decision-models/)
- [Oscilar — AI in Credit Underwriting: Deploying Systems That Hold Up Under Scrutiny](https://oscilar.com/blog/ai-credit-underwriting)
- [Fintech Takes — Mapping the Cash Flow Lending Adoption Curve (February 2026)](https://fintechtakes.com/articles/2026-02-25/mapping-the-cash-flow-lending-adoption-curve/)
- [Prestatech — Cash Flow Underwriting for European Banks](https://www.prestatech.com/blog/cash-flow-underwriting-for-european-banks-the-complete-guide-to-transaction-based-credit-decisioning)
- [MDPI, Journal of Risk and Financial Management — Performance Evaluation of Machine Learning and Deep Learning Models for Credit Risk Prediction](https://www.mdpi.com/1911-8074/19/3/210)
- [MDPI, Information — Deep Learning for Credit Risk Prediction: A Survey](https://www.mdpi.com/2078-2489/17/4/395)
- [IJCT — Explainable Credit Risk Assessment: Comparing Logistic Regression, XGBoost and LightGBM with SHAP and LIME](https://ijctjournal.org/explainable-credit-risk-assessment/)
- [arXiv — What's the Price of Monotonicity? A Multi-Dataset Benchmark](https://arxiv.org/pdf/2512.17945)
- [arXiv — Challenging Gradient Boosted Decision Trees with Tabular Transformers for Fraud Detection at Booking.com](https://arxiv.org/pdf/2405.13692)
- [Nova Credit — Cash Atlas cash-flow underwriting](https://markets.financialcontent.com/workboat/article/bizwire-2022-5-3-nova-credit-introduces-cash-atlas-a-cash-flow-underwriting-solution-that-allows-businesses-to-lend-more-responsibly-using-bank-transaction-data)
