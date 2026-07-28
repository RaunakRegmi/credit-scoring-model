/**
 * Extraction: resume parsing, statement parsing, transaction classification and recurrence.
 *
 * These run against realistic document text rather than pre-parsed objects, because the
 * accuracy of the whole scorecard rests on this layer — a misclassified salary credit costs an
 * applicant 60 points on the Financial pillar.
 */
import { describe, expect, it } from 'vitest';

import { parseResume } from '../src/extraction/resume.parser';
import { parseStatement } from '../src/extraction/statement.parser';
import {
  classifyStatement,
  classifyTransaction,
  extractCounterparty,
} from '../src/extraction/transaction-classifier';
import {
  classifyEmployer,
  extractCountries,
  inferEducationLevel,
  inferReferenceTier,
  inferSeniorityRank,
  isInternationalCertification,
} from '../src/extraction/taxonomy';
import { parseAmount, parseDate } from '../src/extraction/text-extraction.util';

/* ========================================================================== */
/* Text helpers                                                               */
/* ========================================================================== */

describe('parseAmount', () => {
  it('handles thousands separators and currency symbols', () => {
    expect(parseAmount('NPR 285,000')).toBe(285_000);
    expect(parseAmount('Rs. 1,25,000')).toBe(125_000);
    expect(parseAmount('$4,500.50')).toBe(4_500.5);
  });

  it('handles South Asian units', () => {
    expect(parseAmount('NPR 2.5 lakh')).toBe(250_000);
    expect(parseAmount('1.2 crore')).toBe(12_000_000);
    expect(parseAmount('45 thousand')).toBe(45_000);
  });

  it('returns null when there is no number', () => {
    expect(parseAmount('negotiable')).toBeNull();
    expect(parseAmount('')).toBeNull();
  });
});

describe('parseDate', () => {
  it('parses ISO, day-first and month-name formats', () => {
    expect(parseDate('2026-03-15')?.toISOString().slice(0, 10)).toBe('2026-03-15');
    expect(parseDate('15/03/2026')?.toISOString().slice(0, 10)).toBe('2026-03-15');
    expect(parseDate('15 Mar 2026')?.toISOString().slice(0, 10)).toBe('2026-03-15');
    expect(parseDate('March 2026')?.toISOString().slice(0, 10)).toBe('2026-03-01');
  });

  it('resolves an unambiguous US-ordered date correctly', () => {
    // 03/25 cannot be day-first, because there is no month 25.
    expect(parseDate('03/25/2026')?.toISOString().slice(0, 10)).toBe('2026-03-25');
  });

  it('resolves an ambiguous date as day-first, the Nepali convention', () => {
    expect(parseDate('05/03/2026')?.toISOString().slice(0, 10)).toBe('2026-03-05');
  });

  it('builds dates in UTC so month bucketing is not shifted by the local timezone', () => {
    // Nepal is UTC+5:45; a local-time Date would move a 1st-of-month transaction into the
    // previous month and corrupt every monthly aggregate.
    const date = parseDate('2026-03-01');
    expect(date?.getUTCDate()).toBe(1);
    expect(date?.getUTCMonth()).toBe(2);
    expect(date?.getUTCHours()).toBe(0);
  });

  it('rejects impossible calendar dates rather than rolling over', () => {
    expect(parseDate('31/02/2026')).toBeNull();
    expect(parseDate('2026-13-01')).toBeNull();
    expect(parseDate('not a date')).toBeNull();
  });
});

/* ========================================================================== */
/* Taxonomy                                                                   */
/* ========================================================================== */

