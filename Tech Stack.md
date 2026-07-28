## 1. TECH STACK SPECIFICATIONS
- **Backend Architecture**: Node.js (TypeScript) + NestJS (API & Workflow Orchestration).
- **AI Processing Microservice**: Python + FastAPI + XGBoost + SHAP (Model Scoring Engine).
- **Database**: PostgreSQL 16 using Prisma ORM (Relational schemas, JSONB for unstructured raw metrics).
- **Document OCR/Parsing**: LlamaParse / Unstructured Python Client integration.
- **Frontend**: React (TypeScript) + Next.js + Tailwind CSS + Shadcn UI + TanStack Query.

---

## 2. SYSTEM DATA FLOW & ARCHITECTURE
1. **Document Upload**: Frontend uploads Resume PDF and Bank Statement PDF.
2. **Extraction Worker**:
   - Ingests PDFs into LlamaParse to produce structured JSON outputs.
   - Extracts resume signals: `past_salary`, `expected_salary`, `company_type`, `total_exp_years`, `job_changes`, `education_level`, `countries_traveled`.
   - Extracts bank statement signals: `avg_6m_balance`, `salary_credits`, `remittances`, `rental_income`, `loan_emis`, `cc_payments`, `bounced_cheques`.
3. **Feature Engineering Store**:
   - Computes: `dti_ratio` (Debt-to-Income), `cash_flow_volatility`, `stability_score`, `salary_growth_rate`.
4. **AI Scoring Engine**:
   - Posts feature array to Python FastAPI microservice running an XGBoost inference pipeline.
   - Microservice outputs: `risk_score` (300–900), `p_default` (0.0 to 1.0), and `shap_explainability_codes`.
5. **Decisioning**:
   - Classifies application into `AUTO_APPROVE`, `MANUAL_REVIEW`, or `REJECT`.

---

## 3. REQUIRED CODE TO GENERATE

### STEP 1: Database (Prisma / PostgreSQL Schema)
- Implement full `schema.prisma` mapping `Applicant`, `ResumeProfile`, `BankStatement`, `FeatureStore`, and `CreditScore` models.
- Apply correct indexing, UUID keys, foreign key constraints, and relational mappings.

### STEP 2: Python Scoring Microservice (`FastAPI`)
- Define `/predict` API route receiving candidate feature vectors.
- Implement mock inference using `XGBoost` or `scikit-learn` dummy model.
- Calculate SHAP values and output Top-3 positive and negative risk drivers.

### STEP 3: NestJS Backend Service & Controller
- Implement `CreditAssessmentService` with methods:
  - `processDocumentUpload(applicantId, resumeFile, statementFile)`
  - `computeFeatures(extractedData)`
  - `invokeScoringEngine(features)`
- Include error handling, dynamic fallback logic, and transactional database updates.

### STEP 4: React UI Component (Next.js + Tailwind)
- Create an interactive **Credit Assessment Dashboard** displaying:
  - File upload dropzones for Resume and Bank Statement.
  - Gauge component showing dynamically calculated Credit Score (300-900).
  - Breakdown breakdown card listing positive and negative SHAP risk factors.
  - Final Decision Banner (`APPROVED`, `MANUAL_REVIEW`, `REJECTED`).

---

## 4. CONSTRAINTS
- Strict TypeScript typing; NO `any` types.
- Handle production edge cases: division by zero in financial ratios, empty text extraction, or model timeouts.
- Provide clean, modular code with complete business logic without placeholders or missing imports.