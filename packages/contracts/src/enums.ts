/**
 * Domain enumerations and the regulatory lookup tables from the AICS technical document.
 *
 * These live in `contracts` rather than in the API because the dashboard renders band
 * names, colours, limits and rates directly — duplicating the tables in the frontend is
 * how a rate card silently drifts out of sync with the one credit actually applied.
 */

/* -------------------------------------------------------------------------- */
/* Products (§1.2)                                                             */
/* -------------------------------------------------------------------------- */

export const PRODUCT_TYPES = [
  'BNPL',
  'PERSONAL_LOAN',
  'HIRE_PURCHASE',
  'AUTO_LOAN',
  'MICRO_BNPL',
] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

export interface ProductSpec {
  readonly label: string;
  readonly minTenureMonths: number;
  readonly maxTenureMonths: number;
  /** Absolute product ceiling in NPR (§1.2). The risk band may cap lower. */
  readonly maxLimitNpr: number;
  readonly requiresGuarantorBelowBand: boolean;
}

export const PRODUCT_SPECS: Readonly<Record<ProductType, ProductSpec>> = {
  BNPL: {
    label: 'BNPL — Interest Free',
    minTenureMonths: 3,
    maxTenureMonths: 18,
    maxLimitNpr: 1_000_000,
    requiresGuarantorBelowBand: true,
  },
  PERSONAL_LOAN: {
    label: 'Personal Loan',
    minTenureMonths: 12,
    maxTenureMonths: 60,
    maxLimitNpr: 2_500_000,
    requiresGuarantorBelowBand: false,
  },
  HIRE_PURCHASE: {
    label: 'Hire Purchase',
    minTenureMonths: 12,
    maxTenureMonths: 36,
    maxLimitNpr: 5_000_000,
    requiresGuarantorBelowBand: false,
  },
  AUTO_LOAN: {
    label: 'Auto Loan',
    minTenureMonths: 12,
    maxTenureMonths: 60,
    maxLimitNpr: 4_000_000,
    requiresGuarantorBelowBand: false,
  },
  MICRO_BNPL: {
    label: 'Micro BNPL',
    minTenureMonths: 1,
    maxTenureMonths: 6,
    maxLimitNpr: 50_000,
    requiresGuarantorBelowBand: true,
  },
};

/** BNPL-family products draw their band ceiling from the BNPL column of §5.1. */
export function isBnplFamily(product: ProductType): boolean {
  return product === 'BNPL' || product === 'MICRO_BNPL';
}

/* -------------------------------------------------------------------------- */
/* Risk bands (§5.1), rate card (§5.2), provisioning (§9.3)                    */
/* -------------------------------------------------------------------------- */

export const RISK_BANDS = [
  'ELITE_PRIME',
  'PRIME',
  'NEAR_PRIME',
  'SUBPRIME',
  'HIGH_RISK',
  'REJECT',
] as const;
export type RiskBand = (typeof RISK_BANDS)[number];

export const DECISIONS = [
  'AUTO_APPROVE',
  'APPROVE_STANDARD',
  'APPROVE_WITH_CONDITIONS',
  'REFER_UNDERWRITER',
  'DECLINE',
] as const;
export type Decision = (typeof DECISIONS)[number];

export interface RiskBandSpec {
  readonly band: RiskBand;
  readonly label: string;
  /** Inclusive lower bound on the 0–1,000 composite. */
  readonly minScore: number;
  /** Inclusive upper bound. */
  readonly maxScore: number;
  readonly pdMin: number;
  readonly pdMax: number;
  readonly decision: Decision;
  /** Band ceiling for BNPL / Micro BNPL, NPR. `null` = not eligible. */
  readonly bnplLimitNpr: number | null;
  /** Band ceiling for Hire Purchase / Personal Loan / Auto Loan, NPR. `null` = refer or not eligible. */
  readonly termLoanLimitNpr: number | null;
  readonly rateBnplMonthly: number;
  readonly ratePersonalLoanMonthly: number;
  readonly rateHirePurchaseMonthly: number;
  readonly processingFeePct: number;
  /** §9.3 capital provisioning rate. */
  readonly provisionRate: number;
  /** §9.3 Basel III risk weight for retail exposure. */
  readonly baselRiskWeight: number;
  /** Tailwind-friendly accent used consistently by the dashboard. */
  readonly colorHex: string;
}

