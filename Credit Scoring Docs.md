Fintara Solutions Pvt Ltd / ONE BNPL

AI Credit Scoring Model — Technical & Functional Document

# **FINTARA SOLUTIONS PVT LTD**

### **ONE BNPL**

## **AI-POWERED CREDIT SCORING MODEL**

**Technical & Functional Document and Standard Operating Procedures** For Auto-Approval of Unsecured Lending Products _Personal Loan | Hire Purchase | BNPL | Auto Loan_

| **Document Reference** | FSL/ONEBNPL/AICS/2026/001                               |
| ---------------------- | ------------------------------------------------------- |
| **Version**            | v1.0 — Initial Release                                  |
| **Date**               | May 2026                                                |
| **Prepared by**        | Fintara Solutions Pvt Ltd — AI &<br>Technology Division |
| **Classification**     | **CONFIDENTIAL — Board & Senior**<br>**Management**     |
| **Submission to**      | Board of Directors & Senior<br>Management Committee     |

#### **1. Executive Summary**

This document presents the technical architecture, functional design, and standard operating procedures for the ONE BNPL Artificial Intelligence-based Credit Scoring Model (AICS Model). The AICS Model is a proprietary multi-pillar risk assessment engine developed by Fintara Solutions Pvt Ltd to enable fully automated credit decisions for unsecured lending products including Buy Now Pay Later (BNPL), Personal Loans, Hire Purchase, and Auto Loans.

The model ingests applicant data from three primary sources — Curriculum Vitae / Resume, Bank Account Statements, and KYC Documents — and applies a four-pillar scoring framework encompassing Financial, Professional, Social, and Behavioral dimensions. The output is a composite credit score on a 1,000-point scale that drives instant, explainable, and auditable lending decisions.

This document is prepared for management and board review and approval to authorise the deployment of the AICS Model as the primary credit assessment mechanism for unsecured lending operations.

#### MORE DETAILED PROMPT

Prepare AI credit scoring model for accessing credit worthiness for unsecured lending or hire purchase financing thru ONE BNPL with data source from uploaded resume, bank account statement. First prepare database table to insert major parameters of resume & bank account statement, which can be used for dynamic credit scoring based on financial information (like average balance in account for last 6 months, withdrawal & deposits, consistent credit in bank account like salary, remittances, rentals, credit card payments, loan installment payments, insurance premium payments etc.) Also from resume (Past salary, expected salary), job history, type of company (MNC, Banks, Corporate, Private, Salaried), number of years in employment if different positions, travel history or countries traveled, residence status, phone, email, father name, NID or citizenship details, trainings attended, references, educational status, institutions, domestic or abroad etc. After extraction of these information in database, prepare suggested AI models to use the information to dynamically access credit worthiness, repayment behavior, loan loss or non-repayment chances for such individuals based on risk scoring dynamically including financial, social, professional & behavior analysis. Find the latest AI models being used by the best financing companies.

##### **1.1 Key Benefits**

CONFIDENTIAL — FINTARA SOLUTIONS PVT LTS (ONEBNPL) INTERNAL USE ONLY May 2026

Page 1

Fintara Solutions Pvt Ltd / ONE BNPL

AI Credit Scoring Model — Technical & Functional Document

- Sub-2-second credit decisions eliminating manual underwriting delays of 3–7 business days

- Consistent, bias-free scoring based on 120+ quantitative parameters across four pillars

- Regulatory compliance through Explainable AI (XAI) with SHAP value justifications for every decision

- Estimated 35–45% reduction in credit loss rates vs traditional manual underwriting

- Enablement of financial inclusion for thin-file applicants using alternative data sources

- Full audit trail for NRB regulatory reporting, internal audit, and board oversight

##### **1.2 Products Covered**

| **Product**             | **Tenure**   | **Max Limit (NPR)** | **Target**<br>**Segment**    | **Decision**<br>**Mode** |
| ----------------------- | ------------ | ------------------- | ---------------------------- | ------------------------ |
| BNPL — Interest<br>Free | 3–18 months  | 10,00,000           | Salaried / Self-<br>employed | Auto-<br>approve         |
| Personal Loan           | 12–60 months | 25,00,000           | Salaried /<br>Business       | Auto / Refer             |
| Hire Purchase           | 12–36 months | 50,00,000           | Salaried /<br>Corporate      | Auto / Refer             |
| Auto Loan               | 12–60 months | 40,00,000           | Salaried /<br>Professional   | Auto / Refer             |
| Micro BNPL              | 1–6 months   | 50,000              | Students / Gig<br>workers    | Auto w/<br>guarantor     |

#### **2. Background and Regulatory Context**

##### **2.1 Market Rationale**

Nepal's credit market is characterized by heavy reliance on collateral-based lending, leaving a significant population of creditworthy individuals — salaried professionals, digital workers, small business owners, and young graduates — underserved due to the absence of traditional collateral or formal credit bureau histories. The Nepal Rastra Bank (NRB) has progressively encouraged digital lending through its fintech regulatory sandbox framework, Digital Nepal Strategy, and Payment Systems Regulations 2019.

ONE BNPL by Fintara Solutions has demonstrated market viability with 10+ commercial bank partnerships and 150+ merchant integrations. The AICS Model is the logical next step: extending the credit assessment capability from credit-card-linked BNPL to standalone unsecured lending using AI-driven risk scoring.

##### **2.2 Regulatory Alignment**

- Nepal Rastra Bank (NRB) Unified Directives — Digital Lending and Financial Technology Guidelines

- NRB Financial Intermediary Act — Credit Risk Management Framework

- Electronic Transactions Act 2063 (Nepal) — digital document validity

CONFIDENTIAL — FINTARA SOLUTIONS PVT LTS (ONEBNPL) INTERNAL USE ONLY

Page 2

May 2026

Fintara Solutions Pvt Ltd / ONE BNPL

AI Credit Scoring Model — Technical & Functional Document

- Individual Privacy Act 2075 — personal data protection requirements

- Anti-Money Laundering / Combating the Financing of Terrorism (AML/CFT) Framework

- Basel III Capital Adequacy requirements for credit risk-weighted assets

- IRD (Inland Revenue Department) digital billing compliance for transaction records

##### **2.3 Benchmark Reference Models**

The AICS Model draws on methodologies from leading global BNPL and AI credit scoring practitioners:

