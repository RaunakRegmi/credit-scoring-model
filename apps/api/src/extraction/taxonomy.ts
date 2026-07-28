/**
 * Classification tables used to turn resume free text into the typed values the scorecard
 * expects: employer categories (§4.3), seniority ranks for the career-progression
 * regression, education levels, country names, and certification recognition.
 *
 * These are ordinary lookup tables and keyword heuristics rather than a model. That is a
 * deliberate choice for the fields that drive points: a rule that assigns
 * "Nepal Investment Bank" to COMMERCIAL_BANK can be shown to an auditor and corrected in
 * one line. When `LLAMA_CLOUD_API_KEY` is set, the LLM adapter proposes these values and
 * these tables still normalise and bound them.
 */
import type { EducationLevel, EmployerType, ReferenceTier } from '@aics/contracts';

/* -------------------------------------------------------------------------- */
/* Countries                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Country name -> ISO 3166-1 alpha-2, covering the destinations that actually appear on
 * Nepali applicants' CVs: SAARC, the Gulf, East and Southeast Asia, OECD, plus the
 * common alternate spellings.
 */
export const COUNTRY_TO_ISO: Readonly<Record<string, string>> = {
  nepal: 'NP',
  india: 'IN',
  bangladesh: 'BD',
  pakistan: 'PK',
  'sri lanka': 'LK',
  srilanka: 'LK',
  bhutan: 'BT',
  maldives: 'MV',
  afghanistan: 'AF',
  myanmar: 'MM',
  burma: 'MM',

  china: 'CN',
  'hong kong': 'HK',
  hongkong: 'HK',
  taiwan: 'TW',
  japan: 'JP',
  'south korea': 'KR',
  korea: 'KR',
  singapore: 'SG',
  malaysia: 'MY',
  thailand: 'TH',
  vietnam: 'VN',
  indonesia: 'ID',
  philippines: 'PH',
  cambodia: 'KH',
  laos: 'LA',
  brunei: 'BN',
  mongolia: 'MN',

  uae: 'AE',
  'united arab emirates': 'AE',
  dubai: 'AE',
  'abu dhabi': 'AE',
  qatar: 'QA',
  'saudi arabia': 'SA',
  ksa: 'SA',
  kuwait: 'KW',
  bahrain: 'BH',
  oman: 'OM',
  jordan: 'JO',
  lebanon: 'LB',
  israel: 'IL',
  turkey: 'TR',
  turkiye: 'TR',

  'united states': 'US',
  'united states of america': 'US',
  usa: 'US',
  us: 'US',
  america: 'US',
  canada: 'CA',
  mexico: 'MX',
  brazil: 'BR',
  argentina: 'AR',
  chile: 'CL',
  colombia: 'CO',

  'united kingdom': 'GB',
  uk: 'GB',
  'great britain': 'GB',
  england: 'GB',
  scotland: 'GB',
  ireland: 'IE',
  france: 'FR',
  germany: 'DE',
  netherlands: 'NL',
  holland: 'NL',
  belgium: 'BE',
  luxembourg: 'LU',
  switzerland: 'CH',
  austria: 'AT',
  italy: 'IT',
  spain: 'ES',
  portugal: 'PT',
  greece: 'GR',
  sweden: 'SE',
  norway: 'NO',
  denmark: 'DK',
  finland: 'FI',
  iceland: 'IS',
  poland: 'PL',
  'czech republic': 'CZ',
  czechia: 'CZ',
  hungary: 'HU',
  slovakia: 'SK',
  slovenia: 'SI',
  estonia: 'EE',
  latvia: 'LV',
  lithuania: 'LT',
  croatia: 'HR',
  romania: 'RO',
  bulgaria: 'BG',
  russia: 'RU',
  ukraine: 'UA',

  australia: 'AU',
  'new zealand': 'NZ',

  'south africa': 'ZA',
  kenya: 'KE',
  nigeria: 'NG',
  egypt: 'EG',
  ethiopia: 'ET',
  tanzania: 'TZ',
  uganda: 'UG',
  ghana: 'GH',
  morocco: 'MA',
};

/**
 * §4.4 — "visa type premium (Schengen/US/UK = 2x)". Holding one of these signals having
 * cleared a demanding financial and documentary check by a third party.
 */
export const PREMIUM_VISA_COUNTRIES: readonly string[] = [
  'US',
  'GB',
  'CA',
  'AU',
  'NZ',
  'JP',
  // Schengen area.
  'AT', 'BE', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IS', 'IT', 'LV', 'LT',
  'LU', 'NL', 'NO', 'PL', 'PT', 'SK', 'SI', 'ES', 'SE', 'CH', 'HR',
];

