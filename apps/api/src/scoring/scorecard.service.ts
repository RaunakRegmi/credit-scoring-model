/**
 * The deterministic four-pillar scorecard (§4.2 – §4.5).
 *
 * This is the component that actually decides. Every sub-parameter in the technical document
 * appears here as one method returning its points, its maximum and a plain-language
 * explanation of how it got there. Nothing is learned, nothing is opaque: given a feature
 * vector, the composite score is reproducible by hand, which is what makes an adverse action
 * notice defensible and what lets an auditor re-derive a decision years later.
 *
 * Where the source document is ambiguous or internally inconsistent, the interpretation is
 * stated in a comment at the point of use rather than resolved silently. Two such places
 * are called out below (experience bonus, travel scale).
 */
import { Injectable } from '@nestjs/common';
import {
  COMPOSITE_MAX_SCORE,
  EDUCATION_SCORE,
  KYC_SCORED_DOCUMENTS,
  PILLAR_MAX_POINTS,
  type FeatureVector,
  type Pillar,
  type PillarResult,
  type ScorecardResult,
  type SubScore,
} from '@aics/contracts';

import { clamp, inverseLinearScore, linearScore, roundTo } from '../common/math.util';

/**
 * Bumped whenever any scoring rule changes. Persisted on every `CreditScore` row so a
 * historical decision can always be tied to the rules that produced it (§10.4).
 */
export const SCORECARD_VERSION = '1.0.0';

/** §4.2 average-balance ceiling: NPR 200,000 earns the full 80 points. */
const AVG_BALANCE_CEILING_NPR = 200_000;

/** §4.2 bounce cap: more than this many incidents caps the Financial pillar. */
const BOUNCE_CAP_THRESHOLD = 3;
const FINANCIAL_PILLAR_CAP_ON_BOUNCES = 180;

interface Builder {
  readonly subScores: SubScore[];
  readonly notes: string[];
}

function newBuilder(): Builder {
  return { subScores: [], notes: [] };
}

function add(
  builder: Builder,
  code: string,
  label: string,
  points: number,
  maxPoints: number,
  detail: string,
): void {
  builder.subScores.push({
    code,
    label,
    points: roundTo(clamp(points, 0, maxPoints), 2),
    maxPoints,
    detail,
  });
}

function finish(builder: Builder, pillar: Pillar, cap?: number): PillarResult {
  const raw = builder.subScores.reduce((total, sub) => total + sub.points, 0);
  const max = PILLAR_MAX_POINTS[pillar];
  const capped = cap === undefined ? raw : Math.min(raw, cap);

  return {
    pillar,
    points: roundTo(clamp(capped, 0, max), 2),
    maxPoints: max,
    subScores: builder.subScores,
    notes: builder.notes,
  };
}

