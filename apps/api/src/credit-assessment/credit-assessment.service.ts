/**
 * The credit assessment pipeline (SOP-001, SOP-002).
 *
 * Implements the three methods named in the technical brief —
 * `processDocumentUpload`, `computeFeatures`, `invokeScoringEngine` — and the orchestration
 * that runs them in order:
 *
 *     upload -> extract -> classify -> aggregate -> features -> scorecard
 *            -> ML (shadow) -> overrides -> decision -> persist (one transaction)
 *
 * Three properties this file is responsible for holding:
 *
 *   · The scorecard decides. The ML model runs alongside it in shadow mode and is recorded,
 *     never decisive, until §6.4 promotion on real outcome data.
 *   · A degraded run never approves. Extraction failures, thin statements and an absent model
 *     all converge on manual review rather than on a guess.
 *   · The score and its audit record are written together or not at all. §10.4 requires a
 *     reconstructable trail for every decision, and a score without one is a compliance
 *     defect rather than a partial success.
 */
import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CURRENT_FEATURE_SET_VERSION,
  adverseActionFor,
  labelFor,
  type CreateApplicationInput,
  type CreditAssessmentResult,
  type DegradedFlag,
  type DocumentType,
  type ModelProvenance,
  type PillarResult,
  type ResidenceStatus,
  type ShapFactor,
} from '@aics/contracts';

import { EmptyExtractionError } from '../extraction/document-extractor.port';
import {
  DOCUMENT_EXTRACTOR,
  type DocumentExtractor,
  type RawDocument,
  type ResumeExtraction,
  type StatementExtraction,
  emptyResumeExtraction,
  emptyStatementExtraction,
} from '../extraction/document-extractor.port';
import { classifyStatement, type ClassifiedTransaction } from '../extraction/transaction-classifier';
import {
  FeatureEngineeringService,
  type FeatureComputationResult,
} from '../features/feature-engineering.service';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { PolicyService } from '../policy/policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { DecisionService } from '../scoring/decision.service';
import { MlScoringClient } from '../scoring/ml-scoring.client';
import { OverrideRuleEngine } from '../scoring/override-rule.engine';
import { ScorecardService } from '../scoring/scorecard.service';
import { StorageService } from '../storage/storage.service';
import { maskAccountNumber } from '../common/crypto.util';
import { toJson } from '../common/json.util';
import { roundTo } from '../common/math.util';

export interface UploadedFile {
  readonly buffer: Buffer;
  readonly originalname: string;
  readonly mimetype: string;
  readonly size: number;
}

interface ExtractionOutcome {
  readonly resume: ResumeExtraction;
  readonly statement: StatementExtraction;
  readonly transactions: readonly ClassifiedTransaction[];
  readonly resumeError: string | null;
  readonly statementError: string | null;
}