export function resolveCountry(text: string): string | null {
  const normalised = text.trim().toLowerCase().replace(/[.,;]+$/, '');
  if (normalised === '') {
    return null;
  }
  const direct = COUNTRY_TO_ISO[normalised];
  if (direct !== undefined) {
    return direct;
  }
  // Already an ISO code?
  if (/^[A-Za-z]{2}$/.test(normalised)) {
    const upper = normalised.toUpperCase();
    if (Object.values(COUNTRY_TO_ISO).includes(upper)) {
      return upper;
    }
  }
  return null;
}

/** Extracts every recognisable country mentioned in a block of text. */
export function extractCountries(text: string): string[] {
  const found = new Set<string>();
  const haystack = text.toLowerCase();

  // Longest names first so "united states" wins over the substring "us".
  const names = Object.keys(COUNTRY_TO_ISO).sort((a, b) => b.length - a.length);

  for (const name of names) {
    // Word-boundary match; short codes like "us"/"uk" would otherwise hit inside words.
    const pattern = new RegExp(`(?<![a-z])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z])`);
    if (pattern.test(haystack)) {
      const iso = COUNTRY_TO_ISO[name];
      if (iso !== undefined) {
        found.add(iso);
      }
    }
  }
  return [...found];
}

/* -------------------------------------------------------------------------- */
/* Employer classification (§4.3)                                              */
/* -------------------------------------------------------------------------- */

interface EmployerRule {
  readonly type: EmployerType;
  readonly patterns: readonly RegExp[];
}

/**
 * Evaluated in order — the first match wins, so the most specific categories come first.
 * An explicit annotation on the CV (`Acme Corp (MNC)`) is handled separately and beats all
 * of these.
 */
const EMPLOYER_RULES: readonly EmployerRule[] = [
  {
    type: 'INTERNATIONAL_NGO',
    patterns: [
      /\b(united nations|\bun[a-z]{2,4}\b|undp|unicef|unesco|unhcr|world bank|asian development bank|\badb\b|imf|international monetary fund)\b/i,
      /\b(usaid|dfid|giz|jica|kfw|sida|danida|norad)\b/i,
      /\b(red cross|save the children|oxfam|care international|world vision|plan international|mercy corps)\b/i,
      /\b(international finance corporation|\bifc\b)\b/i,
    ],
  },
  {
    type: 'COMMERCIAL_BANK',
    patterns: [
      /\bbank\b/i,
      /\b(nrb|nepal rastra)\b/i,
      /\b(finance company|microfinance|bittiya sanstha)\b/i,
      /\b(citibank|hsbc|standard chartered|barclays|jpmorgan|goldman sachs|morgan stanley)\b/i,
    ],
  },
  {
    type: 'GOVERNMENT',
    patterns: [
      /\b(ministry|ministry of|government of|govt\.? of|department of|municipality|nagarpalika)\b/i,
      /\b(public service commission|inland revenue|customs|police|army|nepal telecom authority)\b/i,
      /\b(authority|commission|board of|corporation of nepal)\b/i,
    ],
  },
  {
    type: 'MNC',
    patterns: [
      // Well-known multinationals that commonly appear on CVs in the region.
      /\b(microsoft|google|alphabet|amazon|apple|meta|facebook|ibm|oracle|sap|intel|nvidia|cisco|dell|hp|hewlett)\b/i,
      /\b(deloitte|pwc|pricewaterhouse|ernst\s*&?\s*young|\bey\b|kpmg|mckinsey|bain|boston consulting|accenture|capgemini)\b/i,
      /\b(unilever|nestl[eé]|procter\s*&?\s*gamble|coca[\s-]?cola|pepsi|samsung|lg electronics|sony|toyota|honda|siemens|philips|bosch)\b/i,
      /\b(tata consultancy|\btcs\b|infosys|wipro|cognizant|hcl technologies|tech mahindra)\b/i,
      /\b(ncell|axiata|huawei|ericsson|nokia|zte)\b/i,
      /\b(multinational|\bmnc\b)\b/i,
    ],
  },
  {
    type: 'CORPORATE',
    patterns: [
      /\b(limited|ltd\.?|plc|incorporated|inc\.?|corporation|corp\.?|holdings|group|conglomerate)\b/i,
      /\b(hydropower|cement|airlines|insurance|hospital|medical college|university)\b/i,
    ],
  },
  {
    type: 'SME',
    patterns: [
      /\b(pvt\.?\s*ltd|private limited|enterprises|traders|trading|suppliers|store|shop|agency|associates|consultancy|studio|workshop)\b/i,
    ],
  },
  {
    type: 'INFORMAL',
    patterns: [
      /\b(freelance|self[\s-]?employed|own business|contractor|gig|part[\s-]?time|daily wage|home based)\b/i,
    ],
  },
];

