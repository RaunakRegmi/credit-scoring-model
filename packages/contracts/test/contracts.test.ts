import { describe, expect, it } from 'vitest';

import {
  COMPOSITE_MAX_SCORE,
  PILLAR_MAX_POINTS,
  PILLAR_SPECS,
  RISK_BAND_TABLE,
  bandForScore,
  isAutomatedApproval,
  strictestDecision,
} from '../src/enums';
import {
  FEATURE_MANIFEST,
  FEATURE_NAMES,
  defaultFeatureVector,
  featureVectorSchema,
  monotoneConstraints,
  toOrderedArray,
} from '../src/features';
import { DEFAULT_SCORING_POLICY, scoringPolicySchema } from '../src/policy';

describe('feature manifest', () => {
  it('has unique, canonically ordered names', () => {
    expect(new Set(FEATURE_NAMES).size).toBe(FEATURE_NAMES.length);
    expect(FEATURE_MANIFEST.map((d) => d.name)).toEqual([...FEATURE_NAMES]);
  });

  it('excludes protected characteristics (§10.2)', () => {
    const prohibited = /gender|sex|\bage\b|dob|birth|nationality|ethnic|caste|religion|race|marital/i;
    for (const definition of FEATURE_MANIFEST) {
      expect(definition.name, `${definition.name} looks demographic`).not.toMatch(prohibited);
    }
  });

  it('gives every feature adverse-action wording for decline notices (§6.3)', () => {
    for (const definition of FEATURE_MANIFEST) {
      expect(definition.adverseAction.length).toBeGreaterThan(10);
      // The applicant must never see a raw column name.
      expect(definition.adverseAction).not.toContain('_');
    }
  });

  it('emits monotone constraints aligned to the column order', () => {
    const constraints = monotoneConstraints();
    expect(constraints).toHaveLength(FEATURE_NAMES.length);
    constraints.forEach((direction, index) => {
      expect(direction).toBe(FEATURE_MANIFEST[index]?.monotone);
    });
  });

  it('produces a dense, ordered vector from the defaults', () => {
    const vector = defaultFeatureVector();
    expect(Object.keys(vector).sort()).toEqual([...FEATURE_NAMES].sort());
    expect(toOrderedArray(vector)).toHaveLength(FEATURE_NAMES.length);
  });
});

describe('featureVectorSchema', () => {
  it('clamps out-of-range values rather than rejecting real data', () => {
    const parsed = featureVectorSchema.parse({ ...defaultFeatureVector(), dsr: 999 });
    expect(parsed.dsr).toBe(5); // manifest max
  });

  it('rounds integer-typed features', () => {
    const parsed = featureVectorSchema.parse({
      ...defaultFeatureVector(),
      salary_consistency_months: 4.7,
    });
    expect(parsed.salary_consistency_months).toBe(5);
  });

  it('rejects non-finite values — those mean an upstream computation bug', () => {
    expect(() =>
      featureVectorSchema.parse({ ...defaultFeatureVector(), dsr: Number.POSITIVE_INFINITY }),
    ).toThrow();
    expect(() =>
      featureVectorSchema.parse({ ...defaultFeatureVector(), savings_rate: Number.NaN }),
    ).toThrow();
  });

  it('rejects unknown keys — a sign the caller is on another manifest version', () => {
    expect(() =>
      featureVectorSchema.parse({ ...defaultFeatureVector(), invented_feature: 1 }),
    ).toThrow();
  });

  it('rejects an incomplete vector', () => {
    const { dsr, ...incomplete } = defaultFeatureVector();
    void dsr;
    expect(() => featureVectorSchema.parse(incomplete)).toThrow();
  });
});