describe('employer classification (§4.3)', () => {
  it('recognises banks, MNCs, government and international institutions', () => {
    expect(classifyEmployer('Nepal Investment Mega Bank Limited')).toBe('COMMERCIAL_BANK');
    expect(classifyEmployer('Standard Chartered Bank Nepal')).toBe('COMMERCIAL_BANK');
    expect(classifyEmployer('Microsoft Corporation')).toBe('MNC');
    expect(classifyEmployer('Deloitte Nepal')).toBe('MNC');
    expect(classifyEmployer('Ministry of Finance')).toBe('GOVERNMENT');
    expect(classifyEmployer('United Nations Development Programme')).toBe('INTERNATIONAL_NGO');
    expect(classifyEmployer('The World Bank')).toBe('INTERNATIONAL_NGO');
  });

  it('honours an explicit annotation over keyword inference', () => {
    expect(classifyEmployer('Acme Traders (MNC)')).toBe('MNC');
    expect(classifyEmployer('Acme Bank Ltd (SME)')).toBe('SME');
  });

  it('defaults to SME rather than awarding an unearned premium', () => {
    expect(classifyEmployer('Unfamiliar Name Here')).toBe('SME');
  });

  it('detects informal employment', () => {
    expect(classifyEmployer('Self-Employed')).toBe('INFORMAL');
    expect(classifyEmployer('Freelance')).toBe('INFORMAL');
  });
});

describe('seniority inference', () => {
  it('ranks a hierarchy correctly', () => {
    expect(inferSeniorityRank('Chief Executive Officer')).toBe(10);
    expect(inferSeniorityRank('Executive Director')).toBe(9);
    expect(inferSeniorityRank('Vice President')).toBe(8);
    expect(inferSeniorityRank('Head of Credit')).toBe(7);
    expect(inferSeniorityRank('Senior Manager')).toBe(6);
    expect(inferSeniorityRank('Manager')).toBe(5);
    expect(inferSeniorityRank('Officer')).toBe(2);
    expect(inferSeniorityRank('Intern')).toBe(1);
  });

  it('reads "Assistant Manager" as management, not as an assistant', () => {
    // The compound title must beat the bare word "Assistant", which ranks 1.
    expect(inferSeniorityRank('Assistant Manager')).toBe(4);
    expect(inferSeniorityRank('Deputy General Manager')).toBe(7);
  });

  it('is monotonic across a real career ladder', () => {
    const ladder = ['Intern', 'Officer', 'Senior Officer', 'Manager', 'Senior Manager', 'Director'];
    const ranks = ladder.map(inferSeniorityRank);
    for (let index = 1; index < ranks.length; index += 1) {
      expect(ranks[index]).toBeGreaterThanOrEqual(ranks[index - 1] as number);
    }
  });
});

describe('education and certifications', () => {
  it('infers education level from common phrasings', () => {
    expect(inferEducationLevel('Master of Business Administration')).toBe('MASTERS');
    expect(inferEducationLevel('MBA (Finance)')).toBe('MASTERS');
    expect(inferEducationLevel('Bachelor of Science in Computer Engineering')).toBe('BACHELORS');
    expect(inferEducationLevel('PhD in Economics')).toBe('PHD');
    expect(inferEducationLevel('Diploma in Civil')).toBe('DIPLOMA');
    expect(inferEducationLevel('no qualifications listed')).toBe('NONE');
  });

  it('recognises international certifications for the §4.3 5-point tier', () => {
    expect(isInternationalCertification('CFA Level II, CFA Institute')).toBe(true);
    expect(isInternationalCertification('PMP')).toBe(true);
    expect(isInternationalCertification('AWS Certified Solutions Architect')).toBe(true);
    expect(isInternationalCertification('Basel III Risk Management')).toBe(true);
    expect(isInternationalCertification('Local district training workshop')).toBe(false);
  });

  it('maps reference designations to tiers', () => {
    expect(inferReferenceTier('Chief Executive Officer')).toBe('C_SUITE');
    expect(inferReferenceTier('Director - Risk')).toBe('DIRECTOR');
    expect(inferReferenceTier('Senior Manager')).toBe('SENIOR_MANAGER');
    expect(inferReferenceTier('Team Lead')).toBe('MANAGER');
    expect(inferReferenceTier(null)).toBe('UNKNOWN');
  });
});