/**
 * Classifies an employer.
 *
 * Defaults to SME rather than something more generous: an employer we cannot recognise
 * should not receive a premium it has not evidenced. §4.3 prices SME at 55/100, which is
 * a reasonable neutral position.
 */
export function classifyEmployer(employerName: string): EmployerType {
  const name = employerName.trim();
  if (name === '') {
    return 'INFORMAL';
  }

  // An explicit parenthetical annotation is authoritative: "Acme Corp (MNC)".
  const annotation = /\((mnc|bank|commercial bank|corporate|government|govt|ngo|ingo|sme|informal)\)/i.exec(
    name,
  );
  if (annotation?.[1] !== undefined) {
    switch (annotation[1].toLowerCase()) {
      case 'mnc':
        return 'MNC';
      case 'bank':
      case 'commercial bank':
        return 'COMMERCIAL_BANK';
      case 'corporate':
        return 'CORPORATE';
      case 'government':
      case 'govt':
        return 'GOVERNMENT';
      case 'ngo':
      case 'ingo':
        return 'INTERNATIONAL_NGO';
      case 'sme':
        return 'SME';
      case 'informal':
        return 'INFORMAL';
      default:
        break;
    }
  }

  for (const rule of EMPLOYER_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(name))) {
      return rule.type;
    }
  }
  return 'SME';
}

/* -------------------------------------------------------------------------- */
/* Seniority (§4.3 career progression index)                                   */
/* -------------------------------------------------------------------------- */

interface SeniorityRule {
  readonly rank: number;
  readonly patterns: readonly RegExp[];
}

/**
 * Ordered most senior first. The rank is the dependent variable in the §4.3 progression
 * regression, so what matters is that it is monotonic and consistent, not that the exact
 * integers mean anything absolute.
 */
const SENIORITY_RULES: readonly SeniorityRule[] = [
  { rank: 10, patterns: [/\b(ceo|chief executive|managing director|chairman|founder|proprietor|partner)\b/i, /\bchief\s+\w+\s+officer\b/i, /\b(cfo|coo|cto|cio|cro|cmo)\b/i] },
  { rank: 9, patterns: [/\b(executive director|deputy managing director|director|country head)\b/i] },
  { rank: 8, patterns: [/\b(vice president|\bvp\b|senior vice president|\bsvp\b|assistant vice president|\bavp\b)\b/i] },
  { rank: 7, patterns: [/\b(head of|general manager|\bgm\b|deputy general manager|\bdgm\b|principal|chief of)\b/i] },
  { rank: 6, patterns: [/\b(senior manager|department manager|regional manager|branch manager|lead architect)\b/i] },
  {
    // The bare word "manager" must NOT match inside "Assistant Manager" or "Deputy Manager",
    // which are rank 4. Ordering alone cannot fix this: the list runs most-senior-first, so
    // rank 5 is tested before rank 4 and would otherwise swallow both compounds. The
    // lookbehinds make the general term yield to the more specific one.
    rank: 5,
    patterns: [/(?<!assistant\s)(?<!deputy\s)\b(manager|product owner|scrum master)\b/i],
  },
  { rank: 4, patterns: [/\b(assistant manager|deputy manager|team lead|tech lead|supervisor|coordinator|superintendent)\b/i] },
  { rank: 3, patterns: [/\b(senior|sr\.?|specialist|consultant|lead)\b/i] },
  { rank: 2, patterns: [/\b(officer|associate|engineer|analyst|accountant|executive|developer|designer|teacher|nurse|technician|representative)\b/i] },
  { rank: 1, patterns: [/\b(intern|trainee|apprentice|junior|jr\.?|assistant|entry level|fresher|helper)\b/i] },
];

/**
 * Infers seniority from a job title.
 *
 * "Assistant Manager" must not be read as "Assistant" (rank 1), so the rules are ordered
 * to let the more senior compound match first — hence rank 4 above rank 1.
 */
export function inferSeniorityRank(title: string): number {
  const cleaned = title.trim();
  if (cleaned === '') {
    return 1;
  }
  for (const rule of SENIORITY_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(cleaned))) {
      return rule.rank;
    }
  }
  return 2; // Unrecognised individual-contributor title.
}

