/**
 * Asserts the §4.2–4.5 point tables exactly as printed in the technical document.
 *
 * These are the tests that make the scorecard auditable. Each one names the sub-parameter, the
 * threshold from the document, and the points the document says it earns — so if someone
 * changes a scoring rule, the failure message points at the clause they violated.
 */
import { describe, expect, it } from 'vitest';
import { PILLAR_MAX_POINTS, defaultFeatureVector, type FeatureVector } from '@aics/contracts';

import { ScorecardService } from '../src/scoring/scorecard.service';

const scorecard = new ScorecardService();

/** A feature vector with the named overrides applied to the manifest defaults. */
function vector(overrides: Partial<Record<string, number>> = {}): FeatureVector {
  return { ...defaultFeatureVector(), ...overrides } as FeatureVector;
}

function subScore(
  pillar: ReturnType<ScorecardService['scoreFinancial']>,
  code: string,
): { points: number; maxPoints: number; detail: string } {
  const found = pillar.subScores.find((sub) => sub.code === code);
  if (found === undefined) {
    throw new Error(`sub-score ${code} not found in ${pillar.pillar}`);
  }
  return found;
}

/* ========================================================================== */
/* §4.2 Financial — 300 points                                                */
/* ========================================================================== */

describe('§4.2 Financial pillar', () => {
  it('awards the full 80 points for an average balance at or above NPR 200,000', () => {
    expect(subScore(scorecard.scoreFinancial(vector({ avg_balance_6m: 200_000 })), 'AVG_BALANCE_6M').points).toBe(80);
    expect(subScore(scorecard.scoreFinancial(vector({ avg_balance_6m: 5_000_000 })), 'AVG_BALANCE_6M').points).toBe(80);
  });

  it('scales the average balance linearly below the threshold', () => {
    expect(subScore(scorecard.scoreFinancial(vector({ avg_balance_6m: 100_000 })), 'AVG_BALANCE_6M').points).toBe(40);
    expect(subScore(scorecard.scoreFinancial(vector({ avg_balance_6m: 0 })), 'AVG_BALANCE_6M').points).toBe(0);
  });

  it('awards salary consistency in proportion to months verified (60 pts at 6/6)', () => {
    for (const [months, expected] of [[6, 60], [3, 30], [1, 10], [0, 0]] as const) {
      expect(
        subScore(scorecard.scoreFinancial(vector({ salary_consistency_months: months })), 'SALARY_CONSISTENCY').points,
      ).toBe(expected);
    }
  });

  it('applies the documented DSR bands: <30% = 50, 30-40% = 35, 40-50% = 20, >50% = 5', () => {
    const points = (dsr: number): number =>
      subScore(scorecard.scoreFinancial(vector({ dsr })), 'DEBT_SERVICE_RATIO').points;

    expect(points(0.0)).toBe(50);
    expect(points(0.29)).toBe(50);
    expect(points(0.3)).toBe(35);
    expect(points(0.39)).toBe(35);
    expect(points(0.4)).toBe(20);
    expect(points(0.45)).toBe(20);
    expect(points(0.5)).toBe(20);
    expect(points(0.51)).toBe(5);
    expect(points(1.5)).toBe(5);
  });

  it('awards the full 40 savings points above a 20% savings rate', () => {
    expect(subScore(scorecard.scoreFinancial(vector({ savings_rate: 0.2 })), 'SAVINGS_RATE').points).toBe(40);
    expect(subScore(scorecard.scoreFinancial(vector({ savings_rate: 0.1 })), 'SAVINGS_RATE').points).toBe(20);
    expect(subScore(scorecard.scoreFinancial(vector({ savings_rate: -0.3 })), 'SAVINGS_RATE').points).toBe(0);
  });

  it('deducts 8 points per late payment from the 40-point punctuality score', () => {
    const points = (late: number): number =>
      subScore(scorecard.scoreFinancial(vector({ late_payment_count_6m: late })), 'PAYMENT_PUNCTUALITY').points;

    expect(points(0)).toBe(40);
    expect(points(1)).toBe(32);
    expect(points(3)).toBe(16);
    expect(points(5)).toBe(0);
    // Cannot go negative and drag down other sub-scores.
    expect(points(20)).toBe(0);
  });

  it('deducts 10 points per bounce from the 30-point bounce score', () => {
    const points = (bounces: number): number =>
      subScore(scorecard.scoreFinancial(vector({ bounce_count_6m: bounces })), 'BOUNCE_OVERDRAFT').points;

    expect(points(0)).toBe(30);
    expect(points(1)).toBe(20);
    expect(points(2)).toBe(10);
    expect(points(3)).toBe(0);
    expect(points(9)).toBe(0);
  });

  it('caps the whole pillar at 180 when bounces exceed 3 (§4.2)', () => {
    // An otherwise flawless financial profile.
    const strong = {
      avg_balance_6m: 500_000,
      min_monthly_balance_6m: 300_000,
      salary_consistency_months: 6,
      avg_monthly_income: 300_000,
      dsr: 0.1,
      savings_rate: 0.4,
      cash_buffer_months: 12,
      late_payment_count_6m: 0,
      overdraft_days_6m: 0,
    };

    const withinTolerance = scorecard.scoreFinancial(vector({ ...strong, bounce_count_6m: 3 }));
    const beyondTolerance = scorecard.scoreFinancial(vector({ ...strong, bounce_count_6m: 4 }));

    expect(withinTolerance.points).toBeGreaterThan(180);
    expect(beyondTolerance.points).toBe(180);
    expect(beyondTolerance.notes.join(' ')).toMatch(/capped at 180/);
  });

  it('never exceeds the 300-point pillar maximum', () => {
    const perfect = scorecard.scoreFinancial(
      vector({
        avg_balance_6m: 100_000_000,
        min_monthly_balance_6m: 100_000_000,
        salary_consistency_months: 6,
        avg_monthly_income: 100_000_000,
        income_stability_cv: 0,
        dsr: 0,
        savings_rate: 1,
        cash_buffer_months: 120,
        bounce_count_6m: 0,
        overdraft_days_6m: 0,
        late_payment_count_6m: 0,
      }),
    );
    expect(perfect.points).toBeLessThanOrEqual(PILLAR_MAX_POINTS.FINANCIAL);
    expect(perfect.points).toBe(300);
  });
});