/**
 * §5.1 / §5.2 / §9.3 as one table. Ordered highest band first so a linear scan finds
 * the first band whose `minScore` the composite clears.
 */
export const RISK_BAND_TABLE: readonly RiskBandSpec[] = [
  {
    band: 'ELITE_PRIME',
    label: 'Elite Prime',
    minScore: 900,
    maxScore: 1000,
    pdMin: 0,
    pdMax: 0.01,
    decision: 'AUTO_APPROVE',
    bnplLimitNpr: 1_000_000,
    termLoanLimitNpr: 5_000_000,
    rateBnplMonthly: 0.009,
    ratePersonalLoanMonthly: 0.01,
    rateHirePurchaseMonthly: 0.0075,
    processingFeePct: 0.005,
    provisionRate: 0.005,
    baselRiskWeight: 0.75,
    colorHex: '#059669',
  },
  {
    band: 'PRIME',
    label: 'Prime',
    minScore: 750,
    maxScore: 899,
    pdMin: 0.01,
    pdMax: 0.035,
    decision: 'AUTO_APPROVE',
    bnplLimitNpr: 500_000,
    termLoanLimitNpr: 2_500_000,
    rateBnplMonthly: 0.012,
    ratePersonalLoanMonthly: 0.013,
    rateHirePurchaseMonthly: 0.01,
    processingFeePct: 0.0075,
    provisionRate: 0.015,
    baselRiskWeight: 0.75,
    colorHex: '#16a34a',
  },
  {
    band: 'NEAR_PRIME',
    label: 'Near Prime',
    minScore: 600,
    maxScore: 749,
    pdMin: 0.035,
    pdMax: 0.08,
    decision: 'APPROVE_STANDARD',
    bnplLimitNpr: 250_000,
    termLoanLimitNpr: 1_000_000,
    rateBnplMonthly: 0.015,
    ratePersonalLoanMonthly: 0.016,
    rateHirePurchaseMonthly: 0.012,
    processingFeePct: 0.01,
    provisionRate: 0.04,
    baselRiskWeight: 1.0,
    colorHex: '#65a30d',
  },
  {
    band: 'SUBPRIME',
    label: 'Subprime',
    minScore: 450,
    maxScore: 599,
    pdMin: 0.08,
    pdMax: 0.2,
    decision: 'APPROVE_WITH_CONDITIONS',
    bnplLimitNpr: 75_000,
    termLoanLimitNpr: 300_000,
    rateBnplMonthly: 0.018,
    ratePersonalLoanMonthly: 0.02,
    rateHirePurchaseMonthly: 0.015,
    processingFeePct: 0.015,
    provisionRate: 0.1,
    baselRiskWeight: 1.5,
    colorHex: '#ca8a04',
  },
  {
    band: 'HIGH_RISK',
    label: 'High Risk',
    minScore: 300,
    maxScore: 449,
    pdMin: 0.2,
    pdMax: 0.4,
    decision: 'REFER_UNDERWRITER',
    // §5.1 footnote: micro-limit only with a creditworthy guarantor co-signature.
    bnplLimitNpr: 25_000,
    termLoanLimitNpr: null,
    rateBnplMonthly: 0.024,
    ratePersonalLoanMonthly: 0.028,
    rateHirePurchaseMonthly: 0.02,
    processingFeePct: 0.02,
    provisionRate: 0.25,
    baselRiskWeight: 2.0,
    colorHex: '#ea580c',
  },
  {
    band: 'REJECT',
    label: 'Reject',
    minScore: 0,
    maxScore: 299,
    pdMin: 0.4,
    pdMax: 1,
    decision: 'DECLINE',
    bnplLimitNpr: null,
    termLoanLimitNpr: null,
    rateBnplMonthly: 0,
    ratePersonalLoanMonthly: 0,
    rateHirePurchaseMonthly: 0,
    processingFeePct: 0,
    provisionRate: 1,
    baselRiskWeight: 2.0,
    colorHex: '#dc2626',
  },
];