describe('risk bands (§5.1)', () => {
  it('pillar maxima sum to the composite scale (§4.1)', () => {
    const total = PILLAR_SPECS.reduce((sum, spec) => sum + spec.maxPoints, 0);
    expect(total).toBe(COMPOSITE_MAX_SCORE);
    expect(Object.values(PILLAR_MAX_POINTS).reduce((a, b) => a + b, 0)).toBe(COMPOSITE_MAX_SCORE);
  });

  it('covers 0–1000 with no gaps or overlaps', () => {
    const ascending = [...RISK_BAND_TABLE].sort((a, b) => a.minScore - b.minScore);
    expect(ascending[0]?.minScore).toBe(0);
    expect(ascending.at(-1)?.maxScore).toBe(1000);
    for (let i = 1; i < ascending.length; i += 1) {
      expect(ascending[i]?.minScore).toBe((ascending[i - 1]?.maxScore ?? -1) + 1);
    }
  });

  it('maps boundary scores to the documented bands', () => {
    expect(bandForScore(1000).band).toBe('ELITE_PRIME');
    expect(bandForScore(900).band).toBe('ELITE_PRIME');
    expect(bandForScore(899).band).toBe('PRIME');
    expect(bandForScore(750).band).toBe('PRIME');
    expect(bandForScore(749).band).toBe('NEAR_PRIME');
    expect(bandForScore(600).band).toBe('NEAR_PRIME');
    expect(bandForScore(599).band).toBe('SUBPRIME');
    expect(bandForScore(450).band).toBe('SUBPRIME');
    expect(bandForScore(449).band).toBe('HIGH_RISK');
    expect(bandForScore(300).band).toBe('HIGH_RISK');
    expect(bandForScore(299).band).toBe('REJECT');
    expect(bandForScore(0).band).toBe('REJECT');
  });

  it('clamps scores outside the scale', () => {
    expect(bandForScore(-500).band).toBe('REJECT');
    expect(bandForScore(99999).band).toBe('ELITE_PRIME');
  });

  it('keeps PD ranges monotonically worsening as the band drops', () => {
    const ascending = [...RISK_BAND_TABLE].sort((a, b) => b.minScore - a.minScore);
    for (let i = 1; i < ascending.length; i += 1) {
      expect(ascending[i]?.pdMax).toBeGreaterThan(ascending[i - 1]?.pdMax ?? 0);
    }
  });
});

describe('decision severity', () => {
  it('always returns the most conservative decision', () => {
    expect(strictestDecision('AUTO_APPROVE', 'DECLINE')).toBe('DECLINE');
    expect(strictestDecision('DECLINE', 'AUTO_APPROVE')).toBe('DECLINE');
    expect(strictestDecision('AUTO_APPROVE', 'REFER_UNDERWRITER', 'APPROVE_STANDARD')).toBe(
      'REFER_UNDERWRITER',
    );
    expect(strictestDecision('AUTO_APPROVE')).toBe('AUTO_APPROVE');
    expect(strictestDecision()).toBe('AUTO_APPROVE');
  });

  it('classifies only the hands-off decisions as automated approval', () => {
    expect(isAutomatedApproval('AUTO_APPROVE')).toBe(true);
    expect(isAutomatedApproval('APPROVE_STANDARD')).toBe(true);
    expect(isAutomatedApproval('APPROVE_WITH_CONDITIONS')).toBe(false);
    expect(isAutomatedApproval('REFER_UNDERWRITER')).toBe(false);
    expect(isAutomatedApproval('DECLINE')).toBe(false);
  });
});

describe('scoring policy', () => {
  it('validates the shipped defaults', () => {
    expect(() => scoringPolicySchema.parse(DEFAULT_SCORING_POLICY)).not.toThrow();
  });

  it('ships the nationality adjustment DISABLED (§10.2 fair lending)', () => {
    expect(DEFAULT_SCORING_POLICY.geopoliticalAdjustment.enabled).toBe(false);
    expect(DEFAULT_SCORING_POLICY.geopoliticalAdjustment.legalSignOffReference).toBeNull();
    expect(DEFAULT_SCORING_POLICY.geopoliticalAdjustment.fairLendingWarning).toMatch(/DISABLED/);
  });

  it('sets the board-approved auto-approval threshold at 750 (§12.1)', () => {
    expect(DEFAULT_SCORING_POLICY.autoApproveMinScore).toBe(750);
  });

  it('prices secured products with lower LGD than unsecured', () => {
    const { lgdByProduct } = DEFAULT_SCORING_POLICY;
    expect(lgdByProduct.HIRE_PURCHASE).toBeLessThan(lgdByProduct.PERSONAL_LOAN);
    expect(lgdByProduct.AUTO_LOAN).toBeLessThan(lgdByProduct.BNPL);
  });
});
