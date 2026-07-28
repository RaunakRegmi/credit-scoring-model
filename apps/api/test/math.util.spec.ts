import { describe, expect, it } from 'vitest';

import {
  clamp,
  coefficientOfVariation,
  compoundGrowthRate,
  distinctMonths,
  inverseLinearScore,
  linearScore,
  mean,
  monthsBetween,
  olsSlope,
  roundTo,
  safeRatio,
  stdDev,
  sum,
  yearsBetween,
} from '../src/common/math.util';

/**
 * `safeRatio` is the guard the whole §4 edge-case requirement rests on. A DSR of `Infinity`
 * reaching the model is scored as the worst possible applicant by accident, so these are the
 * highest-value assertions in the API suite.
 */
describe('safeRatio', () => {
  it('divides normally', () => {
    expect(safeRatio(50, 200)).toBe(0.25);
    expect(safeRatio(-30, 60)).toBe(-0.5);
  });

  it('returns null on a zero denominator instead of Infinity', () => {
    expect(safeRatio(45_000, 0)).toBeNull();
    expect(safeRatio(-45_000, 0)).toBeNull();
    expect(safeRatio(0, 0)).toBeNull();
  });

  it('returns null for non-finite inputs rather than propagating them', () => {
    expect(safeRatio(Number.POSITIVE_INFINITY, 10)).toBeNull();
    expect(safeRatio(10, Number.NEGATIVE_INFINITY)).toBeNull();
    expect(safeRatio(Number.NaN, 10)).toBeNull();
    expect(safeRatio(10, Number.NaN)).toBeNull();
  });

  it('never returns a non-finite number for any input pair', () => {
    const awkward = [0, -0, 1, -1, 1e308, -1e308, Number.MIN_VALUE, Number.MAX_VALUE];
    for (const numerator of awkward) {
      for (const denominator of awkward) {
        const result = safeRatio(numerator, denominator);
        if (result !== null) {
          expect(Number.isFinite(result)).toBe(true);
        }
      }
    }
  });
});

describe('clamp', () => {
  it('bounds values', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(50, 0, 10)).toBe(10);
  });

  it('collapses ANY non-finite input to the minimum, including Infinity', () => {
    // Fail-safe, and deliberately not "Infinity clamps to max". A non-finite value here always
    // means an upstream computation bug; resolving it to the maximum would silently award an
    // applicant full marks on the strength of a defect.
    expect(clamp(Number.NaN, 3, 10)).toBe(3);
    expect(clamp(Number.POSITIVE_INFINITY, 3, 10)).toBe(3);
    expect(clamp(Number.NEGATIVE_INFINITY, 3, 10)).toBe(3);
  });
});

describe('linearScore', () => {
  it('interpolates between floor and ceiling', () => {
    expect(linearScore(0, 0, 200_000, 80)).toBe(0);
    expect(linearScore(100_000, 0, 200_000, 80)).toBe(40);
    expect(linearScore(200_000, 0, 200_000, 80)).toBe(80);
  });

  it('caps at the ceiling rather than continuing to accrue', () => {
    expect(linearScore(10_000_000, 0, 200_000, 80)).toBe(80);
  });

  it('floors at zero for values below the floor', () => {
    expect(linearScore(-50_000, 0, 200_000, 80)).toBe(0);
  });

  it('returns zero for a degenerate range instead of dividing by zero', () => {
    expect(linearScore(5, 10, 10, 80)).toBe(0);
    expect(linearScore(5, 20, 10, 80)).toBe(0);
  });
});

describe('inverseLinearScore', () => {
  it('awards full points at or below the best value', () => {
    expect(inverseLinearScore(0.2, 0.4, 1.0, 40)).toBe(40);
    expect(inverseLinearScore(0.4, 0.4, 1.0, 40)).toBe(40);
  });

  it('awards nothing at or above the worst value', () => {
    expect(inverseLinearScore(1.0, 0.4, 1.0, 40)).toBe(0);
    expect(inverseLinearScore(3.0, 0.4, 1.0, 40)).toBe(0);
  });

  it('interpolates in between', () => {
    expect(inverseLinearScore(0.7, 0.4, 1.0, 40)).toBeCloseTo(20, 6);
  });
});

describe('mean / stdDev / sum', () => {
  it('returns null for an empty series rather than NaN', () => {
    expect(mean([])).toBeNull();
    expect(stdDev([])).toBeNull();
  });

  it('needs two observations for a standard deviation', () => {
    expect(stdDev([5])).toBeNull();
    expect(stdDev([5, 5])).toBe(0);
  });

  it('ignores non-finite entries', () => {
    expect(mean([10, Number.NaN, 20])).toBe(15);
    expect(sum([10, Number.POSITIVE_INFINITY, 20])).toBe(30);
  });
});