| **Institution**          | **AI Model Approach**                | **Relevance to AICS**              |
| ------------------------ | ------------------------------------ | ---------------------------------- |
| Klarna (Sweden)          | XGBoost ensemble + behavioural<br>ML | Real-time BNPL scoring at scale    |
| Affirm (USA)             | Custom ML + income verification AI   | Repayment prediction methodology   |
| MNT-Halan (Egypt)        | Behavioural + transactional scoring  | Emerging market thin-file approach |
| Ant Financial<br>(China) | GNN fraud + Zhima social credit      | Social pillar scoring architecture |
| Kueski (Mexico)          | Digital behaviour + payment history  | Entry-level borrower scoring       |

#### **3. Data Sources and Ingestion Architecture**

The AICS Model uses three primary data source types, each processed through dedicated AI extraction pipelines before being stored in the structured applicant database.

##### **3.1 Source 1: Resume / Curriculum Vitae**

###### **3.1.1 Extraction Method**

Resumes submitted in PDF, DOCX, or image formats are processed through a Large Language Model (LLM) pipeline using Named Entity Recognition (NER), Optical Character Recognition (OCR), and structured JSON extraction. The model identifies and extracts the following data categories:

| **Data Category**   | **Parameters Extracted**                                                             | **Scoring Relevance**                     |
| ------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------- |
| Personal identity   | Full name, DOB, gender, father<br>name, NID, passport, nationality                   | KYC verification, social pillar           |
| Contact & residence | Phone, email, current address,<br>permanent address, residence<br>status             | Identity verification, fraud<br>detection |
| Employment history  | Employer names, types<br>(MNC/Bank/Corporate/Govt/SME),<br>titles, tenure, countries | Professional pillar — primary<br>driver   |
| Salary information  | Past salary, expected salary,<br>salary progression, currency                        | Financial capacity estimation             |

CONFIDENTIAL — FINTARA SOLUTIONS PVT LTS (ONEBNPL) INTERNAL USE ONLY

Page 3

May 2026

Fintara Solutions Pvt Ltd / ONE BNPL

AI Credit Scoring Model — Technical & Functional Document

| **Data Category**    | **Parameters Extracted**                                                                | **Scoring Relevance**                    |
| -------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------- |
| Education            | Degree level, institution, country<br>(domestic/international),<br>graduation year, GPA | Professional pillar — education<br>score |
| Skills & trainings   | Certifications, professional<br>training, skill categories, issuing<br>organisation     | Professional pillar — skills<br>premium  |
| Travel history       | Countries visited, visa types,<br>travel purpose, frequency                             | Social pillar — mobility score           |
| References           | Reference names, designations,<br>organisations, contact,<br>relationship type          | Social pillar — reference<br>quality     |
| Awards & recognition | Industry awards, institutional<br>recognitions, publication history                     | Social pillar — premium signal           |

##### **3.2 Source 2: Bank Account Statements**

###### **3.2.1 Extraction & Processing**

Bank statements submitted as PDF, CSV, or via Open Banking API are parsed using a specialized financial document AI pipeline. All transactions are automatically categorized using AI classification with confidence scoring. The following financial parameters are extracted and computed:

| **Financial Parameter**   | **Computation Method**                                            | **Months**<br>**Required** | **Scoring Pillar**          |
| ------------------------- | ----------------------------------------------------------------- | -------------------------- | --------------------------- |
| Average daily balance     | Sum of closing<br>balances / trading days                         | 6 months<br>minimum        | Financial — 80 pts          |
| Salary credit consistency | Recurring credit<br>detection + timing<br>analysis                | 6 months                   | Financial — 60 pts          |
| Total monthly credits     | Sum of all inbound<br>transactions per month                      | 6 months                   | Financial — income          |
| Remittance income         | Foreign credit<br>identification + pattern<br>matching            | 6 months                   | Financial + Social          |
| Rental income             | Recurring non-salary<br>credits from consistent<br>counterparties | 6 months                   | Financial                   |
| EMI / loan obligations    | Outward recurring fixed-<br>amount debits to FIs                  | 6 months                   | Debt service ratio          |
| Credit card payments      | Card company<br>credits/debits<br>identification                  | 6 months                   | Behavioral                  |
| Insurance premiums        | Recurring debits to<br>insurance counterparties                   | 6 months                   | Behavioral —<br>reliability |
| ATM withdrawals           | Cash withdrawal<br>patterns, frequency,<br>amounts                | 6 months                   | Behavioral — cash<br>usage  |

CONFIDENTIAL — FINTARA SOLUTIONS PVT LTS (ONEBNPL) INTERNAL USE ONLY

Page 4

May 2026

Fintara Solutions Pvt Ltd / ONE BNPL

AI Credit Scoring Model — Technical & Functional Document

| **Financial Parameter**  | **Computation Method**                                   | **Months**<br>**Required** | **Scoring Pillar**           |
| ------------------------ | -------------------------------------------------------- | -------------------------- | ---------------------------- |
| Bounce / overdraft count | Returned cheques, OD<br>incidents, NSF events            | 6 months                   | Financial —<br>negative flag |
| Debt-to-income ratio     | Total monthly obligations<br>/ average monthly<br>income | 6 months                   | Financial — key<br>ratio     |
| Savings rate             | (Credits - Debits) /<br>Credits, monthly avg             | 6 months                   | Behavioral —<br>savings      |
| Cash buffer months       | Average balance /<br>average monthly spend               | 6 months                   | Financial — liquidity        |

##### **3.3 Source 3: KYC Documents**

###### **3.3.1 Documents Required**

- National Identity Card (NID) or Citizenship Certificate — front and back

- Passport (if available — adds international mobility score)

- PAN Card (for income tax linkage and formal sector verification)

- Recent utility bill or bank letter confirming current address

- Employer Identity Card or appointment letter (for employed applicants)

- Business registration certificate (for self-employed applicants)

###### **3.3.2 KYC AI Processing**

KYC documents are processed through an OCR + AI validation pipeline with the following checks:

- Face match between selfie and ID document photograph using facial recognition AI (>95% confidence threshold)

- Document authenticity verification — font consistency, MRZ line validation, hologram pattern analysis

- NID number format validation against Nepal national ID schema

- Cross-reference of name, DOB, and address across all submitted documents (tolerance: minor transliteration variations)

- Liveness detection to prevent deepfake or static photo submission

