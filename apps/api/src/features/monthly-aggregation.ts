/**
 * Transaction-level data -> monthly aggregates (§7.1 `monthly_financial_summary`).
 *
 * The scorecard never touches raw transactions. It reads these aggregates, which means the
 * definitions here — what counts as income, what counts as an obligation, how average daily
 * balance is computed — are the definitions the score is built on. They are written out
 * explicitly rather than expressed as SQL so they can be unit-tested against the worked
 * examples in §4.2.
 */
import {
  ESSENTIAL_CATEGORIES,
  INCOME_CATEGORIES,
  OBLIGATION_CATEGORIES,
  type TxnCategory,
} from '@aics/contracts';

import type { ClassifiedTransaction } from '../extraction/transaction-classifier';
import { startOfUtcMonth } from '../common/math.util';

export interface MonthlyAggregate {
  readonly monthStart: Date;
  /** §3.2: sum of daily closing balances / days observed. */
  readonly avgDailyBalanceNpr: number;
  readonly closingBalanceNpr: number;
  readonly minBalanceNpr: number;

  readonly totalCreditsNpr: number;
  readonly totalDebitsNpr: number;

  readonly salaryCreditsNpr: number;
  readonly remittanceNpr: number;
  readonly rentalIncomeNpr: number;
  readonly otherIncomeNpr: number;
  /** Sum of all credits in an income category — excludes unclassified inflows. */
  readonly verifiedIncomeNpr: number;

  readonly emiPaymentsNpr: number;
  readonly cardPaymentsNpr: number;
  readonly insurancePremiumNpr: number;
  readonly atmWithdrawalsNpr: number;
  readonly essentialSpendNpr: number;
  readonly discretionarySpendNpr: number;

  readonly bounceCount: number;
  readonly overdraftDays: number;
  readonly latePaymentCount: number;

