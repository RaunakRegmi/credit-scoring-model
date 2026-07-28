/**
 * Extracted documents -> the canonical 38-feature vector.
 *
 * This is `computeFeatures` from the technical brief. Every value produced here is defined
 * by `packages/contracts/feature-set.v1.json`, validated against it before it leaves, and
 * consumed by both the scorecard and the ML model.
 *
 * Two rules govern the whole file:
 *
 *   1. No ratio is computed with bare division. Everything goes through `safeRatio`, and a
 *      `null` result means "we could not determine this", which raises a degraded flag and
 *      keeps the manifest default in the vector. We never substitute a worst-case number for
 *      missing data: that silently converts "unknown" into "bad", which is both unfair to the
 *      applicant and unexplainable to a regulator.
 *
 *   2. Absent evidence never earns points. An unparseable CV yields the manifest defaults and
 *      a flag, not a neutral-to-favourable guess.
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  EDUCATION_SCORE,
  EMPLOYER_TYPE_PREMIUM,
  FEATURE_SET_VERSION,
  INSTITUTIONAL_TIER,
  KYC_SCORED_DOCUMENTS,
  MAX_SCORED_REFERENCES,
  REFERENCE_TIER_SCORE,
  RESIDENCE_STATUS_MULTIPLIER,
  defaultFeatureVector,
  featureVectorSchema,
  type DegradedFlag,
  type DocumentType,
  type FeatureName,
  type FeatureVector,
  type ProductType,
  type ResidenceStatus,
} from '@aics/contracts';

import {
  clamp,
  coefficientOfVariation,
  compoundGrowthRate,
  mean,
  olsSlope,
  roundTo,
  safeRatio,
  sum,
  yearsBetween,
} from '../common/math.util';
import type { ResumeExtraction, StatementExtraction } from '../extraction/document-extractor.port';
import type { ClassifiedTransaction } from '../extraction/transaction-classifier';

import { aggregateByMonth, countObligationGaps, type MonthlyAggregate } from './monthly-aggregation';

/** §3.2 — the model is specified on six months of statement data. */
const SCORING_WINDOW_MONTHS = 6;

export interface FeatureComputationInput {
  readonly productType: ProductType;
  readonly requestedAmountNpr: number;
  readonly tenureMonths: number;
  readonly resume: ResumeExtraction;
  readonly statement: StatementExtraction;
  readonly transactions: readonly ClassifiedTransaction[];
  /** KYC documents actually supplied and accepted (§4.4 completeness sub-score). */
  readonly suppliedDocuments: readonly DocumentType[];
  readonly residenceStatus: ResidenceStatus;
  readonly yearsAtAddress: number | null;
  /** Extraction confidences, so the degraded-flag logic lives in one place. */
  readonly resumeConfidence: number;
  readonly statementConfidence: number;
  readonly minConfidence: number;
}

/** Values materialised onto `FeatureStore` for portfolio analytics and KRI reporting. */
export interface DerivedMetrics {
  readonly avgBalance6mNpr: number | null;
  readonly avgMonthlyIncomeNpr: number | null;
  readonly debtServiceRatio: number | null;
  readonly savingsRate: number | null;
  readonly salaryConsistencyMonths: number;
  readonly bounceCount6m: number;
  readonly cashBufferMonths: number | null;
  readonly incomeStreamCount: number;
  readonly discretionaryRatio: number | null;
}

export interface FeatureComputationResult {
  readonly features: FeatureVector;
  readonly featureSetVersion: string;
  readonly monthlyAggregates: readonly MonthlyAggregate[];
  readonly derived: DerivedMetrics;
  readonly degradedFlags: readonly DegradedFlag[];
}

@Injectable()
export class FeatureEngineeringService {
  private readonly logger = new Logger(FeatureEngineeringService.name);