export const RISK_BAND_BY_NAME: Readonly<Record<RiskBand, RiskBandSpec>> = Object.fromEntries(
  RISK_BAND_TABLE.map((spec) => [spec.band, spec]),
) as Readonly<Record<RiskBand, RiskBandSpec>>;

/**
 * Maps a 0–1,000 composite to its band. Total by construction: the table's lowest entry
 * starts at 0, so the fallback can never actually be reached — it exists so the function
 * has no `!` assertion and no possible `undefined` return.
 */
export function bandForScore(compositeScore: number): RiskBandSpec {
  const clamped = Math.max(0, Math.min(1000, compositeScore));
  for (const spec of RISK_BAND_TABLE) {
    if (clamped >= spec.minScore) {
      return spec;
    }
  }
  return RISK_BAND_BY_NAME.REJECT;
}

/* -------------------------------------------------------------------------- */
/* Pillars (§4.1)                                                              */
/* -------------------------------------------------------------------------- */

export const PILLARS = ['FINANCIAL', 'PROFESSIONAL', 'SOCIAL', 'BEHAVIORAL'] as const;
export type Pillar = (typeof PILLARS)[number];

export interface PillarSpec {
  readonly pillar: Pillar;
  readonly label: string;
  readonly maxPoints: number;
  /** §4.1 weight. Informational: the pillar maxima already encode the weighting. */
  readonly weight: number;
  readonly primarySource: string;
}

export const PILLAR_SPECS: readonly PillarSpec[] = [
  { pillar: 'FINANCIAL', label: 'Financial', maxPoints: 300, weight: 0.3, primarySource: 'Bank statements' },
  { pillar: 'PROFESSIONAL', label: 'Professional', maxPoints: 250, weight: 0.25, primarySource: 'Resume / CV' },
  { pillar: 'SOCIAL', label: 'Social', maxPoints: 200, weight: 0.2, primarySource: 'Resume + KYC' },
  { pillar: 'BEHAVIORAL', label: 'Behavioral', maxPoints: 250, weight: 0.25, primarySource: 'Bank statements + Resume' },
];

export const PILLAR_MAX_POINTS: Readonly<Record<Pillar, number>> = {
  FINANCIAL: 300,
  PROFESSIONAL: 250,
  SOCIAL: 200,
  BEHAVIORAL: 250,
};

/** §4.1 — the four pillar maxima sum to the composite scale. */
export const COMPOSITE_MAX_SCORE = 1000;

/* -------------------------------------------------------------------------- */
/* Employment (§4.3)                                                           */
/* -------------------------------------------------------------------------- */

export const EMPLOYER_TYPES = [
  'MNC',
  'COMMERCIAL_BANK',
  'CORPORATE',
  'GOVERNMENT',
  'INTERNATIONAL_NGO',
  'SME',
  'INFORMAL',
] as const;
export type EmployerType = (typeof EMPLOYER_TYPES)[number];

/**
 * §4.3 employer type premium, 0–100. The Professional pillar converts this to its
 * 60-point sub-score. `INTERNATIONAL_NGO` is not in the §4.3 table but is implied by
 * §4.4's "World Bank / UN / Intl FIs" top tier; it is priced between MNC and Corporate.
 */
export const EMPLOYER_TYPE_PREMIUM: Readonly<Record<EmployerType, number>> = {
  MNC: 100,
  COMMERCIAL_BANK: 95,
  INTERNATIONAL_NGO: 90,
  CORPORATE: 80,
  GOVERNMENT: 75,
  SME: 55,
  INFORMAL: 30,
};