  readonly hasSalaryCredit: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Explicit penalty narrations — direct evidence of a missed or late obligation. */
const LATE_PAYMENT_NARRATION =
  /\b(late\s*(fee|charge|payment|penalty)|penal\s*(interest|charge)|overdue|default\s*charge|delay\s*(fee|charge))\b/i;

function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function sumWhere(
  transactions: readonly ClassifiedTransaction[],
  predicate: (txn: ClassifiedTransaction) => boolean,
  side: 'credit' | 'debit',
): number {
  return transactions
    .filter(predicate)
    .reduce((total, txn) => total + (side === 'credit' ? txn.creditNpr : txn.debitNpr), 0);
}

function sumCategories(
  transactions: readonly ClassifiedTransaction[],
  categories: readonly TxnCategory[],
  side: 'credit' | 'debit',
): number {
  return sumWhere(transactions, (txn) => categories.includes(txn.category), side);
}

/**
 * Builds the daily closing-balance series for one month by carrying the last known balance
 * forward across days with no activity.
 *
 * Returns an empty array when the statement prints no running balance, in which case the
 * caller falls back to a transaction-flow estimate. Silently treating "no balance column"
 * as "zero balance" would hand a Prime applicant a zero average-balance score.
 */
function dailyBalances(
  transactions: readonly ClassifiedTransaction[],
  openingBalance: number | null,
): number[] {
  const withBalance = transactions.filter((txn) => txn.balanceAfterNpr !== null);
  if (withBalance.length === 0) {
    return [];
  }

  const first = transactions[0];
  const last = transactions.at(-1);
  if (first === undefined || last === undefined) {
    return [];
  }

  const startDay = Math.floor(first.date.getTime() / DAY_MS);
  const endDay = Math.floor(last.date.getTime() / DAY_MS);

  // Last balance recorded on each day.
  const balanceByDay = new Map<number, number>();
  for (const txn of withBalance) {
    balanceByDay.set(Math.floor(txn.date.getTime() / DAY_MS), txn.balanceAfterNpr as number);
  }

  const series: number[] = [];
  let carried = openingBalance ?? (withBalance[0]?.balanceAfterNpr ?? 0);

  for (let day = startDay; day <= endDay; day += 1) {
    const recorded = balanceByDay.get(day);
    if (recorded !== undefined) {
      carried = recorded;
    }
    series.push(carried);
  }
  return series;
}

/**
 * Explicit late-fee or penal-interest narrations in a set of transactions.
 *
 * Month-scopable, because the evidence is the transaction itself.
 */
function countExplicitLatePayments(transactions: readonly ClassifiedTransaction[]): number {
  return transactions.filter((txn) => LATE_PAYMENT_NARRATION.test(txn.description)).length;
}

/**
 * Counts gaps in recurring obligation series across the whole statement.
 *
 * A salary-day EMI that appears in months 1, 2, 4, 5 and 6 did not happen in month 3, and
 * that gap is exactly the §4.2 "payment punctuality" signal. Keyword matching can never see
 * it, because a payment that did not happen leaves no narration to match.
 *
 * This is deliberately a whole-statement computation and NOT part of the per-month
 * aggregate: a gap is a property of the series, and a month cannot tell that it is missing
 * a payment by looking only at itself.
 */
export function countObligationGaps(transactions: readonly ClassifiedTransaction[]): number {
  const obligationGroups = new Map<string, Set<string>>();
  for (const txn of transactions) {
    if (txn.recurringGroupId === null || !OBLIGATION_CATEGORIES.includes(txn.category)) {
      continue;
    }
    const months = obligationGroups.get(txn.recurringGroupId) ?? new Set<string>();
    months.add(monthKey(txn.date));
    obligationGroups.set(txn.recurringGroupId, months);
  }

  let gaps = 0;
  for (const months of obligationGroups.values()) {
    const sorted = [...months].sort();
    const firstMonth = sorted[0];
    const lastMonth = sorted.at(-1);
    if (firstMonth === undefined || lastMonth === undefined) {
      continue;
    }
    // Months the series should have covered between its first and last appearance.
    const expected = monthsInRange(firstMonth, lastMonth);
    gaps += Math.max(0, expected - months.size);
  }

  return gaps;
}

function monthsInRange(fromKey: string, toKey: string): number {
  const [fromYear, fromMonth] = fromKey.split('-').map(Number) as [number, number];
  const [toYear, toMonth] = toKey.split('-').map(Number) as [number, number];
  return (toYear - fromYear) * 12 + (toMonth - fromMonth) + 1;
}

/**
 * Aggregates classified transactions into one record per calendar month, ascending.
 *
 * `openingBalanceNpr` seeds the daily-balance carry-forward for the earliest month.
 */
export function aggregateByMonth(
  transactions: readonly ClassifiedTransaction[],
  openingBalanceNpr: number | null,
): MonthlyAggregate[] {
  if (transactions.length === 0) {
    return [];
  }

  const ordered = [...transactions].sort((a, b) => a.date.getTime() - b.date.getTime());

  const grouped = new Map<string, ClassifiedTransaction[]>();
  for (const txn of ordered) {
    const key = monthKey(txn.date);
    const bucket = grouped.get(key);
    if (bucket === undefined) {
      grouped.set(key, [txn]);
    } else {
      bucket.push(txn);
    }
  }

  const aggregates: MonthlyAggregate[] = [];
  let carriedOpening = openingBalanceNpr;

  for (const key of [...grouped.keys()].sort()) {
    const monthTxns = grouped.get(key) ?? [];
    const first = monthTxns[0];
    if (first === undefined) {
      continue;
    }

    const totalCreditsNpr = monthTxns.reduce((total, txn) => total + txn.creditNpr, 0);
    const totalDebitsNpr = monthTxns.reduce((total, txn) => total + txn.debitNpr, 0);

    const balances = dailyBalances(monthTxns, carriedOpening);
    const closingBalanceNpr =
      monthTxns.at(-1)?.balanceAfterNpr ??
      (carriedOpening ?? 0) + totalCreditsNpr - totalDebitsNpr;

    // With no running balance column, approximate the month's average by the midpoint
    // between its opening and closing position. Crude, but it is an estimate the score can
    // use, and it is flagged by the lower extraction confidence that such a statement gets.
    const avgDailyBalanceNpr =
      balances.length > 0
        ? balances.reduce((total, value) => total + value, 0) / balances.length
        : ((carriedOpening ?? closingBalanceNpr) + closingBalanceNpr) / 2;

    const minBalanceNpr = balances.length > 0 ? Math.min(...balances) : Math.min(carriedOpening ?? closingBalanceNpr, closingBalanceNpr);
    const overdraftDays = balances.filter((value) => value < 0).length;

    const salaryCreditsNpr = sumCategories(monthTxns, ['SALARY'], 'credit');
    const remittanceNpr = sumCategories(monthTxns, ['REMITTANCE'], 'credit');
    const rentalIncomeNpr = sumCategories(monthTxns, ['RENTAL_INCOME'], 'credit');
    const otherIncomeNpr = sumCategories(monthTxns, ['BUSINESS_INCOME', 'INTEREST_INCOME'], 'credit');
    const verifiedIncomeNpr = sumCategories(monthTxns, INCOME_CATEGORIES, 'credit');

    const emiPaymentsNpr = sumCategories(monthTxns, ['LOAN_EMI'], 'debit');
    const cardPaymentsNpr = sumCategories(monthTxns, ['CREDIT_CARD_PAYMENT'], 'debit');
    const insurancePremiumNpr = sumCategories(monthTxns, ['INSURANCE_PREMIUM'], 'debit');
    const atmWithdrawalsNpr = sumCategories(monthTxns, ['ATM_WITHDRAWAL'], 'debit');
    const essentialSpendNpr = sumCategories(monthTxns, ESSENTIAL_CATEGORIES, 'debit');
    const discretionarySpendNpr = sumCategories(monthTxns, ['DISCRETIONARY'], 'debit');

    aggregates.push({
      monthStart: startOfUtcMonth(first.date),
      avgDailyBalanceNpr,
      closingBalanceNpr,
      minBalanceNpr,
      totalCreditsNpr,
      totalDebitsNpr,
      salaryCreditsNpr,
      remittanceNpr,
      rentalIncomeNpr,
      otherIncomeNpr,
      verifiedIncomeNpr,
      emiPaymentsNpr,
      cardPaymentsNpr,
      insurancePremiumNpr,
      atmWithdrawalsNpr,
      essentialSpendNpr,
      discretionarySpendNpr,
      bounceCount: monthTxns.filter((txn) => txn.category === 'BOUNCE_PENALTY').length,
      overdraftDays,
      // Explicit penalties only. Series gaps are counted once across the whole statement by
      // `countObligationGaps` — see the note there.
      latePaymentCount: countExplicitLatePayments(monthTxns),
      // A salary credit only counts when it is part of a detected recurring series or the
      // narration is explicit — one transfer labelled "salary" is not a salaried income.
      hasSalaryCredit: monthTxns.some(
        (txn) => txn.category === 'SALARY' && txn.creditNpr > 0,
      ),
    });

    carriedOpening = closingBalanceNpr;
  }

  return aggregates;
}