@Injectable()
export class CreditAssessmentService {
  private readonly logger = new Logger(CreditAssessmentService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DOCUMENT_EXTRACTOR) private readonly extractor: DocumentExtractor,
    private readonly prisma: PrismaService,
    private readonly features: FeatureEngineeringService,
    private readonly scorecard: ScorecardService,
    private readonly ml: MlScoringClient,
    private readonly overrides: OverrideRuleEngine,
    private readonly decisions: DecisionService,
    private readonly storage: StorageService,
    private readonly policy: PolicyService,
  ) {}

  /* ====================================================================== */
  /* SOP-001 — application intake                                           */
  /* ====================================================================== */

  /**
   * Creates an application and its applicant record.
   *
   * The applicant is keyed on the HMAC of their national ID, so a returning applicant is
   * recognised and updated rather than duplicated — without a plaintext index of national IDs
   * existing anywhere in the database.
   */
  async createApplication(input: CreateApplicationInput): Promise<{ id: string; arn: string }> {
    const { applicant } = input;
    const nid = this.prisma.pii.encodeNid(applicant.nationalId);
    const arn = this.generateArn();

    const record = await this.prisma.transaction(async (tx) => {
      const existing = await tx.applicant.findUnique({ where: { nidHash: nid.nidHash } });

      const applicantRecord =
        existing === null
          ? await tx.applicant.create({
              data: {
                fullName: applicant.fullName,
                fatherName: applicant.fatherName ?? null,
                nidEnc: nid.nidEnc,
                nidHash: nid.nidHash,
                email: applicant.email,
                phone: applicant.phone,
                nationality: applicant.nationality,
                currentAddress: applicant.currentAddress ?? null,
                yearsAtAddress: applicant.yearsAtAddress ?? null,
              },
            })
          : await tx.applicant.update({
              where: { id: existing.id },
              data: {
                fullName: applicant.fullName,
                email: applicant.email,
                phone: applicant.phone,
                ...(applicant.fatherName !== undefined ? { fatherName: applicant.fatherName } : {}),
                ...(applicant.currentAddress !== undefined
                  ? { currentAddress: applicant.currentAddress }
                  : {}),
                ...(applicant.yearsAtAddress !== undefined
                  ? { yearsAtAddress: applicant.yearsAtAddress }
                  : {}),
              },
            });

      const application = await tx.loanApplication.create({
        data: {
          arn,
          applicantId: applicantRecord.id,
          productType: input.productType,
          requestedAmountNpr: input.requestedAmountNpr,
          tenureMonths: input.tenureMonths,
          status: 'PENDING_DOCUMENTS',
          consentDataProcessing: input.consent.dataProcessing,
          consentCreditBureauPull: input.consent.creditBureauPull,
          consentAutomatedAssessment: input.consent.automatedAssessment,
          consentedAt: new Date(),
          submittedAt: new Date(),
        },
      });

      await tx.decisionAudit.create({
        data: {
          applicationId: application.id,
          eventType: 'APPLICATION_CREATED',
          actorType: 'APPLICANT',
          inputSnapshot: toJson({
            productType: input.productType,
            requestedAmountNpr: input.requestedAmountNpr,
            tenureMonths: input.tenureMonths,
            // Consents are the legal basis for everything that follows (SOP-001 step 5).
            consent: input.consent,
            isReturningApplicant: existing !== null,
          }),
        },
      });

      return application;
    });

    this.logger.log(`Created application ${record.arn} (${input.productType})`);
    return { id: record.id, arn: record.arn };
  }

  /* ====================================================================== */
  /* Brief method 1 — processDocumentUpload                                 */
  /* ====================================================================== */

  /**
   * Stores and extracts the resume and bank statement, then runs the full assessment.
   *
   * Extraction failures are captured rather than thrown: a CV that will not parse should
   * produce a referred application with a specific reason, not a 500 to the applicant.
   */
  async processDocumentUpload(
    applicationId: string,
    resumeFile: UploadedFile,
    statementFile: UploadedFile,
    options: {
      readonly kycDocuments?: readonly DocumentType[];
      readonly residenceStatus?: ResidenceStatus;
    } = {},
  ): Promise<CreditAssessmentResult> {
    const started = Date.now();

    const application = await this.prisma.db.loanApplication.findUnique({
      where: { id: applicationId },
      include: { applicant: true },
    });
    if (application === null) {
      throw new NotFoundException(`Application ${applicationId} not found`);
    }
    if (!application.consentAutomatedAssessment) {
      throw new BadRequestException(
        'Applicant has not consented to automated assessment (SOP-001 step 5)',
      );
    }

    await this.prisma.db.loanApplication.update({
      where: { id: applicationId },
      data: { status: 'EXTRACTING' },
    });

    // ---- Persist the raw uploads ----------------------------------------
    const [storedResume, storedStatement] = await Promise.all([
      this.storage.store(applicationId, resumeFile.buffer),
      this.storage.store(applicationId, statementFile.buffer),
    ]);

    const extraction = await this.extract(resumeFile, statementFile);

    await this.persistDocuments(applicationId, [
      {
        type: 'RESUME' as DocumentType,
        file: resumeFile,
        stored: storedResume,
        confidence: extraction.resume.confidence,
        error: extraction.resumeError,
        raw: {
          employmentCount: extraction.resume.employment.length,
          educationLevel: extraction.resume.education.level,
          missingFields: extraction.resume.missingFields,
          extractor: this.extractor.name,
        },
      },
      {
        type: 'BANK_STATEMENT' as DocumentType,
        file: statementFile,
        stored: storedStatement,
        confidence: extraction.statement.confidence,
        error: extraction.statementError,
        raw: {
          transactionCount: extraction.statement.transactions.length,
          bankName: extraction.statement.bankName,
          missingFields: extraction.statement.missingFields,
          extractor: this.extractor.name,
        },
      },
    ]);

    // ---- Feature engineering --------------------------------------------
    const suppliedDocuments: DocumentType[] = [
      'RESUME',
      'BANK_STATEMENT',
      ...(options.kycDocuments ?? []),
    ];
    if (extraction.resume.passportNumber !== null && !suppliedDocuments.includes('PASSPORT')) {
      suppliedDocuments.push('PASSPORT');
    }

    const featureResult = this.computeFeatures({
      productType: application.productType,
      requestedAmountNpr: Number(application.requestedAmountNpr),
      tenureMonths: application.tenureMonths,
      resume: extraction.resume,
      statement: extraction.statement,
      transactions: extraction.transactions,
      suppliedDocuments,
      residenceStatus: options.residenceStatus ?? application.applicant.residenceStatus,
      yearsAtAddress:
        application.applicant.yearsAtAddress === null
          ? null
          : Number(application.applicant.yearsAtAddress),
      resumeConfidence: extraction.resume.confidence,
      statementConfidence: extraction.statement.confidence,
      minConfidence: this.policy.current.extractionMinConfidence,
    });

    return this.score(applicationId, extraction, featureResult, started);
  }

  /* ====================================================================== */
  /* Brief method 2 — computeFeatures                                       */
  /* ====================================================================== */

  /** Thin delegation; the logic lives in `FeatureEngineeringService`. */
  computeFeatures(
    input: Parameters<FeatureEngineeringService['computeFeatures']>[0],
  ): FeatureComputationResult {
    return this.features.computeFeatures(input);
  }

  /* ====================================================================== */
  /* Brief method 3 — invokeScoringEngine                                   */
  /* ====================================================================== */

  /**
   * Scores the feature vector and records the decision.
   *
   * The scorecard runs first and unconditionally; the model runs second and its failure is a
   * degraded flag rather than an exception. That ordering is what makes the ML service a
   * genuinely optional dependency of a credit decision.
   */
  async invokeScoringEngine(
    applicationId: string,
    featureResult: FeatureComputationResult,
    context: {
      readonly arn: string;
      readonly startedAt: number;
      readonly extractionConfidenceOk: boolean;
    },
  ): Promise<CreditAssessmentResult> {
    const application = await this.prisma.db.loanApplication.findUnique({
      where: { id: applicationId },
      include: { applicant: true },
    });
    if (application === null) {
      throw new NotFoundException(`Application ${applicationId} not found`);
    }

    const scorecardResult = this.scorecard.score(featureResult.features);
    const flags = new Set<DegradedFlag>(featureResult.degradedFlags);

    // An identity that has not been verified is not an adverse finding, so it does not fire the
    // §5.3 decline override — but it does make the assessment incomplete, which blocks automated
    // approval and routes the application to a human.
    if (application.applicant.nidVerificationStatus !== 'VERIFIED') {
      flags.add('KYC_NOT_VERIFIED');
    }

    // ---- ML model, shadow mode -------------------------------------------
    const mlOutcome = await this.ml.predict(context.arn, featureResult.features);
    let mlPDefaultShadow: number | null = null;
    let mlModelVersion: string | null = null;
    let mlProvenance: ModelProvenance | null = null;
    let positiveFactors: ShapFactor[] = [];
    let negativeFactors: ShapFactor[] = [];

    if (mlOutcome.ok) {
      mlPDefaultShadow = mlOutcome.prediction.pDefault;
      mlModelVersion = mlOutcome.prediction.modelVersion;
      mlProvenance = mlOutcome.prediction.provenance;
      positiveFactors = [...mlOutcome.prediction.positiveFactors];
      negativeFactors = [...mlOutcome.prediction.negativeFactors];
    } else {
      flags.add(mlOutcome.flag);
      // Without SHAP we still owe the applicant an explanation, so derive one from the
      // scorecard itself: the sub-scores that earned least are precisely the reasons.
      const derived = this.explainFromScorecard(scorecardResult.pillars, featureResult.features);
      positiveFactors = derived.positive;
      negativeFactors = derived.negative;
    }

    // ---- Overrides (§5.3) -----------------------------------------------
    const overrideResult = this.overrides.evaluate({
      amlWatchlistHit: application.applicant.amlWatchlistHit,
      isPep: application.applicant.isPep,
      kycFaceMatchScore:
        application.applicant.kycFaceMatchScore === null
          ? null
          : Number(application.applicant.kycFaceMatchScore),
      nidVerificationStatus: application.applicant.nidVerificationStatus,
      hasActiveBankruptcy: application.hasActiveBankruptcy,
      activeLoanCount: application.activeLoanCount,
      documentFraudFlag: application.documentFraudFlag,
      debtServiceRatio: featureResult.derived.debtServiceRatio,
    });

    // The nationality rule is evaluated on every application and recorded. Shipping
    // disabled, it contributes zero points — and that zero is the audit evidence.
    const geoEvaluation = this.policy.evaluateGeopoliticalAdjustment(
      application.applicant.nationality,
    );

    // ---- Decision --------------------------------------------------------
    const scorecardPd = this.decisions.pDefaultFromScore(scorecardResult.compositeScore);
    const decision = this.decisions.decide({
      compositeScore: scorecardResult.compositeScore,
      productType: application.productType,
      requestedAmountNpr: Number(application.requestedAmountNpr),
      tenureMonths: application.tenureMonths,
      // The scorecard is authoritative (§6.4 promotion pending real outcome data), so the
      // decisive PD comes from the band mapping, not the model.
      pDefault: scorecardPd,
      mlPDefaultShadow,
      triggeredOverrides: overrideResult.triggered,
      degradedFlags: [...flags],
    });

    const latencyMs = Date.now() - context.startedAt;

    // ---- Persist: features, score, policy evaluations and audit together --
    const scoreRecord = await this.prisma.transaction(async (tx) => {
      await tx.featureStore.upsert({
        where: { applicationId },
        create: {
          applicationId,
          featureSetVersion: featureResult.featureSetVersion,
          features: toJson(featureResult.features),
          avgBalance6mNpr: featureResult.derived.avgBalance6mNpr,
          avgMonthlyIncomeNpr: featureResult.derived.avgMonthlyIncomeNpr,
          debtServiceRatio: featureResult.derived.debtServiceRatio,
          savingsRate: featureResult.derived.savingsRate,
          salaryConsistencyMonths: featureResult.derived.salaryConsistencyMonths,
          bounceCount6m: featureResult.derived.bounceCount6m,
          cashBufferMonths: featureResult.derived.cashBufferMonths,
          incomeStreamCount: featureResult.derived.incomeStreamCount,
          discretionaryRatio: featureResult.derived.discretionaryRatio,
          degradedFlags: [...flags],
        },
        update: {
          featureSetVersion: featureResult.featureSetVersion,
          features: featureResult.features,
          avgBalance6mNpr: featureResult.derived.avgBalance6mNpr,
          avgMonthlyIncomeNpr: featureResult.derived.avgMonthlyIncomeNpr,
          debtServiceRatio: featureResult.derived.debtServiceRatio,
          savingsRate: featureResult.derived.savingsRate,
          salaryConsistencyMonths: featureResult.derived.salaryConsistencyMonths,
          bounceCount6m: featureResult.derived.bounceCount6m,
          cashBufferMonths: featureResult.derived.cashBufferMonths,
          incomeStreamCount: featureResult.derived.incomeStreamCount,
          discretionaryRatio: featureResult.derived.discretionaryRatio,
          degradedFlags: [...flags],
        },
      });

      const pillarByName = (name: PillarResult['pillar']): number =>
        scorecardResult.pillars.find((pillar) => pillar.pillar === name)?.points ?? 0;

      const created = await tx.creditScore.create({
        data: {
          applicationId,
          financialScore: pillarByName('FINANCIAL'),
          professionalScore: pillarByName('PROFESSIONAL'),
          socialScore: pillarByName('SOCIAL'),
          behavioralScore: pillarByName('BEHAVIORAL'),
          compositeScore: scorecardResult.compositeScore,
          riskBand: decision.riskBand,
          decision: decision.decision,
          pdProbability: decision.pDefault,
          lgdEstimate: decision.lgdEstimate,
          expectedLossNpr: decision.expectedLossNpr,
          provisionRate: decision.provisionRate,
          baselRiskWeight: decision.baselRiskWeight,
          approvedLimitNpr: decision.offer?.approvedLimitNpr ?? null,
          monthlyInterestRate: decision.offer?.monthlyInterestRate ?? null,
          processingFeePct: decision.offer?.processingFeePct ?? null,
          requiresGuarantor: decision.offer?.requiresGuarantor ?? false,
          shapJson: toJson({ positiveFactors, negativeFactors }),
          pillarBreakdownJson: toJson({ pillars: scorecardResult.pillars }),
          reasons: [...decision.reasons],
          overrideCodes: overrideResult.triggered.map((override) => override.code),
          degradedFlags: [...flags],
          degraded: decision.degraded,
          scorecardVersion: scorecardResult.scorecardVersion,
          featureSetVersion: featureResult.featureSetVersion,
          mlModelVersion,
          mlProvenance,
          mlPDefaultShadow,
          modelDivergence:
            mlPDefaultShadow === null ? null : roundTo(Math.abs(mlPDefaultShadow - scorecardPd), 6),
          latencyMs,
        },
      });

      await tx.policyRuleEvaluation.createMany({
        data: [...overrideResult.evaluations, geoEvaluation].map((evaluation) => ({
          applicationId,
          ruleId: evaluation.ruleId,
          ruleVersion: evaluation.ruleVersion,
          outcome: evaluation.outcome,
          pointsApplied: evaluation.pointsApplied,
          detail: evaluation.detail,
        })),
      });

      // §10.4 / EU AI Act: a complete, self-contained record of the decision.
      await tx.decisionAudit.create({
        data: {
          applicationId,
          eventType: 'CREDIT_DECISION',
          actorType: 'SYSTEM',
          actorId: `scorecard@${scorecardResult.scorecardVersion}`,
          inputSnapshot: toJson({
            features: featureResult.features,
            featureSetVersion: featureResult.featureSetVersion,
            scorecardVersion: scorecardResult.scorecardVersion,
            policyVersion: this.policy.current.version,
            mlModelVersion,
            mlProvenance,
            extractor: this.extractor.name,
            degradedFlags: [...flags],
          }),
          outputSnapshot: toJson({
            compositeScore: scorecardResult.compositeScore,
            pillars: scorecardResult.pillars,
            riskBand: decision.riskBand,
            decision: decision.decision,
            pDefault: decision.pDefault,
            mlPDefaultShadow,
            expectedLossNpr: decision.expectedLossNpr,
            offer: decision.offer,
            overrides: overrideResult.triggered,
            reasons: decision.reasons,
            shap: { positiveFactors, negativeFactors },
            latencyMs,
          }),
        },
      });

      await tx.loanApplication.update({
        where: { id: applicationId },
        data: {
          status: decision.decision === 'REFER_UNDERWRITER' ? 'UNDER_REVIEW' : 'DECIDED',
          decidedAt: new Date(),
        },
      });

      // §10.1 — schedule the raw documents for deletion 90 days after the decision.
      await tx.document.updateMany({
        where: { applicationId },
        data: { purgeAfter: this.storage.purgeDeadline() },
      });

      return created;
    });

    this.logger.log(
      `[${context.arn}] ${decision.decision} · ${scorecardResult.compositeScore.toFixed(0)}/1000 ` +
        `· ${decision.riskBand} · ${latencyMs}ms` +
        (decision.degraded ? ` · DEGRADED (${[...flags].join(', ')})` : ''),
    );

    return {
      applicationId,
      arn: context.arn,
      productType: application.productType,
      requestedAmountNpr: Number(application.requestedAmountNpr),
      compositeScore: scorecardResult.compositeScore,
      riskBand: decision.riskBand,
      decision: decision.decision,
      pillars: scorecardResult.pillars,
      pDefault: decision.pDefault,
      lgdEstimate: decision.lgdEstimate,
      expectedLossNpr: decision.expectedLossNpr,
      offer: decision.offer,
      positiveFactors,
      negativeFactors,
      triggeredOverrides: decision.triggeredOverrides,
      degradedFlags: [...flags],
      degraded: decision.degraded,
      reasons: decision.reasons,
      scorecardVersion: scorecardResult.scorecardVersion,
      mlModelVersion,
      mlProvenance,
      mlPDefaultShadow,
      featureSetVersion: featureResult.featureSetVersion,
      scoredAt: scoreRecord.scoredAt.toISOString(),
      latencyMs,
    };
  }

  /* ====================================================================== */
  /* Read model                                                             */
  /* ====================================================================== */

  /** Latest assessment for an application, for the dashboard. */
  async getAssessment(applicationId: string): Promise<CreditAssessmentResult | null> {
    const application = await this.prisma.db.loanApplication.findUnique({
      where: { id: applicationId },
      include: {
        creditScores: { orderBy: { scoredAt: 'desc' }, take: 1 },
        featureStore: true,
      },
    });

    const score = application?.creditScores[0];
    if (application === undefined || application === null || score === undefined) {
      return null;
    }

    const shap = score.shapJson as { positiveFactors?: ShapFactor[]; negativeFactors?: ShapFactor[] };
    const breakdown = score.pillarBreakdownJson as { pillars?: PillarResult[] };

    return {
      applicationId: application.id,
      arn: application.arn,
      productType: application.productType,
      requestedAmountNpr: Number(application.requestedAmountNpr),
      compositeScore: Number(score.compositeScore),
      riskBand: score.riskBand,
      decision: score.decision,
      pillars: breakdown.pillars ?? [],
      pDefault: Number(score.pdProbability),
      lgdEstimate: Number(score.lgdEstimate),
      expectedLossNpr: Number(score.expectedLossNpr),
      offer:
        score.approvedLimitNpr === null
          ? null
          : {
              approvedLimitNpr: Number(score.approvedLimitNpr),
              monthlyInterestRate: Number(score.monthlyInterestRate ?? 0),
              processingFeePct: Number(score.processingFeePct ?? 0),
              processingFeeNpr: roundTo(
                Number(score.approvedLimitNpr) * Number(score.processingFeePct ?? 0),
                2,
              ),
              tenureMonths: application.tenureMonths,
              requiresGuarantor: score.requiresGuarantor,
            },
      positiveFactors: shap.positiveFactors ?? [],
      negativeFactors: shap.negativeFactors ?? [],
      triggeredOverrides: [],
      degradedFlags: score.degradedFlags as DegradedFlag[],
      degraded: score.degraded,
      reasons: score.reasons,
      scorecardVersion: score.scorecardVersion,
      mlModelVersion: score.mlModelVersion,
      mlProvenance: score.mlProvenance,
      mlPDefaultShadow: score.mlPDefaultShadow === null ? null : Number(score.mlPDefaultShadow),
      featureSetVersion: score.featureSetVersion,
      scoredAt: score.scoredAt.toISOString(),
      latencyMs: score.latencyMs,
    };
  }

  /* ====================================================================== */
  /* Internals                                                              */
  /* ====================================================================== */

  private async score(
    applicationId: string,
    extraction: ExtractionOutcome,
    featureResult: FeatureComputationResult,
    startedAt: number,
  ): Promise<CreditAssessmentResult> {
    const application = await this.prisma.db.loanApplication.findUniqueOrThrow({
      where: { id: applicationId },
      select: { arn: true },
    });

    await this.persistBankData(applicationId, extraction);
    await this.persistResume(applicationId, extraction.resume);

    await this.prisma.db.loanApplication.update({
      where: { id: applicationId },
      data: { status: 'SCORING' },
    });

    const minConfidence = this.policy.current.extractionMinConfidence;
    return this.invokeScoringEngine(applicationId, featureResult, {
      arn: application.arn,
      startedAt,
      extractionConfidenceOk:
        extraction.resume.confidence >= minConfidence &&
        extraction.statement.confidence >= minConfidence,
    });
  }

  /**
   * Runs both extractions concurrently (§6.2 budgets them in parallel).
   *
   * A failure in one document does not abort the other: an unreadable CV still leaves a
   * scoreable bank statement, and the resulting assessment is referred with a precise reason
   * rather than rejected outright.
   */
  private async extract(
    resumeFile: UploadedFile,
    statementFile: UploadedFile,
  ): Promise<ExtractionOutcome> {
    const toRaw = (file: UploadedFile): RawDocument => ({
      buffer: file.buffer,
      originalName: file.originalname,
      mimeType: file.mimetype,
    });

    const [resumeSettled, statementSettled] = await Promise.allSettled([
      this.extractor.extractResume(toRaw(resumeFile)),
      this.extractor.extractStatement(toRaw(statementFile)),
    ]);

    let resume: ResumeExtraction;
    let resumeError: string | null = null;
    if (resumeSettled.status === 'fulfilled') {
      resume = resumeSettled.value;
    } else {
      resumeError = this.describeExtractionFailure(resumeSettled.reason);
      this.logger.warn(`Resume extraction failed: ${resumeError}`);
      resume = emptyResumeExtraction(['resume']);
    }

    let statement: StatementExtraction;
    let statementError: string | null = null;
    if (statementSettled.status === 'fulfilled') {
      statement = statementSettled.value;
    } else {
      statementError = this.describeExtractionFailure(statementSettled.reason);
      this.logger.warn(`Statement extraction failed: ${statementError}`);
      statement = emptyStatementExtraction(['transactions']);
    }

    return {
      resume,
      statement,
      transactions: classifyStatement(statement.transactions),
      resumeError,
      statementError,
    };
  }

  private describeExtractionFailure(reason: unknown): string {
    if (reason instanceof EmptyExtractionError) {
      return reason.message;
    }
    return reason instanceof Error ? reason.message : String(reason);
  }

  private async persistDocuments(
    applicationId: string,
    documents: readonly {
      type: DocumentType;
      file: UploadedFile;
      stored: { storageKey: string; sha256: string; sizeBytes: number };
      confidence: number;
      error: string | null;
      raw: Record<string, unknown>;
    }[],
  ): Promise<void> {
    const minConfidence = this.policy.current.extractionMinConfidence;

    await this.prisma.db.document.createMany({
      data: documents.map((document) => ({
        applicationId,
        type: document.type,
        originalName: document.file.originalname.slice(0, 255),
        mimeType: document.file.mimetype.slice(0, 127),
        sizeBytes: document.stored.sizeBytes,
        sha256: document.stored.sha256,
        storageKey: document.stored.storageKey,
        extractionStatus:
          document.error !== null
            ? ('FAILED' as const)
            : document.confidence < minConfidence
              ? ('LOW_CONFIDENCE' as const)
              : ('SUCCEEDED' as const),
        extractionConfidence: document.confidence,
        extractionError: document.error,
        rawJson: toJson(document.raw),
        extractedAt: new Date(),
      })),
    });
  }

  private async persistResume(applicationId: string, resume: ResumeExtraction): Promise<void> {
    await this.prisma.transaction(async (tx) => {
      // Re-scoring an application replaces its resume profile; cascades clear the children.
      await tx.resumeProfile.deleteMany({ where: { applicationId } });

      const profile = await tx.resumeProfile.create({
        data: {
          applicationId,
          pastSalaryNpr: resume.pastSalaryNpr,
          expectedSalaryNpr: resume.expectedSalaryNpr,
          totalExperienceYears: resume.employment.length === 0 ? 0 : undefined,
          jobChangesCount: Math.max(0, resume.employment.length - 1),
          highestEducation: resume.education.level,
          institution: resume.education.institution,
          educationCountry: resume.education.country,
          isEducationAbroad: resume.education.isAbroad,
          graduationYear: resume.education.graduationYear,
          gpa: resume.education.gpa,
          countriesTraveled: [...resume.countriesTraveled],
          premiumVisas: [...resume.premiumVisas],
          extractionConfidence: resume.confidence,
          missingFields: [...resume.missingFields],
        },
      });

      if (resume.employment.length > 0) {
        await tx.employmentHistory.createMany({
          data: resume.employment.map((role) => ({
            resumeProfileId: profile.id,
            employerName: role.employerName.slice(0, 300),
            employerType: role.employerType,
            title: role.title.slice(0, 200),
            seniorityRank: role.seniorityRank,
            startDate: role.startDate,
            endDate: role.endDate,
            isCurrent: role.isCurrent,
            salaryNpr: role.salaryNpr,
            country: role.country,
          })),
        });
      }

      if (resume.references.length > 0) {
        await tx.professionalReference.createMany({
          data: resume.references.map((reference) => ({
            resumeProfileId: profile.id,
            name: reference.name.slice(0, 200),
            designation: reference.designation?.slice(0, 200) ?? null,
            organisation: reference.organisation?.slice(0, 300) ?? null,
            tier: reference.tier,
            relationship: reference.relationship?.slice(0, 100) ?? null,
            // A referee's contact details are third-party personal data (§10.1).
            contactEnc: this.prisma.pii.encodeOptional(reference.contact),
          })),
        });
      }

      if (resume.certifications.length > 0) {
        await tx.certification.createMany({
          data: resume.certifications.map((cert) => ({
            resumeProfileId: profile.id,
            name: cert.name.slice(0, 300),
            issuer: cert.issuer?.slice(0, 300) ?? null,
            isInternational: cert.isInternational,
            issuedYear: cert.issuedYear,
          })),
        });
      }

      if (resume.awards.length > 0) {
        await tx.award.createMany({
          data: resume.awards.map((award) => ({
            resumeProfileId: profile.id,
            title: award.title.slice(0, 300),
            scope: award.scope,
            year: award.year,
          })),
        });
      }
    });
  }

  private async persistBankData(
    applicationId: string,
    extraction: ExtractionOutcome,
  ): Promise<void> {
    const { statement, transactions } = extraction;
    if (transactions.length === 0) {
      return;
    }

    // A statement with no readable account number still needs a stable identity; the
    // application id gives one without inventing a plausible-looking account number.
    const accountNumber = statement.accountNumber ?? `UNKNOWN-${applicationId}`;
    const encoded = this.prisma.pii.encodeAccountNumber(accountNumber);

    await this.prisma.transaction(async (tx) => {
      await tx.bankStatement.deleteMany({ where: { applicationId } });

      const account = await tx.bankAccount.create({
        data: {
          bankName: (statement.bankName ?? 'Undisclosed bank').slice(0, 200),
          accountType: statement.accountType ?? 'SAVINGS',
          currency: statement.currency,
          accountNumberMasked:
            statement.accountNumber === null
              ? 'UNKNOWN'
              : maskAccountNumber(statement.accountNumber),
          accountNumberEnc: encoded.accountNumberEnc,
          accountNumberHash: encoded.accountNumberHash,
          statementFrom: statement.periodFrom,
          statementTo: statement.periodTo,
        },
      });

      const monthsCovered = new Set(
        transactions.map(
          (txn) =>
            `${txn.date.getUTCFullYear()}-${String(txn.date.getUTCMonth() + 1).padStart(2, '0')}`,
        ),
      ).size;

      await tx.bankStatement.create({
        data: {
          applicationId,
          bankAccountId: account.id,
          periodFrom: statement.periodFrom ?? transactions[0]?.date ?? new Date(),
          periodTo: statement.periodTo ?? transactions.at(-1)?.date ?? new Date(),
          monthsCovered,
          parsedTxnCount: transactions.length,
          openingBalanceNpr: statement.openingBalanceNpr,
          closingBalanceNpr: statement.closingBalanceNpr,
          extractionConfidence: statement.confidence,
        },
      });

      await tx.transaction.createMany({
        data: transactions.map((txn) => ({
          accountId: account.id,
          txnDate: txn.date,
          description: txn.description.slice(0, 500),
          debitNpr: txn.debitNpr,
          creditNpr: txn.creditNpr,
          direction: txn.creditNpr > 0 ? ('CREDIT' as const) : ('DEBIT' as const),
          balanceAfterNpr: txn.balanceAfterNpr,
          aiCategory: txn.category,
          categoryConfidence: txn.categoryConfidence,
          counterparty: txn.counterparty?.slice(0, 300) ?? null,
          isRecurring: txn.isRecurring,
          recurringGroupId: txn.recurringGroupId,
        })),
      });
    });
  }

  /**
   * Builds explanation factors from the scorecard when SHAP is unavailable.
   *
   * §6.3 and SOP-003 require top-5 positive and top-3 negative factors on every decision,
   * including one taken while the model was down. Ranking sub-scores by the points they
   * earned or forfeited yields the same shape of explanation, sourced from the artefact that
   * actually made the decision.
   */
  private explainFromScorecard(
    pillars: readonly PillarResult[],
    features: Record<string, number>,
  ): { positive: ShapFactor[]; negative: ShapFactor[] } {
    const rows = pillars.flatMap((pillar) =>
      pillar.subScores.map((sub) => ({
        sub,
        // Share of the sub-score's maximum that was earned.
        earnedRatio: sub.maxPoints === 0 ? 0 : sub.points / sub.maxPoints,
        forfeited: sub.maxPoints - sub.points,
      })),
    );

    const toFactor = (
      row: (typeof rows)[number],
      direction: ShapFactor['direction'],
    ): ShapFactor => ({
      feature: row.sub.code,
      label: row.sub.label,
      description: row.sub.detail,
      // Signed magnitude in points, so the UI can size bars consistently with real SHAP.
      shapValue: direction === 'INCREASES_RISK' ? row.forfeited : -row.sub.points,
      featureValue: roundTo(row.sub.points, 2),
      direction,
    });

    const positive = [...rows]
      .filter((row) => row.earnedRatio >= 0.6 && row.sub.points > 0)
      .sort((a, b) => b.sub.points - a.sub.points)
      .slice(0, 5)
      .map((row) => toFactor(row, 'DECREASES_RISK'));

    const negative = [...rows]
      .filter((row) => row.forfeited > 0)
      .sort((a, b) => b.forfeited - a.forfeited)
      .slice(0, 3)
      .map((row) => toFactor(row, 'INCREASES_RISK'));

    return { positive, negative };
  }

  /**
   * Application Reference Number (SOP-001 step 11).
   *
   * `BNPL-YYYYMMDD-XXXXXX`: sortable by date, unique via a random suffix, and readable over
   * the phone by a support agent.
   */
  private generateArn(): string {
    const now = new Date();
    const datePart = [
      now.getUTCFullYear(),
      String(now.getUTCMonth() + 1).padStart(2, '0'),
      String(now.getUTCDate()).padStart(2, '0'),
    ].join('');
    const suffix = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
    return `ONE-${datePart}-${suffix}`;
  }

  /** Exposed for the adverse-action notice generator and tests. */
  adverseActionText(feature: string): string {
    return adverseActionFor(feature);
  }

  /** Exposed for the dashboard's factor labels. */
  featureLabel(feature: string): string {
    return labelFor(feature);
  }

  /** Feature-set version this build computes against. */
  get featureSetVersion(): string {
    return CURRENT_FEATURE_SET_VERSION;
  }
}