/* -------------------------------------------------------------------------- */
/* Education (§4.3)                                                            */
/* -------------------------------------------------------------------------- */

const EDUCATION_RULES: readonly { level: EducationLevel; patterns: readonly RegExp[] }[] = [
  { level: 'PHD', patterns: [/\b(ph\.?\s?d|doctorate|doctoral|d\.?phil)\b/i] },
  {
    level: 'MASTERS',
    patterns: [
      /\b(master'?s?|m\.?sc|m\.?a\b|m\.?b\.?a|m\.?tech|m\.?e\b|m\.?com|m\.?phil|mph|llm|pgdm|post[\s-]?graduate)\b/i,
    ],
  },
  {
    level: 'BACHELORS',
    patterns: [
      /\b(bachelor'?s?|b\.?sc|b\.?a\b|b\.?b\.?a|b\.?tech|b\.?e\b|b\.?com|b\.?ed|llb|mbbs|b\.?arch|undergraduate)\b/i,
    ],
  },
  { level: 'DIPLOMA', patterns: [/\b(diploma|certificate course|polytechnic|\bpcl\b|associate degree)\b/i] },
  { level: 'HIGHER_SECONDARY', patterns: [/\b(higher secondary|\+\s?2\b|intermediate|a[\s-]?level|hsc|\bslc\b\s*\+|12th)\b/i] },
  { level: 'SECONDARY', patterns: [/\b(secondary|\bslc\b|\bsee\b|o[\s-]?level|10th|matriculation)\b/i] },
];

export function inferEducationLevel(text: string): EducationLevel {
  for (const rule of EDUCATION_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(text))) {
      return rule.level;
    }
  }
  return 'NONE';
}

/** Ranking used to pick the highest qualification when a CV lists several. */
export const EDUCATION_RANK: Readonly<Record<EducationLevel, number>> = {
  PHD: 6,
  MASTERS: 5,
  BACHELORS: 4,
  DIPLOMA: 3,
  HIGHER_SECONDARY: 2,
  SECONDARY: 1,
  NONE: 0,
};

/* -------------------------------------------------------------------------- */
/* Certifications (§4.3)                                                       */
/* -------------------------------------------------------------------------- */

/**
 * §4.3 — "International certs (VISA, SWIFT, CFA, etc.) = 5pts each; local = 2pts".
 * Recognition here is what separates the two tiers.
 */
const INTERNATIONAL_CERT_PATTERNS: readonly RegExp[] = [
  /\b(cfa|frm|caia|cpa|aca|acca|cima|cma)\b/i,
  /\b(pmp|prince2|capm|csm|safe|itil|six sigma|lean)\b/i,
  /\b(cisa|cissp|cism|ceh|comptia|security\+)\b/i,
  /\b(aws|azure|google cloud|gcp|oracle certified|cisco|ccna|ccnp|ccie|red hat|rhce|kubernetes|cka)\b/i,
  /\b(swift|visa|mastercard|iso\s?\d{4,5}|basel|ifrs|gaap)\b/i,
  /\b(ielts|toefl|gre|gmat|sat)\b/i,
  /\b(microsoft certified|certified public|chartered)\b/i,
];

export function isInternationalCertification(name: string): boolean {
  return INTERNATIONAL_CERT_PATTERNS.some((pattern) => pattern.test(name));
}

/* -------------------------------------------------------------------------- */
/* References (§4.4)                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Maps a reference's designation to a tier. Reuses `inferSeniorityRank` so a reference's
 * seniority and an applicant's are judged on one scale rather than two that could drift.
 */
export function inferReferenceTier(designation: string | null): ReferenceTier {
  if (designation === null || designation.trim() === '') {
    return 'UNKNOWN';
  }
  const rank = inferSeniorityRank(designation);
  if (rank >= 10) return 'C_SUITE';
  if (rank >= 9) return 'DIRECTOR';
  if (rank >= 6) return 'SENIOR_MANAGER';
  if (rank >= 4) return 'MANAGER';
  return 'PEER';
}

/* -------------------------------------------------------------------------- */
/* Awards (§4.4)                                                              */
/* -------------------------------------------------------------------------- */

export function inferAwardScope(text: string): 'INTERNATIONAL' | 'NATIONAL' | 'COMPANY' {
  if (/\b(international|global|world|asia|regional|foreign)\b/i.test(text)) {
    return 'INTERNATIONAL';
  }
  if (/\b(national|nepal|country|federal|state|government)\b/i.test(text)) {
    return 'NATIONAL';
  }
  return 'COMPANY';
}
