/**
 * Externalised credit policy.
 *
 * Thresholds that Credit, Risk or Compliance may need to move live here rather than in
 * code, so a policy change is a reviewed config change and not a deploy. Every rule
 * evaluation — including rules that are switched off — is written to
 * `PolicyRuleEvaluation` so an auditor can see what the engine considered, not just what
 * it applied.
 */
import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Geopolitical adjustment — SHIPS DISABLED                                    */
/* -------------------------------------------------------------------------- */

/**
 * SOP-002 step 25 specifies a nationality-based score adjustment (Myanmar −45, other
 * SAARC −15, OECD 0).
 *
 * ⚠️  FAIR LENDING CONFLICT. §10.2 of the same document commits the model to being
 * demographically neutral and commits the business to quarterly disparate-impact testing.
 * A blanket penalty on national origin is a direct contradiction and, in most
 * jurisdictions, unlawful discrimination in lending.
 *
 * It is therefore implemented as configuration, shipped `enabled: false`, and gated on
 * written Legal and Compliance sign-off. Country risk that IS defensible — sanctions and
 * AML/CFT screening under §10.3 — is handled separately by the override engine on a
 * per-applicant basis, which is a different and legitimate control.
 *
 * Leave this off unless Legal has signed off in writing.
 */
export const geopoliticalRuleSchema = z.object({
  enabled: z.boolean(),
  requiresLegalSignOff: z.literal(true),
  legalSignOffReference: z.string().nullable(),
  /** Points added to the Social pillar. Negative values are penalties. */
  adjustments: z.record(z.string(), z.number()),
  /** Named country groups referenced by `adjustments`, e.g. `SAARC`. */
  groups: z.record(z.string(), z.array(z.string().length(2))),
  fairLendingWarning: z.string(),
});

export type GeopoliticalRuleConfig = z.infer<typeof geopoliticalRuleSchema>;

/* -------------------------------------------------------------------------- */
/* Scoring policy                                                              */
/* -------------------------------------------------------------------------- */

export const scoringPolicySchema = z.object({
  version: z.string().min(1),
  effectiveFrom: z.string().min(1),

  /**
   * §12.1 item 49 — the board-approved auto-approval authority threshold. A composite at
   * or above this releases funds with no human in the loop.
   */
  autoApproveMinScore: z.number().min(0).max(1000),

  /** SOP-002 step 20 — below this extraction confidence, a human looks at it. */
  extractionMinConfidence: z.number().min(0).max(1),

  /** §3.2 — the model is specified on 6 months of statement data. */
  minStatementMonths: z.number().int().min(1).max(24),

  /** §5.3 — DSR above this forces an underwriter referral. */
  dsrOverrideThreshold: z.number().min(0).max(5),

  /** §5.3 — KYC face match below this confidence holds the application. */
  kycFaceMatchMinConfidence: z.number().min(0).max(1),

  /** §5.3 — this many concurrent active loans flags overleveraging. */
  activeLoanOverleverageCount: z.number().int().min(1),

  /**
   * How far the ML shadow PD may diverge from the PD the scorecard band implies before
   * the application goes to a human. Two models disagreeing sharply about the same
   * applicant is a signal in itself.
   */
  mlDivergenceThreshold: z.number().min(0).max(1),

  /**
   * Loss Given Default by product (§SOP-002 step 33). Unsecured lending recovers little;
   * hire purchase and auto loans sit against an asset.
   */
  lgdByProduct: z.object({
    BNPL: z.number().min(0).max(1),
    PERSONAL_LOAN: z.number().min(0).max(1),
    HIRE_PURCHASE: z.number().min(0).max(1),
    AUTO_LOAN: z.number().min(0).max(1),
    MICRO_BNPL: z.number().min(0).max(1),
  }),

  geopoliticalAdjustment: geopoliticalRuleSchema,
});

export type ScoringPolicy = z.infer<typeof scoringPolicySchema>;

/**
 * Shipped defaults, matching the document as approved. Overridable by
 * `apps/api/policy/scoring-policy.json`.
 */
export const DEFAULT_SCORING_POLICY: ScoringPolicy = {
  version: '1.0.0',
  effectiveFrom: '2026-05-01',
  autoApproveMinScore: 750,
  extractionMinConfidence: 0.85,
  minStatementMonths: 6,
  dsrOverrideThreshold: 0.6,
  kycFaceMatchMinConfidence: 0.9,
  activeLoanOverleverageCount: 3,
  mlDivergenceThreshold: 0.25,
  lgdByProduct: {
    BNPL: 0.9,
    PERSONAL_LOAN: 0.85,
    HIRE_PURCHASE: 0.45,
    AUTO_LOAN: 0.4,
    MICRO_BNPL: 0.95,
  },
  geopoliticalAdjustment: {
    enabled: false,
    requiresLegalSignOff: true,
    legalSignOffReference: null,
    adjustments: {
      MM: -45,
      SAARC: -15,
      OECD: 0,
    },
    groups: {
      SAARC: ['AF', 'BD', 'BT', 'IN', 'MV', 'NP', 'PK', 'LK'],
      OECD: [
        'AU', 'AT', 'BE', 'CA', 'CL', 'CO', 'CR', 'CZ', 'DK', 'EE', 'FI', 'FR',
        'DE', 'GR', 'HU', 'IS', 'IE', 'IL', 'IT', 'JP', 'KR', 'LV', 'LT', 'LU',
        'MX', 'NL', 'NZ', 'NO', 'PL', 'PT', 'SK', 'SI', 'ES', 'SE', 'CH', 'TR',
        'GB', 'US',
      ],
    },
    fairLendingWarning:
      'Nationality-based score adjustment contradicts §10.2 (demographic neutrality) and ' +
      'constitutes national-origin discrimination in lending. DISABLED pending written ' +
      'Legal and Compliance sign-off. Use AML/CFT sanctions screening (§10.3) for ' +
      'defensible country risk instead.',
  },
};

/* -------------------------------------------------------------------------- */
/* Rule evaluation audit                                                        */
/* -------------------------------------------------------------------------- */

export const RULE_OUTCOMES = ['APPLIED', 'NOT_TRIGGERED', 'SKIPPED_DISABLED', 'ERRORED'] as const;
export type RuleOutcome = (typeof RULE_OUTCOMES)[number];

/**
 * One line of the audit trail. `SKIPPED_DISABLED` rows matter as much as `APPLIED` ones:
 * they are the evidence that a rule was considered and deliberately not used.
 */
export interface RuleEvaluation {
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly outcome: RuleOutcome;
  /** Score delta actually applied. Always 0 unless `outcome === 'APPLIED'`. */
  readonly pointsApplied: number;
  readonly detail: string;
}