describe('country extraction', () => {
  it('finds countries and maps them to ISO codes', () => {
    const found = extractCountries('Australia, Singapore, United Kingdom, UAE, India');
    expect(found).toContain('AU');
    expect(found).toContain('SG');
    expect(found).toContain('GB');
    expect(found).toContain('AE');
    expect(found).toContain('IN');
  });

  it('prefers the longest match so "United States" does not resolve as "us"', () => {
    expect(extractCountries('United States of America')).toContain('US');
  });

  it('does not match a short code inside an unrelated word', () => {
    // "us" inside "industry" / "business" must not become the United States.
    expect(extractCountries('banking industry business analysis')).not.toContain('US');
  });
});

/* ========================================================================== */
/* Transaction classification (§3.2.1)                                        */
/* ========================================================================== */

describe('transaction classification', () => {
  it('classifies the income categories', () => {
    expect(classifyTransaction('SALARY CREDIT - PAYROLL TRANSFER', true).category).toBe('SALARY');
    expect(classifyTransaction('IME REMIT INWARD REMITTANCE', true).category).toBe('REMITTANCE');
    expect(classifyTransaction('WESTERN UNION TRANSFER', true).category).toBe('REMITTANCE');
    expect(classifyTransaction('RENTAL INCOME RECEIVED - TENANT', true).category).toBe('RENTAL_INCOME');
    expect(classifyTransaction('INVOICE PAYMENT PROFESSIONAL FEE', true).category).toBe('BUSINESS_INCOME');
    expect(classifyTransaction('INTEREST CREDIT', true).category).toBe('INTEREST_INCOME');
  });

  it('classifies the obligation and behavioural categories', () => {
    expect(classifyTransaction('AUTO LOAN EMI INSTALMENT RECOVERY', false).category).toBe('LOAN_EMI');
    expect(classifyTransaction('CREDIT CARD PAYMENT - VISA SETTLEMENT', false).category).toBe(
      'CREDIT_CARD_PAYMENT',
    );
    expect(classifyTransaction('NEPAL LIFE INSURANCE PREMIUM PAYMENT', false).category).toBe(
      'INSURANCE_PREMIUM',
    );
    expect(classifyTransaction('ATM CASH WITHDRAWAL', false).category).toBe('ATM_WITHDRAWAL');
    expect(classifyTransaction('NEA ELECTRICITY BILL PAYMENT', false).category).toBe('UTILITY');
    expect(classifyTransaction('HOUSE RENT PAID - LANDLORD', false).category).toBe('RENT_PAID');
    expect(classifyTransaction('BHATBHATENI SUPERMARKET GROCERY', false).category).toBe(
      'GROCERY_ESSENTIAL',
    );
    expect(classifyTransaction('DARAZ ONLINE SHOPPING ORDER', false).category).toBe('DISCRETIONARY');
  });

  it('detects a bounce regardless of direction', () => {
    expect(classifyTransaction('CHEQUE RETURN - INSUFFICIENT FUNDS', false).category).toBe(
      'BOUNCE_PENALTY',
    );
    expect(classifyTransaction('ECS RETURN CHARGE', false).category).toBe('BOUNCE_PENALTY');
  });

  it('respects direction — a salary keyword on a debit is not income', () => {
    expect(classifyTransaction('SALARY DISBURSEMENT TO STAFF', false).category).not.toBe('SALARY');
  });

  it('falls back to low confidence rather than guessing', () => {
    const credit = classifyTransaction('XYZ9910 REF 88213', true);
    expect(credit.category).toBe('OTHER_CREDIT');
    expect(credit.confidence).toBeLessThan(0.6);

    const debit = classifyTransaction('', false);
    expect(debit.category).toBe('OTHER_DEBIT');
  });

  it('assigns high confidence only to unambiguous narrations', () => {
    expect(classifyTransaction('SALARY CREDIT', true).confidence).toBeGreaterThan(0.9);
    // A generic transfer is a weak signal and must say so.
    expect(classifyTransaction('FUND TRANSFER TO A/C', false).confidence).toBeLessThan(0.8);
  });
});