- Blacklist / watchlist screening against AML/CFT databases

CONFIDENTIAL — FINTARA SOLUTIONS PVT LTS (ONEBNPL) INTERNAL USE ONLY May 2026

Page 5

Fintara Solutions Pvt Ltd / ONE BNPL

AI Credit Scoring Model — Technical & Functional Document

#### **4. Four-Pillar AI Credit Scoring Model**

The AICS Model computes a composite credit score on a scale of 0–1,000 across four independently weighted pillars. Each pillar is scored by dedicated AI sub-models and fed into a meta-learner ensemble that produces the final probability of default (PD) and credit decision.

##### **4.1 Scoring Architecture Overview**

| **Pillar**   | **Max Score** | **Weight** | **Primary Data**<br>**Source** | **AI Sub-model**         |
| ------------ | ------------- | ---------- | ------------------------------ | ------------------------ |
| Financial    | 300 pts       | 30%        | Bank statements                | XGBoost + LSTM           |
| Professional | 250 pts       | 25%        | Resume / CV                    | LLM NER + Rule<br>engine |
| Social       | 200 pts       | 20%        | Resume + KYC +<br>GNN          | Graph Neural<br>Network  |
| Behavioral   | 250 pts       | 25%        | Bank statements +<br>Resume    | LSTM +<br>Transformer    |
| TOTAL        | 1,000 pts     | 100%       | All three sources              | Ensemble meta-<br>model  |

##### **4.2 Pillar 1 — Financial Scoring (300 points)**

| **Sub-parameter**            | **Max Pts** | **Threshold**<br>**for Max** | **Scoring Logic**                                                   |
| ---------------------------- | ----------- | ---------------------------- | ------------------------------------------------------------------- |
| Average balance (6 months)   | 80          | NPR<br>2,00,000+             | Linear scale from 0 to max; capped<br>at top threshold              |
| Salary credit consistency    | 60          | 6/6 months<br>regular        | Proportional to months with verified<br>salary credit               |
| Debt service ratio (DSR)     | 50          | DSR < 30%                    | Inverse scoring: DSR 30-40% =<br>35pts, 40-50% = 20pts, >50% = 5pts |
| Savings rate                 | 40          | > 20%<br>savings rate        | Avg (credits-debits)/credits over 6<br>months                       |
| Payment punctuality          | 40          | Zero late<br>payments        | Each EMI/card/utility late payment<br>deducts 8pts                  |
| Bounce / overdraft incidents | 30          | Zero incidents               | Each bounce deducts 10pts; >3 =<br>pillar cap at 180                |

##### **4.3 Pillar 2 — Professional Scoring (250 points)**

| **Sub-parameter**         | **Max Pts** | **Top Score**<br>**Criteria** | **Employer Type Premium**                                                |
| ------------------------- | ----------- | ----------------------------- | ------------------------------------------------------------------------ |
| Employer type quality     | 60          | MNC /<br>Central<br>Bank / UN | MNC=100, Comm. Bank=95,<br>Corporate=80, Govt=75, SME=55,<br>Informal=30 |
| Total years of experience | 50          | 20+ years                     | Linear 0-20 yrs; bonus +5pts for 25+<br>yrs                              |

CONFIDENTIAL — FINTARA SOLUTIONS PVT LTS (ONEBNPL) INTERNAL USE ONLY

Page 6

May 2026

Fintara Solutions Pvt Ltd / ONE BNPL

AI Credit Scoring Model — Technical & Functional Document

| **Sub-parameter**        | **Max Pts** | **Top Score**<br>**Criteria**  | **Employer Type Premium**                                                                     |
| ------------------------ | ----------- | ------------------------------ | --------------------------------------------------------------------------------------------- |
| Career progression index | 50          | Consistent<br>upward           | Regression on role seniority over<br>time; stagnation = deduction                             |
| Salary trajectory        | 40          | Consistent<br>growth<br>>8%/yr | YoY salary growth rate vs industry<br>benchmarks                                              |
| Education quality        | 30          | Masters/PhD<br>abroad          | PhD-intl=30, Masters-intl=27,<br>Masters-local=23, Bach-intl=20,<br>Bach-local=16, Diploma=10 |
| Skills & certifications  | 20          | 5+<br>professional<br>certs    | International certs (VISA, SWIFT,<br>CFA, etc.) = 5pts each; local = 2pts                     |

##### **4.4 Pillar 3 — Social Scoring (200 points)**

| **Sub-parameter**                 | **Max Pts** | **Top Score**<br>**Criteria**       | **Scoring Notes**                                                        |
| --------------------------------- | ----------- | ----------------------------------- | ------------------------------------------------------------------------ |
| International travel history      | 40          | 15+ countries                       | 5pts per 3 countries visited; visa type<br>premium (Schengen/US/UK = 2x) |
| Reference quality                 | 40          | C-suite / CEO<br>/ Director         | Reference tier score \* weight; max 2<br>references counted              |
| Institutional network tier        | 35          | World Bank /<br>UN / Intl FIs       | Employer network maps to<br>institutional prestige score                 |
| Residence stability               | 30          | 3+ years at<br>confirmed<br>address | Owner-occupied > rented; KYC-<br>verified address                        |
| Personal identity<br>completeness | 30          | All KYC docs<br>verified            | NID + passport + PAN + address =<br>max; each missing doc = -7pts        |
| Industry awards / recognition     | 25          | 3+<br>international<br>awards       | International = 5pts, national = 3pts,<br>company-level = 1pt each       |

##### **4.5 Pillar 4 — Behavioral Scoring (250 points)**

| **Sub-parameter**            | **Max Pts** | **Top Score**<br>**Criteria**          | **Behavioral Signal**                                              |
| ---------------------------- | ----------- | -------------------------------------- | ------------------------------------------------------------------ |
| Average employer tenure      | 60          | 5+ years per<br>employer               | Long tenures signal stability;<br>frequent job changes = deduction |
| Income diversification index | 50          | 3+<br>independent<br>income<br>streams | Multiple stable income sources lower<br>default risk               |
| Repayment track record       | 50          | Zero late /<br>zero NPA                | Derived from bank statement<br>EMI/card payment patterns           |
| Spending pattern discipline  | 40          | Discretionary<br><40% of<br>income     | Ratio of discretionary vs essential<br>spend over 6 months         |