/** §4.4 institutional network tier, 0–100, feeding the Social pillar's 35-point sub-score. */
export const INSTITUTIONAL_TIER: Readonly<Record<EmployerType, number>> = {
  INTERNATIONAL_NGO: 100,
  MNC: 85,
  COMMERCIAL_BANK: 80,
  CORPORATE: 65,
  GOVERNMENT: 60,
  SME: 35,
  INFORMAL: 15,
};

/* -------------------------------------------------------------------------- */
/* Education (§4.3)                                                            */
/* -------------------------------------------------------------------------- */

export const EDUCATION_LEVELS = [
  'PHD',
  'MASTERS',
  'BACHELORS',
  'DIPLOMA',
  'HIGHER_SECONDARY',
  'SECONDARY',
  'NONE',
] as const;
export type EducationLevel = (typeof EDUCATION_LEVELS)[number];

/**
 * §4.3 education quality, max 30 points. The document tabulates international and local
 * variants, so the lookup is keyed on both level and whether the institution was abroad.
 */
export const EDUCATION_SCORE: Readonly<Record<EducationLevel, { intl: number; local: number }>> = {
  PHD: { intl: 30, local: 26 },
  MASTERS: { intl: 27, local: 23 },
  BACHELORS: { intl: 20, local: 16 },
  DIPLOMA: { intl: 12, local: 10 },
  HIGHER_SECONDARY: { intl: 7, local: 6 },
  SECONDARY: { intl: 4, local: 3 },
  NONE: { intl: 0, local: 0 },
};

/* -------------------------------------------------------------------------- */
/* Residence, references, KYC                                                  */
/* -------------------------------------------------------------------------- */

export const RESIDENCE_STATUSES = [
  'OWNED',
  'FAMILY_OWNED',
  'RENTED',
  'COMPANY_PROVIDED',
  'UNDECLARED',
] as const;
export type ResidenceStatus = (typeof RESIDENCE_STATUSES)[number];

/** §4.4 "Owner-occupied > rented" — multiplier on the 30-point residence sub-score. */
export const RESIDENCE_STATUS_MULTIPLIER: Readonly<Record<ResidenceStatus, number>> = {
  OWNED: 1.0,
  FAMILY_OWNED: 0.85,
  COMPANY_PROVIDED: 0.7,
  RENTED: 0.6,
  UNDECLARED: 0.2,
};

export const REFERENCE_TIERS = ['C_SUITE', 'DIRECTOR', 'SENIOR_MANAGER', 'MANAGER', 'PEER', 'UNKNOWN'] as const;
export type ReferenceTier = (typeof REFERENCE_TIERS)[number];

/** §4.4 reference quality, 0–100. Top of the scale is "C-suite / CEO / Director". */
export const REFERENCE_TIER_SCORE: Readonly<Record<ReferenceTier, number>> = {
  C_SUITE: 100,
  DIRECTOR: 90,
  SENIOR_MANAGER: 70,
  MANAGER: 55,
  PEER: 30,
  UNKNOWN: 0,
};

/** §4.4 counts at most two references. */
export const MAX_SCORED_REFERENCES = 2;