function npr(value: number): string {
  return `NPR ${Math.round(value).toLocaleString('en-IN')}`;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

@Injectable()
export class ScorecardService {
  /** Scores all four pillars and the composite. */
  score(features: FeatureVector): ScorecardResult {
    const pillars: PillarResult[] = [
      this.scoreFinancial(features),
      this.scoreProfessional(features),
      this.scoreSocial(features),
      this.scoreBehavioral(features),
    ];

    const composite = pillars.reduce((total, pillar) => total + pillar.points, 0);

    return {
      pillars,
      compositeScore: roundTo(clamp(composite, 0, COMPOSITE_MAX_SCORE), 2),
      scorecardVersion: SCORECARD_VERSION,
    };
  }

  /* ====================================================================== */
  /* §4.2 Financial — 300 points                                            */
  /* ====================================================================== */

  scoreFinancial(features: FeatureVector): PillarResult {
    const builder = newBuilder();

    // --- Average balance, 80 pts, max at NPR 200,000 ---------------------
    const balancePoints = linearScore(features.avg_balance_6m, 0, AVG_BALANCE_CEILING_NPR, 80);
    add(
      builder,
      'AVG_BALANCE_6M',
      'Average balance (6 months)',
      balancePoints,
      80,
      `Average daily balance ${npr(features.avg_balance_6m)} against the ${npr(
        AVG_BALANCE_CEILING_NPR,
      )} threshold for full marks.`,
    );

    // --- Salary consistency, 60 pts, proportional to months verified -----
    const salaryPoints = (clamp(features.salary_consistency_months, 0, 6) / 6) * 60;
    add(
      builder,
      'SALARY_CONSISTENCY',
      'Salary credit consistency',
      salaryPoints,
      60,
      `Verified salary credits in ${features.salary_consistency_months} of 6 months.`,
    );

    // --- Debt service ratio, 50 pts, banded (§4.2 inverse scoring) -------
    const { points: dsrPoints, detail: dsrDetail } = this.scoreDsr(features.dsr);
    add(builder, 'DEBT_SERVICE_RATIO', 'Debt service ratio (DSR)', dsrPoints, 50, dsrDetail);

    // --- Savings rate, 40 pts, max above 20% -----------------------------
    const savingsPoints = linearScore(features.savings_rate, 0, 0.2, 40);
    add(
      builder,
      'SAVINGS_RATE',
      'Savings rate',
      savingsPoints,
      40,
      `Average monthly savings rate ${pct(features.savings_rate)} against the 20% threshold.`,
    );

    // --- Payment punctuality, 40 pts, −8 per late payment ----------------
    const latePayments = features.late_payment_count_6m;
    const punctualityPoints = 40 - latePayments * 8;
    add(
      builder,
      'PAYMENT_PUNCTUALITY',
      'Payment punctuality',
      punctualityPoints,
      40,
      latePayments === 0
        ? 'No late payments detected across the statement period.'
        : `${latePayments} late or missed payment(s) detected, deducting 8 points each.`,
    );

    // --- Bounce / overdraft, 30 pts, −10 per bounce ----------------------
    const bounces = features.bounce_count_6m;
    const bouncePoints = 30 - bounces * 10;
    add(
      builder,
      'BOUNCE_OVERDRAFT',
      'Bounce / overdraft incidents',
      bouncePoints,
      30,
      bounces === 0
        ? `No returned payments. ${features.overdraft_days_6m} day(s) in overdraft.`
        : `${bounces} bounce/NSF incident(s), deducting 10 points each. ` +
          `${features.overdraft_days_6m} day(s) in overdraft.`,
    );

    // §4.2: "Each bounce deducts 10pts; >3 = pillar cap at 180". A pattern of returned
    // payments is treated as disqualifying evidence about the whole financial pillar, not
    // merely a deduction within it — an applicant cannot offset chronic bounces with a
    // healthy balance.
    let cap: number | undefined;
    if (bounces > BOUNCE_CAP_THRESHOLD) {
      cap = FINANCIAL_PILLAR_CAP_ON_BOUNCES;
      builder.notes.push(
        `${bounces} bounce incidents exceed the tolerance of ${BOUNCE_CAP_THRESHOLD}; ` +
          `Financial pillar capped at ${FINANCIAL_PILLAR_CAP_ON_BOUNCES} points per §4.2.`,
      );
    }

    return finish(builder, 'FINANCIAL', cap);
  }

  /**
   * §4.2 DSR bands: `<30% = 50`, `30–40% = 35`, `40–50% = 20`, `>50% = 5`.
   *
   * Banded rather than continuous because that is what the document specifies, and because
   * a step function is what a credit committee can reason about.
   */
  private scoreDsr(dsr: number): { points: number; detail: string } {
    if (dsr < 0.3) {
      return { points: 50, detail: `DSR ${pct(dsr)} is below the 30% threshold for full marks.` };
    }
    if (dsr < 0.4) {
      return { points: 35, detail: `DSR ${pct(dsr)} falls in the 30–40% band.` };
    }
    if (dsr <= 0.5) {
      return { points: 20, detail: `DSR ${pct(dsr)} falls in the 40–50% band.` };
    }
    return {
      points: 5,
      detail: `DSR ${pct(dsr)} exceeds 50%; existing obligations consume most of the verified income.`,
    };
  }

  /* ====================================================================== */
  /* §4.3 Professional — 250 points                                         */
  /* ====================================================================== */

  scoreProfessional(features: FeatureVector): PillarResult {
    const builder = newBuilder();

    // --- Employer type quality, 60 pts -----------------------------------
    const employerPoints = (features.employer_tier_score / 100) * 60;
    add(
      builder,
      'EMPLOYER_TYPE',
      'Employer type quality',
      employerPoints,
      60,
      `Employer category premium ${features.employer_tier_score.toFixed(0)}/100 (§4.3).`,
    );

    // --- Total experience, 50 pts ----------------------------------------
    //
    // §4.3 reads "Linear 0-20 yrs; bonus +5pts for 25+ yrs" against a 50-point maximum,
    // which cannot all hold at once — a linear scale that already reaches 50 at 20 years
    // leaves no room for a bonus. Interpreted as: linear to 45 points across 0–20 years,
    // with the +5 long-career bonus taking a 25-year veteran to the full 50.
    const years = features.total_experience_years;
    const basePoints = linearScore(years, 0, 20, 45);
    const bonus = years >= 25 ? 5 : 0;
    add(
      builder,
      'TOTAL_EXPERIENCE',
      'Total years of experience',
      basePoints + bonus,
      50,
      `${years.toFixed(1)} years of experience` +
        (bonus > 0 ? ', including the +5 point bonus for 25+ years.' : '.'),
    );

    // --- Career progression, 50 pts --------------------------------------
    //
    // The regressand is seniority rank per year (§4.3). A flat career scores low but not
    // zero; a demotion trend scores zero. Full marks need roughly one seniority step every
    // 18 months sustained.
    const slope = features.career_progression_slope;
    const progressionPoints = linearScore(slope, -0.5, 0.75, 50);
    add(
      builder,
      'CAREER_PROGRESSION',
      'Career progression index',
      progressionPoints,
      50,
      slope > 0.05
        ? `Seniority rising at ${slope.toFixed(2)} levels per year.`
        : slope < -0.05
          ? `Seniority trending downwards at ${slope.toFixed(2)} levels per year.`
          : 'Seniority has been flat across the recorded history (stagnation deduction applied).',
    );

    // --- Salary trajectory, 40 pts, max above 8%/yr ----------------------
    const growth = features.salary_growth_rate;
    const salaryPoints = linearScore(growth, 0, 0.08, 40);
    add(
      builder,
      'SALARY_TRAJECTORY',
      'Salary trajectory',
      salaryPoints,
      40,
      `Year-on-year salary growth ${pct(growth)} against the 8% industry benchmark.`,
    );

    // --- Education quality, 30 pts ---------------------------------------
    add(
      builder,
      'EDUCATION_QUALITY',
      'Education quality',
      features.education_level_score,
      30,
      `Education score ${features.education_level_score.toFixed(0)}/30 ` +
        `(maximum ${EDUCATION_SCORE.PHD.intl} for an international doctorate).`,
    );

    // --- Certifications, 20 pts ------------------------------------------
    add(
      builder,
      'CERTIFICATIONS',
      'Skills & certifications',
      features.certification_score,
      20,
      `Certification score ${features.certification_score.toFixed(0)}/20 ` +
        '(international certifications 5 points each, local 2 points).',
    );

    return finish(builder, 'PROFESSIONAL');
  }

  /* ====================================================================== */
  /* §4.4 Social — 200 points                                               */
  /* ====================================================================== */

  scoreSocial(features: FeatureVector): PillarResult {
    const builder = newBuilder();

    // --- International travel, 40 pts ------------------------------------
    //
    // §4.4 specifies "5pts per 3 countries visited" with a stated maximum at 15+ countries,
    // but 15 countries at that rate yields 25 points, not 40. Reconciled by applying the
    // document's own "Schengen/US/UK = 2x" premium as an effective country count: a
    // high-scrutiny visa counts twice, so a well-travelled applicant with premium visas
    // reaches the 40-point maximum while the stated per-country rate is preserved.
    const effectiveCountries = features.countries_traveled_count + features.premium_visa_count;
    const travelPoints = (effectiveCountries / 3) * 5;
    add(
      builder,
      'TRAVEL_HISTORY',
      'International travel history',
      travelPoints,
      40,
      `${features.countries_traveled_count} countries visited` +
        (features.premium_visa_count > 0
          ? `, including ${features.premium_visa_count} high-scrutiny (Schengen/US/UK class) visa(s) counted at double weight.`
          : '.'),
    );

    // --- Reference quality, 40 pts ---------------------------------------
    const referencePoints = (features.reference_tier_score / 100) * 40;
    add(
      builder,
      'REFERENCE_QUALITY',
      'Reference quality',
      referencePoints,
      40,
      features.reference_tier_score > 0
        ? `Average seniority tier of the two strongest references: ${features.reference_tier_score.toFixed(
            0,
          )}/100.`
        : 'No verifiable professional references were provided.',
    );

    // --- Institutional network tier, 35 pts ------------------------------
    const institutionalPoints = (features.institutional_tier_score / 100) * 35;
    add(
      builder,
      'INSTITUTIONAL_TIER',
      'Institutional network tier',
      institutionalPoints,
      35,
      `Highest institutional prestige tier in the applicant's history: ${features.institutional_tier_score.toFixed(
        0,
      )}/100.`,
    );

    // --- Residence stability, 30 pts, max at 3+ years --------------------
    const residencePoints = linearScore(features.residence_stability_years, 0, 3, 30);
    add(
      builder,
      'RESIDENCE_STABILITY',
      'Residence stability',
      residencePoints,
      30,
      `Tenure-weighted residence stability of ${features.residence_stability_years.toFixed(
        1,
      )} years against the 3-year threshold (owner-occupied weighted above rented).`,
    );

    // --- KYC completeness, 30 pts, −7 per missing document ---------------
    const totalDocs = KYC_SCORED_DOCUMENTS.length;
    const suppliedDocs = Math.round(features.kyc_completeness_pct * totalDocs);
    const missingDocs = Math.max(0, totalDocs - suppliedDocs);
    const kycPoints = 30 - missingDocs * 7;
    add(
      builder,
      'KYC_COMPLETENESS',
      'Personal identity completeness',
      kycPoints,
      30,
      missingDocs === 0
        ? 'All required identity documents supplied and verified.'
        : `${missingDocs} of ${totalDocs} identity documents missing, deducting 7 points each.`,
    );

    // --- Awards, 25 pts ---------------------------------------------------
    add(
      builder,
      'AWARDS_RECOGNITION',
      'Industry awards / recognition',
      features.awards_score,
      25,
      features.awards_score > 0
        ? `Award score ${features.awards_score.toFixed(0)}/25 (international 5, national 3, company 1).`
        : 'No industry awards or recognitions recorded.',
    );

    return finish(builder, 'SOCIAL');
  }

  /* ====================================================================== */
  /* §4.5 Behavioral — 250 points                                           */
  /* ====================================================================== */

  scoreBehavioral(features: FeatureVector): PillarResult {
    const builder = newBuilder();

    // --- Average employer tenure, 60 pts, max at 5+ years ----------------
    const tenurePoints = linearScore(features.avg_employer_tenure_years, 0, 5, 60);
    add(
      builder,
      'EMPLOYER_TENURE',
      'Average employer tenure',
      tenurePoints,
      60,
      `Average of ${features.avg_employer_tenure_years.toFixed(1)} years per employer across ` +
        `${features.job_changes_count + 1} recorded role(s), against the 5-year threshold.`,
    );

    // --- Income diversification, 50 pts ----------------------------------
    //
    // Stepped rather than linear from zero. §4.5 rewards multiple income sources, but a
    // single well-evidenced salary is the normal case for a salaried applicant and should
    // not score zero on a stability measure — it is the baseline, not a deficiency.
    const streams = features.income_stream_count;
    const diversificationPoints = streams >= 3 ? 50 : streams === 2 ? 35 : streams === 1 ? 20 : 0;
    add(
      builder,
      'INCOME_DIVERSIFICATION',
      'Income diversification index',
      diversificationPoints,
      50,
      streams === 0
        ? 'No verifiable income stream identified in the statement.'
        : `${streams} material independent income stream(s) detected; 3 or more earns full marks.`,
    );

    // --- Repayment track record, 50 pts ----------------------------------
    //
    // Derived from statement behaviour (§4.5), not a bureau file. An applicant with no
    // observable obligations has no track record either way; awarding half acknowledges the
    // absence of adverse evidence without crediting a discipline they have not demonstrated.
    const hasObligations = features.credit_card_utilization_proxy > 0 || features.dsr > 0;
    const repaymentPoints = hasObligations ? features.emi_payment_punctuality * 50 : 25;
    add(
      builder,
      'REPAYMENT_TRACK_RECORD',
      'Repayment track record',
      repaymentPoints,
      50,
      hasObligations
        ? `${pct(features.emi_payment_punctuality)} of observed instalment obligations were met on schedule.`
        : 'No existing credit obligations observed — thin file, scored at the neutral midpoint.',
    );

    // --- Spending discipline, 40 pts, max below 40% discretionary --------
    const disciplinePoints = inverseLinearScore(features.discretionary_spend_ratio, 0.4, 1.0, 40);
    add(
      builder,
      'SPENDING_DISCIPLINE',
      'Spending pattern discipline',
      disciplinePoints,
      40,
      `Discretionary spending is ${pct(features.discretionary_spend_ratio)} of verified income ` +
        '(40% or below earns full marks).',
    );

    // --- Financial self-management, 30 pts, max at 5/6 months ------------
    const selfManagementPoints = linearScore(features.savings_months_count, 0, 5, 30);
    add(
      builder,
      'FINANCIAL_SELF_MANAGEMENT',
      'Financial self-management',
      selfManagementPoints,
      30,
      `Net positive savings in ${features.savings_months_count} of the months reviewed ` +
        `(5 earns full marks). ` +
        (features.insurance_premium_active === 1
          ? 'An active insurance premium was detected.'
          : 'No active insurance premium was detected.'),
    );

    // --- Geographic mobility, 20 pts -------------------------------------
    const mobilityPoints = linearScore(features.countries_worked_count - 1, 0, 2, 20);
    add(
      builder,
      'GEOGRAPHIC_MOBILITY',
      'Geographic mobility / resilience',
      mobilityPoints,
      20,
      features.countries_worked_count > 1
        ? `Career spans ${features.countries_worked_count} countries.`
        : 'Career has been within a single country.',
    );

    return finish(builder, 'BEHAVIORAL');
  }
}