CONFIDENTIAL — FINTARA SOLUTIONS PVT LTS (ONEBNPL) INTERNAL USE ONLY May 2026

Page 7

Fintara Solutions Pvt Ltd / ONE BNPL

AI Credit Scoring Model — Technical & Functional Document

| **Sub-parameter**                   | **Max Pts** | **Top Score**<br>**Criteria**     | **Behavioral Signal**                                        |
| ----------------------------------- | ----------- | --------------------------------- | ------------------------------------------------------------ |
| Financial self-management           | 30          | Consistent<br>savings<br>behavior | Savings detected in 5/6 months = full<br>score               |
| Geographic mobility /<br>resilience | 20          | Multi-country<br>career history   | Employment across multiple<br>countries signals adaptability |

#### **5. Risk Band Classification and Credit Decision Matrix**

##### **5.1 Risk Band Mapping**

| **Risk Band** | **Score**<br>**Range** | **PD Range** | **Decision**             | **BNPL Max**<br>**Limit** | **HP / PL Max**<br>**Limit** |
| ------------- | ---------------------- | ------------ | ------------------------ | ------------------------- | ---------------------------- |
| Elite Prime   | 900–1000               | < 1.0%       | Auto Approve             | NPR<br>10,00,000          | NPR 50,00,000                |
| Prime         | 750–899                | 1.0–3.5%     | Auto Approve             | NPR<br>5,00,000           | NPR 25,00,000                |
| Near Prime    | 600–749                | 3.5–8.0%     | Approve —<br>Standard    | NPR<br>2,50,000           | NPR 10,00,000                |
| Subprime      | 450–599                | 8.0–20.0%    | Approve w/<br>Conditions | NPR 75,000                | NPR 3,00,000                 |
| High Risk     | 300–449                | 20–40%       | Refer to<br>Underwriter  | NPR 25,000\*              | Refer only                   |
| Reject        | < 300                  | > 40%        | Decline                  | Not eligible              | Not eligible                 |

_\* High Risk BNPL micro-limit only with creditworthy guarantor co-signature_

##### **5.2 Interest Rate Schedule by Risk Band**

| **Risk Band** | **BNPL Rate**<br>**/mo** | **Personal**<br>**Loan /mo** | **Hire Purchase**<br>**/mo** | **Processing Fee** |
| ------------- | ------------------------ | ---------------------------- | ---------------------------- | ------------------ |
| Elite Prime   | 0.9%                     | 1.0%                         | 0.75%                        | 0.5% of limit      |
| Prime         | 1.2%                     | 1.3%                         | 1.0%                         | 0.75% of limit     |
| Near Prime    | 1.5%                     | 1.6%                         | 1.2%                         | 1.0% of limit      |
| Subprime      | 1.8%                     | 2.0%                         | 1.5%                         | 1.5% of limit      |
| High Risk     | 2.4%                     | 2.8%                         | 2.0%                         | 2.0% of limit      |

CONFIDENTIAL — FINTARA SOLUTIONS PVT LTS (ONEBNPL) INTERNAL USE ONLY May 2026

Page 8

Fintara Solutions Pvt Ltd / ONE BNPL

AI Credit Scoring Model — Technical & Functional Document

##### **5.3 Mandatory Override Conditions**

Regardless of composite score, the following conditions trigger a mandatory Decline or Hold:

- AML/CFT watchlist match — immediate decline, escalation to Compliance Officer

- KYC face match failure (<90% confidence) — document hold, manual review required

- NID verification failure — decline pending document resubmission

- Active bankruptcy or court attachment found in public records

- Three or more current active loans detected across institutions (overleveraging flag)

- Fraudulent document flag raised by OCR authenticity engine

- DSR > 60% of verified gross income — mandatory underwriter referral

#### **6. AI Model Technical Architecture**

##### **6.1 Model Stack Overview**

The AICS Model is an ensemble of five specialised AI/ML models, each handling a specific aspect of the credit assessment pipeline. These are coordinated by a meta-learner that produces the final output.

| **Model**<br>**Component** | **Algorithm**                     | **Input Data**                   | **Output**                    | **Latency** |
| -------------------------- | --------------------------------- | -------------------------------- | ----------------------------- | ----------- |
| LLM Document<br>Extractor  | Fine-tuned LLM<br>(GPT-4 class)   | Resume, KYC docs                 | Structured JSON               | ~1,500ms    |
| Financial Scorer           | XGBoost v2.0                      | Bank statement<br>features       | Financial score (0–<br>300)   | ~45ms       |
| Sequence<br>Analyser       | LSTM +<br>Temporal<br>Transformer | Transaction time-<br>series      | Behavioral score (0<br>–250)  | ~200ms      |
| Social Risk<br>Engine      | Graph Neural<br>Network (GNN)     | Entity relationship<br>graph     | Social score (0–<br>200)      | ~500ms      |
| Professional<br>Scorer     | Rule engine +<br>LLM embeddings   | Extracted resume<br>features     | Professional score<br>(0–250) | ~80ms       |
| Meta-learner<br>Ensemble   | Logistic<br>regression +<br>SHAP  | All sub-scores +<br>raw features | PD, LGD, Decision,<br>Score   | ~60ms       |

##### **6.2 Total Processing Time Budget**

- Document ingestion and OCR: 1,500ms

- LLM entity extraction: 1,500ms (parallel processing)

- Financial and behavioral model inference: 245ms (sequential)

- GNN social risk evaluation: 500ms

- Professional scoring: 80ms

- Meta-learner + SHAP explanation: 60ms

CONFIDENTIAL — FINTARA SOLUTIONS PVT LTS (ONEBNPL) INTERNAL USE ONLY

Page 9

May 2026

Fintara Solutions Pvt Ltd / ONE BNPL

AI Credit Scoring Model — Technical & Functional Document

- Database write + response generation: 50ms

- Total end-to-end: < 4,000ms (first application); < 500ms (returning applicant with cached features)

##### **6.3 Explainability Framework (XAI)**

Every credit decision produced by the AICS Model is accompanied by a SHAP (SHapley Additive exPlanations) values report that quantifies the contribution of each input feature to the final score. This satisfies the NRB requirement for explainability in automated lending decisions and provides the basis for applicant communication, adverse action notices, and audit documentation.

- Top 5 positive factors contributing to the score are surfaced to the applicant and banker

- Top 3 negative factors are listed as improvement recommendations