  computeFeatures(input: FeatureComputationInput): FeatureComputationResult {
    const flags = new Set<DegradedFlag>();

    const allMonths = aggregateByMonth(input.transactions, input.statement.openingBalanceNpr);
    // Most recent six months. §3.2 specifies the window; more history is welcome for a
    // manual review but must not change an automated score's basis.
    const months = allMonths.slice(-SCORING_WINDOW_MONTHS);

    this.recordDataQualityFlags(input, months, flags);

    const draft = defaultFeatureVector();

    const financial = this.financialFeatures(input, months, flags);
    const professional = this.professionalFeatures(input, flags);
    const social = this.socialFeatures(input);
    const behavioral = this.behavioralFeatures(input, months);
    const application = this.applicationFeatures(input, months, financial.avgMonthlyIncome);

    Object.assign(draft, financial.values, professional, social, behavioral, application);

    // The schema clamps to the manifest range, rounds integer features and rejects
    // non-finite values. If anything non-finite reaches here it is a bug in this file, and
    // failing loudly is the correct outcome — far better than scoring an applicant on a NaN.
    const features = featureVectorSchema.parse(draft) as FeatureVector;

    return {
      features,
      featureSetVersion: FEATURE_SET_VERSION,
      monthlyAggregates: months,
      derived: {
        avgBalance6mNpr: financial.avgBalance,
        avgMonthlyIncomeNpr: financial.avgMonthlyIncome,
        debtServiceRatio: financial.dsr,
        savingsRate: financial.savingsRate,
        salaryConsistencyMonths: months.filter((month) => month.hasSalaryCredit).length,
        bounceCount6m: sum(months.map((month) => month.bounceCount)),
        cashBufferMonths: financial.cashBuffer,
        incomeStreamCount: behavioral.income_stream_count,
        discretionaryRatio: behavioral.discretionary_spend_ratio,
      },
      degradedFlags: [...flags],
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Data quality                                                           */
  /* ---------------------------------------------------------------------- */

  private recordDataQualityFlags(
    input: FeatureComputationInput,
    months: readonly MonthlyAggregate[],
    flags: Set<DegradedFlag>,
  ): void {
    if (input.transactions.length === 0) {
      flags.add('STATEMENT_EXTRACTION_EMPTY');
      flags.add('NO_BANK_ACCOUNT');
    }
    if (months.length < SCORING_WINDOW_MONTHS) {
      flags.add('INSUFFICIENT_STATEMENT_HISTORY');
    }
    if (input.resume.employment.length === 0) {
      flags.add('NO_EMPLOYMENT_HISTORY');
    }
    if (input.resume.confidence === 0) {
      flags.add('RESUME_EXTRACTION_EMPTY');
    }
    if (
      input.resumeConfidence < input.minConfidence ||
      input.statementConfidence < input.minConfidence
    ) {
      flags.add('LOW_EXTRACTION_CONFIDENCE');
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Financial (§4.2)                                                       */
  /* ---------------------------------------------------------------------- */

  private financialFeatures(
    input: FeatureComputationInput,
    months: readonly MonthlyAggregate[],
    flags: Set<DegradedFlag>,
  ): {
    values: Partial<Record<FeatureName, number>>;
    avgBalance: number | null;
    avgMonthlyIncome: number | null;
    dsr: number | null;
    savingsRate: number | null;
    cashBuffer: number | null;
  } {
    const avgBalance = mean(months.map((month) => month.avgDailyBalanceNpr));
    const minBalance = months.length === 0 ? null : Math.min(...months.map((m) => m.minBalanceNpr));

    const incomeSeries = months.map((month) => month.verifiedIncomeNpr);
    const avgMonthlyIncome = mean(incomeSeries);
    const incomeCv = coefficientOfVariation(incomeSeries);

    // Obligations = EMIs + card repayments (§4.2 debt service ratio).
    const avgObligations = mean(
      months.map((month) => month.emiPaymentsNpr + month.cardPaymentsNpr),
    );

    // The single most important null-guard in the system. Zero verified income makes DSR
    // undefined; without this it is `Infinity`, which XGBoost would happily score.
    const dsr =
      avgObligations === null || avgMonthlyIncome === null
        ? null
        : safeRatio(avgObligations, avgMonthlyIncome);

    if (dsr === null && (avgObligations ?? 0) > 0) {
      // They demonstrably owe money but we cannot verify income to service it.
      flags.add('INSUFFICIENT_INCOME_DATA');
    }
    if (avgMonthlyIncome === null || avgMonthlyIncome <= 0) {
      flags.add('INSUFFICIENT_INCOME_DATA');
    }

    // Savings rate per §4.2: (credits − debits) / credits, averaged over the window.
    const monthlySavingsRates = months
      .map((month) => safeRatio(month.totalCreditsNpr - month.totalDebitsNpr, month.totalCreditsNpr))
      .filter((rate): rate is number => rate !== null);
    const savingsRate = mean(monthlySavingsRates);

    const avgMonthlySpend = mean(months.map((month) => month.totalDebitsNpr));
    const cashBuffer =
      avgBalance === null || avgMonthlySpend === null ? null : safeRatio(avgBalance, avgMonthlySpend);

    const values: Partial<Record<FeatureName, number>> = {};
    if (avgBalance !== null) values.avg_balance_6m = avgBalance;
    if (minBalance !== null) values.min_monthly_balance_6m = minBalance;
    values.salary_consistency_months = months.filter((month) => month.hasSalaryCredit).length;
    if (avgMonthlyIncome !== null) values.avg_monthly_income = avgMonthlyIncome;
    if (incomeCv !== null) values.income_stability_cv = incomeCv;
    if (dsr !== null) values.dsr = dsr;
    if (savingsRate !== null) values.savings_rate = savingsRate;
    if (cashBuffer !== null) values.cash_buffer_months = cashBuffer;
    values.bounce_count_6m = sum(months.map((month) => month.bounceCount));
    values.overdraft_days_6m = sum(months.map((month) => month.overdraftDays));
    values.late_payment_count_6m =
      sum(months.map((month) => month.latePaymentCount)) + countObligationGaps(input.transactions);

    return { values, avgBalance, avgMonthlyIncome, dsr, savingsRate, cashBuffer };
  }

  /* ---------------------------------------------------------------------- */
  /* Professional (§4.3)                                                    */
  /* ---------------------------------------------------------------------- */

  private professionalFeatures(
    input: FeatureComputationInput,
    flags: Set<DegradedFlag>,
  ): Partial<Record<FeatureName, number>> {
    const { resume } = input;
    const employment = [...resume.employment].sort(
      (a, b) => a.startDate.getTime() - b.startDate.getTime(),
    );

    const values: Partial<Record<FeatureName, number>> = {};

    // Current employer, else the most recent one.
    const currentRole = employment.find((role) => role.isCurrent) ?? employment.at(-1);
    if (currentRole !== undefined) {
      values.employer_tier_score = EMPLOYER_TYPE_PREMIUM[currentRole.employerType];
    }

    values.total_experience_years = totalExperienceYears(employment);

    // §4.3 "regression on role seniority over time". Needs two roles to have a slope.
    if (employment.length >= 2) {
      const origin = employment[0]?.startDate.getTime() ?? 0;
      const slope = olsSlope(
        employment.map((role) => ({
          x: (role.startDate.getTime() - origin) / (1000 * 60 * 60 * 24 * 365.25),
          y: role.seniorityRank,
        })),
      );
      if (slope !== null) {
        values.career_progression_slope = slope;
      }
    }

    // Salary trajectory: prefer the CV's own employment salary history, fall back to the
    // stated past salary against the earliest recorded one.
    const salariedRoles = employment.filter(
      (role): role is typeof role & { salaryNpr: number } => role.salaryNpr !== null,
    );
    if (salariedRoles.length >= 2) {
      const first = salariedRoles[0];
      const last = salariedRoles.at(-1);
      if (first !== undefined && last !== undefined) {
        const years = yearsBetween(first.startDate, last.startDate);
        const growth = compoundGrowthRate(first.salaryNpr, last.salaryNpr, years);
        if (growth !== null) {
          values.salary_growth_rate = growth;
        }
      }
    }

    const educationScore = EDUCATION_SCORE[resume.education.level];
    values.education_level_score = resume.education.isAbroad
      ? educationScore.intl
      : educationScore.local;

    // §4.3: international certs 5pts each, local 2pts, capped at the 20-point sub-score.
    const certificationPoints = sum(
      resume.certifications.map((cert) => (cert.isInternational ? 5 : 2)),
    );
    values.certification_score = clamp(certificationPoints, 0, 20);

    const expectedRatio =
      resume.expectedSalaryNpr === null || resume.pastSalaryNpr === null
        ? null
        : safeRatio(resume.expectedSalaryNpr, resume.pastSalaryNpr);
    if (expectedRatio !== null) {
      values.expected_to_past_salary_ratio = expectedRatio;
    }

    if (employment.length === 0) {
      flags.add('NO_EMPLOYMENT_HISTORY');
    }

    return values;
  }

  /* ---------------------------------------------------------------------- */
  /* Social (§4.4)                                                          */
  /* ---------------------------------------------------------------------- */

  private socialFeatures(input: FeatureComputationInput): Partial<Record<FeatureName, number>> {
    const { resume } = input;
    const values: Partial<Record<FeatureName, number>> = {};

    values.countries_traveled_count = resume.countriesTraveled.length;
    values.premium_visa_count = resume.premiumVisas.length;

    // §4.4 counts at most two references; take the best two.
    const referenceScores = resume.references
      .map((reference) => REFERENCE_TIER_SCORE[reference.tier])
      .sort((a, b) => b - a)
      .slice(0, MAX_SCORED_REFERENCES);
    values.reference_tier_score = mean(referenceScores) ?? 0;

    // Institutional prestige is the best employer the applicant has been associated with —
    // §4.4 frames it as network tier, and a network is cumulative, not current.
    const institutionalScores = resume.employment.map(
      (role) => INSTITUTIONAL_TIER[role.employerType],
    );
    values.institutional_tier_score =
      institutionalScores.length === 0 ? 40 : Math.max(...institutionalScores);

    // §4.4 weights owner-occupied above rented, and KYC-verified above declared.
    const residenceYears = input.yearsAtAddress ?? resume.yearsAtAddress ?? 0;
    values.residence_stability_years =
      residenceYears * RESIDENCE_STATUS_MULTIPLIER[input.residenceStatus];

    const suppliedScored = KYC_SCORED_DOCUMENTS.filter((type) =>
      input.suppliedDocuments.includes(type),
    ).length;
    values.kyc_completeness_pct =
      safeRatio(suppliedScored, KYC_SCORED_DOCUMENTS.length) ?? 0;

    // §4.4: international 5pts, national 3pts, company 1pt, capped at 25.
    const awardPoints = sum(
      resume.awards.map((award) =>
        award.scope === 'INTERNATIONAL' ? 5 : award.scope === 'NATIONAL' ? 3 : 1,
      ),
    );
    values.awards_score = clamp(awardPoints, 0, 25);

    return values;
  }

  /* ---------------------------------------------------------------------- */
  /* Behavioral (§4.5)                                                      */
  /* ---------------------------------------------------------------------- */

  private behavioralFeatures(
    input: FeatureComputationInput,
    months: readonly MonthlyAggregate[],
  ): Record<'income_stream_count' | 'discretionary_spend_ratio', number> &
    Partial<Record<FeatureName, number>> {
    const { resume } = input;
    const values: Partial<Record<FeatureName, number>> = {};

    const now = new Date();
    const tenures = resume.employment.map((role) =>
      yearsBetween(role.startDate, role.endDate ?? now),
    );
    values.avg_employer_tenure_years = mean(tenures) ?? 0;
    values.job_changes_count = Math.max(0, resume.employment.length - 1);

    // §4.5 income diversification. Counts a stream only if it is materially present —
    // a single incidental interest credit is not an income stream.
    const totalIncome = sum(months.map((month) => month.verifiedIncomeNpr));
    const streamTotals: readonly number[] = [
      sum(months.map((month) => month.salaryCreditsNpr)),
      sum(months.map((month) => month.remittanceNpr)),
      sum(months.map((month) => month.rentalIncomeNpr)),
      sum(months.map((month) => month.otherIncomeNpr)),
    ];
    const materialThreshold = totalIncome * 0.05;
    const incomeStreamCount = streamTotals.filter(
      (total) => total > 0 && total >= materialThreshold,
    ).length;

    // §4.5 repayment track record, from the statement rather than a bureau file.
    const expectedObligations = months.filter(
      (month) => month.emiPaymentsNpr > 0 || month.cardPaymentsNpr > 0,
    ).length;
    const lateEvents =
      sum(months.map((month) => month.latePaymentCount)) + countObligationGaps(input.transactions);
    const punctuality =
      expectedObligations === 0
        ? // No obligations observed is not evidence of good behaviour, but it is not
          // evidence of bad behaviour either. The manifest default (1.0) treats it as
          // neutral; the Behavioral pillar separately declines to award the sub-score.
          1
        : clamp(1 - (safeRatio(lateEvents, expectedObligations) ?? 0), 0, 1);
    values.emi_payment_punctuality = punctuality;

    const discretionaryTotal = sum(months.map((month) => month.discretionarySpendNpr));
    const discretionaryRatio = safeRatio(discretionaryTotal, totalIncome) ?? 0;
    values.discretionary_spend_ratio = discretionaryRatio;

    const totalDebits = sum(months.map((month) => month.totalDebitsNpr));
    const atmTotal = sum(months.map((month) => month.atmWithdrawalsNpr));
    values.atm_withdrawal_ratio = safeRatio(atmTotal, totalDebits) ?? 0;

    values.savings_months_count = months.filter(
      (month) => month.totalCreditsNpr > month.totalDebitsNpr,
    ).length;

    values.countries_worked_count = new Set(resume.employment.map((role) => role.country)).size;

    values.insurance_premium_active = months.some((month) => month.insurancePremiumNpr > 0) ? 1 : 0;

    const cardTotal = sum(months.map((month) => month.cardPaymentsNpr));
    values.credit_card_utilization_proxy = safeRatio(cardTotal, totalIncome) ?? 0;

    values.income_stream_count = incomeStreamCount;

    return {
      ...values,
      income_stream_count: incomeStreamCount,
      discretionary_spend_ratio: discretionaryRatio,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Application context                                                    */
  /* ---------------------------------------------------------------------- */

  private applicationFeatures(
    input: FeatureComputationInput,
    months: readonly MonthlyAggregate[],
    avgMonthlyIncome: number | null,
  ): Partial<Record<FeatureName, number>> {
    const values: Partial<Record<FeatureName, number>> = {};

    const annualIncome = avgMonthlyIncome === null ? null : avgMonthlyIncome * 12;
    const exposureRatio =
      annualIncome === null ? null : safeRatio(input.requestedAmountNpr, annualIncome);
    if (exposureRatio !== null) {
      values.requested_amount_to_income_ratio = exposureRatio;
    }

    values.tenure_months = input.tenureMonths;
    values.statement_months_available = months.length;

    return values;
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Total experience as the union of employment intervals.
 *
 * Summing each role's duration double-counts concurrent roles, which is how a consultant
 * with three simultaneous engagements acquires thirty years of experience in a decade.
 * Merging overlapping intervals first gives the figure §4.3 actually intends.
 */
function totalExperienceYears(
  employment: readonly { startDate: Date; endDate: Date | null }[],
): number {
  if (employment.length === 0) {
    return 0;
  }

  const now = Date.now();
  const intervals = employment
    .map((role) => ({
      start: role.startDate.getTime(),
      end: Math.min(role.endDate?.getTime() ?? now, now),
    }))
    .filter((interval) => Number.isFinite(interval.start) && interval.end > interval.start)
    .sort((a, b) => a.start - b.start);

  if (intervals.length === 0) {
    return 0;
  }

  let totalMs = 0;
  let currentStart = intervals[0]?.start ?? 0;
  let currentEnd = intervals[0]?.end ?? 0;

  for (const interval of intervals.slice(1)) {
    if (interval.start <= currentEnd) {
      currentEnd = Math.max(currentEnd, interval.end);
    } else {
      totalMs += currentEnd - currentStart;
      currentStart = interval.start;
      currentEnd = interval.end;
    }
  }
  totalMs += currentEnd - currentStart;

  return roundTo(totalMs / (1000 * 60 * 60 * 24 * 365.25), 2);
}
