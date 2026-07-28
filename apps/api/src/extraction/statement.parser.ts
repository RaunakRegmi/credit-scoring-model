/**
 * Bank statement text -> `StatementExtraction` (§3.2).
 *
 * Handles the two shapes a statement actually arrives in:
 *
 *   · CSV / TSV — a header row naming the columns. Reliable, so it is tried first and its
 *     column mapping is flexible about naming (`Txn Date`, `Value Date`, `Date`, …).
 *
 *   · Tabular PDF text — fixed-order columns flattened into lines by the text layer. Parsed
 *     positionally: a leading date, a narration, then the trailing numbers.
 *
 * The hard part is not finding numbers, it is deciding which number is the debit, which is
 * the credit and which is the running balance. Statements variously print two amount
 * columns plus a balance, one signed amount plus a balance, or an amount with a separate
 * Dr/Cr marker. All three are handled below, and where the layout is genuinely ambiguous we
 * use the balance delta to decide — the arithmetic is unambiguous even when the columns are
 * not.
 */
import {
  type ExtractedTransaction,
  type StatementExtraction,
} from './document-extractor.port';
import { normaliseLines, parseAmount, parseDate } from './text-extraction.util';

/* -------------------------------------------------------------------------- */
/* Column identification                                                       */
/* -------------------------------------------------------------------------- */

type ColumnRole =
  | 'DATE'
  | 'VALUE_DATE'
  | 'DESCRIPTION'
  | 'DEBIT'
  | 'CREDIT'
  | 'AMOUNT'
  | 'DR_CR'
  | 'BALANCE'
  | 'REFERENCE'
  | 'IGNORE';

const COLUMN_PATTERNS: readonly { role: ColumnRole; pattern: RegExp }[] = [
  { role: 'VALUE_DATE', pattern: /^(value\s*date|val\s*date|posting\s*date)$/i },
  { role: 'DATE', pattern: /^(txn\s*date|transaction\s*date|tran\s*date|date|trans\s*date)$/i },
  {
    role: 'DESCRIPTION',
    pattern: /^(description|narration|particulars?|details?|remarks?|transaction\s*details?)$/i,
  },
  { role: 'DEBIT', pattern: /^(debit|withdrawal|withdrawals?|dr|paid\s*out|amount\s*\(?dr\)?)$/i },
  { role: 'CREDIT', pattern: /^(credit|deposit|deposits?|cr|paid\s*in|amount\s*\(?cr\)?)$/i },
  { role: 'DR_CR', pattern: /^(dr\/?cr|type|txn\s*type|debit\/?credit|indicator)$/i },
  { role: 'AMOUNT', pattern: /^(amount|txn\s*amount|transaction\s*amount|value)$/i },
  { role: 'BALANCE', pattern: /^(balance|running\s*balance|closing\s*balance|bal|balance\s*after)$/i },
  { role: 'REFERENCE', pattern: /^(ref(erence)?(\s*no\.?)?|cheque\s*no\.?|instrument|utr|voucher)$/i },
];

