/**
 * Feature engineering, with an emphasis on the §4 edge cases the brief calls out:
 * division by zero in financial ratios, empty extraction, and thin statement history.
 *
 * The governing principle asserted throughout: missing data must never be silently converted
 * into a bad score. It raises a degraded flag, keeps the manifest default, and the decision
 * engine routes the application to a human.
 */
import { describe, expect, it } from 'vitest';
import { FEATURE_DEFINITIONS } from '@aics/contracts';

import {
  FeatureEngineeringService,
  type FeatureComputationInput,
} from '../src/features/feature-engineering.service';
import { emptyResumeExtraction, emptyStatementExtraction } from '../src/extraction/document-extractor.port';
import type { ExtractedTransaction } from '../src/extraction/document-extractor.port';
import { classifyStatement } from '../src/extraction/transaction-classifier';

const features = new FeatureEngineeringService();

function txn(
  dateIso: string,
  description: string,
  credit: number,
  debit: number,
  balance: number,
): ExtractedTransaction {
  return {
    date: new Date(`${dateIso}T00:00:00.000Z`),
    description,
    creditNpr: credit,
    debitNpr: debit,
    balanceAfterNpr: balance,
  };
}

/** Six months of a clean salaried statement. */
function salariedTransactions(): ExtractedTransaction[] {
  const rows: ExtractedTransaction[] = [];
  let balance = 150_000;
  for (let month = 1; month <= 6; month += 1) {
    const mm = String(month).padStart(2, '0');
    balance += 120_000;
    rows.push(txn(`2026-${mm}-28`, 'SALARY CREDIT - PAYROLL TRANSFER', 120_000, 0, balance));
    balance -= 20_000;
    rows.push(txn(`2026-${mm}-05`, 'BHATBHATENI SUPERMARKET GROCERY', 0, 20_000, balance));
    balance -= 15_000;
    rows.push(txn(`2026-${mm}-15`, 'AUTO LOAN EMI INSTALMENT RECOVERY', 0, 15_000, balance));
  }
  return rows;
}

function input(overrides: Partial<FeatureComputationInput> = {}): FeatureComputationInput {
  const transactions = classifyStatement(salariedTransactions());
  return {
    productType: 'PERSONAL_LOAN',
    requestedAmountNpr: 500_000,
    tenureMonths: 36,
    resume: emptyResumeExtraction(),
    statement: { ...emptyStatementExtraction(), openingBalanceNpr: 150_000 },
    transactions,
    suppliedDocuments: ['RESUME', 'BANK_STATEMENT'],
    residenceStatus: 'RENTED',
    yearsAtAddress: 2,
    resumeConfidence: 0.9,
    statementConfidence: 0.9,
    minConfidence: 0.85,
    ...overrides,
  };
}

/* ========================================================================== */
/* Division by zero — the headline edge case                                  */
/* ========================================================================== */

describe('division by zero in financial ratios', () => {
  it('never emits a non-finite value for any feature', () => {
    const result = features.computeFeatures(input());
    for (const [name, value] of Object.entries(result.features)) {
      expect(Number.isFinite(value), `${name} = ${value}`).toBe(true);
    }
  });

  it('flags INSUFFICIENT_INCOME_DATA when obligations exist but income cannot be verified', () => {
    // EMI debits with no recognisable income credits at all: DSR is undefined, not infinite.
    const rows: ExtractedTransaction[] = [];
    let balance = 80_000;
    for (let month = 1; month <= 6; month += 1) {
      const mm = String(month).padStart(2, '0');
      balance -= 15_000;
      rows.push(txn(`2026-${mm}-15`, 'AUTO LOAN EMI INSTALMENT RECOVERY', 0, 15_000, balance));
    }

    const result = features.computeFeatures(
      input({ transactions: classifyStatement(rows), statement: { ...emptyStatementExtraction(), openingBalanceNpr: 80_000 } }),
    );

    expect(result.derived.debtServiceRatio).toBeNull();
    expect(result.degradedFlags).toContain('INSUFFICIENT_INCOME_DATA');
    // The vector keeps the manifest default rather than a fabricated worst case.
    expect(result.features.dsr).toBe(FEATURE_DEFINITIONS.dsr.default);
  });

  it('keeps the manifest default rather than substituting a worst-case value', () => {
    const result = features.computeFeatures(input({ transactions: [] }));
    expect(result.features.dsr).toBe(FEATURE_DEFINITIONS.dsr.default);
    expect(result.features.discretionary_spend_ratio).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(result.features.savings_rate)).toBe(true);
  });

  it('computes a real DSR when both sides are observable', () => {
    const result = features.computeFeatures(input());
    // 15,000 EMI against 120,000 salary = 12.5%.
    expect(result.derived.debtServiceRatio).toBeCloseTo(0.125, 3);
    expect(result.features.dsr).toBeCloseTo(0.125, 3);
  });
});

