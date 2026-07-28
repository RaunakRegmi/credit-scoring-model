/**
 * Transaction classification and recurrence detection (§3.2.1).
 *
 * Two jobs, both feeding the Financial and Behavioral pillars:
 *
 *   1. Category — what kind of money movement is this? Keyword rules over the narration,
 *      ordered so the specific beats the general. A confidence is attached to every call
 *      because "we think this is a salary" and "this line literally says SALARY" should not
 *      contribute equally to a salary-consistency score.
 *
 *   2. Recurrence — which transactions form a repeating series? This is what distinguishes
 *      a salary from a one-off transfer and an EMI from an ordinary payment, and it is the
 *      basis of the §4.2 salary-consistency and debt-service measures. A rule engine can
 *      read the word "SALARY"; only recurrence analysis can tell you it arrived in six
 *      consecutive months.
 */
import type { TxnCategory } from '@aics/contracts';

import type { ExtractedTransaction } from './document-extractor.port';

interface CategoryRule {
  readonly category: TxnCategory;
  readonly direction: 'CREDIT' | 'DEBIT' | 'ANY';
  readonly patterns: readonly RegExp[];
  /** Confidence when this rule matches. High only where the narration is unambiguous. */
  readonly confidence: number;
}

/**
 * Ordered; first match wins.
 *
 * Patterns are tuned for Nepali bank narrations — Connect IPS, fonepay, eSewa, Khalti, the
 * standard remittance corridors — alongside generic international formats.
 */
