/**
 * Deterministic applicant fixtures.
 *
 * Generates a resume (plain text) and a bank statement (CSV) per archetype, which the real
 * extractors then parse. That matters: the fixtures exercise the actual parsing and
 * classification path rather than injecting pre-parsed objects, so a regression in the resume
 * parser or the transaction classifier shows up in the seeded scores.
 *
 * Everything is derived from a fixed base date and a seeded PRNG, so the same input always
 * produces the same score. A fixture whose band moves between runs is useless as a check.
 */

/** Fixed reference date. Statements are the six months ending the month before this. */
export const FIXTURE_BASE_DATE = new Date(Date.UTC(2026, 6, 1)); // 2026-07-01

/**
 * Mulberry32 — a small, fast, fully deterministic PRNG.
 * `Math.random()` would make the fixtures irreproducible.
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

/** First day of the month `monthsBack` before `FIXTURE_BASE_DATE`. */
function monthStart(monthsBack: number): Date {
  return new Date(
    Date.UTC(FIXTURE_BASE_DATE.getUTCFullYear(), FIXTURE_BASE_DATE.getUTCMonth() - monthsBack, 1),
  );
}

export interface StatementRow {
  readonly date: Date;
  readonly description: string;
  readonly debit: number;
  readonly credit: number;
}

export interface FixtureProfile {
  readonly key: string;
  readonly label: string;
  readonly expectedBand: string;
  readonly notes: string;

  readonly fullName: string;
  readonly fatherName: string;
  readonly email: string;
  readonly phone: string;
  readonly nationalId: string;
  readonly nationality: string;
  readonly address: string;
  readonly yearsAtAddress: number;

  readonly productType: 'BNPL' | 'PERSONAL_LOAN' | 'HIRE_PURCHASE' | 'AUTO_LOAN' | 'MICRO_BNPL';
  readonly requestedAmountNpr: number;
  readonly tenureMonths: number;

  readonly resumeText: string;
  readonly statementCsv: string;

  readonly kycDocuments: readonly string[];
  readonly residenceStatus: 'OWNED' | 'FAMILY_OWNED' | 'RENTED' | 'COMPANY_PROVIDED' | 'UNDECLARED';
  readonly nidVerified: boolean;
  readonly kycFaceMatchScore: number | null;
  readonly activeLoanCount: number;
}

/* -------------------------------------------------------------------------- */
/* Statement construction                                                      */
/* -------------------------------------------------------------------------- */

interface StatementSpec {
  readonly seed: number;
  readonly months: number;
  readonly openingBalance: number;
  readonly salary: number | null;
  /** Day of month the salary lands. */
  readonly salaryDay: number;
  readonly salaryGrowthAtMonth: number | null;
  readonly remittance: number | null;
  readonly rental: number | null;
  /**
   * Freelance/consulting receipts, split across two irregular invoice payments a month.
   * Classified as BUSINESS_INCOME, so it counts towards verified income but never towards
   * salary consistency — which is exactly what makes a gig worker a thin file.
   */
  readonly businessIncome: number | null;
  readonly emi: number | null;
  readonly cardPayment: number | null;
  readonly insurance: number | null;
  readonly rentPaid: number | null;
  readonly essentialSpend: number;
  readonly discretionarySpend: number;
  readonly atmWithdrawal: number;
  readonly bouncesInMonths: readonly number[];
  /** Months (0 = oldest) where the EMI is skipped, to create a punctuality gap. */
  readonly skipEmiMonths: readonly number[];
  readonly bankName: string;
  readonly accountNumber: string;
}

/**
 * Builds a six-month statement as CSV.
 *
 * The running balance is carried forward across every row so that average daily balance,
 * minimum balance and overdraft days are all computed from real arithmetic rather than
 * asserted — the same way a genuine statement behaves.
 */