export const DOCUMENT_TYPES = [
  'RESUME',
  'BANK_STATEMENT',
  'NID_FRONT',
  'NID_BACK',
  'PASSPORT',
  'PAN_CARD',
  'ADDRESS_PROOF',
  'EMPLOYER_LETTER',
  'SALARY_SLIP',
  'BUSINESS_REGISTRATION',
  'SELFIE',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** §4.4 "NID + passport + PAN + address = max; each missing doc = −7pts". */
export const KYC_SCORED_DOCUMENTS: readonly DocumentType[] = [
  'NID_FRONT',
  'PASSPORT',
  'PAN_CARD',
  'ADDRESS_PROOF',
];

/* -------------------------------------------------------------------------- */
/* Transactions                                                                */
/* -------------------------------------------------------------------------- */

/** AI classification taxonomy for bank statement lines (§3.2.1). */
export const TXN_CATEGORIES = [
  'SALARY',
  'REMITTANCE',
  'RENTAL_INCOME',
  'BUSINESS_INCOME',
  'INTEREST_INCOME',
  'OTHER_CREDIT',
  'LOAN_EMI',
  'CREDIT_CARD_PAYMENT',
  'INSURANCE_PREMIUM',
  'UTILITY',
  'RENT_PAID',
  'ATM_WITHDRAWAL',
  'GROCERY_ESSENTIAL',
  'DISCRETIONARY',
  'TRANSFER_OUT',
  'BANK_CHARGE',
  'BOUNCE_PENALTY',
  'OTHER_DEBIT',
] as const;
export type TxnCategory = (typeof TXN_CATEGORIES)[number];

/** Credit-side categories that count towards verified income. */
export const INCOME_CATEGORIES: readonly TxnCategory[] = [
  'SALARY',
  'REMITTANCE',
  'RENTAL_INCOME',
  'BUSINESS_INCOME',
  'INTEREST_INCOME',
];

/** Debit-side categories that count towards the debt service ratio numerator. */
export const OBLIGATION_CATEGORIES: readonly TxnCategory[] = [
  'LOAN_EMI',
  'CREDIT_CARD_PAYMENT',
];

/** Non-negotiable monthly outgoings, used for the discretionary/essential split (§4.5). */
export const ESSENTIAL_CATEGORIES: readonly TxnCategory[] = [
  'UTILITY',
  'RENT_PAID',
  'GROCERY_ESSENTIAL',
  'INSURANCE_PREMIUM',
  'LOAN_EMI',
];

/* -------------------------------------------------------------------------- */
/* Application lifecycle (SOP-001 / SOP-002)                                   */
/* -------------------------------------------------------------------------- */

export const APPLICATION_STATUSES = [
  'DRAFT',
  'PENDING_DOCUMENTS',
  'EXTRACTING',
  'SCORING',
  'DECIDED',
  'UNDER_REVIEW',
  'FAILED',
  'EXPIRED',
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const EXTRACTION_STATUSES = ['PENDING', 'SUCCEEDED', 'LOW_CONFIDENCE', 'FAILED'] as const;
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

/* -------------------------------------------------------------------------- */
/* Degradation and override reason codes                                       */
/* -------------------------------------------------------------------------- */

/**
 * Conditions that make the assessment less than fully reliable. Any of these blocks
 * auto-approval regardless of score — a degraded pipeline must never approve.
 */
/**
 * Outcome of an identity verification check.
 *
 * Tri-state rather than boolean: §5.3 declines a *failed* NID verification, but an application
 * whose KYC pipeline has not run yet has produced no adverse finding and must be held for
 * review rather than refused.
 */
export const KYC_VERIFICATION_STATUSES = ['NOT_ATTEMPTED', 'VERIFIED', 'FAILED'] as const;
export type KycVerificationStatus = (typeof KYC_VERIFICATION_STATUSES)[number];

export const DEGRADED_FLAGS = [
  'INSUFFICIENT_INCOME_DATA',
  'INSUFFICIENT_STATEMENT_HISTORY',
  'KYC_NOT_VERIFIED',
  'LOW_EXTRACTION_CONFIDENCE',
  'RESUME_EXTRACTION_EMPTY',
  'STATEMENT_EXTRACTION_EMPTY',
  'ML_SERVICE_UNAVAILABLE',
  'ML_SERVICE_TIMEOUT',
  'ML_FEATURE_VERSION_MISMATCH',
  'SCORECARD_ML_DIVERGENCE',
  'NO_EMPLOYMENT_HISTORY',
  'NO_BANK_ACCOUNT',
] as const;
export type DegradedFlag = (typeof DEGRADED_FLAGS)[number];

/** §5.3 mandatory override conditions. These beat the composite score in every case. */
export const OVERRIDE_CODES = [
  'AML_WATCHLIST_MATCH',
  'KYC_FACE_MATCH_FAILURE',
  'NID_VERIFICATION_FAILURE',
  'ACTIVE_BANKRUPTCY',
  'OVERLEVERAGED_THREE_PLUS_LOANS',
  'FRAUDULENT_DOCUMENT_FLAG',
  'DSR_ABOVE_60_PERCENT',
] as const;
export type OverrideCode = (typeof OVERRIDE_CODES)[number];

export interface OverrideSpec {
  readonly code: OverrideCode;
  readonly label: string;
  /** The decision this override forces. Never weaker than the score-based decision. */
  readonly forcedDecision: Decision;
  /** Whether Compliance must be notified (§5.3, §10.3). */
  readonly escalateToCompliance: boolean;
}

export const OVERRIDE_SPECS: Readonly<Record<OverrideCode, OverrideSpec>> = {
  AML_WATCHLIST_MATCH: {
    code: 'AML_WATCHLIST_MATCH',
    label: 'AML/CFT watchlist match',
    forcedDecision: 'DECLINE',
    escalateToCompliance: true,
  },
  KYC_FACE_MATCH_FAILURE: {
    code: 'KYC_FACE_MATCH_FAILURE',
    label: 'KYC face match below 90% confidence',
    forcedDecision: 'REFER_UNDERWRITER',
    escalateToCompliance: false,
  },
  NID_VERIFICATION_FAILURE: {
    code: 'NID_VERIFICATION_FAILURE',
    label: 'National ID verification failed',
    forcedDecision: 'DECLINE',
    escalateToCompliance: false,
  },
  ACTIVE_BANKRUPTCY: {
    code: 'ACTIVE_BANKRUPTCY',
    label: 'Active bankruptcy or court attachment',
    forcedDecision: 'DECLINE',
    escalateToCompliance: true,
  },
  OVERLEVERAGED_THREE_PLUS_LOANS: {
    code: 'OVERLEVERAGED_THREE_PLUS_LOANS',
    label: 'Three or more active loans across institutions',
    forcedDecision: 'REFER_UNDERWRITER',
    escalateToCompliance: false,
  },
  FRAUDULENT_DOCUMENT_FLAG: {
    code: 'FRAUDULENT_DOCUMENT_FLAG',
    label: 'Document authenticity check failed',
    forcedDecision: 'DECLINE',
    escalateToCompliance: true,
  },
  DSR_ABOVE_60_PERCENT: {
    code: 'DSR_ABOVE_60_PERCENT',
    label: 'Debt service ratio above 60% of verified gross income',
    forcedDecision: 'REFER_UNDERWRITER',
    escalateToCompliance: false,
  },
};

/**
 * Decision severity, ascending. Used to take the strictest of the score-based decision,
 * every triggered override, and any degradation downgrade — the engine only ever moves
 * a decision in the conservative direction.
 */
export const DECISION_SEVERITY: Readonly<Record<Decision, number>> = {
  AUTO_APPROVE: 0,
  APPROVE_STANDARD: 1,
  APPROVE_WITH_CONDITIONS: 2,
  REFER_UNDERWRITER: 3,
  DECLINE: 4,
};

export function strictestDecision(...decisions: readonly Decision[]): Decision {
  return decisions.reduce<Decision>(
    (worst, candidate) =>
      DECISION_SEVERITY[candidate] > DECISION_SEVERITY[worst] ? candidate : worst,
    'AUTO_APPROVE',
  );
}

/** Decisions that release funds without a human in the loop. */
export function isAutomatedApproval(decision: Decision): boolean {
  return decision === 'AUTO_APPROVE' || decision === 'APPROVE_STANDARD';
}