/* ========================================================================== */
/* §4.3 Professional — 250 points                                             */
/* ========================================================================== */

describe('§4.3 Professional pillar', () => {
  it('scales employer type quality from the 0-100 premium onto 60 points', () => {
    // §4.3: MNC = 100, Commercial Bank = 95, Corporate = 80, SME = 55, Informal = 30.
    const points = (tier: number): number =>
      subScore(scorecard.scoreProfessional(vector({ employer_tier_score: tier })), 'EMPLOYER_TYPE').points;

    expect(points(100)).toBe(60);
    expect(points(95)).toBeCloseTo(57, 5);
    expect(points(80)).toBe(48);
    expect(points(55)).toBe(33);
    expect(points(30)).toBe(18);
  });

  it('scales experience to 45 points over 20 years and adds the +5 bonus at 25 years', () => {
    const points = (years: number): number =>
      subScore(scorecard.scoreProfessional(vector({ total_experience_years: years })), 'TOTAL_EXPERIENCE').points;

    expect(points(0)).toBe(0);
    expect(points(10)).toBeCloseTo(22.5, 5);
    expect(points(20)).toBe(45);
    expect(points(24)).toBe(45);
    expect(points(25)).toBe(50);
    expect(points(40)).toBe(50);
  });

  it('deducts for career stagnation and rewards progression', () => {
    const points = (slope: number): number =>
      subScore(scorecard.scoreProfessional(vector({ career_progression_slope: slope })), 'CAREER_PROGRESSION').points;

    expect(points(0.75)).toBe(50);
    expect(points(-0.5)).toBe(0);
    // A flat career scores low but not zero.
    const flat = points(0);
    expect(flat).toBeGreaterThan(0);
    expect(flat).toBeLessThan(25);
    expect(points(0.4)).toBeGreaterThan(flat);
  });

  it('awards the full 40 salary-trajectory points above 8% annual growth', () => {
    const points = (growth: number): number =>
      subScore(scorecard.scoreProfessional(vector({ salary_growth_rate: growth })), 'SALARY_TRAJECTORY').points;

    expect(points(0.08)).toBe(40);
    expect(points(0.16)).toBe(40);
    expect(points(0.04)).toBe(20);
    expect(points(0)).toBe(0);
    expect(points(-0.1)).toBe(0);
  });

  it('passes education and certification scores straight through, capped', () => {
    const pillar = scorecard.scoreProfessional(
      vector({ education_level_score: 30, certification_score: 20 }),
    );
    expect(subScore(pillar, 'EDUCATION_QUALITY').points).toBe(30);
    expect(subScore(pillar, 'CERTIFICATIONS').points).toBe(20);
  });

  it('never exceeds the 250-point pillar maximum', () => {
    const perfect = scorecard.scoreProfessional(
      vector({
        employer_tier_score: 100,
        total_experience_years: 40,
        career_progression_slope: 3,
        salary_growth_rate: 5,
        education_level_score: 30,
        certification_score: 20,
      }),
    );
    expect(perfect.points).toBe(250);
  });
});