describe('counterparty extraction', () => {
  it('strips reference numbers and dates', () => {
    const counterparty = extractCounterparty('NEPAL LIFE INSURANCE REF 8891234 15/03/2026');
    expect(counterparty).toContain('NEPAL LIFE INSURANCE');
    expect(counterparty).not.toMatch(/8891234/);
  });

  it('returns null when nothing meaningful remains', () => {
    expect(extractCounterparty('99887766')).toBeNull();
    expect(extractCounterparty('  ')).toBeNull();
  });
});

describe('recurrence detection', () => {
  it('marks a six-month salary series as recurring', () => {
    const transactions = Array.from({ length: 6 }, (_, index) => ({
      date: new Date(Date.UTC(2026, index, 28)),
      description: 'SALARY CREDIT - PAYROLL TRANSFER ACME LIMITED',
      creditNpr: 120_000,
      debitNpr: 0,
      balanceAfterNpr: 200_000,
    }));

    const classified = classifyStatement(transactions);
    expect(classified.every((txn) => txn.isRecurring)).toBe(true);
    expect(new Set(classified.map((txn) => txn.recurringGroupId)).size).toBe(1);
  });

  it('tolerates a salary revision within the series', () => {
    // A raise must not split one salary into two unrelated payments.
    const amounts = [120_000, 120_000, 120_000, 130_000, 130_000, 130_000];
    const transactions = amounts.map((amount, index) => ({
      date: new Date(Date.UTC(2026, index, 28)),
      description: 'SALARY CREDIT - PAYROLL TRANSFER ACME LIMITED',
      creditNpr: amount,
      debitNpr: 0,
      balanceAfterNpr: 200_000,
    }));

    const classified = classifyStatement(transactions);
    expect(classified.every((txn) => txn.isRecurring)).toBe(true);
  });

  it('does not mark two isolated payments as recurring', () => {
    const transactions = [0, 1].map((index) => ({
      date: new Date(Date.UTC(2026, index, 12)),
      description: 'ONE OFF TRANSFER TO SOMEONE',
      creditNpr: 0,
      debitNpr: 5_000,
      balanceAfterNpr: 50_000,
    }));

    const classified = classifyStatement(transactions);
    expect(classified.some((txn) => txn.isRecurring)).toBe(false);
  });

  it('separates distinct series into distinct groups', () => {
    const transactions = [];
    for (let month = 0; month < 6; month += 1) {
      transactions.push({
        date: new Date(Date.UTC(2026, month, 28)),
        description: 'SALARY CREDIT PAYROLL ACME LIMITED',
        creditNpr: 120_000,
        debitNpr: 0,
        balanceAfterNpr: 200_000,
      });
      transactions.push({
        date: new Date(Date.UTC(2026, month, 15)),
        description: 'AUTO LOAN EMI RECOVERY BETA FINANCE',
        creditNpr: 0,
        debitNpr: 15_000,
        balanceAfterNpr: 185_000,
      });
    }

    const classified = classifyStatement(transactions);
    const groups = new Set(
      classified.filter((txn) => txn.recurringGroupId !== null).map((txn) => txn.recurringGroupId),
    );
    expect(groups.size).toBe(2);
  });
});

/* ========================================================================== */
/* Statement parsing (§3.2)                                                   */
/* ========================================================================== */

