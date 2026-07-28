/**
 * Score -> decision (§5.1 bands, §5.2 pricing, §9.3 provisioning, §5.3 overrides).
 *
 * The decision is assembled from four independent inputs, and the rule that binds them is
 * that the engine only ever moves in the conservative direction:
 *
 *     final = strictest(band decision, every override, degradation downgrade)
 *
 * Nothing in this file can make an outcome more generous than the band table allows. That
 * property is what makes the §12.1 board delegation ("composite ≥ 750 auto-approves")
 * safe to grant: the ceiling is structural, not a matter of getting every branch right.
 */
import { Injectable } from '@nestjs/common';
import {
  DECISION_SEVERITY,
  PRODUCT_SPECS,
  bandForScore,
  isAutomatedApproval,
  isBnplFamily,
  strictestDecision,
  type Decision,
  type DecisionResult,
  type DegradedFlag,
  type PricedOffer,
  type ProductType,
  type RiskBandSpec,
  type TriggeredOverride,
} from '@aics/contracts';

import { clamp, roundTo } from '../common/math.util';
import { PolicyService } from '../policy/policy.service';

export interface DecisionInput {
  readonly compositeScore: number;
  readonly productType: ProductType;
  readonly requestedAmountNpr: number;
  readonly tenureMonths: number;
  /** Scorecard-derived PD when the model is unavailable; model PD when promoted. */
  readonly pDefault: number;
  /** Shadow-mode model PD, recorded for §6.4 champion/challenger comparison. */
  readonly mlPDefaultShadow: number | null;
  readonly triggeredOverrides: readonly TriggeredOverride[];
  readonly degradedFlags: readonly DegradedFlag[];
}

@Injectable()
export class DecisionService {
  constructor(private readonly policy: PolicyService) {}

  decide(input: DecisionInput): DecisionResult {
    const policy = this.policy.current;
    const band = bandForScore(input.compositeScore);
    const reasons: string[] = [];

    reasons.push(
      `Composite score ${input.compositeScore.toFixed(0)}/1000 places the applicant in the ` +
        `${band.label} band (${band.minScore}–${band.maxScore}).`,
    );

    // ---- 1. Band decision, then the board-approved auto-approval gate ----
    let decision: Decision = band.decision;

    // §12.1 item 49 delegates auto-approval authority only at or above the threshold. If the
    // band table says AUTO_APPROVE but the score sits below the delegated threshold, the
    // narrower authority wins.
    if (
      decision === 'AUTO_APPROVE' &&
      input.compositeScore < policy.autoApproveMinScore
    ) {
      decision = 'APPROVE_STANDARD';
      reasons.push(
        `Score is below the board-delegated auto-approval threshold of ` +
          `${policy.autoApproveMinScore}; routed to standard approval.`,
      );
    }

    // ---- 2. Overrides (§5.3) — these cannot be outscored ------------------
    for (const override of input.triggeredOverrides) {
      decision = strictestDecision(decision, override.forcedDecision);
      reasons.push(`Override — ${override.label}: ${override.detail}`);
    }

    // ---- 3. Degradation: an unreliable assessment must not auto-approve --
    const degraded = input.degradedFlags.length > 0;
    if (degraded && isAutomatedApproval(decision)) {
      decision = strictestDecision(decision, 'REFER_UNDERWRITER');
      reasons.push(
        'Assessment is incomplete or degraded, so automated approval is withheld and the ' +
          `application is referred for manual review. Flags: ${input.degradedFlags.join(', ')}.`,
      );
    } else if (degraded) {
      reasons.push(`Data quality flags recorded: ${input.degradedFlags.join(', ')}.`);
    }

    // ---- 4. Scorecard/model divergence ------------------------------------
    const divergence = this.computeDivergence(input, band);
    if (divergence !== null && divergence > policy.mlDivergenceThreshold) {
      decision = strictestDecision(decision, 'REFER_UNDERWRITER');
      reasons.push(
        `The scorecard and the ML model disagree by ${(divergence * 100).toFixed(1)} percentage ` +
          `points on probability of default (threshold ${(policy.mlDivergenceThreshold * 100).toFixed(
            0,
          )}). Referred for manual review.`,
      );
    }

    // ---- 5. Price it -----------------------------------------------------
    const offer = this.priceOffer(decision, band, input);
    if (offer === null && decision !== 'DECLINE') {
      reasons.push(
        `No limit is available for ${PRODUCT_SPECS[input.productType].label} in the ${band.label} ` +
          'band; the application cannot proceed on this product.',
      );
    }

    const lgdEstimate = policy.lgdByProduct[input.productType];
    // §SOP-002 step 34: EL = PD × LGD × EAD. Exposure is what we would actually lend, not
    // what was asked for — pricing EL on a requested amount we declined to grant would
    // overstate the provision.
    const exposure = offer?.approvedLimitNpr ?? 0;
    const expectedLossNpr = roundTo(input.pDefault * lgdEstimate * exposure, 2);

    return {
      decision,
      riskBand: band.band,
      compositeScore: roundTo(input.compositeScore, 2),
      pDefault: roundTo(clamp(input.pDefault, 0, 1), 6),
      lgdEstimate,
      expectedLossNpr,
      provisionRate: band.provisionRate,
      baselRiskWeight: band.baselRiskWeight,
      offer,
      triggeredOverrides: input.triggeredOverrides,
      degradedFlags: input.degradedFlags,
      degraded,
      reasons,
    };
  }

