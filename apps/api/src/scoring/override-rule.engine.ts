/**
 * §5.3 mandatory override conditions.
 *
 * "Regardless of composite score, the following conditions trigger a mandatory Decline or
 * Hold." That word — regardless — is the entire contract of this file. An override is not a
 * deduction and cannot be outscored: an Elite Prime applicant with a sanctions match is
 * declined, full stop.
 *
 * Every condition is evaluated on every application, and every evaluation is recorded,
 * including the ones that did not fire. "We checked for a bankruptcy and found none" is an
 * auditable fact; silence is not.
 */
import { Injectable } from '@nestjs/common';
import {
  OVERRIDE_SPECS,
  type KycVerificationStatus,
  type OverrideCode,
  type RuleEvaluation,
  type TriggeredOverride,
} from '@aics/contracts';

import { PolicyService } from '../policy/policy.service';

/** Facts sourced from outside the uploaded documents (KYC, AML, bureau). */
export interface OverrideContext {
  readonly amlWatchlistHit: boolean;
  readonly isPep: boolean;
  /** §3.3.2 face match, 0–1. `null` when no selfie was submitted. */
  readonly kycFaceMatchScore: number | null;
  readonly nidVerificationStatus: KycVerificationStatus;
  readonly hasActiveBankruptcy: boolean;
  readonly activeLoanCount: number;
  readonly documentFraudFlag: boolean;
  /** Verified debt service ratio. `null` when income could not be verified. */
  readonly debtServiceRatio: number | null;
}

export interface OverrideResult {
  readonly triggered: readonly TriggeredOverride[];
  /** One row per condition, fired or not, for `PolicyRuleEvaluation`. */
  readonly evaluations: readonly RuleEvaluation[];
}

@Injectable()
export class OverrideRuleEngine {
  constructor(private readonly policy: PolicyService) {}

  evaluate(context: OverrideContext): OverrideResult {
    const triggered: TriggeredOverride[] = [];
    const evaluations: RuleEvaluation[] = [];
    const policy = this.policy.current;

    const consider = (code: OverrideCode, hit: boolean, detail: string): void => {
      evaluations.push({
        ruleId: `SEC-5.3:${code}`,
        ruleVersion: policy.version,
        outcome: hit ? 'APPLIED' : 'NOT_TRIGGERED',
        pointsApplied: 0,
        detail,
      });
      if (hit) {
        const spec = OVERRIDE_SPECS[code];
        triggered.push({
          code,
          label: spec.label,
          forcedDecision: spec.forcedDecision,
          detail,
          escalateToCompliance: spec.escalateToCompliance,
        });
      }
    };

    // 1. AML/CFT watchlist — immediate decline, escalate to Compliance.
    consider(
      'AML_WATCHLIST_MATCH',
      context.amlWatchlistHit,
      context.amlWatchlistHit
        ? 'Applicant matched an AML/CFT sanctions or watchlist entry. Escalated to the Compliance Officer.'
        : 'AML/CFT screening returned no watchlist match.',
    );

    // 2. KYC face match below the configured confidence — document hold.
    //
    // A missing selfie is not a failed match. It is missing evidence, which the KYC
    // completeness sub-score already penalises; treating it as a failure would double-count
    // and would decline every applicant who skipped an optional upload.
    const faceMatchFailed =
      context.kycFaceMatchScore !== null &&
      context.kycFaceMatchScore < policy.kycFaceMatchMinConfidence;
    consider(
      'KYC_FACE_MATCH_FAILURE',
      faceMatchFailed,
      context.kycFaceMatchScore === null
        ? 'No selfie submitted; face match not performed (scored as incomplete KYC, not as a failure).'
        : `Face match confidence ${(context.kycFaceMatchScore * 100).toFixed(1)}% against the ` +
          `${(policy.kycFaceMatchMinConfidence * 100).toFixed(0)}% threshold.`,
    );

    // 3. NID verification failure — decline pending resubmission.
    //
    // Only an actual FAILED check declines. NOT_ATTEMPTED means the KYC pipeline has not run
    // yet, which is missing evidence rather than an adverse finding — treating it as a failure
    // would decline every application the moment it is created, before verification has had a
    // chance to happen. The unverified case is handled upstream as a degraded flag, which
    // blocks auto-approval and routes to manual review.
    consider(
      'NID_VERIFICATION_FAILURE',
      context.nidVerificationStatus === 'FAILED',
      context.nidVerificationStatus === 'VERIFIED'
        ? 'National ID verified against the Nepal national ID schema.'
        : context.nidVerificationStatus === 'FAILED'
          ? 'National ID verification failed. Decline pending document resubmission.'
          : 'National ID verification has not been performed yet; held for review rather than ' +
            'declined (recorded as an incomplete-KYC degradation, not as a failed check).',
    );

    // 4. Active bankruptcy or court attachment.
    consider(
      'ACTIVE_BANKRUPTCY',
      context.hasActiveBankruptcy,
      context.hasActiveBankruptcy
        ? 'An active bankruptcy or court attachment was found in public records.'
        : 'No active bankruptcy or court attachment found.',
    );

    // 5. Overleveraging — three or more active loans across institutions.
    const overleveraged = context.activeLoanCount >= policy.activeLoanOverleverageCount;
    consider(
      'OVERLEVERAGED_THREE_PLUS_LOANS',
      overleveraged,
      `${context.activeLoanCount} active loan(s) detected across institutions ` +
        `(threshold ${policy.activeLoanOverleverageCount}).`,
    );

    // 6. Document authenticity failure.
    consider(
      'FRAUDULENT_DOCUMENT_FLAG',
      context.documentFraudFlag,
      context.documentFraudFlag
        ? 'The document authenticity engine flagged a submitted document as potentially fraudulent.'
        : 'All submitted documents passed the authenticity check.',
    );

    // 7. DSR above the policy ceiling — mandatory underwriter referral.
    //
    // An unverifiable DSR is deliberately NOT treated as a breach here. It is handled as a
    // degraded flag upstream, which already blocks auto-approval. Firing this override on
    // `null` would report "DSR above 60%" about an applicant whose DSR we never established,
    // and that sentence would end up in an adverse action notice.
    const dsrBreach =
      context.debtServiceRatio !== null && context.debtServiceRatio > policy.dsrOverrideThreshold;
    consider(
      'DSR_ABOVE_60_PERCENT',
      dsrBreach,
      context.debtServiceRatio === null
        ? 'Debt service ratio could not be established from the statement; handled as incomplete ' +
          'financial data rather than as a threshold breach.'
        : `Debt service ratio ${(context.debtServiceRatio * 100).toFixed(1)}% against the ` +
          `${(policy.dsrOverrideThreshold * 100).toFixed(0)}% referral threshold.`,
    );

    // §10.3 PEP status is not an override — it triggers enhanced due diligence, not a
    // decline. Recorded so the workflow can pick it up.
    evaluations.push({
      ruleId: 'SEC-10.3:PEP_SCREENING',
      ruleVersion: policy.version,
      outcome: context.isPep ? 'APPLIED' : 'NOT_TRIGGERED',
      pointsApplied: 0,
      detail: context.isPep
        ? 'Applicant is a Politically Exposed Person. Enhanced due diligence workflow required.'
        : 'Applicant is not on the PEP register.',
    });

    return { triggered, evaluations };
  }
}