/* ========================================================================== */
/* §4.4 Social — 200 points                                                   */
/* ========================================================================== */

describe('§4.4 Social pillar', () => {
  it('awards 5 travel points per 3 countries, doubling premium visas', () => {
    const points = (countries: number, visas = 0): number =>
      subScore(
        scorecard.scoreSocial(vector({ countries_traveled_count: countries, premium_visa_count: visas })),
        'TRAVEL_HISTORY',
      ).points;

    expect(points(0)).toBe(0);
    expect(points(3)).toBe(5);
    expect(points(6)).toBe(10);
    // Premium visas count a second time, per the §4.4 "2x" premium.
    expect(points(6, 3)).toBe(15);
    expect(points(24)).toBe(40);
    // Capped at the 40-point maximum.
    expect(points(100, 50)).toBe(40);
  });

  it('scales reference quality from the tier score onto 40 points, counting the best two', () => {
    const points = (tier: number): number =>
      subScore(scorecard.scoreSocial(vector({ reference_tier_score: tier })), 'REFERENCE_QUALITY').points;

    expect(points(100)).toBe(40); // C-suite
    expect(points(90)).toBe(36); // Director
    expect(points(0)).toBe(0);
  });

  it('awards full residence points at 3+ years', () => {
    const points = (years: number): number =>
      subScore(scorecard.scoreSocial(vector({ residence_stability_years: years })), 'RESIDENCE_STABILITY').points;

    expect(points(3)).toBe(30);
    expect(points(1.5)).toBe(15);
    expect(points(0)).toBe(0);
  });

  it('deducts 7 points per missing KYC document from 30 (§4.4)', () => {
    // Four scored documents: NID, passport, PAN, address proof.
    const points = (completeness: number): number =>
      subScore(scorecard.scoreSocial(vector({ kyc_completeness_pct: completeness })), 'KYC_COMPLETENESS').points;

    expect(points(1.0)).toBe(30); // none missing
    expect(points(0.75)).toBe(23); // one missing
    expect(points(0.5)).toBe(16); // two missing
    expect(points(0.25)).toBe(9); // three missing
    expect(points(0)).toBe(2); // all four missing
  });

  it('never exceeds the 200-point pillar maximum', () => {
    const perfect = scorecard.scoreSocial(
      vector({
        countries_traveled_count: 100,
        premium_visa_count: 50,
        reference_tier_score: 100,
        institutional_tier_score: 100,
        residence_stability_years: 40,
        kyc_completeness_pct: 1,
        awards_score: 25,
      }),
    );
    expect(perfect.points).toBe(200);
  });
});

/* ========================================================================== */
/* §4.5 Behavioral — 250 points                                               */
/* ========================================================================== */