  /**
   * Absolute gap between the model's PD and the midpoint of the band's PD range.
   *
   * Comparing against the band midpoint rather than a point estimate keeps this meaningful
   * while the scorecard is authoritative: the scorecard does not produce a PD directly, its
   * band *implies* one, and the §5.1 table is where that mapping lives.
   */
  private computeDivergence(input: DecisionInput, band: RiskBandSpec): number | null {
    if (input.mlPDefaultShadow === null) {
      return null;
    }
    const bandMidpoint = (band.pdMin + band.pdMax) / 2;
    return Math.abs(input.mlPDefaultShadow - bandMidpoint);
  }

  /**
   * Applies §5.1 limits and the §5.2 rate card.
   *
   * The approved limit is the minimum of what was asked for, the product ceiling (§1.2) and
   * the band ceiling (§5.1) — three independent constraints, and the tightest binds.
   */
  private priceOffer(
    decision: Decision,
    band: RiskBandSpec,
    input: DecisionInput,
  ): PricedOffer | null {
    if (decision === 'DECLINE') {
      return null;
    }

    const product = PRODUCT_SPECS[input.productType];
    const bandCeiling = isBnplFamily(input.productType)
      ? band.bnplLimitNpr
      : band.termLoanLimitNpr;

    // `null` means the band does not offer this product family at all — High Risk term
    // loans are "Refer only" and Reject is "Not eligible" (§5.1).
    if (bandCeiling === null) {
      return null;
    }

    const approvedLimitNpr = roundTo(
      Math.min(input.requestedAmountNpr, product.maxLimitNpr, bandCeiling),
      2,
    );
    if (approvedLimitNpr <= 0) {
      return null;
    }

    const monthlyInterestRate = this.rateFor(input.productType, band);

    // Keep the tenure inside the product's published range rather than rejecting the
    // application over it — a 24-month request on a 3–18 month product is a UI problem, and
    // clamping to the boundary is the behaviour a credit officer would apply.
    const tenureMonths = clamp(
      input.tenureMonths,
      product.minTenureMonths,
      product.maxTenureMonths,
    );

    return {
      approvedLimitNpr,
      monthlyInterestRate,
      processingFeePct: band.processingFeePct,
      processingFeeNpr: roundTo(approvedLimitNpr * band.processingFeePct, 2),
      tenureMonths: Math.round(tenureMonths),
      // §5.1 footnote: the High Risk BNPL micro-limit requires a creditworthy guarantor.
      requiresGuarantor:
        product.requiresGuarantorBelowBand &&
        DECISION_SEVERITY[decision] >= DECISION_SEVERITY.REFER_UNDERWRITER,
    };
  }

  /** §5.2 rate card. Auto and personal loans share the personal-loan column. */
  private rateFor(productType: ProductType, band: RiskBandSpec): number {
    switch (productType) {
      case 'BNPL':
      case 'MICRO_BNPL':
        return band.rateBnplMonthly;
      case 'HIRE_PURCHASE':
        return band.rateHirePurchaseMonthly;
      case 'PERSONAL_LOAN':
      case 'AUTO_LOAN':
        return band.ratePersonalLoanMonthly;
      default:
        return band.ratePersonalLoanMonthly;
    }
  }

  /**
   * Maps a composite score to a probability of default.
   *
   * Used while the scorecard is authoritative and no calibrated model PD is available.
   * Interpolates within the band's own PD range from §5.1, so the two artefacts cannot drift
   * apart: change the band table and this follows automatically.
   */
  pDefaultFromScore(compositeScore: number): number {
    const band = bandForScore(compositeScore);
    const span = band.maxScore - band.minScore;
    if (span <= 0) {
      return band.pdMax;
    }
    // Higher score within the band -> lower PD.
    const positionInBand = clamp((compositeScore - band.minScore) / span, 0, 1);
    const pd = band.pdMax - positionInBand * (band.pdMax - band.pdMin);
    return roundTo(clamp(pd, 0, 1), 6);
  }
}