describe('statement parsing', () => {
  const csv = [
    'Nepal Investment Mega Bank Limited',
    'Statement of Account',
    'Account Number: 01234567890123',
    'Account Type: Savings Account',
    'Statement Period: 2026-01-01 to 2026-06-30',
    'Opening Balance: 150000.00',
    '',
    'Txn Date,Description,Debit,Credit,Balance',
    '2026-01-28,"SALARY CREDIT - PAYROLL TRANSFER",,120000.00,270000.00',
    '2026-01-15,"AUTO LOAN EMI INSTALMENT RECOVERY",15000.00,,255000.00',
    '2026-02-28,"SALARY CREDIT - PAYROLL TRANSFER",,120000.00,375000.00',
    '',
    'Closing Balance: 375000.00',
  ].join('\n');

  it('extracts header metadata', () => {
    const result = parseStatement(csv);
    expect(result.bankName).toContain('Nepal Investment Mega Bank');
    expect(result.accountNumber).toBe('01234567890123');
    expect(result.accountType).toBe('SAVING');
    expect(result.currency).toBe('NPR');
    expect(result.openingBalanceNpr).toBe(150_000);
    expect(result.closingBalanceNpr).toBe(375_000);
  });

  it('parses transactions with correct direction', () => {
    const result = parseStatement(csv);
    expect(result.transactions).toHaveLength(3);

    const credits = result.transactions.filter((txn) => txn.creditNpr > 0);
    const debits = result.transactions.filter((txn) => txn.debitNpr > 0);
    expect(credits).toHaveLength(2);
    expect(debits).toHaveLength(1);
    expect(debits[0]?.debitNpr).toBe(15_000);
  });

  it('returns transactions in date order', () => {
    const result = parseStatement(csv);
    const times = result.transactions.map((txn) => txn.date.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('handles a quoted description containing the delimiter', () => {
    const withComma = csv.replace(
      '"SALARY CREDIT - PAYROLL TRANSFER",,120000.00,270000.00',
      '"SALARY CREDIT, MONTHLY, PAYROLL",,120000.00,270000.00',
    );
    const result = parseStatement(withComma);
    expect(result.transactions.some((txn) => txn.description.includes('MONTHLY'))).toBe(true);
  });

  it('parses a tab-separated statement', () => {
    const tsv = [
      'Txn Date\tDescription\tDebit\tCredit\tBalance',
      '2026-01-28\tSALARY CREDIT\t\t120000.00\t270000.00',
      '2026-02-28\tSALARY CREDIT\t\t120000.00\t390000.00',
    ].join('\n');
    const result = parseStatement(tsv);
    expect(result.transactions).toHaveLength(2);
  });

  it('resolves direction from the balance delta when only one amount column exists', () => {
    const single = [
      'Txn Date,Description,Amount,Balance',
      '2026-01-10,OPENING ENTRY,1000.00,101000.00',
      '2026-01-15,ATM CASH WITHDRAWAL,5000.00,96000.00',
    ].join('\n');
    const result = parseStatement(single);
    const withdrawal = result.transactions.find((txn) => txn.description.includes('ATM'));
    // The balance fell, so the amount must be a debit even though it is printed unsigned.
    expect(withdrawal?.debitNpr).toBe(5_000);
    expect(withdrawal?.creditNpr).toBe(0);
  });

  it('reports a low confidence for a statement with too little history', () => {
    const short = [
      'Txn Date,Description,Debit,Credit,Balance',
      '2026-01-28,SALARY,,120000.00,270000.00',
    ].join('\n');
    const result = parseStatement(short);
    expect(result.confidence).toBeLessThan(0.85);
    expect(result.missingFields).toContain('sixMonthHistory');
  });

  it('returns an empty result rather than throwing on unparseable input', () => {
    const result = parseStatement('this document contains no transactions whatsoever');
    expect(result.transactions).toHaveLength(0);
    expect(result.confidence).toBe(0);
    expect(result.missingFields).toContain('transactions');
  });
});

/* ========================================================================== */
/* Resume parsing (§3.1)                                                      */
/* ========================================================================== */

describe('resume parsing', () => {
  const resume = `Anjali Sharma
Jhamsikhel, Lalitpur
anjali.sharma@example.com.np | 9801234567

PERSONAL DETAILS
Name: Anjali Sharma
Father's Name: Ramesh Sharma
Citizenship No: 27-01-75-04821
Passport No: PA1234567
Current Salary: NPR 285,000
Expected Salary: NPR 320,000

WORK EXPERIENCE
Senior Manager - Corporate Credit, Nepal Investment Mega Bank Limited | Jan 2021 - Present
Leading the corporate credit portfolio. Salary: NPR 285,000 per month.

Manager - Credit Risk, Standard Chartered Bank Nepal | Mar 2017 - Dec 2020
Salary: NPR 195,000 per month.

EDUCATION
Master of Business Administration (Finance), University of Melbourne, Australia, 2011
CGPA 3.8

CERTIFICATIONS
- CFA Level II, CFA Institute, 2016
- Certified Credit Professional, Nepal Banking Institute, 2015

TRAVEL HISTORY
Countries Visited: Australia, Singapore, United Kingdom, India
Visas Held: Schengen, US B1/B2

AWARDS
- Best Credit Officer of the Year, Nepal Bankers Association, National, 2019

REFERENCES
Bikash Thapa, Chief Executive Officer, Nepal Investment Mega Bank Limited, bikash.thapa@example.com.np
`;

  it('extracts identity fields', () => {
    const result = parseResume(resume);
    expect(result.fullName).toBe('Anjali Sharma');
    expect(result.fatherName).toBe('Ramesh Sharma');
    expect(result.email).toBe('anjali.sharma@example.com.np');
    expect(result.phone).toBe('9801234567');
    expect(result.nationalId).toBe('27-01-75-04821');
    expect(result.passportNumber).toBe('PA1234567');
  });

  it('extracts salary figures', () => {
    const result = parseResume(resume);
    expect(result.pastSalaryNpr).toBe(285_000);
    expect(result.expectedSalaryNpr).toBe(320_000);
  });

  it('extracts employment history with employer type and seniority', () => {
    const result = parseResume(resume);
    expect(result.employment.length).toBeGreaterThanOrEqual(2);

    const current = result.employment.find((role) => role.isCurrent);
    expect(current).toBeDefined();
    expect(current?.employerType).toBe('COMMERCIAL_BANK');
    expect(current?.seniorityRank).toBeGreaterThanOrEqual(6);
    expect(current?.endDate).toBeNull();
  });

  it('returns employment in chronological order', () => {
    const result = parseResume(resume);
    const times = result.employment.map((role) => role.startDate.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('extracts the highest education with its country', () => {
    const result = parseResume(resume);
    expect(result.education.level).toBe('MASTERS');
    expect(result.education.isAbroad).toBe(true);
    expect(result.education.country).toBe('AU');
    expect(result.education.gpa).toBeCloseTo(3.8, 2);
  });

  it('extracts certifications and flags the international ones', () => {
    const result = parseResume(resume);
    expect(result.certifications.length).toBeGreaterThanOrEqual(2);
    expect(result.certifications.some((cert) => cert.isInternational)).toBe(true);
  });

  it('extracts travel history only from the travel section', () => {
    const result = parseResume(resume);
    expect(result.countriesTraveled).toContain('AU');
    expect(result.countriesTraveled).toContain('SG');
    expect(result.countriesTraveled).toContain('GB');
    expect(result.premiumVisas.length).toBeGreaterThan(0);
  });

  it('does not count an employer country as somewhere the applicant travelled', () => {
    // Scanning the whole CV would inflate the §4.4 mobility score for someone who never left.
    const homebody = `Ram Bahadur
ram@example.com | 9801111111

WORK EXPERIENCE
Officer, Standard Chartered Bank Nepal | Jan 2020 - Present

EDUCATION
Bachelor of Business Administration, University of Melbourne, Australia, 2019
`;
    const result = parseResume(homebody);
    expect(result.countriesTraveled).toHaveLength(0);
  });

  it('extracts references with their tier', () => {
    const result = parseResume(resume);
    expect(result.references.length).toBeGreaterThanOrEqual(1);
    expect(result.references[0]?.tier).toBe('C_SUITE');
    expect(result.references[0]?.contact).toContain('@');
  });

  it('extracts awards with scope', () => {
    const result = parseResume(resume);
    expect(result.awards.length).toBeGreaterThanOrEqual(1);
    expect(result.awards[0]?.scope).toBe('NATIONAL');
  });

  it('reports a high confidence for a complete CV', () => {
    expect(parseResume(resume).confidence).toBeGreaterThan(0.85);
  });

  it('reports a low confidence and names the gaps for a sparse CV', () => {
    const result = parseResume('Just a name\n\nnothing else here');
    expect(result.confidence).toBeLessThan(0.5);
    expect(result.missingFields).toContain('employment');
    expect(result.missingFields).toContain('education');
  });

  it('ignores "references available on request"', () => {
    const withoutRefs = resume.replace(
      /REFERENCES[\s\S]*$/,
      'REFERENCES\nReferences available on request\n',
    );
    expect(parseResume(withoutRefs).references).toHaveLength(0);
  });

  it('never throws on adversarial input', () => {
    const inputs = ['', '\n\n\n', 'x'.repeat(100_000), '///---***', ' '];
    for (const text of inputs) {
      expect(() => parseResume(text)).not.toThrow();
    }
  });
});

/* ========================================================================== */
/* Letter-spaced headings                                                     */
/* ========================================================================== */

describe('letter-spaced section headings', () => {
  /**
   * `letter-spacing` on a section heading is a near-universal choice in designed CVs. It positions
   * every glyph independently in the PDF, so the text layer yields `W O R K  E X P E R I E N C E` —
   * and the word boundary is rendered as the same single space as the letter boundaries, so it is
   * not recoverable from the text.
   *
   * The failure this guards against was total rather than partial: no heading matched, so no
   * section existed, so nothing downstream of the header block parsed at all. Measured on the demo
   * CV before the fix: 0 employment entries, confidence 0.38.
   */
  const spaced = [
    'Anjali Sharma',
    'anjali.sharma@example.com.np | 9801234567',
    'P E R S O N A L  D E TA I L S',
    'Current Salary: NPR 285,000',
    'W O R K  E X P E R I E N C E',
    'Senior Manager - Corporate Credit, Nepal Investment Mega Bank Limited | Jan 2021 - Present',
    'Leading the corporate credit portfolio. Salary: NPR 285,000 per month.',
    'E D U C AT I O N',
    'Master of Business Administration (Finance), University of Melbourne, Australia, 2011',
    'C E R T I F I C AT I O N S',
    '- CFA Level II, CFA Institute, 2016',
  ].join('\n');

  it('recovers the sections, and therefore the content under them', () => {
    const result = parseResume(spaced);

    expect(result.employment).toHaveLength(1);
    expect(result.employment[0]?.employerName).toContain('Nepal Investment Mega Bank');
    expect(result.education.level).toBe('MASTERS');
    expect(result.certifications).toHaveLength(1);
    // Read out of PERSONAL DETAILS, which only exists if that heading was recognised.
    expect(result.pastSalaryNpr).toBe(285_000);
  });

  it('parses letter-spaced and ordinary headings to the same result', () => {
    const ordinary = spaced
      .replace('P E R S O N A L  D E TA I L S', 'PERSONAL DETAILS')
      .replace('W O R K  E X P E R I E N C E', 'WORK EXPERIENCE')
      .replace('E D U C AT I O N', 'EDUCATION')
      .replace('C E R T I F I C AT I O N S', 'CERTIFICATIONS');

    expect(parseResume(spaced)).toEqual(parseResume(ordinary));
  });

  it('does not mistake ordinary short-word text for a letter-spaced heading', () => {
    // Four-plus tokens of one or two characters is the trigger, so these are the shapes that could
    // be misread. None of them should open a section and swallow what follows.
    for (const line of [
      'I am a UX designer',
      'A B C D Corporation Pvt Ltd',
      'Rs 45 00 000 in total',
      'Ph D in Economics',
    ]) {
      const parsed = parseResume(
        ['Test Applicant', line, 'Some following body text that must not be captured.'].join('\n'),
      );
      // With no heading recognised, everything stays in the header block and no section exists.
      expect(parsed.employment, line).toHaveLength(0);
      expect(parsed.certifications, line).toHaveLength(0);
    }
  });
});
