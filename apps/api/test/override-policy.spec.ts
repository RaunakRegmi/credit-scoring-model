/**
 * §5.3 override evaluation and §10.2 fair-lending policy.
 *
 * The fair-lending block at the bottom is the test that holds the user's decision in place:
 * the nationality adjustment must ship disabled, contribute zero, and still be recorded so
 * Compliance can prove it was considered and not applied.
 */
import { describe, expect, it } from 'vitest';
import { OVERRIDE_CODES } from '@aics/contracts';

import { PolicyService, GEOPOLITICAL_RULE_ID } from '../src/policy/policy.service';
import { OverrideRuleEngine, type OverrideContext } from '../src/scoring/override-rule.engine';

const policy = new PolicyService();
const engine = new OverrideRuleEngine(policy);

/** A clean applicant: nothing should trigger. */
function context(overrides: Partial<OverrideContext> = {}): OverrideContext {
  return {
    amlWatchlistHit: false,
    isPep: false,
    kycFaceMatchScore: 0.97,
    nidVerificationStatus: 'VERIFIED' as const,
    hasActiveBankruptcy: false,
    activeLoanCount: 1,
    documentFraudFlag: false,
    debtServiceRatio: 0.25,
    ...overrides,
  };
}

function codes(result: ReturnType<OverrideRuleEngine['evaluate']>): string[] {
  return result.triggered.map((override) => override.code);
}

/* ========================================================================== */
/* Audit completeness                                                         */
/* ========================================================================== */

describe('override evaluation coverage', () => {
  it('evaluates and records every §5.3 condition on every application', () => {
    const result = engine.evaluate(context());
    // Seven §5.3 conditions plus the §10.3 PEP screening record.
    expect(result.evaluations).toHaveLength(OVERRIDE_CODES.length + 1);

    for (const code of OVERRIDE_CODES) {
      const evaluation = result.evaluations.find((entry) => entry.ruleId.endsWith(code));
      expect(evaluation, `${code} was not evaluated`).toBeDefined();
      expect(evaluation?.detail.length).toBeGreaterThan(10);
    }
  });

  it('records a NOT_TRIGGERED outcome for a clean applicant — silence is not evidence', () => {
    const result = engine.evaluate(context());
    expect(codes(result)).toHaveLength(0);
    expect(
      result.evaluations.every((entry) => entry.outcome === 'NOT_TRIGGERED'),
    ).toBe(true);
  });

  it('never applies score points — overrides change decisions, not scores', () => {
    const result = engine.evaluate(
      context({ amlWatchlistHit: true, activeLoanCount: 5, debtServiceRatio: 0.9 }),
    );
    expect(result.evaluations.every((entry) => entry.pointsApplied === 0)).toBe(true);
  });
});

/* ========================================================================== */
/* Individual conditions                                                      */
/* ========================================================================== */