const CATEGORY_RULES: readonly CategoryRule[] = [
  // ---- Credits -----------------------------------------------------------
  {
    category: 'SALARY',
    direction: 'CREDIT',
    patterns: [
      /\bsalary\b/i,
      /\bsal[\s.]?cr\b/i,
      /\bpayroll\b/i,
      /\bwages?\b/i,
      /\bmonthly\s+(pay|remuneration)\b/i,
      /\bstaff\s+payment\b/i,
    ],
    confidence: 0.97,
  },
  {
    category: 'REMITTANCE',
    direction: 'CREDIT',
    patterns: [
      /\bremit(tance)?\b/i,
      /\b(western\s*union|moneygram|ria money|worldremit|transferwise|wise|xoom)\b/i,
      /\b(ime|prabhu|city\s*express|himal\s*remit|samsara|jme)\s*(remit)?\b/i,
      /\binward\s+(remittance|swift|telegraphic)\b/i,
      /\bforeign\s+(inward|currency\s+credit)\b/i,
    ],
    confidence: 0.94,
  },
  {
    category: 'RENTAL_INCOME',
    direction: 'CREDIT',
    patterns: [/\brent(al)?\s*(income|received|collection)\b/i, /\bhouse\s+rent\s+cr\b/i, /\btenant\b/i],
    confidence: 0.88,
  },
  {
    category: 'INTEREST_INCOME',
    direction: 'CREDIT',
    patterns: [/\binterest\s*(credit|earned|paid|capitalis)/i, /\bint\.?\s*cr\b/i, /\bfd\s+interest\b/i],
    confidence: 0.95,
  },
  {
    category: 'BUSINESS_INCOME',
    direction: 'CREDIT',
    patterns: [
      /\b(invoice|billing|professional\s+fee|consult(ing|ancy)\s+fee|commission|sales\s+proceeds)\b/i,
      /\bmerchant\s+settlement\b/i,
    ],
    confidence: 0.8,
  },

  // ---- Debits ------------------------------------------------------------
  {
    category: 'BOUNCE_PENALTY',
    direction: 'ANY',
    patterns: [
      /\b(cheque|check)\s*(return|bounce|dishonour|dishonor)/i,
      /\breturn(ed)?\s*(cheque|check|unpaid)/i,
      /\b(nsf|insufficient\s+fund)/i,
      /\bbounce\s*charge/i,
      /\becs\s+return/i,
    ],
    confidence: 0.96,
  },
  {
    category: 'LOAN_EMI',
    direction: 'DEBIT',
    patterns: [
      /\bemi\b/i,
      /\b(loan|advance)\s*(repay|instal|instl|payment|recovery|deduction)/i,
      /\bequated\s+monthly/i,
      /\b(auto|vehicle|home|housing|education|personal)\s+loan\b/i,
      /\bprincipal\s*(&|and)?\s*interest\b/i,
      /\bhire\s*purchase\b/i,
    ],
    confidence: 0.93,
  },
  {
    category: 'CREDIT_CARD_PAYMENT',
    direction: 'DEBIT',
    patterns: [
      /\b(credit\s*card|cc)\s*(payment|bill|settlement|dues?)/i,
      /\bcard\s+payment\b/i,
      /\b(visa|mastercard|amex)\s*(card)?\s*(payment|bill)/i,
    ],
    confidence: 0.92,
  },
  {
    category: 'INSURANCE_PREMIUM',
    direction: 'DEBIT',
    patterns: [
      /\b(insurance|assurance)\b/i,
      /\bpremium\s*(payment|debit)?\b/i,
      /\b(life|health|term|motor|vehicle)\s+(insurance|policy)\b/i,
      /\b(nlic|nepal life|met\s?life|prabhu insurance|shikhar insurance)\b/i,
    ],
    confidence: 0.9,
  },
  {
    category: 'ATM_WITHDRAWAL',
    direction: 'DEBIT',
    patterns: [/\batm\b/i, /\bcash\s*(withdraw|wdl|wd)\b/i, /\bcw\s*-?\s*atm\b/i, /\bcardless\s+withdrawal\b/i],
    confidence: 0.96,
  },
  {
    category: 'UTILITY',
    direction: 'DEBIT',
    patterns: [
      /\b(electricity|nea\b|water|khanepani|internet|broadband|wifi|telephone|landline|mobile\s+topup|recharge)\b/i,
      /\b(ntc|ncell|smart\s?cell|worldlink|vianet|subisu|classic\s?tech)\b/i,
      /\b(gas|lpg|cable|dish\s?home|netflix|spotify)\b/i,
      /\butility\s+(bill|payment)\b/i,
    ],
    confidence: 0.87,
  },
  {
    category: 'RENT_PAID',
    direction: 'DEBIT',
    patterns: [/\b(house|room|flat|apartment|office)\s+rent\b/i, /\brent\s*(paid|payment|dr)\b/i],
    confidence: 0.85,
  },
  {
    category: 'GROCERY_ESSENTIAL',
    direction: 'DEBIT',
    patterns: [
      /\b(grocery|groceries|supermarket|kirana|mart|bhatbhateni|big\s?mart|salesberry)\b/i,
      /\b(pharmacy|medical|hospital|clinic|doctor|lab\s+test|diagnostic)\b/i,
      /\b(school|college|tuition|university)\s*(fee|payment)\b/i,
      /\bfuel|petrol|diesel|petroleum\b/i,
    ],
    confidence: 0.82,
  },
  {
    category: 'DISCRETIONARY',
    direction: 'DEBIT',
    patterns: [
      /\b(restaurant|cafe|coffee|bar|pub|hotel|resort|foodmandu|pathao\s+food|bhojdeals)\b/i,
      /\b(daraz|sastodeal|amazon|aliexpress|shopping|apparel|fashion|boutique|jewel)\b/i,
      /\b(cinema|movie|qfx|entertainment|gaming|casino|lottery)\b/i,
      /\b(airline|flight|travel|tour|trek|booking\.com|ticket)\b/i,
      /\b(salon|spa|gym|fitness)\b/i,
    ],
    confidence: 0.78,
  },
  {
    category: 'BANK_CHARGE',
    direction: 'DEBIT',
    patterns: [
      /\b(service\s+charge|sms\s+charge|annual\s+fee|maintenance\s+fee|ledger\s+fee|stamp\s+duty)\b/i,
      /\b(commission|comm\.?)\s*(charge|dr)?\b/i,
      /\btds\b/i,
      /\bcheque\s+book\s+(charge|fee)\b/i,
    ],
    confidence: 0.9,
  },
  {
    category: 'TRANSFER_OUT',
    direction: 'DEBIT',
    patterns: [
      /\b(transfer|trf|fund\s+transfer|ft\b|neft|rtgs|imps|connect\s*ips|fonepay|esewa|khalti|ips)\b/i,
      /\bto\s+a\/?c\b/i,
    ],
    confidence: 0.72,
  },
];