/* ========================================================================== */
/* Empty and thin extraction                                                  */
/* ========================================================================== */

describe('empty extraction', () => {
  it('flags an empty statement without throwing', () => {
    const result = features.computeFeatures(input({ transactions: [] }));
    expect(result.degradedFlags).toContain('STATEMENT_EXTRACTION_EMPTY');
    expect(result.degradedFlags).toContain('NO_BANK_ACCOUNT');
    expect(result.degradedFlags).toContain('INSUFFICIENT_STATEMENT_HISTORY');
  });

  it('flags an empty resume', () => {
    const result = features.computeFeatures(input({ resume: emptyResumeExtraction(['resume']) }));
    expect(result.degradedFlags).toContain('RESUME_EXTRACTION_EMPTY');
    expect(result.degradedFlags).toContain('NO_EMPLOYMENT_HISTORY');
  });

  it('flags low extraction confidence against the policy floor', () => {
    const result = features.computeFeatures(
      input({ resumeConfidence: 0.4, statementConfidence: 0.9, minConfidence: 0.85 }),
    );
    expect(result.degradedFlags).toContain('LOW_EXTRACTION_CONFIDENCE');
  });

  it('produces a complete, valid vector even with no data at all', () => {
    const result = features.computeFeatures(
      input({
        transactions: [],
        resume: emptyResumeExtraction(),
        resumeConfidence: 0,
        statementConfidence: 0,
      }),
    );
    expect(Object.keys(result.features).sort()).toEqual(Object.keys(FEATURE_DEFINITIONS).sort());
    for (const value of Object.values(result.features)) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });
});

describe('thin statement history', () => {
  it('flags fewer than six months', () => {
    const rows: ExtractedTransaction[] = [];
    let balance = 100_000;
    for (let month = 1; month <= 3; month += 1) {
      const mm = String(month).padStart(2, '0');
      balance += 100_000;
      rows.push(txn(`2026-${mm}-28`, 'SALARY CREDIT - PAYROLL TRANSFER', 100_000, 0, balance));
    }
    const result = features.computeFeatures(input({ transactions: classifyStatement(rows) }));
    expect(result.degradedFlags).toContain('INSUFFICIENT_STATEMENT_HISTORY');
    expect(result.features.statement_months_available).toBe(3);
  });

  it('does not flag a full six months', () => {
    const result = features.computeFeatures(input());
    expect(result.degradedFlags).not.toContain('INSUFFICIENT_STATEMENT_HISTORY');
    expect(result.features.statement_months_available).toBe(6);
  });

  it('scores only the most recent six months when more history is supplied', () => {
    const rows: ExtractedTransaction[] = [];
    let balance = 100_000;
    for (let month = 1; month <= 12; month += 1) {
      const mm = String(month).padStart(2, '0');
      balance += 100_000;
      rows.push(txn(`2026-${mm}-28`, 'SALARY CREDIT - PAYROLL TRANSFER', 100_000, 0, balance));
    }
    const result = features.computeFeatures(input({ transactions: classifyStatement(rows) }));
    expect(result.features.statement_months_available).toBe(6);
    expect(result.monthlyAggregates).toHaveLength(6);
  });
});

/* ========================================================================== */
/* Financial features                                                         */
/* ========================================================================== */

