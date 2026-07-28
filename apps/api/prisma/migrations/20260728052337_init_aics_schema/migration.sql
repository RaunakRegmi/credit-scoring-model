-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('BNPL', 'PERSONAL_LOAN', 'HIRE_PURCHASE', 'AUTO_LOAN', 'MICRO_BNPL');

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('DRAFT', 'PENDING_DOCUMENTS', 'EXTRACTING', 'SCORING', 'DECIDED', 'UNDER_REVIEW', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "RiskBand" AS ENUM ('ELITE_PRIME', 'PRIME', 'NEAR_PRIME', 'SUBPRIME', 'HIGH_RISK', 'REJECT');

-- CreateEnum
CREATE TYPE "Decision" AS ENUM ('AUTO_APPROVE', 'APPROVE_STANDARD', 'APPROVE_WITH_CONDITIONS', 'REFER_UNDERWRITER', 'DECLINE');

-- CreateEnum
CREATE TYPE "EmployerType" AS ENUM ('MNC', 'COMMERCIAL_BANK', 'CORPORATE', 'GOVERNMENT', 'INTERNATIONAL_NGO', 'SME', 'INFORMAL');

-- CreateEnum
CREATE TYPE "EducationLevel" AS ENUM ('PHD', 'MASTERS', 'BACHELORS', 'DIPLOMA', 'HIGHER_SECONDARY', 'SECONDARY', 'NONE');

-- CreateEnum
CREATE TYPE "ResidenceStatus" AS ENUM ('OWNED', 'FAMILY_OWNED', 'RENTED', 'COMPANY_PROVIDED', 'UNDECLARED');

-- CreateEnum
CREATE TYPE "ReferenceTier" AS ENUM ('C_SUITE', 'DIRECTOR', 'SENIOR_MANAGER', 'MANAGER', 'PEER', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('RESUME', 'BANK_STATEMENT', 'NID_FRONT', 'NID_BACK', 'PASSPORT', 'PAN_CARD', 'ADDRESS_PROOF', 'EMPLOYER_LETTER', 'SALARY_SLIP', 'BUSINESS_REGISTRATION', 'SELFIE');

-- CreateEnum
CREATE TYPE "ExtractionStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'LOW_CONFIDENCE', 'FAILED');

-- CreateEnum
CREATE TYPE "TxnCategory" AS ENUM ('SALARY', 'REMITTANCE', 'RENTAL_INCOME', 'BUSINESS_INCOME', 'INTEREST_INCOME', 'OTHER_CREDIT', 'LOAN_EMI', 'CREDIT_CARD_PAYMENT', 'INSURANCE_PREMIUM', 'UTILITY', 'RENT_PAID', 'ATM_WITHDRAWAL', 'GROCERY_ESSENTIAL', 'DISCRETIONARY', 'TRANSFER_OUT', 'BANK_CHARGE', 'BOUNCE_PENALTY', 'OTHER_DEBIT');

-- CreateEnum
CREATE TYPE "TxnDirection" AS ENUM ('CREDIT', 'DEBIT');

-- CreateEnum
CREATE TYPE "OverrideCode" AS ENUM ('AML_WATCHLIST_MATCH', 'KYC_FACE_MATCH_FAILURE', 'NID_VERIFICATION_FAILURE', 'ACTIVE_BANKRUPTCY', 'OVERLEVERAGED_THREE_PLUS_LOANS', 'FRAUDULENT_DOCUMENT_FLAG', 'DSR_ABOVE_60_PERCENT');

-- CreateEnum
CREATE TYPE "RuleOutcome" AS ENUM ('APPLIED', 'NOT_TRIGGERED', 'SKIPPED_DISABLED', 'ERRORED');

-- CreateEnum
CREATE TYPE "ModelProvenance" AS ENUM ('SYNTHETIC_SEED', 'HISTORICAL_OUTCOMES', 'HYBRID');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('SYSTEM', 'UNDERWRITER', 'CREDIT_MANAGER', 'COMPLIANCE_OFFICER', 'APPLICANT');

-- CreateTable
CREATE TABLE "applicant_profile" (
    "id" UUID NOT NULL,
    "fullName" VARCHAR(200) NOT NULL,
    "fatherName" VARCHAR(200),
    "nidEnc" TEXT NOT NULL,
    "nidHash" CHAR(64) NOT NULL,
    "passportEnc" TEXT,
    "panEnc" TEXT,
    "email" VARCHAR(254) NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "nationality" CHAR(2) NOT NULL DEFAULT 'NP',
    "dateOfBirth" DATE,
    "gender" VARCHAR(20),
    "currentAddress" VARCHAR(500),
    "permanentAddress" VARCHAR(500),
    "residenceStatus" "ResidenceStatus" NOT NULL DEFAULT 'UNDECLARED',
    "yearsAtAddress" DECIMAL(5,2),
    "kycVerified" BOOLEAN NOT NULL DEFAULT false,
    "kycFaceMatchScore" DECIMAL(5,4),
    "nidVerified" BOOLEAN NOT NULL DEFAULT false,
    "amlScreenedAt" TIMESTAMP(3),
    "amlWatchlistHit" BOOLEAN NOT NULL DEFAULT false,
    "isPep" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "applicant_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loan_application" (
    "id" UUID NOT NULL,
    "arn" VARCHAR(24) NOT NULL,
    "applicantId" UUID NOT NULL,
    "productType" "ProductType" NOT NULL,
    "requestedAmountNpr" DECIMAL(18,2) NOT NULL,
    "tenureMonths" INTEGER NOT NULL,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'DRAFT',
    "consentDataProcessing" BOOLEAN NOT NULL DEFAULT false,
    "consentCreditBureauPull" BOOLEAN NOT NULL DEFAULT false,
    "consentAutomatedAssessment" BOOLEAN NOT NULL DEFAULT false,
    "consentedAt" TIMESTAMP(3),
    "activeLoanCount" INTEGER NOT NULL DEFAULT 0,
    "hasActiveBankruptcy" BOOLEAN NOT NULL DEFAULT false,
    "documentFraudFlag" BOOLEAN NOT NULL DEFAULT false,
    "submittedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "loan_application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document" (
    "id" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "type" "DocumentType" NOT NULL,
    "originalName" VARCHAR(255) NOT NULL,
    "mimeType" VARCHAR(127) NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "storageKey" VARCHAR(500) NOT NULL,
    "extractionStatus" "ExtractionStatus" NOT NULL DEFAULT 'PENDING',
    "extractionConfidence" DECIMAL(5,4),
    "extractionError" TEXT,
    "rawJson" JSONB,
    "extractedAt" TIMESTAMP(3),
    "purgeAfter" TIMESTAMP(3),
    "purgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resume_profile" (
    "id" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "pastSalaryNpr" DECIMAL(18,2),
    "expectedSalaryNpr" DECIMAL(18,2),
    "salaryCurrency" CHAR(3) NOT NULL DEFAULT 'NPR',
    "salaryGrowthRate" DECIMAL(8,4),
    "totalExperienceYears" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "jobChangesCount" INTEGER NOT NULL DEFAULT 0,
    "careerProgressionSlope" DECIMAL(8,4),
    "highestEducation" "EducationLevel" NOT NULL DEFAULT 'NONE',
    "institution" VARCHAR(300),
    "educationCountry" CHAR(2),
    "isEducationAbroad" BOOLEAN NOT NULL DEFAULT false,
    "graduationYear" INTEGER,
    "gpa" DECIMAL(4,2),
    "countriesTraveled" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "premiumVisas" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "extractionConfidence" DECIMAL(5,4),
    "missingFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resume_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employment_history" (
    "id" UUID NOT NULL,
    "resumeProfileId" UUID NOT NULL,
    "employerName" VARCHAR(300) NOT NULL,
    "employerType" "EmployerType" NOT NULL DEFAULT 'SME',
    "title" VARCHAR(200) NOT NULL,
    "seniorityRank" INTEGER NOT NULL DEFAULT 1,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "salaryNpr" DECIMAL(18,2),
    "country" CHAR(2) NOT NULL DEFAULT 'NP',
    "employerScore" DECIMAL(5,2) NOT NULL DEFAULT 55,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employment_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "professional_reference" (
    "id" UUID NOT NULL,
    "resumeProfileId" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "designation" VARCHAR(200),
    "organisation" VARCHAR(300),
    "tier" "ReferenceTier" NOT NULL DEFAULT 'UNKNOWN',
    "relationship" VARCHAR(100),
    "contactEnc" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "professional_reference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certification" (
    "id" UUID NOT NULL,
    "resumeProfileId" UUID NOT NULL,
    "name" VARCHAR(300) NOT NULL,
    "issuer" VARCHAR(300),
    "isInternational" BOOLEAN NOT NULL DEFAULT false,
    "issuedYear" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "certification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "award" (
    "id" UUID NOT NULL,
    "resumeProfileId" UUID NOT NULL,
    "title" VARCHAR(300) NOT NULL,
    "scope" VARCHAR(20) NOT NULL DEFAULT 'COMPANY',
    "year" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "award_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_statement" (
    "id" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "bankAccountId" UUID NOT NULL,
    "periodFrom" DATE NOT NULL,
    "periodTo" DATE NOT NULL,
    "monthsCovered" INTEGER NOT NULL DEFAULT 0,
    "parsedTxnCount" INTEGER NOT NULL DEFAULT 0,
    "openingBalanceNpr" DECIMAL(18,2),
    "closingBalanceNpr" DECIMAL(18,2),
    "extractionConfidence" DECIMAL(5,4),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_statement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_account" (
    "id" UUID NOT NULL,
    "bankName" VARCHAR(200) NOT NULL,
    "accountType" VARCHAR(50) NOT NULL DEFAULT 'SAVINGS',
    "currency" CHAR(3) NOT NULL DEFAULT 'NPR',
    "accountNumberMasked" VARCHAR(24) NOT NULL,
    "accountNumberEnc" TEXT NOT NULL,
    "accountNumberHash" CHAR(64) NOT NULL,
    "statementFrom" DATE,
    "statementTo" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "txnDate" DATE NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "debitNpr" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "creditNpr" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "direction" "TxnDirection" NOT NULL,
    "balanceAfterNpr" DECIMAL(18,2),
    "aiCategory" "TxnCategory" NOT NULL DEFAULT 'OTHER_DEBIT',
    "categoryConfidence" DECIMAL(5,4) NOT NULL DEFAULT 0.5,
    "counterparty" VARCHAR(300),
    "isRecurring" BOOLEAN NOT NULL DEFAULT false,
    "recurringGroupId" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monthly_financial_summary" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "monthStart" DATE NOT NULL,
    "avgDailyBalanceNpr" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "closingBalanceNpr" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "minBalanceNpr" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "totalCreditsNpr" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "totalDebitsNpr" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "salaryCreditsNpr" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "remittanceNpr" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "rentalIncomeNpr" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "otherIncomeNpr" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "emiPaymentsNpr" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "cardPaymentsNpr" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "insurancePremiumNpr" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "atmWithdrawalsNpr" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "essentialSpendNpr" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "discretionarySpendNpr" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "bounceCount" INTEGER NOT NULL DEFAULT 0,
    "overdraftDays" INTEGER NOT NULL DEFAULT 0,
    "latePaymentCount" INTEGER NOT NULL DEFAULT 0,
    "hasSalaryCredit" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "monthly_financial_summary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_analytics" (
    "id" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "featureSetVersion" VARCHAR(20) NOT NULL,
    "features" JSONB NOT NULL,
    "avgBalance6mNpr" DECIMAL(18,2),
    "avgMonthlyIncomeNpr" DECIMAL(18,2),
    "debtServiceRatio" DECIMAL(8,4),
    "savingsRate" DECIMAL(8,4),
    "salaryConsistencyMonths" INTEGER NOT NULL DEFAULT 0,
    "bounceCount6m" INTEGER NOT NULL DEFAULT 0,
    "cashBufferMonths" DECIMAL(8,2),
    "incomeStreamCount" INTEGER NOT NULL DEFAULT 0,
    "discretionaryRatio" DECIMAL(8,4),
    "degradedFlags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "financial_analytics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_score_output" (
    "id" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "financialScore" DECIMAL(6,2) NOT NULL,
    "professionalScore" DECIMAL(6,2) NOT NULL,
    "socialScore" DECIMAL(6,2) NOT NULL,
    "behavioralScore" DECIMAL(6,2) NOT NULL,
    "compositeScore" DECIMAL(6,2) NOT NULL,
    "riskBand" "RiskBand" NOT NULL,
    "decision" "Decision" NOT NULL,
    "pdProbability" DECIMAL(8,6) NOT NULL,
    "lgdEstimate" DECIMAL(5,4) NOT NULL,
    "expectedLossNpr" DECIMAL(18,2) NOT NULL,
    "provisionRate" DECIMAL(5,4) NOT NULL,
    "baselRiskWeight" DECIMAL(5,4) NOT NULL,
    "approvedLimitNpr" DECIMAL(18,2),
    "monthlyInterestRate" DECIMAL(6,4),
    "processingFeePct" DECIMAL(6,4),
    "requiresGuarantor" BOOLEAN NOT NULL DEFAULT false,
    "shapJson" JSONB NOT NULL,
    "pillarBreakdownJson" JSONB NOT NULL,
    "reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "overrideCodes" "OverrideCode"[] DEFAULT ARRAY[]::"OverrideCode"[],
    "degradedFlags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "degraded" BOOLEAN NOT NULL DEFAULT false,
    "scorecardVersion" VARCHAR(20) NOT NULL,
    "featureSetVersion" VARCHAR(20) NOT NULL,
    "mlModelVersion" VARCHAR(50),
    "mlProvenance" "ModelProvenance",
    "mlPDefaultShadow" DECIMAL(8,6),
    "modelDivergence" DECIMAL(8,6),
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "scoredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_score_output_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "decision_audit" (
    "id" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "eventType" VARCHAR(60) NOT NULL,
    "actorType" "ActorType" NOT NULL DEFAULT 'SYSTEM',
    "actorId" VARCHAR(100),
    "inputSnapshot" JSONB NOT NULL,
    "outputSnapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decision_audit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_rule_evaluation" (
    "id" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "ruleId" VARCHAR(100) NOT NULL,
    "ruleVersion" VARCHAR(20) NOT NULL,
    "outcome" "RuleOutcome" NOT NULL,
    "pointsApplied" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "detail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policy_rule_evaluation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "underwriter_review" (
    "id" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "reviewerId" VARCHAR(100) NOT NULL,
    "reviewerName" VARCHAR(200) NOT NULL,
    "decision" "Decision" NOT NULL,
    "justification" TEXT NOT NULL,
    "overrodeModel" BOOLEAN NOT NULL DEFAULT false,
    "dualAuthById" VARCHAR(100),
    "dualAuthByName" VARCHAR(200),
    "dualAuthAt" TIMESTAMP(3),
    "approvedLimitNpr" DECIMAL(18,2),
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "underwriter_review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_version" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "version" VARCHAR(50) NOT NULL,
    "kind" VARCHAR(50) NOT NULL,
    "provenance" "ModelProvenance" NOT NULL DEFAULT 'SYNTHETIC_SEED',
    "featureSetVersion" VARCHAR(20) NOT NULL,
    "metrics" JSONB NOT NULL,
    "isChampion" BOOLEAN NOT NULL DEFAULT false,
    "trainedAt" TIMESTAMP(3) NOT NULL,
    "promotedAt" TIMESTAMP(3),
    "artifactPath" VARCHAR(500),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_version_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "applicant_profile_nidHash_key" ON "applicant_profile"("nidHash");

-- CreateIndex
CREATE INDEX "applicant_profile_email_idx" ON "applicant_profile"("email");

-- CreateIndex
CREATE INDEX "applicant_profile_phone_idx" ON "applicant_profile"("phone");

-- CreateIndex
CREATE INDEX "applicant_profile_nationality_idx" ON "applicant_profile"("nationality");

-- CreateIndex
CREATE UNIQUE INDEX "loan_application_arn_key" ON "loan_application"("arn");

-- CreateIndex
CREATE INDEX "loan_application_applicantId_idx" ON "loan_application"("applicantId");

-- CreateIndex
CREATE INDEX "loan_application_status_idx" ON "loan_application"("status");

-- CreateIndex
CREATE INDEX "loan_application_createdAt_idx" ON "loan_application"("createdAt");

-- CreateIndex
CREATE INDEX "loan_application_status_createdAt_idx" ON "loan_application"("status", "createdAt");

-- CreateIndex
CREATE INDEX "document_applicationId_idx" ON "document"("applicationId");

-- CreateIndex
CREATE INDEX "document_applicationId_type_idx" ON "document"("applicationId", "type");

-- CreateIndex
CREATE INDEX "document_sha256_idx" ON "document"("sha256");

-- CreateIndex
CREATE INDEX "document_purgeAfter_idx" ON "document"("purgeAfter");

-- CreateIndex
CREATE UNIQUE INDEX "resume_profile_applicationId_key" ON "resume_profile"("applicationId");

-- CreateIndex
CREATE INDEX "employment_history_resumeProfileId_idx" ON "employment_history"("resumeProfileId");

-- CreateIndex
CREATE INDEX "employment_history_resumeProfileId_startDate_idx" ON "employment_history"("resumeProfileId", "startDate");

-- CreateIndex
CREATE INDEX "professional_reference_resumeProfileId_idx" ON "professional_reference"("resumeProfileId");

-- CreateIndex
CREATE INDEX "certification_resumeProfileId_idx" ON "certification"("resumeProfileId");

-- CreateIndex
CREATE INDEX "award_resumeProfileId_idx" ON "award"("resumeProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statement_bankAccountId_key" ON "bank_statement"("bankAccountId");

-- CreateIndex
CREATE INDEX "bank_statement_applicationId_idx" ON "bank_statement"("applicationId");

-- CreateIndex
CREATE INDEX "bank_account_accountNumberHash_idx" ON "bank_account"("accountNumberHash");

-- CreateIndex
CREATE INDEX "transaction_accountId_txnDate_idx" ON "transaction"("accountId", "txnDate");

-- CreateIndex
CREATE INDEX "transaction_accountId_aiCategory_idx" ON "transaction"("accountId", "aiCategory");

-- CreateIndex
CREATE INDEX "transaction_recurringGroupId_idx" ON "transaction"("recurringGroupId");

-- CreateIndex
CREATE INDEX "monthly_financial_summary_accountId_monthStart_idx" ON "monthly_financial_summary"("accountId", "monthStart");

-- CreateIndex
CREATE UNIQUE INDEX "monthly_financial_summary_accountId_monthStart_key" ON "monthly_financial_summary"("accountId", "monthStart");

-- CreateIndex
CREATE UNIQUE INDEX "financial_analytics_applicationId_key" ON "financial_analytics"("applicationId");

-- CreateIndex
CREATE INDEX "financial_analytics_featureSetVersion_idx" ON "financial_analytics"("featureSetVersion");

-- CreateIndex
CREATE INDEX "credit_score_output_applicationId_idx" ON "credit_score_output"("applicationId");

-- CreateIndex
CREATE INDEX "credit_score_output_applicationId_scoredAt_idx" ON "credit_score_output"("applicationId", "scoredAt");

-- CreateIndex
CREATE INDEX "credit_score_output_riskBand_idx" ON "credit_score_output"("riskBand");

-- CreateIndex
CREATE INDEX "credit_score_output_decision_idx" ON "credit_score_output"("decision");

-- CreateIndex
CREATE INDEX "credit_score_output_scoredAt_idx" ON "credit_score_output"("scoredAt");

-- CreateIndex
CREATE INDEX "decision_audit_applicationId_idx" ON "decision_audit"("applicationId");

-- CreateIndex
CREATE INDEX "decision_audit_applicationId_createdAt_idx" ON "decision_audit"("applicationId", "createdAt");

-- CreateIndex
CREATE INDEX "decision_audit_eventType_idx" ON "decision_audit"("eventType");

-- CreateIndex
CREATE INDEX "decision_audit_createdAt_idx" ON "decision_audit"("createdAt");

-- CreateIndex
CREATE INDEX "policy_rule_evaluation_applicationId_idx" ON "policy_rule_evaluation"("applicationId");

-- CreateIndex
CREATE INDEX "policy_rule_evaluation_ruleId_idx" ON "policy_rule_evaluation"("ruleId");

-- CreateIndex
CREATE INDEX "policy_rule_evaluation_outcome_idx" ON "policy_rule_evaluation"("outcome");

-- CreateIndex
CREATE INDEX "underwriter_review_applicationId_idx" ON "underwriter_review"("applicationId");

-- CreateIndex
CREATE INDEX "underwriter_review_reviewerId_idx" ON "underwriter_review"("reviewerId");

-- CreateIndex
CREATE INDEX "model_version_kind_isChampion_idx" ON "model_version"("kind", "isChampion");

-- CreateIndex
CREATE UNIQUE INDEX "model_version_name_version_key" ON "model_version"("name", "version");

-- AddForeignKey
ALTER TABLE "loan_application" ADD CONSTRAINT "loan_application_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "applicant_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "loan_application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resume_profile" ADD CONSTRAINT "resume_profile_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "loan_application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employment_history" ADD CONSTRAINT "employment_history_resumeProfileId_fkey" FOREIGN KEY ("resumeProfileId") REFERENCES "resume_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "professional_reference" ADD CONSTRAINT "professional_reference_resumeProfileId_fkey" FOREIGN KEY ("resumeProfileId") REFERENCES "resume_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certification" ADD CONSTRAINT "certification_resumeProfileId_fkey" FOREIGN KEY ("resumeProfileId") REFERENCES "resume_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "award" ADD CONSTRAINT "award_resumeProfileId_fkey" FOREIGN KEY ("resumeProfileId") REFERENCES "resume_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement" ADD CONSTRAINT "bank_statement_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "loan_application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement" ADD CONSTRAINT "bank_statement_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "bank_account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "bank_account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monthly_financial_summary" ADD CONSTRAINT "monthly_financial_summary_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "bank_account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_analytics" ADD CONSTRAINT "financial_analytics_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "loan_application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_score_output" ADD CONSTRAINT "credit_score_output_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "loan_application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision_audit" ADD CONSTRAINT "decision_audit_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "loan_application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_rule_evaluation" ADD CONSTRAINT "policy_rule_evaluation_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "loan_application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "underwriter_review" ADD CONSTRAINT "underwriter_review_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "loan_application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
