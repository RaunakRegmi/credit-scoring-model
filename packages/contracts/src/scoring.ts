/**
 * Wire contracts for the scoring path:
 *   NestJS  ->  FastAPI   (MlPredictRequest / MlPredictResponse)
 *   NestJS  ->  Dashboard (CreditAssessmentResult)
 *
 * Both directions are zod-validated at the boundary. A schema mismatch surfaces as a
 * clear 4xx at the edge rather than as a `NaN` score three layers in.
 */
import { z } from 'zod';

import {
  DECISIONS,
  DEGRADED_FLAGS,
  OVERRIDE_CODES,
  PILLARS,
  PRODUCT_TYPES,
  RISK_BANDS,
  type Decision,
  type DegradedFlag,
  type OverrideCode,
  type Pillar,
  type ProductType,
  type RiskBand,
} from './enums';
import { FEATURE_SET_VERSION, featureVectorSchema } from './features';

/* -------------------------------------------------------------------------- */
/* NestJS -> FastAPI                                                           */
/* -------------------------------------------------------------------------- */

export const mlPredictRequestSchema = z.object({
  /**
   * The manifest version the caller computed features against. The ML service rejects a
   * mismatch with 409 rather than scoring a vector whose columns may not mean what the
   * model thinks they mean.
   */
  featureSetVersion: z.string().min(1),
  /** Opaque correlation id (the ARN) for tracing a prediction back to an application. */
  applicationRef: z.string().min(1),
  features: featureVectorSchema,
});

export type MlPredictRequest = z.infer<typeof mlPredictRequestSchema>;

/** One SHAP contribution, already resolved to human-readable wording. */
export const shapFactorSchema = z.object({
  feature: z.string().min(1),
  label: z.string().min(1),
  /** Plain-language sentence for the applicant (SOP-003). */
  description: z.string().min(1),
  /** Raw SHAP value in log-odds. Positive pushes towards default. */
  shapValue: z.number().finite(),
  /** The feature's value for this applicant, for the underwriter's benefit. */
  featureValue: z.number().finite(),
  direction: z.enum(['INCREASES_RISK', 'DECREASES_RISK']),
});

export type ShapFactor = z.infer<typeof shapFactorSchema>;

/**
 * Where the model's training labels came from. Surfaced all the way to the UI so nobody
 * mistakes the launch model for one fitted on real repayment outcomes.
 */
export const MODEL_PROVENANCES = ['SYNTHETIC_SEED', 'HISTORICAL_OUTCOMES', 'HYBRID'] as const;
export type ModelProvenance = (typeof MODEL_PROVENANCES)[number];

export const mlPredictResponseSchema = z.object({
  pDefault: z.number().min(0).max(1),
  modelVersion: z.string().min(1),
  featureSetVersion: z.string().min(1),
  provenance: z.enum(MODEL_PROVENANCES),
  /** §6.3: top 5 factors supporting the applicant. */
  positiveFactors: z.array(shapFactorSchema).max(10),
  /** §6.3: top 3 factors counting against them, used verbatim in decline notices. */
  negativeFactors: z.array(shapFactorSchema).max(10),
  /** Model's base rate in probability space, so SHAP values reconcile to the prediction. */
  baseValue: z.number().finite(),
  inferenceMs: z.number().nonnegative(),
});

export type MlPredictResponse = z.infer<typeof mlPredictResponseSchema>;

export const mlModelInfoSchema = z.object({
  modelVersion: z.string(),
  featureSetVersion: z.string(),
  provenance: z.enum(MODEL_PROVENANCES),
  trainedAt: z.string(),
  featureCount: z.number().int(),
  metrics: z.object({
    auc: z.number(),
    gini: z.number(),
    ks: z.number(),
    brier: z.number(),
  }),
});

export type MlModelInfo = z.infer<typeof mlModelInfoSchema>;

/* -------------------------------------------------------------------------- */
/* Scorecard output                                                            */
/* -------------------------------------------------------------------------- */

/** One row of a §4.2–4.5 pillar table. */
export interface SubScore {
  /** Stable identifier, e.g. `AVG_BALANCE_6M`. */
  readonly code: string;
  /** Sub-parameter name as printed in the technical document. */
  readonly label: string;
  readonly points: number;
  readonly maxPoints: number;
  /** How the points were arrived at, shown to underwriters. */
  readonly detail: string;
}

export interface PillarResult {
  readonly pillar: Pillar;
  readonly points: number;
  readonly maxPoints: number;
  readonly subScores: readonly SubScore[];
  /** Notes worth surfacing — caps applied, data missing, thresholds hit. */
  readonly notes: readonly string[];
}

