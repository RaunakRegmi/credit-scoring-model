/**
 * §5.1 bands, §5.2 pricing, §5.3 overrides and the degradation rule.
 *
 * The central property under test is that the engine only ever moves a decision in the
 * conservative direction. That is what makes the §12.1 board delegation of auto-approval
 * authority safe to grant, so it is tested from several angles rather than once.
 */
import { describe, expect, it } from 'vitest';
import { OVERRIDE_SPECS, type DegradedFlag, type TriggeredOverride } from '@aics/contracts';

import { DecisionService, type DecisionInput } from '../src/scoring/decision.service';
import { PolicyService } from '../src/policy/policy.service';

const policy = new PolicyService();
const decisions = new DecisionService(policy);

function input(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    compositeScore: 800,
    productType: 'PERSONAL_LOAN',
    requestedAmountNpr: 1_000_000,
    tenureMonths: 36,
    pDefault: 0.02,
    mlPDefaultShadow: null,
    triggeredOverrides: [],
    degradedFlags: [],
    ...overrides,
  };
}

function override(code: keyof typeof OVERRIDE_SPECS): TriggeredOverride {
  const spec = OVERRIDE_SPECS[code];
  return {
    code: spec.code,
    label: spec.label,
    forcedDecision: spec.forcedDecision,
    detail: `test trigger for ${code}`,
    escalateToCompliance: spec.escalateToCompliance,
  };
}

/* ========================================================================== */
/* §5.1 bands                                                                 */
/* ========================================================================== */

describe('§5.1 band mapping and decisions', () => {
  it('maps each band boundary to the documented decision', () => {
    const cases: readonly [number, string, string][] = [
      [950, 'ELITE_PRIME', 'AUTO_APPROVE'],
      [900, 'ELITE_PRIME', 'AUTO_APPROVE'],
      [899, 'PRIME', 'AUTO_APPROVE'],
      [750, 'PRIME', 'AUTO_APPROVE'],
      [749, 'NEAR_PRIME', 'APPROVE_STANDARD'],
      [600, 'NEAR_PRIME', 'APPROVE_STANDARD'],
      [599, 'SUBPRIME', 'APPROVE_WITH_CONDITIONS'],
      [450, 'SUBPRIME', 'APPROVE_WITH_CONDITIONS'],
      [449, 'HIGH_RISK', 'REFER_UNDERWRITER'],
      [300, 'HIGH_RISK', 'REFER_UNDERWRITER'],
      [299, 'REJECT', 'DECLINE'],
      [0, 'REJECT', 'DECLINE'],
    ];

    for (const [score, band, decision] of cases) {
      const result = decisions.decide(input({ compositeScore: score }));
      expect(result.riskBand, `score ${score}`).toBe(band);
      expect(result.decision, `score ${score}`).toBe(decision);
    }
  });

  it('honours the §12.1 board-delegated auto-approval threshold of 750', () => {
    expect(decisions.decide(input({ compositeScore: 750 })).decision).toBe('AUTO_APPROVE');
    // 749 falls into Near Prime, which is approve-standard, not auto-approve.
    expect(decisions.decide(input({ compositeScore: 749 })).decision).toBe('APPROVE_STANDARD');
  });

  it('carries the §9.3 provisioning rate and Basel risk weight for the band', () => {
    const prime = decisions.decide(input({ compositeScore: 800 }));
    expect(prime.provisionRate).toBe(0.015);
    expect(prime.baselRiskWeight).toBe(0.75);

    const subprime = decisions.decide(input({ compositeScore: 500 }));
    expect(subprime.provisionRate).toBe(0.1);
    expect(subprime.baselRiskWeight).toBe(1.5);
  });
});

/* ========================================================================== */
/* §5.2 pricing and §5.1 limits                                               */
/* ========================================================================== */