describe('§4.5 Behavioral pillar', () => {
  it('awards full tenure points at 5+ years per employer', () => {
    const points = (years: number): number =>
      subScore(scorecard.scoreBehavioral(vector({ avg_employer_tenure_years: years })), 'EMPLOYER_TENURE').points;

    expect(points(5)).toBe(60);
    expect(points(2.5)).toBe(30);
    expect(points(0)).toBe(0);
  });

  it('steps income diversification so a single salary is a baseline, not a failure', () => {
    const points = (streams: number): number =>
      subScore(scorecard.scoreBehavioral(vector({ income_stream_count: streams })), 'INCOME_DIVERSIFICATION').points;

    expect(points(0)).toBe(0);
    expect(points(1)).toBe(20);
    expect(points(2)).toBe(35);
    expect(points(3)).toBe(50);
    expect(points(6)).toBe(50);
  });

  it('scores a thin file at the neutral midpoint for repayment track record', () => {
    // No observable obligations at all: no DSR, no card usage.
    const thin = scorecard.scoreBehavioral(
      vector({ dsr: 0, credit_card_utilization_proxy: 0, emi_payment_punctuality: 1 }),
    );
    const record = subScore(thin, 'REPAYMENT_TRACK_RECORD');
    expect(record.points).toBe(25);
    expect(record.detail).toMatch(/thin file/i);
  });

  it('scores repayment track record from punctuality when obligations exist', () => {
    const perfect = scorecard.scoreBehavioral(vector({ dsr: 0.3, emi_payment_punctuality: 1 }));
    expect(subScore(perfect, 'REPAYMENT_TRACK_RECORD').points).toBe(50);

    const poor = scorecard.scoreBehavioral(vector({ dsr: 0.3, emi_payment_punctuality: 0.5 }));
    expect(subScore(poor, 'REPAYMENT_TRACK_RECORD').points).toBe(25);
  });

  it('awards full spending discipline below 40% discretionary spend', () => {
    const points = (ratio: number): number =>
      subScore(scorecard.scoreBehavioral(vector({ discretionary_spend_ratio: ratio })), 'SPENDING_DISCIPLINE').points;

    expect(points(0.2)).toBe(40);
    expect(points(0.4)).toBe(40);
    expect(points(0.7)).toBeCloseTo(20, 5);
    expect(points(1.0)).toBe(0);
  });

  it('awards full self-management points at 5 of 6 saving months', () => {
    const points = (months: number): number =>
      subScore(scorecard.scoreBehavioral(vector({ savings_months_count: months })), 'FINANCIAL_SELF_MANAGEMENT').points;

    expect(points(5)).toBe(30);
    expect(points(6)).toBe(30);
    expect(points(0)).toBe(0);
  });

  it('rewards multi-country careers on the mobility measure', () => {
    const points = (countries: number): number =>
      subScore(scorecard.scoreBehavioral(vector({ countries_worked_count: countries })), 'GEOGRAPHIC_MOBILITY').points;

    expect(points(1)).toBe(0);
    expect(points(2)).toBe(10);
    expect(points(3)).toBe(20);
    expect(points(8)).toBe(20);
  });

  it('never exceeds the 250-point pillar maximum', () => {
    const perfect = scorecard.scoreBehavioral(
      vector({
        avg_employer_tenure_years: 20,
        job_changes_count: 0,
        income_stream_count: 6,
        emi_payment_punctuality: 1,
        dsr: 0.2,
        discretionary_spend_ratio: 0,
        atm_withdrawal_ratio: 0,
        savings_months_count: 6,
        countries_worked_count: 5,
        insurance_premium_active: 1,
        credit_card_utilization_proxy: 0.1,
      }),
    );
    expect(perfect.points).toBe(250);
  });
});

/* ========================================================================== */
/* Composite                                                                  */
/* ========================================================================== */