export interface ScorecardResult {
  readonly pillars: readonly PillarResult[];
  readonly compositeScore: number;
  readonly scorecardVersion: string;
}

/* -------------------------------------------------------------------------- */
/* Decision                                                                    */
/* -------------------------------------------------------------------------- */

export interface TriggeredOverride {
  readonly code: OverrideCode;
  readonly label: string;
  readonly forcedDecision: Decision;
  readonly detail: string;
  readonly escalateToCompliance: boolean;
}

export interface PricedOffer {
  readonly approvedLimitNpr: number;
  readonly monthlyInterestRate: number;
  readonly processingFeePct: number;
  readonly processingFeeNpr: number;
  readonly tenureMonths: number;
  readonly requiresGuarantor: boolean;
}

export interface DecisionResult {
  readonly decision: Decision;
  readonly riskBand: RiskBand;
  readonly compositeScore: number;
  readonly pDefault: number;
  readonly lgdEstimate: number;
  readonly expectedLossNpr: number;
  readonly provisionRate: number;
  readonly baselRiskWeight: number;
  /** `null` when the decision releases no funds. */
  readonly offer: PricedOffer | null;
  readonly triggeredOverrides: readonly TriggeredOverride[];
  readonly degradedFlags: readonly DegradedFlag[];
  /** True when the score came from the scorecard-only fallback path. */
  readonly degraded: boolean;
  /** Ordered, human-readable justification for the decision actually taken. */
  readonly reasons: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* NestJS -> Dashboard                                                         */
/* -------------------------------------------------------------------------- */

export const createApplicationSchema = z.object({
  productType: z.enum(PRODUCT_TYPES),
  requestedAmountNpr: z.number().positive().max(50_000_000),
  tenureMonths: z.number().int().positive().max(120),
  applicant: z.object({
    fullName: z.string().min(2).max(200),
    fatherName: z.string().max(200).optional(),
    email: z.string().email(),
    phone: z.string().min(7).max(20),
    nationalId: z.string().min(4).max(64),
    nationality: z.string().length(2).default('NP'),
    currentAddress: z.string().max(500).optional(),
    yearsAtAddress: z.number().min(0).max(100).optional(),
  }),
  consent: z.object({
    dataProcessing: z.literal(true),
    creditBureauPull: z.literal(true),
    automatedAssessment: z.literal(true),
  }),
});

export type CreateApplicationInput = z.infer<typeof createApplicationSchema>;

export interface ApplicationSummary {
  readonly id: string;
  readonly arn: string;
  readonly status: string;
  readonly productType: ProductType;
  readonly requestedAmountNpr: number;
  readonly tenureMonths: number;
  readonly createdAt: string;
}

/** Everything the dashboard needs to render a completed assessment. */
export interface CreditAssessmentResult {
  readonly applicationId: string;
  readonly arn: string;
  readonly productType: ProductType;
  readonly requestedAmountNpr: number;

  readonly compositeScore: number;
  readonly riskBand: RiskBand;
  readonly decision: Decision;
  readonly pillars: readonly PillarResult[];

  readonly pDefault: number;
  readonly lgdEstimate: number;
  readonly expectedLossNpr: number;

  readonly offer: PricedOffer | null;
  readonly positiveFactors: readonly ShapFactor[];
  readonly negativeFactors: readonly ShapFactor[];
  readonly triggeredOverrides: readonly TriggeredOverride[];
  readonly degradedFlags: readonly DegradedFlag[];
  readonly degraded: boolean;
  readonly reasons: readonly string[];

  readonly scorecardVersion: string;
  readonly mlModelVersion: string | null;
  readonly mlProvenance: ModelProvenance | null;
  /** Shadow-mode PD from the ML model. Logged, not decisive, until §6.4 promotion. */
  readonly mlPDefaultShadow: number | null;
  readonly featureSetVersion: string;
  readonly scoredAt: string;
  readonly latencyMs: number;
}

/* -------------------------------------------------------------------------- */
/* Runtime guards used by the dashboard                                        */
/* -------------------------------------------------------------------------- */

export const decisionSchema = z.enum(DECISIONS);
export const riskBandSchema = z.enum(RISK_BANDS);
export const pillarSchema = z.enum(PILLARS);
export const degradedFlagSchema = z.enum(DEGRADED_FLAGS);
export const overrideCodeSchema = z.enum(OVERRIDE_CODES);

/** The manifest version this build of the contracts package speaks. */
export const CURRENT_FEATURE_SET_VERSION = FEATURE_SET_VERSION;