describe('§5.1 limits and §5.2 rate card', () => {
  it('applies the tightest of requested, product ceiling and band ceiling', () => {
    // Prime term-loan ceiling is NPR 2,500,000; the Personal Loan product ceiling is also
    // 2,500,000; the request is smaller, so the request binds.
    expect(
      decisions.decide(input({ compositeScore: 800, requestedAmountNpr: 900_000 })).offer
        ?.approvedLimitNpr,
    ).toBe(900_000);

    // Request above both ceilings: the ceiling binds.
    expect(
      decisions.decide(input({ compositeScore: 800, requestedAmountNpr: 40_000_000 })).offer
        ?.approvedLimitNpr,
    ).toBe(2_500_000);

    // Subprime band caps a term loan at NPR 300,000 regardless of the product ceiling.
    expect(
      decisions.decide(input({ compositeScore: 500, requestedAmountNpr: 40_000_000 })).offer
        ?.approvedLimitNpr,
    ).toBe(300_000);
  });

  it('prices BNPL from the BNPL column and hire purchase from its own', () => {
    const bnpl = decisions.decide(
      input({ productType: 'BNPL', compositeScore: 800, requestedAmountNpr: 400_000, tenureMonths: 12 }),
    );
    expect(bnpl.offer?.monthlyInterestRate).toBe(0.012);

    const hp = decisions.decide(
      input({ productType: 'HIRE_PURCHASE', compositeScore: 800, requestedAmountNpr: 2_000_000 }),
    );
    expect(hp.offer?.monthlyInterestRate).toBe(0.01);

    const pl = decisions.decide(input({ productType: 'PERSONAL_LOAN', compositeScore: 800 }));
    expect(pl.offer?.monthlyInterestRate).toBe(0.013);
  });

  it('computes the processing fee from the band percentage', () => {
    const offer = decisions.decide(
      input({ compositeScore: 800, requestedAmountNpr: 1_000_000 }),
    ).offer;
    expect(offer?.processingFeePct).toBe(0.0075);
    expect(offer?.processingFeeNpr).toBe(7_500);
  });

  it('offers nothing for a declined application', () => {
    const result = decisions.decide(input({ compositeScore: 150 }));
    expect(result.decision).toBe('DECLINE');
    expect(result.offer).toBeNull();
  });

  it('offers no term loan in the High Risk band — §5.1 marks it refer-only', () => {
    const result = decisions.decide(
      input({ compositeScore: 380, productType: 'PERSONAL_LOAN' }),
    );
    expect(result.decision).toBe('REFER_UNDERWRITER');
    expect(result.offer).toBeNull();
  });

  it('offers the High Risk BNPL micro-limit with a guarantor requirement', () => {
    const result = decisions.decide(
      input({ compositeScore: 380, productType: 'BNPL', requestedAmountNpr: 200_000, tenureMonths: 6 }),
    );
    expect(result.offer?.approvedLimitNpr).toBe(25_000);
    expect(result.offer?.requiresGuarantor).toBe(true);
  });

  it('clamps a tenure outside the product range to its boundary', () => {
    // BNPL runs 3–18 months; a 36-month request is clamped rather than rejected.
    const result = decisions.decide(
      input({ productType: 'BNPL', compositeScore: 800, requestedAmountNpr: 300_000, tenureMonths: 36 }),
    );
    expect(result.offer?.tenureMonths).toBe(18);
  });
});

/* ========================================================================== */
/* §SOP-002 step 34 — expected loss                                           */
/* ========================================================================== */

describe('expected loss', () => {
  it('computes EL = PD x LGD x approved exposure, not the requested amount', () => {
    const result = decisions.decide(
      input({ compositeScore: 800, requestedAmountNpr: 40_000_000, pDefault: 0.02 }),
    );
    // Approved limit is capped at 2,500,000; LGD for a personal loan is 0.85.
    expect(result.offer?.approvedLimitNpr).toBe(2_500_000);
    expect(result.expectedLossNpr).toBeCloseTo(0.02 * 0.85 * 2_500_000, 2);
  });

  it('is zero when nothing was approved', () => {
    expect(decisions.decide(input({ compositeScore: 100 })).expectedLossNpr).toBe(0);
  });

  it('uses a lower LGD for asset-backed products', () => {
    const hp = decisions.decide(
      input({ productType: 'HIRE_PURCHASE', compositeScore: 800, requestedAmountNpr: 1_000_000 }),
    );
    const pl = decisions.decide(
      input({ productType: 'PERSONAL_LOAN', compositeScore: 800, requestedAmountNpr: 1_000_000 }),
    );
    expect(hp.lgdEstimate).toBeLessThan(pl.lgdEstimate);
  });
});

/* ========================================================================== */
/* §5.3 overrides                                                             */
/* ========================================================================== */

describe('§5.3 mandatory overrides', () => {
  it('declines an Elite Prime applicant on an AML watchlist match', () => {
    const result = decisions.decide(
      input({ compositeScore: 990, triggeredOverrides: [override('AML_WATCHLIST_MATCH')] }),
    );
    expect(result.decision).toBe('DECLINE');
    expect(result.offer).toBeNull();
    expect(result.reasons.join(' ')).toMatch(/AML\/CFT watchlist/);
  });

  it('cannot be outscored — a perfect score does not overcome a hard override', () => {
    for (const code of ['NID_VERIFICATION_FAILURE', 'ACTIVE_BANKRUPTCY', 'FRAUDULENT_DOCUMENT_FLAG'] as const) {
      const result = decisions.decide(
        input({ compositeScore: 1000, triggeredOverrides: [override(code)] }),
      );
      expect(result.decision, code).toBe('DECLINE');
    }
  });

  it('refers rather than declines for the hold-type conditions', () => {
    for (const code of [
      'KYC_FACE_MATCH_FAILURE',
      'OVERLEVERAGED_THREE_PLUS_LOANS',
      'DSR_ABOVE_60_PERCENT',
    ] as const) {
      const result = decisions.decide(
        input({ compositeScore: 950, triggeredOverrides: [override(code)] }),
      );
      expect(result.decision, code).toBe('REFER_UNDERWRITER');
    }
  });

  it('applies the strictest of several simultaneous overrides', () => {
    const result = decisions.decide(
      input({
        compositeScore: 900,
        triggeredOverrides: [override('DSR_ABOVE_60_PERCENT'), override('AML_WATCHLIST_MATCH')],
      }),
    );
    expect(result.decision).toBe('DECLINE');
  });

  it('never makes a decision more generous than the band allows', () => {
    // A "refer" override on an already-declined application stays declined.
    const result = decisions.decide(
      input({ compositeScore: 100, triggeredOverrides: [override('KYC_FACE_MATCH_FAILURE')] }),
    );
    expect(result.decision).toBe('DECLINE');
  });
});