function identifyColumn(header: string): ColumnRole {
  const cleaned = header.replace(/[_\-.]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  for (const { role, pattern } of COLUMN_PATTERNS) {
    if (pattern.test(cleaned)) {
      return role;
    }
  }
  return 'IGNORE';
}

/** Splits a delimited line, honouring double quotes so narrations may contain the delimiter. */
function splitDelimited(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      // A doubled quote inside a quoted cell is an escaped quote.
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === delimiter && !inQuotes) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

/** Picks the delimiter by consistency across lines, not just frequency on one. */
function detectDelimiter(lines: readonly string[]): string | null {
  const candidates = [',', '\t', ';', '|'];
  let best: { delimiter: string; score: number } | null = null;

  for (const delimiter of candidates) {
    const counts = lines
      .slice(0, 20)
      .map((line) => splitDelimited(line, delimiter).length)
      .filter((count) => count > 1);

    if (counts.length < 2) {
      continue;
    }
    // A real delimiter yields the same column count on nearly every row.
    const modal = counts.sort(
      (a, b) =>
        counts.filter((count) => count === b).length - counts.filter((count) => count === a).length,
    )[0];
    if (modal === undefined || modal < 3) {
      continue;
    }
    const consistency = counts.filter((count) => count === modal).length / counts.length;
    const score = consistency * modal;
    if (best === null || score > best.score) {
      best = { delimiter, score };
    }
  }

  return best !== null && best.score >= 2.4 ? best.delimiter : null;
}

/* -------------------------------------------------------------------------- */
/* Amount resolution                                                           */
/* -------------------------------------------------------------------------- */

interface ResolvedAmounts {
  readonly debitNpr: number;
  readonly creditNpr: number;
}

/**
 * Decides debit vs credit for one row.
 *
 * Priority: explicit debit/credit columns, then an amount plus a Dr/Cr marker, then a
 * signed amount, then — as a last resort — the direction implied by the change in running
 * balance. That last case is what makes single-amount-column statements parseable at all.
 */
function resolveAmounts(
  debit: number | null,
  credit: number | null,
  amount: number | null,
  drCrMarker: string | null,
  balance: number | null,
  previousBalance: number | null,
): ResolvedAmounts | null {
  // Separate columns — the common, unambiguous case.
  if (debit !== null && debit > 0) {
    return { debitNpr: debit, creditNpr: 0 };
  }
  if (credit !== null && credit > 0) {
    return { debitNpr: 0, creditNpr: credit };
  }

  if (amount !== null && amount !== 0) {
    const magnitude = Math.abs(amount);

    if (drCrMarker !== null) {
      if (/^(d|dr|debit|w|withdrawal)/i.test(drCrMarker)) {
        return { debitNpr: magnitude, creditNpr: 0 };
      }
      if (/^(c|cr|credit|dep|deposit)/i.test(drCrMarker)) {
        return { debitNpr: 0, creditNpr: magnitude };
      }
    }

    // A signed amount is self-describing.
    if (amount < 0) {
      return { debitNpr: magnitude, creditNpr: 0 };
    }

    // Unsigned with no marker: infer from the balance movement.
    if (balance !== null && previousBalance !== null) {
      const delta = balance - previousBalance;
      // Only trust the delta if it matches the amount; otherwise the statement has rows
      // we did not parse and the inference would be wrong.
      if (Math.abs(Math.abs(delta) - magnitude) <= Math.max(1, magnitude * 0.01)) {
        return delta < 0
          ? { debitNpr: magnitude, creditNpr: 0 }
          : { debitNpr: 0, creditNpr: magnitude };
      }
    }

    // Positive, unmarked, unverifiable — treat as a credit, which is the convention when a
    // statement prints a single unsigned "Amount" column alongside a Deposit-style header.
    return { debitNpr: 0, creditNpr: magnitude };
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Delimited parsing                                                           */
/* -------------------------------------------------------------------------- */

interface ParseOutcome {
  readonly transactions: ExtractedTransaction[];
  readonly rowsSeen: number;
  readonly rowsParsed: number;
}

function parseDelimited(lines: readonly string[], delimiter: string): ParseOutcome | null {
  // Find the header: the first row where at least a date and one amount column resolve.
  let headerIndex = -1;
  let roles: ColumnRole[] = [];

  for (let index = 0; index < Math.min(lines.length, 30); index += 1) {
    const cells = splitDelimited(lines[index] ?? '', delimiter);
    if (cells.length < 3) {
      continue;
    }
    const candidate = cells.map(identifyColumn);
    const hasDate = candidate.includes('DATE') || candidate.includes('VALUE_DATE');
    const hasAmount =
      candidate.includes('DEBIT') || candidate.includes('CREDIT') || candidate.includes('AMOUNT');
    if (hasDate && hasAmount) {
      headerIndex = index;
      roles = candidate;
      break;
    }
  }

  if (headerIndex === -1) {
    return null;
  }

  const indexOf = (role: ColumnRole): number => roles.indexOf(role);
  const dateIndex = indexOf('DATE') !== -1 ? indexOf('DATE') : indexOf('VALUE_DATE');
  const descriptionIndex = indexOf('DESCRIPTION');
  const debitIndex = indexOf('DEBIT');
  const creditIndex = indexOf('CREDIT');
  const amountIndex = indexOf('AMOUNT');
  const drCrIndex = indexOf('DR_CR');
  const balanceIndex = indexOf('BALANCE');
  const referenceIndex = indexOf('REFERENCE');

  const transactions: ExtractedTransaction[] = [];
  let rowsSeen = 0;
  let previousBalance: number | null = null;

  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    const cells = splitDelimited(raw, delimiter);
    if (cells.length < 2 || cells.every((cell) => cell === '')) {
      continue;
    }

    const cell = (position: number): string => (position >= 0 ? (cells[position] ?? '') : '');

    const date = parseDate(cell(dateIndex));
    if (date === null) {
      // Statement footers ("Closing balance", page markers) land here; not an error.
      continue;
    }
    rowsSeen += 1;

    const balance = balanceIndex >= 0 ? parseAmount(cell(balanceIndex)) : null;
    const amounts = resolveAmounts(
      debitIndex >= 0 ? parseAmount(cell(debitIndex)) : null,
      creditIndex >= 0 ? parseAmount(cell(creditIndex)) : null,
      amountIndex >= 0 ? parseAmount(cell(amountIndex)) : null,
      drCrIndex >= 0 ? cell(drCrIndex) || null : null,
      balance,
      previousBalance,
    );

    if (amounts === null) {
      continue;
    }

    const descriptionParts = [cell(descriptionIndex), cell(referenceIndex)].filter(
      (part) => part !== '',
    );
    const description =
      descriptionParts.length > 0
        ? descriptionParts.join(' ')
        : // No description column: use whatever non-numeric cells exist.
          cells
            .filter((value, position) => position !== dateIndex && !/^[\d,.\-()]+$/.test(value))
            .join(' ')
            .trim();

    transactions.push({
      date,
      description: description.slice(0, 500),
      debitNpr: amounts.debitNpr,
      creditNpr: amounts.creditNpr,
      balanceAfterNpr: balance,
    });

    if (balance !== null) {
      previousBalance = balance;
    }
  }

  return { transactions, rowsSeen, rowsParsed: transactions.length };
}

/* -------------------------------------------------------------------------- */
/* Positional (PDF text) parsing                                               */
/* -------------------------------------------------------------------------- */

/** A leading date, then narration, then one to three trailing numbers. */
const POSITIONAL_ROW =
  /^(\d{1,4}[/\-.]\d{1,2}[/\-.]\d{2,4}|\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{2,4}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})\s+(.*?)\s+((?:-?[\d,]+(?:\.\d{1,2})?\s*){1,3})$/;

function parsePositional(lines: readonly string[]): ParseOutcome {
  const transactions: ExtractedTransaction[] = [];
  let rowsSeen = 0;
  let previousBalance: number | null = null;

  for (const line of lines) {
    const match = POSITIONAL_ROW.exec(line);
    if (match === null) {
      continue;
    }

    const date = parseDate(match[1] ?? '');
    if (date === null) {
      continue;
    }
    rowsSeen += 1;

    const description = (match[2] ?? '').trim();
    const numbers = (match[3] ?? '')
      .trim()
      .split(/\s+/)
      .map((token) => parseAmount(token))
      .filter((value): value is number => value !== null);

    if (numbers.length === 0) {
      continue;
    }

    // Interpret the trailing numbers by count:
    //   3 -> debit, credit, balance (one of the first two is zero/blank)
    //   2 -> amount, balance
    //   1 -> amount only
    let amounts: ResolvedAmounts | null = null;
    let balance: number | null = null;

    if (numbers.length >= 3) {
      const [first, second, third] = numbers as [number, number, number];
      balance = third;
      amounts =
        first > 0
          ? { debitNpr: first, creditNpr: 0 }
          : second > 0
            ? { debitNpr: 0, creditNpr: second }
            : null;
      if (amounts === null) {
        amounts = resolveAmounts(null, null, first || second, null, balance, previousBalance);
      }
    } else if (numbers.length === 2) {
      const [amount, runningBalance] = numbers as [number, number];
      balance = runningBalance;
      amounts = resolveAmounts(null, null, amount, extractDrCrMarker(description), balance, previousBalance);
    } else {
      const [amount] = numbers as [number];
      amounts = resolveAmounts(null, null, amount, extractDrCrMarker(description), null, null);
    }

    if (amounts === null) {
      continue;
    }

    transactions.push({
      date,
      description: description.slice(0, 500),
      debitNpr: amounts.debitNpr,
      creditNpr: amounts.creditNpr,
      balanceAfterNpr: balance,
    });

    if (balance !== null) {
      previousBalance = balance;
    }
  }

  return { transactions, rowsSeen, rowsParsed: transactions.length };
}

/** Finds a trailing Dr/Cr marker inside a narration. */
function extractDrCrMarker(description: string): string | null {
  const match = /\b(dr|cr|debit|credit)\b\.?\s*$/i.exec(description.trim());
  return match?.[1] ?? null;
}

/* -------------------------------------------------------------------------- */
/* Header metadata                                                             */
/* -------------------------------------------------------------------------- */

function extractBankName(lines: readonly string[]): string | null {
  for (const line of lines.slice(0, 15)) {
    if (/\b(bank|financial institution|finance (company|ltd)|microfinance)\b/i.test(line)) {
      const cleaned = line.replace(/\b(statement|account|of account|passbook)\b.*$/i, '').trim();
      if (cleaned.length >= 4 && cleaned.length <= 120) {
        return cleaned;
      }
    }
  }
  return null;
}

function extractAccountNumber(lines: readonly string[]): string | null {
  const joined = lines.slice(0, 25).join('\n');
  const labelled =
    /\b(?:a\/?c|account)\s*(?:no\.?|number|#)?\s*[:\-]?\s*([0-9][0-9\s-]{6,24}[0-9])/i.exec(joined);
  const value = labelled?.[1]?.replace(/[\s-]/g, '');
  return value !== undefined && value.length >= 7 ? value : null;
}

function extractAccountType(lines: readonly string[]): string | null {
  const joined = lines.slice(0, 25).join(' ');
  const match = /\b(savings?|current|salary|fixed deposit|recurring|call|overdraft)\s*(?:account|a\/?c)?\b/i.exec(
    joined,
  );
  return match?.[1] === undefined ? null : match[1].toUpperCase().replace(/S$/, '');
}

interface Period {
  readonly from: Date | null;
  readonly to: Date | null;
}

function extractPeriod(lines: readonly string[]): Period {
  const joined = lines.slice(0, 30).join('\n');

  const range =
    /\b(?:period|statement period|from)\s*[:\-]?\s*(\S+(?:\s+\w+\s+\d{2,4})?)\s*(?:to|-|–|through|till)\s*(\S+(?:\s+\w+\s+\d{2,4})?)/i.exec(
      joined,
    );
  if (range) {
    return { from: parseDate(range[1] ?? ''), to: parseDate(range[2] ?? '') };
  }
  return { from: null, to: null };
}

function extractLabelledBalance(lines: readonly string[], labels: readonly string[]): number | null {
  for (const label of labels) {
    const pattern = new RegExp(`${label}\\D{0,30}(-?[\\d,]+(?:\\.\\d{1,2})?)`, 'i');
    for (const line of lines) {
      const match = pattern.exec(line);
      if (match?.[1] !== undefined) {
        const amount = parseAmount(match[1]);
        if (amount !== null) {
          return amount;
        }
      }
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Parses a statement.
 *
 * Confidence combines two things that matter independently: how much of the file we
 * understood (parsed rows vs candidate rows), and whether we recovered enough history to
 * score at all. A perfectly parsed two-month statement is not a high-confidence input to a
 * model specified on six months, and the confidence reflects that.
 */
export function parseStatement(text: string): StatementExtraction {
  const lines = normaliseLines(text);
  if (lines.length === 0) {
    return {
      bankName: null,
      accountNumber: null,
      accountType: null,
      currency: 'NPR',
      periodFrom: null,
      periodTo: null,
      openingBalanceNpr: null,
      closingBalanceNpr: null,
      transactions: [],
      confidence: 0,
      missingFields: ['transactions'],
    };
  }

  const delimiter = detectDelimiter(lines);
  const outcome =
    (delimiter !== null ? parseDelimited(lines, delimiter) : null) ?? parsePositional(lines);

  const transactions = [...outcome.transactions].sort((a, b) => a.date.getTime() - b.date.getTime());

  const bankName = extractBankName(lines);
  const accountNumber = extractAccountNumber(lines);
  const accountType = extractAccountType(lines);
  const period = extractPeriod(lines);

  const currency = /\b(usd|\$)\b/i.test(lines.slice(0, 20).join(' ')) ? 'USD' : 'NPR';

  const periodFrom = period.from ?? transactions[0]?.date ?? null;
  const periodTo = period.to ?? transactions.at(-1)?.date ?? null;

  const openingBalanceNpr =
    extractLabelledBalance(lines, ['opening balance', 'balance b/f', 'brought forward']) ??
    // Reconstruct from the first row: balance after minus the movement that produced it.
    (transactions[0]?.balanceAfterNpr != null
      ? transactions[0].balanceAfterNpr - transactions[0].creditNpr + transactions[0].debitNpr
      : null);

  const closingBalanceNpr =
    extractLabelledBalance(lines, ['closing balance', 'balance c/f', 'carried forward']) ??
    transactions.at(-1)?.balanceAfterNpr ??
    null;

  const monthsCovered = new Set(
    transactions.map(
      (txn) => `${txn.date.getUTCFullYear()}-${String(txn.date.getUTCMonth() + 1).padStart(2, '0')}`,
    ),
  ).size;

  const missingFields: string[] = [];
  if (transactions.length === 0) missingFields.push('transactions');
  if (bankName === null) missingFields.push('bankName');
  if (accountNumber === null) missingFields.push('accountNumber');
  if (closingBalanceNpr === null) missingFields.push('closingBalance');
  if (monthsCovered < 6) missingFields.push('sixMonthHistory');

  return {
    bankName,
    accountNumber,
    accountType,
    currency,
    periodFrom,
    periodTo,
    openingBalanceNpr,
    closingBalanceNpr,
    transactions,
    confidence: computeConfidence(outcome, monthsCovered, bankName !== null, accountNumber !== null),
    missingFields,
  };
}

function computeConfidence(
  outcome: ParseOutcome,
  monthsCovered: number,
  hasBankName: boolean,
  hasAccountNumber: boolean,
): number {
  if (outcome.rowsParsed === 0) {
    return 0;
  }

  // How much of what looked like a transaction row did we actually understand?
  const parseRate = outcome.rowsSeen === 0 ? 0 : outcome.rowsParsed / outcome.rowsSeen;
  // Do we have the history the model is specified on (§3.2: six months)?
  const historyRate = Math.min(1, monthsCovered / 6);
  // Metadata is worth a little: it corroborates that we read a real statement.
  const metadataRate = (hasBankName ? 0.5 : 0) + (hasAccountNumber ? 0.5 : 0);

  const confidence = parseRate * 0.5 + historyRate * 0.4 + metadataRate * 0.1;
  return Math.round(Math.min(1, Math.max(0, confidence)) * 10000) / 10000;
}