- Adverse action notice is auto-generated for declined applications with specific reasons

- Full SHAP JSON is stored in the audit database for regulatory inspection

##### **6.4 Model Governance and Continuous Learning**

- Model performance is monitored weekly using Gini coefficient, AUC-ROC, and KS statistic

- Champion-Challenger A/B testing framework for new model versions (minimum 1,000 decisions before promotion)

- Monthly model drift detection using Population Stability Index (PSI); alert threshold PSI > 0.25

- Quarterly retraining using accumulated repayment outcome data (minimum 500 labelled outcomes required)

- Annual full model validation by independent risk model validation team

- All model versions version-controlled in MLflow with full training lineage

#### **7. Database Schema — Key Tables**

The AICS Model uses a PostgreSQL relational database with a TimeSeries extension (TimescaleDB) for transaction-level financial data. The following describes the primary tables:

##### **7.1 Core Tables**

| **Table Name**     | **Primary Fields**                                                                                                           | **Record**<br>**Volume** | **Purpose**                               |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ----------------------------------------- |
| applicant_profile  | applicant_id (UUID PK),<br>full_name, father_name,<br>DOB, NID (encrypted),<br>nationality,<br>residence_status,<br>contacts | 1 per<br>applicant       | Master applicant<br>identity record       |
| employment_history | employment_id,<br>applicant_id (FK),<br>employer_name,                                                                       | 1-N per<br>applicant     | Career history for<br>professional pillar |

CONFIDENTIAL — FINTARA SOLUTIONS PVT LTS (ONEBNPL) INTERNAL USE ONLY

Page 10

May 2026

Fintara Solutions Pvt Ltd / ONE BNPL

AI Credit Scoring Model — Technical & Functional Document

| **Table Name**                | **Primary Fields**                                                                                                                                                                                                                   | **Record**<br>**Volume**      | **Purpose**                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- | -------------------------------------- |
|                               | employer_type, title,<br>start_date, end_date,<br>salary, country,<br>employer_score                                                                                                                                                 |                               |                                        |
| bank_accounts                 | account_id, applicant_id<br>(FK), bank_name,<br>account_type, currency,<br>statement_from,<br>statement_to                                                                                                                           | 1-N per<br>applicant          | Bank account register                  |
| transactions                  | txn_id, account_id (FK),<br>txn_date, debit_amount,<br>credit_amount,<br>balance_after, txn_type,<br>ai_category, is_recurring,<br>counterparty                                                                                      | Thousands<br>per<br>applicant | Raw transaction time-<br>series        |
| monthly_financial_summar<br>y | summary_id, account_id<br>(FK), month_year,<br>avg_daily_balance,<br>total_credits, total_debits,<br>salary_credits,<br>emi_payments,<br>bounce_count                                                                                | 6-24 per<br>applicant         | Aggregated monthly<br>financials       |
| financial_analytics           | applicant_id,<br>avg_balance_6m,<br>salary_consistency_score,<br>debt_service_ratio,<br>savings_rate,<br>bounce_rate,<br>financial_score_composite                                                                                   | 1 per<br>applicant            | AI-computed financial<br>features      |
| credit_score_output           | score_id, applicant_id<br>(FK), financial_score,<br>professional_score,<br>social_score,<br>behavioral_score,<br>composite_score,<br>risk_band, pd_probability,<br>lgd_estimate, decision,<br>shap_json,<br>model_version, scored_at | 1+ per<br>applicant           | Final scoring output +<br>audit record |

#### **8. Standard Operating Procedures (SOP)**

##### **SOP-001: Application Submission and Document Ingestion**

Document Reference: FSL/SOP/AICS/001 | Version: 1.0 | Effective: May 2026

###### **Step 1: Applicant Self-Service Portal**

1. Applicant accesses ONE BNPL digital portal (web or mobile app)

CONFIDENTIAL — FINTARA SOLUTIONS PVT LTS (ONEBNPL) INTERNAL USE ONLY May 2026

Page 11

Fintara Solutions Pvt Ltd / ONE BNPL

AI Credit Scoring Model — Technical & Functional Document

2. Selects desired product: BNPL / Personal Loan / Hire Purchase / Auto Loan

3. Declares desired loan amount and repayment tenure

4. System displays pre-qualification eligibility criteria before document upload

5. Applicant consents to: data processing, credit bureau pull, AI-based assessment

###### **Step 2: Document Upload**

6. Applicant uploads Resume/CV (PDF or DOCX, max 10MB)

7. Applicant uploads Bank Statement — minimum 6 months (PDF or Open Banking API connection)

8. Applicant uploads KYC documents: NID front/back, PAN card, recent selfie for liveness check

9. Optional documents for score enhancement: Passport, employer letter, salary slips, property documents

10. System validates file formats, sizes, and readability before acceptance

11. Applicant receives SMS and email confirmation of successful submission with Application Reference Number (ARN)

###### **Step 3: Automated Document Quality Check**

12. OCR engine assesses document clarity — minimum DPI 150 for images

13. Completeness check: are all mandatory documents present?

14. If incomplete: system sends automated notification listing missing documents; application placed in Pending status for 48 hours

15. If complete: application moves to AI processing queue (target: < 30 seconds)

##### **SOP-002: AI Scoring Pipeline Execution**

###### Document Reference: FSL/SOP/AICS/002 | Version: 1.0 | Effective: May 2026

###### **Step 1: Parallel Data Extraction (0–1,500ms)**

16. LLM NER pipeline extracts all resume entities to structured JSON

17. OCR + AI validates and extracts KYC document data

18. Financial statement parser categorises all transactions using AI classifier

19. Extraction confidence scores computed for each document — minimum 85% confidence required

20. Low-confidence extraction (<85%) triggers manual review flag; high-confidence proceeds automatically

###### **Step 2: Feature Engineering (1,500–2,000ms)**

21. Financial features computed: average balance, salary consistency, DSR, savings rate, bounce rate

22. Professional features scored: employer type lookup, tenure calculation, career progression regression

23. Social graph built: entities (employers, references, addresses) linked and scored against institutional tier database

24. Behavioral features extracted: LSTM sequence analysis on 6-month transaction time-series

CONFIDENTIAL — FINTARA SOLUTIONS PVT LTS (ONEBNPL) INTERNAL USE ONLY May 2026

Page 12

Fintara Solutions Pvt Ltd / ONE BNPL