/* ========================================================================== */
/* Degradation                                                                */
/* ========================================================================== */

describe('degraded assessments', () => {
  const flags: readonly DegradedFlag[][] = [
    ['ML_SERVICE_UNAVAILABLE'],
    ['ML_SERVICE_TIMEOUT'],
    ['INSUFFICIENT_STATEMENT_HISTORY'],
    ['INSUFFICIENT_INCOME_DATA'],
    ['LOW_EXTRACTION_CONFIDENCE'],
    ['STATEMENT_EXTRACTION_EMPTY'],
  ];

  it('withholds automated approval for every degradation cause', () => {
    for (const degradedFlags of flags) {
      const result = decisions.decide(input({ compositeScore: 950, degradedFlags }));
      expect(result.decision, degradedFlags.join(',')).toBe('REFER_UNDERWRITER');
      expect(result.degraded).toBe(true);
    }
  });

  it('downgrades an approve-standard decision as well', () => {
    const result = decisions.decide(
      input({ compositeScore: 700, degradedFlags: ['ML_SERVICE_TIMEOUT'] }),
    );
    expect(result.decision).toBe('REFER_UNDERWRITER');
  });

  it('does not upgrade a decline just because it was degraded', () => {
    const result = decisions.decide(
      input({ compositeScore: 100, degradedFlags: ['ML_SERVICE_UNAVAILABLE'] }),
    );
    expect(result.decision).toBe('DECLINE');
  });

  it('leaves a clean assessment untouched', () => {
    const result = decisions.decide(input({ compositeScore: 950, degradedFlags: [] }));
    expect(result.decision).toBe('AUTO_APPROVE');
    expect(result.degraded).toBe(false);
  });

  it('explains the degradation in the reasons', () => {
    const result = decisions.decide(
      input({ compositeScore: 950, degradedFlags: ['ML_SERVICE_UNAVAILABLE'] }),
    );
    expect(result.reasons.join(' ')).toMatch(/degraded/i);
    expect(result.reasons.join(' ')).toMatch(/ML_SERVICE_UNAVAILABLE/);
  });
});

/* ========================================================================== */
/* Model divergence                                                           */
/* ========================================================================== */

describe('scorecard/model divergence', () => {
  it('refers when the two disagree beyond the policy threshold', () => {
    // Prime band midpoint PD is about 2.25%; a model PD of 60% is a violent disagreement.
    const result = decisions.decide(
      input({ compositeScore: 800, mlPDefaultShadow: 0.6 }),
    );
    expect(result.decision).toBe('REFER_UNDERWRITER');
    expect(result.reasons.join(' ')).toMatch(/disagree/i);
  });

  it('does not refer when the two broadly agree', () => {
    const result = decisions.decide(input({ compositeScore: 800, mlPDefaultShadow: 0.03 }));
    expect(result.decision).toBe('AUTO_APPROVE');
  });

  it('ignores divergence when no model PD is available', () => {
    const result = decisions.decide(input({ compositeScore: 800, mlPDefaultShadow: null }));
    expect(result.decision).toBe('AUTO_APPROVE');
  });
});

/* ========================================================================== */
/* Score -> PD                                                                */
/* ========================================================================== */

describe('pDefaultFromScore', () => {
  it('stays inside the band PD range from §5.1', () => {
    // Prime spans 1.0%-3.5%.
    expect(decisions.pDefaultFromScore(750)).toBeLessThanOrEqual(0.035);
    expect(decisions.pDefaultFromScore(899)).toBeGreaterThanOrEqual(0.01);
    // Elite Prime is under 1%.
    expect(decisions.pDefaultFromScore(1000)).toBeLessThanOrEqual(0.01);
  });

  it('decreases monotonically as the score rises', () => {
    let previous = 1;
    for (let score = 0; score <= 1000; score += 25) {
      const pd = decisions.pDefaultFromScore(score);
      expect(pd).toBeLessThanOrEqual(previous + 1e-9);
      previous = pd;
    }
  });

  it('always returns a probability', () => {
    for (const score of [-500, 0, 500, 1000, 99_999]) {
      const pd = decisions.pDefaultFromScore(score);
      expect(pd).toBeGreaterThanOrEqual(0);
      expect(pd).toBeLessThanOrEqual(1);
      expect(Number.isFinite(pd)).toBe(true);
    }
  });
});