describe('composite score', () => {
  it('sums the four pillars and cannot exceed 1000', () => {
    const result = scorecard.score(vector());
    const summed = result.pillars.reduce((total, pillar) => total + pillar.points, 0);
    expect(result.compositeScore).toBeCloseTo(summed, 5);
    expect(result.compositeScore).toBeLessThanOrEqual(1000);
    expect(result.compositeScore).toBeGreaterThanOrEqual(0);
  });

  it('reports all four pillars with their documented maxima', () => {
    const result = scorecard.score(vector());
    expect(result.pillars.map((pillar) => pillar.pillar)).toEqual([
      'FINANCIAL',
      'PROFESSIONAL',
      'SOCIAL',
      'BEHAVIORAL',
    ]);
    expect(result.pillars.map((pillar) => pillar.maxPoints)).toEqual([300, 250, 200, 250]);
  });

  it('reaches exactly 1000 only for an applicant who has DEMONSTRATED repayment', () => {
    // Everything maxed except credit history. A perfect applicant who has never borrowed
    // cannot score 1000: §4.5 awards the repayment sub-score for a proven track record, and an
    // absence of obligations is scored at the neutral midpoint (25 of 50) rather than as
    // evidence of discipline. So the ceiling without a credit history is 975, and the last 25
    // points require having serviced real obligations on time.
    const maximalNoCreditHistory = vector({
      avg_balance_6m: 100_000_000,
      min_monthly_balance_6m: 100_000_000,
      salary_consistency_months: 6,
      avg_monthly_income: 100_000_000,
      income_stability_cv: 0,
      dsr: 0,
      savings_rate: 1,
      cash_buffer_months: 120,
      bounce_count_6m: 0,
      overdraft_days_6m: 0,
      late_payment_count_6m: 0,
      employer_tier_score: 100,
      total_experience_years: 40,
      career_progression_slope: 3,
      salary_growth_rate: 5,
      education_level_score: 30,
      certification_score: 20,
      countries_traveled_count: 100,
      premium_visa_count: 50,
      reference_tier_score: 100,
      institutional_tier_score: 100,
      residence_stability_years: 40,
      kyc_completeness_pct: 1,
      awards_score: 25,
      avg_employer_tenure_years: 20,
      income_stream_count: 6,
      emi_payment_punctuality: 1,
      discretionary_spend_ratio: 0,
      savings_months_count: 6,
      countries_worked_count: 5,
      insurance_premium_active: 1,
    });
    expect(scorecard.score(maximalNoCreditHistory).compositeScore).toBe(975);

    // Same applicant, but with observable obligations met perfectly.
    const maximalWithCreditHistory = {
      ...maximalNoCreditHistory,
      dsr: 0.2,
      emi_payment_punctuality: 1,
      credit_card_utilization_proxy: 0.1,
    } as FeatureVector;
    expect(scorecard.score(maximalWithCreditHistory).compositeScore).toBe(1000);
  });

  it('is deterministic — the same vector always yields the same score', () => {
    const input = vector({ avg_balance_6m: 137_412, dsr: 0.37, savings_months_count: 4 });
    const first = scorecard.score(input);
    const second = scorecard.score(input);
    expect(first.compositeScore).toBe(second.compositeScore);
    expect(JSON.stringify(first.pillars)).toBe(JSON.stringify(second.pillars));
  });

  it('gives every sub-score a human-readable explanation', () => {
    for (const pillar of scorecard.score(vector()).pillars) {
      for (const sub of pillar.subScores) {
        expect(sub.detail.length).toBeGreaterThan(10);
        expect(sub.label.length).toBeGreaterThan(3);
        expect(sub.points).toBeGreaterThanOrEqual(0);
        expect(sub.points).toBeLessThanOrEqual(sub.maxPoints);
      }
    }
  });

  it('never produces a non-finite score for extreme inputs', () => {
    const extremes = [0, -1e12, 1e12, Number.MIN_VALUE, Number.MAX_SAFE_INTEGER];
    for (const value of extremes) {
      const filled = Object.fromEntries(
        Object.keys(defaultFeatureVector()).map((name) => [name, value]),
      );
      const result = scorecard.score(filled as FeatureVector);
      expect(Number.isFinite(result.compositeScore)).toBe(true);
      expect(result.compositeScore).toBeGreaterThanOrEqual(0);
      expect(result.compositeScore).toBeLessThanOrEqual(1000);
    }
  });
});