function buildStatement(spec: StatementSpec): string {
  const random = seededRandom(spec.seed);
  const rows: StatementRow[] = [];

  for (let monthIndex = 0; monthIndex < spec.months; monthIndex += 1) {
    // monthsBack counts down so month 0 is the oldest.
    const base = monthStart(spec.months - monthIndex);

    if (spec.salary !== null) {
      const grown =
        spec.salaryGrowthAtMonth !== null && monthIndex >= spec.salaryGrowthAtMonth
          ? Math.round(spec.salary * 1.12)
          : spec.salary;
      rows.push({
        date: addDays(base, spec.salaryDay - 1),
        description: 'SALARY CREDIT - PAYROLL TRANSFER',
        debit: 0,
        credit: grown,
      });
    }

    if (spec.remittance !== null) {
      rows.push({
        date: addDays(base, 8),
        description: 'IME REMIT INWARD REMITTANCE',
        debit: 0,
        credit: Math.round(spec.remittance * (0.9 + random() * 0.2)),
      });
    }

    if (spec.rental !== null) {
      rows.push({
        date: addDays(base, 4),
        description: 'RENTAL INCOME RECEIVED - TENANT',
        debit: 0,
        credit: spec.rental,
      });
    }

    if (spec.businessIncome !== null) {
      // Two uneven receipts on shifting dates: real freelance income, not a payroll run.
      const firstShare = 0.45 + random() * 0.2;
      rows.push({
        date: addDays(base, 5 + Math.floor(random() * 6)),
        description: 'INVOICE PAYMENT - PROFESSIONAL FEE CLIENT SETTLEMENT',
        debit: 0,
        credit: Math.round(spec.businessIncome * firstShare),
      });
      rows.push({
        date: addDays(base, 18 + Math.floor(random() * 7)),
        description: 'CONSULTANCY FEE RECEIVED - DESIGN RETAINER',
        debit: 0,
        credit: Math.round(spec.businessIncome * (1 - firstShare)),
      });
    }

    if (spec.emi !== null && !spec.skipEmiMonths.includes(monthIndex)) {
      rows.push({
        date: addDays(base, spec.salaryDay + 2),
        description: 'AUTO LOAN EMI INSTALMENT RECOVERY',
        debit: spec.emi,
        credit: 0,
      });
    }

    if (spec.cardPayment !== null) {
      rows.push({
        date: addDays(base, 17),
        description: 'CREDIT CARD PAYMENT - VISA SETTLEMENT',
        debit: Math.round(spec.cardPayment * (0.85 + random() * 0.3)),
        credit: 0,
      });
    }

    if (spec.insurance !== null) {
      rows.push({
        date: addDays(base, 11),
        description: 'NEPAL LIFE INSURANCE PREMIUM PAYMENT',
        debit: spec.insurance,
        credit: 0,
      });
    }

    if (spec.rentPaid !== null) {
      rows.push({
        date: addDays(base, 2),
        description: 'HOUSE RENT PAID - LANDLORD',
        debit: spec.rentPaid,
        credit: 0,
      });
    }

    rows.push({
      date: addDays(base, 6),
      description: 'NEA ELECTRICITY BILL PAYMENT',
      debit: Math.round(1200 + random() * 900),
      credit: 0,
    });
    rows.push({
      date: addDays(base, 14),
      description: 'WORLDLINK INTERNET BROADBAND',
      debit: 1699,
      credit: 0,
    });
    rows.push({
      date: addDays(base, 9),
      description: 'BHATBHATENI SUPERMARKET GROCERY',
      debit: Math.round(spec.essentialSpend * (0.8 + random() * 0.4)),
      credit: 0,
    });
    rows.push({
      date: addDays(base, 21),
      description: 'DARAZ ONLINE SHOPPING ORDER',
      debit: Math.round(spec.discretionarySpend * (0.7 + random() * 0.6)),
      credit: 0,
    });
    rows.push({
      date: addDays(base, 24),
      description: 'RESTAURANT DINING - FOODMANDU',
      debit: Math.round(spec.discretionarySpend * 0.35 * (0.6 + random() * 0.8)),
      credit: 0,
    });
    rows.push({
      date: addDays(base, 12),
      description: 'ATM CASH WITHDRAWAL',
      debit: Math.round(spec.atmWithdrawal * (0.8 + random() * 0.4)),
      credit: 0,
    });
    rows.push({
      date: addDays(base, 26),
      description: 'ATM CASH WITHDRAWAL',
      debit: Math.round(spec.atmWithdrawal * 0.6 * (0.7 + random() * 0.6)),
      credit: 0,
    });

    if (spec.bouncesInMonths.includes(monthIndex)) {
      rows.push({
        date: addDays(base, 19),
        description: 'CHEQUE RETURN - INSUFFICIENT FUNDS',
        debit: 590,
        credit: 0,
      });
      rows.push({
        date: addDays(base, 19),
        description: 'LATE PAYMENT CHARGE - PENAL INTEREST',
        debit: 850,
        credit: 0,
      });
    }
  }

  rows.sort((a, b) => a.date.getTime() - b.date.getTime());

  const lines: string[] = [
    `${spec.bankName}`,
    `Statement of Account`,
    `Account Number: ${spec.accountNumber}`,
    `Account Type: Savings Account`,
    `Currency: NPR`,
    `Statement Period: ${iso(monthStart(spec.months))} to ${iso(addDays(monthStart(0), -1))}`,
    `Opening Balance: ${spec.openingBalance.toFixed(2)}`,
    '',
    'Txn Date,Description,Debit,Credit,Balance',
  ];

  let balance = spec.openingBalance;
  for (const row of rows) {
    balance = balance - row.debit + row.credit;
    lines.push(
      [
        iso(row.date),
        `"${row.description}"`,
        row.debit === 0 ? '' : row.debit.toFixed(2),
        row.credit === 0 ? '' : row.credit.toFixed(2),
        balance.toFixed(2),
      ].join(','),
    );
  }

  lines.push('');
  lines.push(`Closing Balance: ${balance.toFixed(2)}`);

  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 1. Prime salaried professional.
 *
 * Commercial-bank employee, thirteen years' experience with steady promotion, master's degree
 * abroad, healthy balance, low DSR, no adverse events. Should land Prime or better and
 * auto-approve.
 */
const primeProfessional: FixtureProfile = {
  key: 'prime-professional',
  label: 'Prime salaried professional',
  expectedBand: 'PRIME or ELITE_PRIME',
  notes:
    'Senior manager at a commercial bank, 13 years experience with upward progression, ' +
    "master's abroad, three income streams, zero adverse events. Expect auto-approval.",

  fullName: 'Anjali Sharma',
  fatherName: 'Ramesh Sharma',
  email: 'anjali.sharma@example.com.np',
  phone: '9801234567',
  nationalId: '27-01-75-04821',
  nationality: 'NP',
  address: 'Jhamsikhel, Lalitpur, Bagmati',
  yearsAtAddress: 7,

  productType: 'HIRE_PURCHASE',
  requestedAmountNpr: 2_500_000,
  tenureMonths: 36,

  resumeText: `Anjali Sharma
Jhamsikhel, Lalitpur, Bagmati
anjali.sharma@example.com.np | 9801234567

PERSONAL DETAILS
Name: Anjali Sharma
Father's Name: Ramesh Sharma
Citizenship No: 27-01-75-04821
Passport No: PA1234567
Address: Jhamsikhel, Lalitpur, Bagmati
Residing Since: 2019
Current Salary: NPR 285,000
Expected Salary: NPR 320,000

PROFESSIONAL SUMMARY
Banking professional with 13 years of experience in corporate credit and risk management.

WORK EXPERIENCE
Senior Manager - Corporate Credit, Nepal Investment Mega Bank Limited | Jan 2021 - Present
Leading the corporate credit portfolio. Salary: NPR 285,000 per month. Kathmandu, Nepal.

Manager - Credit Risk, Standard Chartered Bank Nepal | Mar 2017 - Dec 2020
Managed credit risk assessment for commercial lending. Salary: NPR 195,000 per month.

Assistant Manager - Credit, Himalayan Bank Limited | Jun 2013 - Feb 2017
Credit appraisal and documentation. Salary: NPR 96,000 per month.

Credit Officer, Nabil Bank Limited | Aug 2011 - May 2013
Retail credit processing. Salary: NPR 48,000 per month.

EDUCATION
Master of Business Administration (Finance), University of Melbourne, Australia, 2011
CGPA 3.8

Bachelor of Business Administration, Tribhuvan University, Kathmandu, Nepal, 2008
CGPA 3.5

CERTIFICATIONS
- CFA Level II, CFA Institute, 2016
- FRM Part I, GARP, 2018
- Certified Credit Professional, Nepal Banking Institute, 2015
- IFRS 9 Implementation Certification, Deloitte, 2019
- Basel III Risk Management, SWIFT Institute, 2020

TRAVEL HISTORY
Countries Visited: Australia, Singapore, United Kingdom, United Arab Emirates, India, Thailand, Japan, Germany, France, Malaysia, Qatar, Hong Kong
Visas Held: Schengen, US B1/B2, UK Standard Visitor, Australia Student

AWARDS
- Best Credit Officer of the Year, Nepal Bankers Association, National, 2019
- Excellence in Risk Management, Standard Chartered Group, International, 2020

REFERENCES
Bikash Thapa, Chief Executive Officer, Nepal Investment Mega Bank Limited, bikash.thapa@example.com.np
Sunita Rana, Director - Risk, Standard Chartered Bank Nepal, 9851098510
`,

  statementCsv: buildStatement({
    seed: 1001,
    months: 6,
    openingBalance: 410_000,
    salary: 285_000,
    salaryDay: 28,
    salaryGrowthAtMonth: null,
    remittance: null,
    rental: 35_000,
    businessIncome: null,
    emi: 24_000,
    cardPayment: 32_000,
    insurance: 8_500,
    rentPaid: null,
    essentialSpend: 28_000,
    discretionarySpend: 34_000,
    atmWithdrawal: 20_000,
    bouncesInMonths: [],
    skipEmiMonths: [],
    bankName: 'Nepal Investment Mega Bank Limited',
    accountNumber: '01234567890123',
  }),

  kycDocuments: ['NID_FRONT', 'NID_BACK', 'PASSPORT', 'PAN_CARD', 'ADDRESS_PROOF'],
  residenceStatus: 'OWNED',
  nidVerified: true,
  kycFaceMatchScore: 0.97,
  activeLoanCount: 1,
};

/**
 * 2. Thin-file gig worker.
 *
 * Real income but irregular, short employment history, no formal credit track record, minimal
 * documentation. This is the financial-inclusion case the model exists to serve: it should
 * score modestly and approve small rather than decline outright.
 */
const thinFileGigWorker: FixtureProfile = {
  key: 'thin-file-gig-worker',
  label: 'Thin-file gig worker',
  expectedBand: 'SUBPRIME or NEAR_PRIME',
  notes:
    'Freelance designer, 3 years experience, irregular income from two sources, no EMI history, ' +
    'incomplete KYC. Expect a modest limit rather than a decline — this is the inclusion case.',

  fullName: 'Prakash Gurung',
  fatherName: 'Dhan Bahadur Gurung',
  email: 'prakash.gurung@example.com',
  phone: '9865432109',
  nationalId: '31-02-80-11947',
  nationality: 'NP',
  address: 'Baluwatar, Kathmandu',
  yearsAtAddress: 1,

  productType: 'BNPL',
  requestedAmountNpr: 150_000,
  tenureMonths: 12,

  resumeText: `Prakash Gurung
Baluwatar, Kathmandu
prakash.gurung@example.com | 9865432109

PERSONAL DETAILS
Name: Prakash Gurung
Father's Name: Dhan Bahadur Gurung
Citizenship No: 31-02-80-11947
Address: Baluwatar, Kathmandu
Years at Address: 1
Current Salary: NPR 62,000
Expected Salary: NPR 95,000

WORK EXPERIENCE
Freelance UI/UX Designer, Self-Employed | Apr 2023 - Present
Contract design work for regional clients. Salary: NPR 62,000 per month. Kathmandu, Nepal.

Junior Graphic Designer, Creative Hub Pvt. Ltd. | Jan 2022 - Mar 2023
Print and digital design production. Salary: NPR 28,000 per month.

EDUCATION
Bachelor of Fine Arts, Lalit Kala Campus, Tribhuvan University, Nepal, 2021
CGPA 3.1

CERTIFICATIONS
- Adobe Certified Professional, Adobe, 2022
- Google UX Design Certificate, Coursera, 2023

TRAVEL HISTORY
Countries Visited: India, Thailand

REFERENCES
Maya Shrestha, Team Lead, Creative Hub Pvt. Ltd., maya.s@example.com
`,

  statementCsv: buildStatement({
    seed: 2002,
    months: 6,
    openingBalance: 34_000,
    // Irregular client payments rather than a payroll salary: no SALARY category at all,
    // which is exactly what makes this a thin file.
    salary: null,
    salaryDay: 15,
    salaryGrowthAtMonth: null,
    // A modest remittance from family abroad alongside the freelance receipts: two genuine
    // income streams, neither of them a salary.
    remittance: 14_000,
    rental: null,
    // Matches the NPR 62,000/month the CV declares, arriving as irregular client invoices.
    businessIncome: 62_000,
    emi: null,
    cardPayment: null,
    insurance: null,
    rentPaid: 14_000,
    essentialSpend: 13_000,
    discretionarySpend: 9_000,
    atmWithdrawal: 16_000,
    bouncesInMonths: [],
    skipEmiMonths: [],
    bankName: 'Nabil Bank Limited',
    accountNumber: '02987654321098',
  }),

  kycDocuments: ['NID_FRONT', 'NID_BACK'],
  residenceStatus: 'RENTED',
  nidVerified: true,
  kycFaceMatchScore: 0.93,
  activeLoanCount: 0,
};

/**
 * 3. Over-leveraged applicant with adverse events.
 *
 * Decent salary entirely consumed by debt service, bounced cheques, a skipped EMI and four
 * active loans. Exercises three independent mechanisms at once: the DSR band, the §4.2 bounce
 * cap on the Financial pillar, and the §5.3 overleveraging override.
 */
const overleveragedApplicant: FixtureProfile = {
  key: 'overleveraged-high-risk',
  label: 'Over-leveraged applicant with adverse events',
  expectedBand: 'HIGH_RISK or REJECT',
  notes:
    'Salary consumed by debt service, 3 bounced cheques, a skipped EMI and 4 active loans. ' +
    'Exercises the DSR band, the §4.2 bounce cap and the §5.3 overleveraging override together.',

  fullName: 'Bibek Adhikari',
  fatherName: 'Krishna Adhikari',
  email: 'bibek.adhikari@example.com',
  phone: '9812345678',
  nationalId: '19-04-78-33265',
  nationality: 'NP',
  address: 'Koteshwor, Kathmandu',
  yearsAtAddress: 2,

  productType: 'PERSONAL_LOAN',
  requestedAmountNpr: 1_200_000,
  tenureMonths: 48,

  resumeText: `Bibek Adhikari
Koteshwor, Kathmandu
bibek.adhikari@example.com | 9812345678

PERSONAL DETAILS
Name: Bibek Adhikari
Father's Name: Krishna Adhikari
Citizenship No: 19-04-78-33265
Address: Koteshwor, Kathmandu
Years at Address: 2
Current Salary: NPR 78,000
Expected Salary: NPR 150,000

WORK EXPERIENCE
Sales Officer, Everest Traders Pvt. Ltd. | Sep 2024 - Present
Regional sales. Salary: NPR 78,000 per month. Kathmandu, Nepal.

Sales Executive, Mountain Suppliers | Nov 2023 - Aug 2024
Salary: NPR 62,000 per month.

Marketing Assistant, Kathmandu Enterprises | Feb 2022 - Oct 2023
Salary: NPR 45,000 per month.

Junior Sales Representative, Local Agency | Jun 2021 - Jan 2022
Salary: NPR 32,000 per month.

EDUCATION
Bachelor of Business Studies, Tribhuvan University, Nepal, 2021

REFERENCES
References available on request
`,

  statementCsv: buildStatement({
    seed: 3003,
    months: 6,
    openingBalance: 12_000,
    salary: 78_000,
    salaryDay: 30,
    salaryGrowthAtMonth: null,
    remittance: null,
    rental: null,
    businessIncome: null,
    // EMI + card together consume well over half of verified income.
    emi: 31_000,
    cardPayment: 18_000,
    insurance: null,
    rentPaid: 16_000,
    essentialSpend: 12_000,
    discretionarySpend: 11_000,
    atmWithdrawal: 14_000,
    bouncesInMonths: [1, 3, 4],
    skipEmiMonths: [2],
    bankName: 'Global IME Bank Limited',
    accountNumber: '03456789012345',
  }),

  kycDocuments: ['NID_FRONT', 'NID_BACK', 'PAN_CARD'],
  residenceStatus: 'RENTED',
  nidVerified: true,
  kycFaceMatchScore: 0.95,
  activeLoanCount: 4,
};

export const FIXTURE_PROFILES: readonly FixtureProfile[] = [
  primeProfessional,
  thinFileGigWorker,
  overleveragedApplicant,
];