describe('financial features', () => {
  it('detects salary consistency across all six months', () => {
    const result = features.computeFeatures(input());
    expect(result.features.salary_consistency_months).toBe(6);
    expect(result.derived.salaryConsistencyMonths).toBe(6);
  });

  it('counts bounces and late-payment penalties', () => {
    const rows = salariedTransactions();
    rows.push(txn('2026-03-19', 'CHEQUE RETURN - INSUFFICIENT FUNDS', 0, 590, 100_000));
    rows.push(txn('2026-04-19', 'LATE PAYMENT CHARGE - PENAL INTEREST', 0, 850, 99_000));

    const result = features.computeFeatures(input({ transactions: classifyStatement(rows) }));
    expect(result.features.bounce_count_6m).toBe(1);
    expect(result.features.late_payment_count_6m).toBeGreaterThanOrEqual(1);
  });

  it('counts a gap in a recurring obligation series as a missed payment', () => {
    // An EMI present in five of six months. The gap leaves no transaction to keyword-match, so
    // only series analysis can see it.
    const rows: ExtractedTransaction[] = [];
    let balance = 200_000;
    for (let month = 1; month <= 6; month += 1) {
      const mm = String(month).padStart(2, '0');
      balance += 120_000;
      rows.push(txn(`2026-${mm}-28`, 'SALARY CREDIT - PAYROLL TRANSFER', 120_000, 0, balance));
      if (month !== 4) {
        balance -= 15_000;
        rows.push(txn(`2026-${mm}-15`, 'AUTO LOAN EMI RECOVERY ACME FINANCE', 0, 15_000, balance));
      }
    }

    const result = features.computeFeatures(input({ transactions: classifyStatement(rows) }));
    expect(result.features.late_payment_count_6m).toBeGreaterThanOrEqual(1);
  });

  it('counts distinct material income streams', () => {
    const rows: ExtractedTransaction[] = [];
    let balance = 100_000;
    for (let month = 1; month <= 6; month += 1) {
      const mm = String(month).padStart(2, '0');
      balance += 90_000;
      rows.push(txn(`2026-${mm}-28`, 'SALARY CREDIT - PAYROLL TRANSFER', 90_000, 0, balance));
      balance += 30_000;
      rows.push(txn(`2026-${mm}-08`, 'IME REMIT INWARD REMITTANCE', 30_000, 0, balance));
      balance += 25_000;
      rows.push(txn(`2026-${mm}-04`, 'RENTAL INCOME RECEIVED - TENANT', 25_000, 0, balance));
    }
    const result = features.computeFeatures(input({ transactions: classifyStatement(rows) }));
    expect(result.features.income_stream_count).toBe(3);
  });

  it('ignores an immaterial income trickle when counting streams', () => {
    const rows: ExtractedTransaction[] = [];
    let balance = 100_000;
    for (let month = 1; month <= 6; month += 1) {
      const mm = String(month).padStart(2, '0');
      balance += 120_000;
      rows.push(txn(`2026-${mm}-28`, 'SALARY CREDIT - PAYROLL TRANSFER', 120_000, 0, balance));
      balance += 40;
      rows.push(txn(`2026-${mm}-30`, 'INTEREST CREDIT', 40, 0, balance));
    }
    const result = features.computeFeatures(input({ transactions: classifyStatement(rows) }));
    // NPR 40 a month is not a second income stream.
    expect(result.features.income_stream_count).toBe(1);
  });
});

/* ========================================================================== */
/* Professional features                                                      */
/* ========================================================================== */