AI Credit Scoring Model — Technical & Functional Document

25. Geopolitical risk overlay applied for non-Nepali nationals (Myanmar: -45pts, other SAARC: -15pts, OECD countries: +0pts)

###### **Step 3: Sub-model Scoring (2,000–2,800ms)**

26. XGBoost financial model generates financial pillar score (0–300)

27. Professional rule engine + LLM embeddings generate professional pillar score (0–250)

28. GNN social risk engine generates social pillar score (0–200)

29. LSTM behavioral model generates behavioral pillar score (0–250)

30. All sub-scores stored with model version tag in credit_score_output table

###### **Step 4: Meta-learner and Final Decision (2,800–3,000ms)**

31. Logistic regression meta-learner combines all pillar scores with additional interaction features

32. Probability of Default (PD) computed on scale 0.0–1.0

33. Loss Given Default (LGD) estimated based on product type and collateral position

34. Expected Loss (EL) = PD x LGD x Exposure at Default computed

35. Composite score (0–1,000) generated; risk band assigned per matrix in Section 5.1

36. SHAP values computed for top 5 positive and top 3 negative factors

37. Override conditions checked (Section 5.3); any match overrides score-based decision

38. Final decision recorded: Auto Approve / Approve with Conditions / Refer to Underwriter / Decline

##### **SOP-003: Credit Decision Communication**

Document Reference: FSL/SOP/AICS/003 | Version: 1.0 | Effective: May 2026

| **Decision Type**        | **Communication**<br>**Channel** | **Time to**<br>**Communicate** | **Content**                                                                 |
| ------------------------ | -------------------------------- | ------------------------------ | --------------------------------------------------------------------------- |
| Auto Approve             | SMS + Email +<br>Portal          | Immediately (<5 sec)           | Approved limit, rate, tenure,<br>T&Cs acceptance link                       |
| Approve w/<br>Conditions | SMS + Email +<br>Call            | Within 1 hour                  | Conditional approval, conditions<br>to be met, document list                |
| Refer —<br>Underwriter   | Email + Portal<br>status         | Within 2 business<br>days      | Status notification; underwriter<br>review outcome communicated             |
| Decline                  | SMS + Email +<br>Letter          | Within 24 hours                | Decline notice, top 3 reasons<br>(SHAP-derived), score<br>improvement guide |
| Score Incomplete         | SMS + Email                      | Within 2 hours                 | List of missing documents, re-<br>submission portal link, 48-hour<br>window |

##### **SOP-004: Manual Underwriter Review Process**

Document Reference: FSL/SOP/AICS/004 | Version: 1.0 | Effective: May 2026

CONFIDENTIAL — FINTARA SOLUTIONS PVT LTS (ONEBNPL) INTERNAL USE ONLY May 2026

Page 13

Fintara Solutions Pvt Ltd / ONE BNPL

AI Credit Scoring Model — Technical & Functional Document

Applications scoring between 300–449 (High Risk) or triggering conditional override flags are escalated to a human underwriter. The underwriter receives a complete AI score report including all SHAP values, pillar breakdowns, and the specific flag that triggered the referral.

###### **Underwriter Review Checklist**

- Review AI composite score and identify the primary low-scoring pillar

- Verify identity documents manually if KYC confidence < 90%

- Contact employer or reference if professional pillar score < 100

- Request additional bank statements (up to 12 months) if financial data is thin

- Assess any contextual factors not captured by model (family context, recent job change with offer letter)

- Document override decision with written justification if approving below AI threshold

- Override approvals above AI recommendation require Dual Authorization (Underwriter + Credit Manager)

- SLA: Underwriter decision within 2 business days of referral

##### **SOP-005: Loan Disbursement and Account Management**

Document Reference: FSL/SOP/AICS/005 | Version: 1.0 | Effective: May 2026

39. Applicant accepts terms digitally via OTP-authenticated consent in portal

40. Loan agreement auto-generated with approved terms; e-signed by applicant

41. For BNPL: merchant purchase instruction received; credit applied to merchant settlement

42. For Personal Loan / HP / Auto: funds disbursed to applicant account via NCHL/eSewa/bank transfer within 2 hours of acceptance

43. Loan account created in core banking system with unique account number

44. First EMI due date set to 30 days from disbursement; auto-debit mandate registered

45. Welcome SMS and repayment schedule sent to applicant

46. Score monitoring: applicant re-scored at 3-month intervals; limit adjustment triggered if score changes by > 50 points

#### **9. Risk Management Framework**

##### **9.1 Key Risk Indicators (KRIs)**

| **Risk Indicator**           | **Metric**                   | **Green** | **Amber** | **Red —**<br>**Action**             |
| ---------------------------- | ---------------------------- | --------- | --------- | ----------------------------------- |
| Portfolio NPA rate           | 90+ DPD / total<br>portfolio | < 2%      | 2–4%      | > 4%: tighten<br>score<br>threshold |
| Model accuracy (AUC-<br>ROC) | Monthly AUC-ROC              | > 0.85    | 0.75–0.85 | < 0.75: initiate<br>retraining      |
| Model drift (PSI)            | Population Stability         | < 0.10    | 0.10–0.25 | > 0.25:                             |

CONFIDENTIAL — FINTARA SOLUTIONS PVT LTS (ONEBNPL) INTERNAL USE ONLY May 2026

Page 14

Fintara Solutions Pvt Ltd / ONE BNPL

AI Credit Scoring Model — Technical & Functional Document

| **Risk Indicator**            | **Metric**                            | **Green** | **Amber** | **Red —**<br>**Action**                  |
| ----------------------------- | ------------------------------------- | --------- | --------- | ---------------------------------------- |
|                               | Index                                 |           |           | mandatory<br>retraining                  |
| Override rate                 | Human overrides /<br>total decisions  | < 5%      | 5–10%     | > 10%: model<br>review                   |
| Auto-approval rate            | Auto-approved /<br>total applications | 50–70%    | 70–85%    | > 85%: review<br>thresholds              |
| Fraud detected /<br>prevented | Fraud events / total<br>approved      | < 0.1%    | 0.1–0.3%  | > 0.3%: GNN<br>review                    |
| Expected loss ratio           | EL / total portfolio<br>value         | < 1.0%    | 1.0–2.5%  | > 2.5%:<br>capital<br>adequacy<br>review |