describe('§5.3 conditions', () => {
  it('triggers on an AML watchlist match and escalates to Compliance', () => {
    const result = engine.evaluate(context({ amlWatchlistHit: true }));
    expect(codes(result)).toContain('AML_WATCHLIST_MATCH');
    const triggered = result.triggered.find((o) => o.code === 'AML_WATCHLIST_MATCH');
    expect(triggered?.forcedDecision).toBe('DECLINE');
    expect(triggered?.escalateToCompliance).toBe(true);
  });

  it('triggers on a face match below the 90% threshold', () => {
    expect(codes(engine.evaluate(context({ kycFaceMatchScore: 0.85 })))).toContain(
      'KYC_FACE_MATCH_FAILURE',
    );
    expect(codes(engine.evaluate(context({ kycFaceMatchScore: 0.9 })))).not.toContain(
      'KYC_FACE_MATCH_FAILURE',
    );
  });

  it('treats a missing selfie as incomplete KYC, not as a failed match', () => {
    // Declining everyone who skipped an optional upload would be wrong, and the §4.4 KYC
    // completeness sub-score already prices the omission.
    const result = engine.evaluate(context({ kycFaceMatchScore: null }));
    expect(codes(result)).not.toContain('KYC_FACE_MATCH_FAILURE');

    const evaluation = result.evaluations.find((entry) =>
      entry.ruleId.endsWith('KYC_FACE_MATCH_FAILURE'),
    );
    expect(evaluation?.detail).toMatch(/not performed/i);
  });

  it('triggers only on an actually FAILED national ID check', () => {
    expect(codes(engine.evaluate(context({ nidVerificationStatus: 'FAILED' })))).toContain(
      'NID_VERIFICATION_FAILURE',
    );
  });

  it('does NOT decline when NID verification has simply not run yet', () => {
    // Otherwise every application is declined the instant it is created, before the KYC
    // pipeline has had any chance to run. Handled upstream as a degradation instead.
    const result = engine.evaluate(context({ nidVerificationStatus: 'NOT_ATTEMPTED' }));
    expect(codes(result)).not.toContain('NID_VERIFICATION_FAILURE');

    const evaluation = result.evaluations.find((entry) =>
      entry.ruleId.endsWith('NID_VERIFICATION_FAILURE'),
    );
    expect(evaluation?.outcome).toBe('NOT_TRIGGERED');
    expect(evaluation?.detail).toMatch(/not been performed yet/i);
  });

  it('triggers on an active bankruptcy', () => {
    expect(codes(engine.evaluate(context({ hasActiveBankruptcy: true })))).toContain(
      'ACTIVE_BANKRUPTCY',
    );
  });

  it('triggers overleveraging at three or more active loans', () => {
    expect(codes(engine.evaluate(context({ activeLoanCount: 2 })))).not.toContain(
      'OVERLEVERAGED_THREE_PLUS_LOANS',
    );
    expect(codes(engine.evaluate(context({ activeLoanCount: 3 })))).toContain(
      'OVERLEVERAGED_THREE_PLUS_LOANS',
    );
    expect(codes(engine.evaluate(context({ activeLoanCount: 7 })))).toContain(
      'OVERLEVERAGED_THREE_PLUS_LOANS',
    );
  });

  it('triggers on a document fraud flag', () => {
    expect(codes(engine.evaluate(context({ documentFraudFlag: true })))).toContain(
      'FRAUDULENT_DOCUMENT_FLAG',
    );
  });

  it('triggers a DSR referral above 60%', () => {
    expect(codes(engine.evaluate(context({ debtServiceRatio: 0.6 })))).not.toContain(
      'DSR_ABOVE_60_PERCENT',
    );
    expect(codes(engine.evaluate(context({ debtServiceRatio: 0.61 })))).toContain(
      'DSR_ABOVE_60_PERCENT',
    );
  });

  it('does NOT claim a DSR breach when the DSR could not be established', () => {
    // Firing here would put "debt service ratio above 60%" into an adverse action notice for
    // an applicant whose ratio was never determined. It is handled as a degraded flag instead.
    const result = engine.evaluate(context({ debtServiceRatio: null }));
    expect(codes(result)).not.toContain('DSR_ABOVE_60_PERCENT');

    const evaluation = result.evaluations.find((entry) => entry.ruleId.endsWith('DSR_ABOVE_60_PERCENT'));
    expect(evaluation?.outcome).toBe('NOT_TRIGGERED');
    expect(evaluation?.detail).toMatch(/could not be established/i);
  });

  it('records PEP status without declining — it requires due diligence, not refusal', () => {
    const result = engine.evaluate(context({ isPep: true }));
    expect(codes(result)).toHaveLength(0);

    const evaluation = result.evaluations.find((entry) => entry.ruleId.includes('PEP_SCREENING'));
    expect(evaluation?.outcome).toBe('APPLIED');
    expect(evaluation?.detail).toMatch(/enhanced due diligence/i);
  });

  it('reports several simultaneous conditions', () => {
    const result = engine.evaluate(
      context({
        amlWatchlistHit: true,
        activeLoanCount: 4,
        debtServiceRatio: 0.8,
        nidVerificationStatus: 'FAILED',
      }),
    );
    expect(codes(result)).toEqual(
      expect.arrayContaining([
        'AML_WATCHLIST_MATCH',
        'NID_VERIFICATION_FAILURE',
        'OVERLEVERAGED_THREE_PLUS_LOANS',
        'DSR_ABOVE_60_PERCENT',
      ]),
    );
  });
});

/* ========================================================================== */
/* §10.2 fair lending                                                         */
/* ========================================================================== */

describe('§10.2 fair lending — geopolitical nationality adjustment', () => {
  it('ships DISABLED', () => {
    expect(policy.current.geopoliticalAdjustment.enabled).toBe(false);
    expect(policy.current.geopoliticalAdjustment.legalSignOffReference).toBeNull();
  });

  it('applies zero points for every nationality while disabled', () => {
    // Including the countries SOP-002 step 25 singles out for a penalty.
    for (const nationality of ['MM', 'NP', 'IN', 'PK', 'US', 'GB', 'XX', '']) {
      const evaluation = policy.evaluateGeopoliticalAdjustment(nationality);
      expect(evaluation.pointsApplied, nationality).toBe(0);
      expect(evaluation.outcome, nationality).toBe('SKIPPED_DISABLED');
    }
  });

  it('still records the evaluation, so Compliance can prove it was not applied', () => {
    const evaluation = policy.evaluateGeopoliticalAdjustment('MM');
    expect(evaluation.ruleId).toBe(GEOPOLITICAL_RULE_ID);
    expect(evaluation.ruleVersion).toBe(policy.current.version);
    expect(evaluation.detail).toMatch(/disabled by policy/i);
  });

  it('carries the fair-lending warning in the recorded detail', () => {
    const evaluation = policy.evaluateGeopoliticalAdjustment('MM');
    expect(evaluation.detail).toMatch(/§10\.2/);
    expect(evaluation.detail).toMatch(/discrimination/i);
  });

  it('is never null — a rule considered and skipped is itself an auditable fact', () => {
    expect(policy.evaluateGeopoliticalAdjustment('NP')).not.toBeNull();
  });
});

describe('policy thresholds', () => {
  it('matches the board-approved values', () => {
    expect(policy.current.autoApproveMinScore).toBe(750);
    expect(policy.current.extractionMinConfidence).toBe(0.85);
    expect(policy.current.minStatementMonths).toBe(6);
    expect(policy.current.dsrOverrideThreshold).toBe(0.6);
    expect(policy.current.kycFaceMatchMinConfidence).toBe(0.9);
    expect(policy.current.activeLoanOverleverageCount).toBe(3);
  });

  it('prices asset-backed products with a lower LGD', () => {
    const lgd = policy.current.lgdByProduct;
    expect(lgd.HIRE_PURCHASE).toBeLessThan(lgd.PERSONAL_LOAN);
    expect(lgd.AUTO_LOAN).toBeLessThan(lgd.BNPL);
    for (const value of Object.values(lgd)) {
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});