describe('professional features', () => {
  it('unions overlapping employment rather than double-counting concurrent roles', () => {
    const resume = {
      ...emptyResumeExtraction(),
      employment: [
        {
          employerName: 'Alpha Ltd',
          employerType: 'CORPORATE' as const,
          title: 'Consultant',
          seniorityRank: 3,
          startDate: new Date(Date.UTC(2020, 0, 1)),
          endDate: new Date(Date.UTC(2024, 0, 1)),
          isCurrent: false,
          salaryNpr: 100_000,
          country: 'NP',
        },
        {
          // Fully concurrent with the first role.
          employerName: 'Beta Pvt Ltd',
          employerType: 'SME' as const,
          title: 'Advisor',
          seniorityRank: 3,
          startDate: new Date(Date.UTC(2020, 0, 1)),
          endDate: new Date(Date.UTC(2024, 0, 1)),
          isCurrent: false,
          salaryNpr: 50_000,
          country: 'NP',
        },
      ],
    };

    const result = features.computeFeatures(input({ resume }));
    // Four calendar years, not eight.
    expect(result.features.total_experience_years).toBeGreaterThan(3.9);
    expect(result.features.total_experience_years).toBeLessThan(4.2);
  });

  it('fits a positive career progression slope for a rising career', () => {
    const resume = {
      ...emptyResumeExtraction(),
      employment: [
        {
          employerName: 'Alpha Bank',
          employerType: 'COMMERCIAL_BANK' as const,
          title: 'Officer',
          seniorityRank: 2,
          startDate: new Date(Date.UTC(2016, 0, 1)),
          endDate: new Date(Date.UTC(2020, 0, 1)),
          isCurrent: false,
          salaryNpr: 60_000,
          country: 'NP',
        },
        {
          employerName: 'Beta Bank',
          employerType: 'COMMERCIAL_BANK' as const,
          title: 'Senior Manager',
          seniorityRank: 6,
          startDate: new Date(Date.UTC(2020, 0, 1)),
          endDate: null,
          isCurrent: true,
          salaryNpr: 180_000,
          country: 'NP',
        },
      ],
    };

    const result = features.computeFeatures(input({ resume }));
    expect(result.features.career_progression_slope).toBeGreaterThan(0);
    expect(result.features.salary_growth_rate).toBeGreaterThan(0);
    // Employer tier reflects the CURRENT employer.
    expect(result.features.employer_tier_score).toBe(95);
  });

  it('leaves the slope at its neutral default for a single role', () => {
    const resume = {
      ...emptyResumeExtraction(),
      employment: [
        {
          employerName: 'Solo Corp',
          employerType: 'CORPORATE' as const,
          title: 'Analyst',
          seniorityRank: 2,
          startDate: new Date(Date.UTC(2023, 0, 1)),
          endDate: null,
          isCurrent: true,
          salaryNpr: 70_000,
          country: 'NP',
        },
      ],
    };
    const result = features.computeFeatures(input({ resume }));
    expect(result.features.career_progression_slope).toBe(
      FEATURE_DEFINITIONS.career_progression_slope.default,
    );
  });
});

/* ========================================================================== */
/* Social features                                                            */
/* ========================================================================== */

describe('social features', () => {
  it('computes KYC completeness from the four scored documents', () => {
    const all = features.computeFeatures(
      input({ suppliedDocuments: ['NID_FRONT', 'PASSPORT', 'PAN_CARD', 'ADDRESS_PROOF'] }),
    );
    expect(all.features.kyc_completeness_pct).toBe(1);

    const half = features.computeFeatures(input({ suppliedDocuments: ['NID_FRONT', 'PAN_CARD'] }));
    expect(half.features.kyc_completeness_pct).toBe(0.5);

    const none = features.computeFeatures(input({ suppliedDocuments: ['RESUME'] }));
    expect(none.features.kyc_completeness_pct).toBe(0);
  });

  it('weights residence stability by tenure type — owned above rented', () => {
    const owned = features.computeFeatures(input({ residenceStatus: 'OWNED', yearsAtAddress: 4 }));
    const rented = features.computeFeatures(input({ residenceStatus: 'RENTED', yearsAtAddress: 4 }));
    const undeclared = features.computeFeatures(
      input({ residenceStatus: 'UNDECLARED', yearsAtAddress: 4 }),
    );

    expect(owned.features.residence_stability_years).toBeGreaterThan(
      rented.features.residence_stability_years,
    );
    expect(rented.features.residence_stability_years).toBeGreaterThan(
      undeclared.features.residence_stability_years,
    );
  });
});

/* ========================================================================== */
/* Versioning                                                                 */
/* ========================================================================== */

describe('feature set version', () => {
  it('stamps the manifest version on every computation', () => {
    const result = features.computeFeatures(input());
    expect(result.featureSetVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