##### **9.2 Stress Testing Requirements**

- Quarterly stress test: simulate 25% increase in portfolio-wide PD — assess capital adequacy impact

- Annual scenario analysis: COVID-like economic shock scenario (40% income reduction across portfolio)

- Model stability test: score distribution shift analysis using PSI across all risk bands

- Concentration risk test: maximum single employer group exposure < 15% of unsecured portfolio

- Liquidity stress: assess 90-day cashflow under 30% simultaneous repayment default scenario

##### **9.3 Capital Provisioning Guidelines**

| **Risk Band** | **PD Range** | **Provision Rate** | **Basel III Risk Weight** |
| ------------- | ------------ | ------------------ | ------------------------- |
| Elite Prime   | < 1.0%       | 0.5%               | 75% (retail exposure)     |
| Prime         | 1.0–3.5%     | 1.5%               | 75%                       |
| Near Prime    | 3.5–8.0%     | 4.0%               | 100%                      |
| Subprime      | 8.0–20.0%    | 10.0%              | 150%                      |
| High Risk     | 20–40%       | 25.0%              | 200%                      |

#### **10. Compliance, Privacy, and Data Governance**

##### **10.1 Data Privacy Compliance**

- All personal data encrypted at rest (AES-256) and in transit (TLS 1.3)

- NID numbers, passport numbers, and financial data stored in encrypted columns with fieldlevel encryption

CONFIDENTIAL — FINTARA SOLUTIONS PVT LTS (ONEBNPL) INTERNAL USE ONLY May 2026

Page 15

Fintara Solutions Pvt Ltd / ONE BNPL

AI Credit Scoring Model — Technical & Functional Document

- Data retention policy: applicant records retained for 7 years per NRB guidelines; raw documents deleted after 90 days of decision

- Right to explanation: every applicant can request a written explanation of their credit decision within 30 days

- Right to review: applicants may request human review of any automated decision within 14 days

- Data sharing: no personal data shared with third parties without explicit applicant consent

- Privacy impact assessment (PIA) conducted annually and upon any material model change

##### **10.2 Fair Lending and Anti-Discrimination**

- The AICS Model is designed to be demographically neutral — no scoring weight assigned to gender, religion, ethnicity, or caste

- Adverse impact testing conducted quarterly: pass rate analysis across gender, age group, and geographic segments

- If any demographic group's approval rate falls more than 20% below the overall approval rate, mandatory model review is triggered

- Disparate impact analysis included in all model governance reports to the Risk Committee

##### **10.3 AML / CFT Controls**

- All applicants screened against UN, OFAC, EU, and Nepal government sanctions lists at application time and monthly thereafter

- Politically Exposed Persons (PEP) flagging with enhanced due diligence workflow

- Transaction monitoring on disbursed accounts: unusual cash withdrawal patterns flagged to Compliance

- Suspicious Transaction Reports (STR) filed with the Financial Intelligence Unit (FIU-Nepal) within 3 working days of detection

- Customer Due Diligence (CDD) refreshed annually for all active borrowers

##### **10.4 Audit and Reporting**

- Complete decision audit trail maintained: input features, model version, scores, decision, SHAP values, timestamp, operator ID

- Monthly portfolio quality report submitted to Credit Risk Committee

- Quarterly AI model performance report submitted to Board Risk Committee

- NRB regulatory reporting: all required returns on digital lending activity filed per NRB schedule

- Annual external audit of AI model by approved model risk management firm

#### **11. Implementation Roadmap**

| **Phase** | **Timeline** | **Key Activities**              | **Milestone / Deliverable** |
| --------- | ------------ | ------------------------------- | --------------------------- |
| Phase 1:  | Month 1–2    | Database schema deployment, LLM | Sandbox environment         |

CONFIDENTIAL — FINTARA SOLUTIONS PVT LTS (ONEBNPL) INTERNAL USE ONLY May 2026

Page 16

Fintara Solutions Pvt Ltd / ONE BNPL

AI Credit Scoring Model — Technical & Functional Document

| **Phase**                     | **Timeline** | **Key Activities**                                                                                                                                   | **Milestone / Deliverable**                                     |
| ----------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Foundation                    |              | extraction pipeline setup, integration<br>with NID verification API, sandbox<br>environment build                                                    | live; document extraction<br>F1 > 90%                           |
| Phase 2:<br>Model<br>Training | Month 2–3    | Historical data collection (1,000+<br>cases), XGBoost and LSTM model<br>training, GNN social graph build,<br>champion model selection                | Champion model AUC-<br>ROC > 0.85; pillar scores<br>calibrated  |
| Phase 3: Pilot                | Month 3–4    | Shadow mode deployment (AI<br>scores generated but decisions by<br>humans), 200-application pilot with 2<br>bank partners, outcome tracking<br>setup | Shadow mode live; <4sec<br>decision latency<br>confirmed        |
| Phase 4: UAT<br>& Validation  | Month 4–5    | User acceptance testing with bank<br>credit teams, NRB regulatory review<br>meeting, independent model<br>validation, SOP training for all staff     | UAT sign-off; NRB no-<br>objection; model<br>validation report  |
| Phase 5:<br>Limited<br>Launch | Month 5–6    | Live auto-approval for Prime and<br>Elite Prime segments only; 500-<br>application live run; KRI monitoring<br>daily                                 | 500 live applications;<br>NPA < 1%; SHAP audit<br>complete      |
| Phase 6: Full<br>Launch       | Month 6+     | Full risk band deployment; all<br>product types; public-facing portal;<br>merchant and partner bank<br>integrations complete                         | Full portfolio live; Board<br>approval of ongoing<br>governance |

#### **12. Board and Management Approval Request**

##### **12.1 Items Requiring Board Approval**

47. Approval of the AICS Model as the primary credit assessment mechanism for all unsecured lending products listed in Section 1.2

48. Approval of the Risk Band matrix, credit limits, and interest rate schedule in Section 5

49. Approval of the auto-approval authority threshold: composite score >= 750 qualifies for auto-approval without human review

50. Approval of capital provisioning rates by risk band as presented in Section 9.3

51. Authorisation to engage NRB for regulatory no-objection filing on the AI-based digital lending framework

52. Approval of the implementation roadmap timeline and associated technology investment budget

53. Designation of the AI Model Governance Committee with quarterly reporting obligation to the Board Risk Committee