export interface Classification {
  readonly category: TxnCategory;
  readonly confidence: number;
}

/**
 * Classifies one transaction from its narration and direction.
 *
 * Falls back to `OTHER_CREDIT`/`OTHER_DEBIT` at low confidence rather than guessing. An
 * unclassified credit must not inflate verified income, and the feature layer treats these
 * as exactly what they are: money we cannot account for.
 */
export function classifyTransaction(description: string, isCredit: boolean): Classification {
  const narration = description.trim();
  const direction = isCredit ? 'CREDIT' : 'DEBIT';

  if (narration === '') {
    return { category: isCredit ? 'OTHER_CREDIT' : 'OTHER_DEBIT', confidence: 0.3 };
  }

  for (const rule of CATEGORY_RULES) {
    if (rule.direction !== 'ANY' && rule.direction !== direction) {
      continue;
    }
    if (rule.patterns.some((pattern) => pattern.test(narration))) {
      return { category: rule.category, confidence: rule.confidence };
    }
  }

  return { category: isCredit ? 'OTHER_CREDIT' : 'OTHER_DEBIT', confidence: 0.4 };
}

/**
 * Extracts a counterparty from the narration.
 *
 * Used to group recurring series: the same landlord, lender or insurer appearing month
 * after month is what makes a credit "consistent" in the §4.2 sense.
 */