describe('coefficientOfVariation', () => {
  it('is zero for a perfectly stable series', () => {
    expect(coefficientOfVariation([100, 100, 100, 100])).toBe(0);
  });

  it('is scale-free — proportional swings score identically at any income level', () => {
    const small = coefficientOfVariation([90, 100, 110]);
    const large = coefficientOfVariation([90_000, 100_000, 110_000]);
    expect(small).not.toBeNull();
    expect(large).toBeCloseTo(small as number, 10);
  });

  it('returns null when the mean is zero', () => {
    expect(coefficientOfVariation([-100, 100])).toBeNull();
  });
});

describe('olsSlope', () => {
  it('recovers a known slope', () => {
    const slope = olsSlope([
      { x: 0, y: 1 },
      { x: 1, y: 2 },
      { x: 2, y: 3 },
      { x: 3, y: 4 },
    ]);
    expect(slope).toBeCloseTo(1, 10);
  });

  it('detects a downward trend', () => {
    const slope = olsSlope([
      { x: 0, y: 5 },
      { x: 2, y: 3 },
    ]);
    expect(slope).toBeCloseTo(-1, 10);
  });

  it('returns null when the slope is not identifiable', () => {
    expect(olsSlope([])).toBeNull();
    expect(olsSlope([{ x: 1, y: 1 }])).toBeNull();
    // Zero variance in x — a vertical fit.
    expect(
      olsSlope([
        { x: 2, y: 1 },
        { x: 2, y: 9 },
      ]),
    ).toBeNull();
  });
});

describe('compoundGrowthRate', () => {
  it('computes annualised growth', () => {
    const rate = compoundGrowthRate(100, 121, 2);
    expect(rate).toBeCloseTo(0.1, 6);
  });

  it('returns null rather than Infinity when starting from zero', () => {
    expect(compoundGrowthRate(0, 50_000, 3)).toBeNull();
    expect(compoundGrowthRate(-1000, 50_000, 3)).toBeNull();
  });

  it('returns null for a zero or negative period', () => {
    expect(compoundGrowthRate(100, 200, 0)).toBeNull();
    expect(compoundGrowthRate(100, 200, -2)).toBeNull();
  });
});

describe('date helpers', () => {
  it('counts distinct calendar months', () => {
    expect(
      distinctMonths([
        new Date(Date.UTC(2026, 0, 5)),
        new Date(Date.UTC(2026, 0, 28)),
        new Date(Date.UTC(2026, 1, 3)),
      ]),
    ).toBe(2);
  });

  it('counts whole months between dates, floored at zero', () => {
    expect(monthsBetween(new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2026, 6, 1)))).toBe(6);
    expect(monthsBetween(new Date(Date.UTC(2026, 6, 1)), new Date(Date.UTC(2026, 0, 1)))).toBe(0);
  });

  it('computes fractional years and refuses negative spans', () => {
    expect(
      yearsBetween(new Date(Date.UTC(2020, 0, 1)), new Date(Date.UTC(2026, 0, 1))),
    ).toBeCloseTo(6, 1);
    expect(yearsBetween(new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2020, 0, 1)))).toBe(0);
  });
});

describe('roundTo', () => {
  it('rounds to the requested precision', () => {
    expect(roundTo(776.666, 0)).toBe(777);
    expect(roundTo(1.234, 2)).toBe(1.23);
    expect(roundTo(-1.236, 2)).toBe(-1.24);
  });

  it('rounds halves toward positive infinity, the JavaScript convention', () => {
    // Documented rather than changed. Only ratios can be negative here (a negative savings
    // rate); every monetary amount and score is non-negative, so the direction taken on an
    // exact negative half has no bearing on a credit decision.
    expect(roundTo(1.5, 0)).toBe(2);
    expect(roundTo(-1.5, 0)).toBe(-1);
    expect(roundTo(-1.235, 2)).toBe(-1.23);
  });

  it('rounds exact decimal halves up, not down', () => {
    // The naive `Math.round(v * 100) / 100` gets these wrong: 1.005 * 100 is
    // 100.49999999999999 in IEEE 754, which rounds down. Money must not drift downward.
    expect(roundTo(1.005, 2)).toBe(1.01);
    expect(roundTo(2.675, 2)).toBe(2.68);
    expect(roundTo(8.615, 2)).toBe(8.62);
  });

  it('returns zero for non-finite input', () => {
    expect(roundTo(Number.NaN)).toBe(0);
    expect(roundTo(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