##### **12.2 Management Responsibilities**

CONFIDENTIAL — FINTARA SOLUTIONS PVT LTS (ONEBNPL) INTERNAL USE ONLY May 2026

Page 17

Fintara Solutions Pvt Ltd / ONE BNPL

AI Credit Scoring Model — Technical & Functional Document

| **Role**                 | **Department** | **Responsibility**                                                             |
| ------------------------ | -------------- | ------------------------------------------------------------------------------ |
| Executive Director / CEO | Board          | Overall accountability for AICS Model<br>deployment and regulatory compliance  |
| Chief Technology Officer | Technology     | Technical architecture, model performance,<br>infrastructure security, MLOps   |
| Chief Risk Officer       | Risk           | Model risk governance, KRI monitoring, NRB<br>reporting, stress testing        |
| Chief Compliance Officer | Compliance     | AML/CFT controls, data privacy, fair lending<br>oversight, FIU reporting       |
| Head of Credit           | Credit         | Underwriter team management, override<br>authority, credit policy calibration  |
| Chief Operating Officer  | Operations     | SOP adherence, customer communication,<br>merchant and bank partner management |
| Internal Audit Head      | Audit          | Independent quarterly audit of AICS Model<br>decisions and process adherence   |

##### **12.3 Board Resolution Draft**

###### **DRAFT BOARD RESOLUTION — FOR REVIEW AND ADOPTION**

_RESOLVED THAT the Board of Directors of [Bank Name], having reviewed the Technical and Functional Document for the AI-Powered Credit Scoring Model (Document Ref: FSL/ONEBNPL/AICS/2026/001) submitted by Fintara Solutions Pvt Ltd, hereby approves the deployment of the AICS Model for auto-approval of unsecured lending products subject to the risk band limits, interest rate schedule, capital provisioning guidelines, and governance framework as presented herein, and further authorises the management to proceed with NRB regulatory filing and phased implementation as per the roadmap in Section 11._

_FURTHER RESOLVED THAT an AI Model Governance Committee comprising the CTO, CRO, CCO, and Head of Credit shall be constituted with quarterly reporting obligations to the Board Risk Committee, and that the Board shall review model performance metrics and portfolio quality at every Board meeting during the first year of deployment._

**Chairman, Board of Chief Executive Officer Company Secretary / Date Directors**

#### **13. Appendices**

##### **Appendix A — Glossary**

| **Term**   | **Definition**                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------ |
| AICS Model | AI-Powered Credit Scoring Model — the proprietary system described<br>in this document                             |
| AUC-ROC    | Area Under Curve — Receiver Operating Characteristic: measure of<br>model discrimination ability (higher = better) |

CONFIDENTIAL — FINTARA SOLUTIONS PVT LTS (ONEBNPL) INTERNAL USE ONLY

Page 18

May 2026

Fintara Solutions Pvt Ltd / ONE BNPL

AI Credit Scoring Model — Technical & Functional Document

| **Term** | **Definition**                                                                                                   |
| -------- | ---------------------------------------------------------------------------------------------------------------- |
| BNPL     | Buy Now Pay Later — deferred or instalment payment product for<br>retail purchases                               |
| DSR      | Debt Service Ratio — total monthly debt obligations as percentage of<br>gross monthly income                     |
| EL       | Expected Loss — PD x LGD x Exposure at Default; used for capital<br>provisioning                                 |
| GNN      | Graph Neural Network — AI model that analyses relationships<br>between entities to detect fraud and social risk  |
| KYC      | Know Your Customer — identity verification process using identity<br>documents                                   |
| LGD      | Loss Given Default — estimated proportion of exposure lost if<br>borrower defaults                               |
| LSTM     | Long Short-Term Memory — recurrent neural network architecture for<br>time-series and sequence analysis          |
| NER      | Named Entity Recognition — AI technique for extracting structured<br>entities from unstructured text             |
| NPA      | Non-Performing Asset — loan where principal or interest is 90+ days<br>past due                                  |
| NRB      | Nepal Rastra Bank — the central bank and primary financial regulator<br>of Nepal                                 |
| OCR      | Optical Character Recognition — AI technology for extracting text from<br>scanned documents and images           |
| PD       | Probability of Default — estimated likelihood (0–1) that a borrower will<br>fail to repay                        |
| PEP      | Politically Exposed Person — individual with prominent public function,<br>subject to enhanced due diligence     |
| PSI      | Population Stability Index — measure of shift in input feature<br>distribution over time (model drift indicator) |
| SHAP     | SHapley Additive exPlanations — game-theoretic method for<br>explaining individual ML model predictions          |
| XGBoost  | Extreme Gradient Boosting — high-performance gradient-boosted<br>decision tree algorithm for tabular data        |
| XAI      | Explainable AI — AI systems designed to provide understandable<br>justifications for their decisions             |

##### **Appendix B — Document Control**

| **Version** | **Date** | **Author**             |                 | **Changes**           |
| ----------- | -------- | ---------------------- | --------------- | --------------------- |
| v1.0        | May 2026 | Fintara Solutions — AI | Initial release | — submitted for Board |
|             |          | & Technology           | approval        |                       |

##### **Appendix C — Related Policies and Documents**

- ONE BNPL Credit Policy — FSL/CREDIT/POL/2026/001

- Data Privacy Policy — FSL/LEGAL/PRIVACY/2026/001

CONFIDENTIAL — FINTARA SOLUTIONS PVT LTS (ONEBNPL) INTERNAL USE ONLY May 2026

Page 19

Fintara Solutions Pvt Ltd / ONE BNPL

AI Credit Scoring Model — Technical & Functional Document

- AML/CFT Policy — FSL/COMPLIANCE/AML/2026/001

- Model Risk Management Policy — FSL/RISK/MRM/2026/001

- Information Security Policy — FSL/IT/ISEC/2026/001

- NRB Unified Directives on Digital Lending — NRB/UD/2079

- Nepal Rastra Bank Financial Intermediary Act 2006

###### **END OF DOCUMENT**

Fintara Solutions Pvt Ltd | ONE BNPL | www.onebnpl.shop | www.fintara.net

_This document is classified CONFIDENTIAL. Unauthorised reproduction or distribution is prohibited._

CONFIDENTIAL — FINTARA SOLUTIONS PVT LTS (ONEBNPL) INTERNAL USE ONLY

Page 20

May 2026