export function extractCounterparty(description: string): string | null {
  const cleaned = description
    .replace(/\b\d{6,}\b/g, ' ') // Reference and account numbers.
    .replace(/\b(txn|ref|utr|rrn|id|no)[.:# ]*\w+/gi, ' ')
    .replace(/\b\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}\b/g, ' ')
    .replace(/[^\w\s&.-]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (cleaned.length < 3) {
    return null;
  }

  // The first few meaningful words are the counterparty in nearly every bank's format.
  const words = cleaned
    .split(/\s+/)
    .filter((word) => word.length > 1 && !/^\d+$/.test(word))
    .slice(0, 4);

  return words.length === 0 ? null : words.join(' ').toUpperCase().slice(0, 120);
}

/* -------------------------------------------------------------------------- */
/* Recurrence detection                                                        */
/* -------------------------------------------------------------------------- */

export interface RecurrenceAssignment {
  /** Index into the input array. */
  readonly index: number;
  readonly isRecurring: boolean;
  readonly groupId: string | null;
}

interface Candidate {
  readonly index: number;
  readonly monthKey: string;
  readonly amount: number;
  readonly isCredit: boolean;
  readonly category: TxnCategory;
  readonly counterparty: string;
}

/** Amounts within this fraction of each other count as "the same" recurring payment. */
const AMOUNT_TOLERANCE = 0.15;
/** A series needs at least this many distinct months to be recurring rather than repeated. */
const MIN_MONTHS_FOR_RECURRENCE = 3;

/**
 * Groups transactions into recurring series.
 *
 * Two transactions belong to the same series when they share a counterparty and category
 * and their amounts are within tolerance. The series is recurring only if it appears in at
 * least three distinct calendar months — a tolerance, because real salaries get revised
 * and real EMIs change with a rate reset, and a strict equality test would classify a
 * perfectly regular salary as three unrelated payments the moment someone got a raise.
 */
export function detectRecurringSeries(
  transactions: readonly ExtractedTransaction[],
  classifications: readonly Classification[],
): RecurrenceAssignment[] {
  const assignments: RecurrenceAssignment[] = transactions.map((_, index) => ({
    index,
    isRecurring: false,
    groupId: null,
  }));

  const candidates: Candidate[] = [];
  for (const [index, txn] of transactions.entries()) {
    const isCredit = txn.creditNpr > 0;
    const amount = isCredit ? txn.creditNpr : txn.debitNpr;
    if (amount <= 0) {
      continue;
    }
    const counterparty = extractCounterparty(txn.description);
    if (counterparty === null) {
      continue;
    }
    const category = classifications[index]?.category;
    if (category === undefined) {
      continue;
    }
    candidates.push({
      index,
      monthKey: `${txn.date.getUTCFullYear()}-${String(txn.date.getUTCMonth() + 1).padStart(2, '0')}`,
      amount,
      isCredit,
      category,
      counterparty,
    });
  }

  // Bucket by the stable part of the key, then split each bucket by amount similarity.
  const buckets = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.isCredit ? 'C' : 'D'}|${candidate.category}|${candidate.counterparty}`;
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, [candidate]);
    } else {
      bucket.push(candidate);
    }
  }

  let groupCounter = 0;

  for (const [key, bucket] of buckets) {
    // Within a bucket, cluster on amount. Sorting first means a single pass suffices.
    const sorted = [...bucket].sort((a, b) => a.amount - b.amount);
    let cluster: Candidate[] = [];

    const flush = (): void => {
      if (cluster.length === 0) {
        return;
      }
      const months = new Set(cluster.map((item) => item.monthKey));
      if (months.size >= MIN_MONTHS_FOR_RECURRENCE) {
        groupCounter += 1;
        const groupId = `rec-${groupCounter}-${hashKey(key)}`;
        for (const item of cluster) {
          assignments[item.index] = { index: item.index, isRecurring: true, groupId };
        }
      }
      cluster = [];
    };

    for (const candidate of sorted) {
      const reference = cluster[0];
      if (reference === undefined) {
        cluster = [candidate];
        continue;
      }
      const spread = Math.abs(candidate.amount - reference.amount) / Math.max(reference.amount, 1);
      if (spread <= AMOUNT_TOLERANCE) {
        cluster.push(candidate);
      } else {
        flush();
        cluster = [candidate];
      }
    }
    flush();
  }

  return assignments;
}

/* -------------------------------------------------------------------------- */
/* Combined pass                                                               */
/* -------------------------------------------------------------------------- */

/** A transaction with its category, counterparty and recurrence resolved. */
export interface ClassifiedTransaction extends ExtractedTransaction {
  readonly category: TxnCategory;
  readonly categoryConfidence: number;
  readonly counterparty: string | null;
  readonly isRecurring: boolean;
  readonly recurringGroupId: string | null;
}

/**
 * Classifies and links an entire statement in one pass.
 *
 * Recurrence has to be computed over the whole set rather than per row, so this is the
 * entry point the feature layer uses — it guarantees categories and recurrence groups were
 * derived from the same view of the data.
 */
export function classifyStatement(
  transactions: readonly ExtractedTransaction[],
): ClassifiedTransaction[] {
  const classifications = transactions.map((txn) =>
    classifyTransaction(txn.description, txn.creditNpr > 0),
  );
  const recurrence = detectRecurringSeries(transactions, classifications);

  return transactions.map((txn, index) => {
    const classification = classifications[index];
    const assignment = recurrence[index];
    return {
      ...txn,
      category: classification?.category ?? (txn.creditNpr > 0 ? 'OTHER_CREDIT' : 'OTHER_DEBIT'),
      categoryConfidence: classification?.confidence ?? 0.3,
      counterparty: extractCounterparty(txn.description),
      isRecurring: assignment?.isRecurring ?? false,
      recurringGroupId: assignment?.groupId ?? null,
    };
  });
}

/** Short, stable, non-cryptographic key digest for readable group ids. */
function hashKey(key: string): string {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36).slice(0, 6);
}
