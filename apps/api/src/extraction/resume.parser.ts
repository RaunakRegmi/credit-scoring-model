/**
 * Resume text -> `ResumeExtraction` (§3.1).
 *
 * A section-oriented parser: split the CV on its headings, then apply targeted rules
 * within each section. Matching "Bachelor of Science" anywhere in a document also matches
 * it inside a job description, so knowing that a line sits under EDUCATION rather than
 * EXPERIENCE is most of the accuracy.
 *
 * Confidence is the share of scoring-relevant fields actually recovered. It drives the
 * SOP-002 step 20 gate, so it deliberately reflects "can we score this applicant" rather
 * than "did the text parse" — a CV that yields a name and nothing else is a manual review,
 * not a successful extraction.
 */
import type { EducationLevel } from '@aics/contracts';

import {
  type ExtractedAward,
  type ExtractedCertification,
  type ExtractedEducation,
  type ExtractedEmployment,
  type ExtractedReference,
  type ResumeExtraction,
} from './document-extractor.port';
import {
  EDUCATION_RANK,
  PREMIUM_VISA_COUNTRIES,
  classifyEmployer,
  extractCountries,
  inferAwardScope,
  inferEducationLevel,
  inferReferenceTier,
  inferSeniorityRank,
  isInternationalCertification,
  resolveCountry,
} from './taxonomy';
import { findLabelledValue, normaliseLines, parseAmount, parseDate } from './text-extraction.util';

/** Canonical sections we care about, and the headings that introduce them. */
const SECTION_PATTERNS: Readonly<Record<string, RegExp>> = {
  PERSONAL: /^(personal\s+(details|information|profile)|bio\s?data|profile)\b/i,
  SUMMARY: /^(summary|objective|career\s+objective|professional\s+summary|about)\b/i,
  EXPERIENCE:
    /^(work\s+experience|professional\s+experience|employment(\s+history)?|experience|career\s+history|work\s+history)\b/i,
  EDUCATION: /^(education(al)?(\s+(qualification|background|details))?|academic(\s+background)?)\b/i,
  CERTIFICATIONS:
    /^(certifications?|trainings?|courses?|professional\s+development|skills?\s*(&|and)\s*certifications?|licen[cs]es?)\b/i,
  TRAVEL: /^(travel(\s+history)?|countries\s+(visited|travelled|traveled)|international\s+exposure|visas?)\b/i,
  REFERENCES: /^(references?|referees?)\b/i,
  AWARDS: /^(awards?|achievements?|honours?|honors?|recognitions?|publications?)\b/i,
  SKILLS: /^(skills?|technical\s+skills?|competenc(y|ies))\b/i,
  LANGUAGES: /^(languages?)\b/i,
};

type SectionName = keyof typeof SECTION_PATTERNS;

const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]{2,}/;
/** Nepali mobiles are 10 digits starting 97/98; also accepts general international forms. */
const PHONE_PATTERN = /(?:\+?977[\s-]?)?(?:9[678]\d{8})|\+\d{1,3}[\s-]?\d{6,14}/;

interface Sections {
  /** Lines before the first recognised heading — usually the name and contact block. */
  readonly header: string[];
  readonly byName: Map<SectionName, string[]>;
  readonly all: string[];
}

/** Splits the CV into sections keyed by canonical name. */
function splitSections(lines: readonly string[]): Sections {
  const header: string[] = [];
  const byName = new Map<SectionName, string[]>();

  let current: SectionName | null = null;

  for (const line of lines) {
    const matched = detectHeading(line);
    if (matched !== null) {
      current = matched;
      if (!byName.has(matched)) {
        byName.set(matched, []);
      }
      continue;
    }
    if (current === null) {
      header.push(line);
    } else {
      byName.get(current)?.push(line);
    }
  }

  return { header, byName, all: [...lines] };
}

/**
 * Decides whether a line is a section heading.
 *
 * Requires the line to be short as well as matching, because "Experience designing
 * payment systems for commercial banks" starts with the word Experience but is prose.
 */
function detectHeading(line: string): SectionName | null {
  const stripped = line.replace(/[:\s_\-–—=|]+$/g, '').trim();
  if (stripped.length === 0 || stripped.length > 60 || stripped.split(/\s+/).length > 6) {
    return null;
  }
  for (const [name, pattern] of Object.entries(SECTION_PATTERNS)) {
    if (pattern.test(stripped)) {
      return name as SectionName;
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Identity                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Picks the applicant's name.
 *
 * Prefers an explicit `Name:` label; otherwise takes the first header line that looks like
 * a person's name. The heuristic rejects lines with digits, '@' or too many words, which
 * removes addresses, contact lines and job titles.
 */
function extractFullName(sections: Sections): string | null {
  const labelled = findLabelledValue(
    [...sections.header, ...(sections.byName.get('PERSONAL') ?? [])],
    ['name', 'full name', 'candidate name', 'applicant name'],
  );
  if (labelled !== null && isPlausibleName(labelled)) {
    return cleanName(labelled);
  }

  for (const line of sections.header.slice(0, 6)) {
    if (isPlausibleName(line)) {
      return cleanName(line);
    }
  }
  return null;
}

function isPlausibleName(text: string): boolean {
  const cleaned = text.replace(/^(mr|mrs|ms|dr|prof)\.?\s+/i, '').trim();
  if (cleaned.length < 3 || cleaned.length > 80) {
    return false;
  }
  if (/[\d@|/\\]/.test(cleaned)) {
    return false;
  }
  const words = cleaned.split(/\s+/);
  if (words.length < 2 || words.length > 5) {
    return false;
  }
  // Reject lines that are actually job titles or headings.
  if (/\b(curriculum vitae|resume|engineer|manager|officer|developer|analyst|consultant)\b/i.test(cleaned)) {
    return false;
  }
  return words.every((word) => /^[A-Za-z][A-Za-z'\-.]*$/.test(word));
}

function cleanName(text: string): string {
  return text
    .replace(/^(mr|mrs|ms|dr|prof)\.?\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* -------------------------------------------------------------------------- */
/* Employment (§3.1, §4.3)                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Date range within an employment entry: `Jan 2020 - Present`, `2018–2021`, `01/2019 to 03/2022`.
 * Captured loosely because CVs punctuate ranges every way imaginable.
 */
const DATE_RANGE_PATTERN =
  /((?:[A-Za-z]{3,9}\.?\s+)?(?:\d{1,2}[/\-.])?\d{4})\s*(?:-|–|—|to|until|till)\s*(present|current|now|ongoing|(?:[A-Za-z]{3,9}\.?\s+)?(?:\d{1,2}[/\-.])?\d{4})/i;

/**
 * Parses the EXPERIENCE section into employment records.
 *
 * Entries are delimited by lines containing a date range: everything from one such line
 * (or the title line immediately above it) until the next forms one role. This copes with
 * both common layouts — `Title, Employer (dates)` on one line, and title/employer/dates on
 * consecutive lines.
 */
function extractEmployment(sections: Sections): ExtractedEmployment[] {
  const lines = sections.byName.get('EXPERIENCE') ?? [];
  if (lines.length === 0) {
    return [];
  }

  const entries: ExtractedEmployment[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) {
      continue;
    }

    const range = DATE_RANGE_PATTERN.exec(line);
    if (range === null) {
      continue;
    }

    const startDate = parseDate(range[1] ?? '');
    if (startDate === null) {
      continue;
    }

    const endToken = (range[2] ?? '').toLowerCase();
    const isCurrent = /^(present|current|now|ongoing)$/.test(endToken);
    const endDate = isCurrent ? null : parseDate(range[2] ?? '');

    // The descriptive text is whatever is on this line either side of the date range,
    // plus the preceding line when this line is only a date range.
    const inlineText = line.replace(DATE_RANGE_PATTERN, ' ').trim();
    const previous = index > 0 ? (lines[index - 1] ?? '') : '';
    const context = inlineText.length >= 4 ? inlineText : previous;

    const { title, employerName } = splitTitleAndEmployer(context, inlineText, previous);
    if (employerName === '' && title === '') {
      continue;
    }

    // Salary and country are often on the following couple of lines.
    const trailing = lines.slice(index + 1, index + 4).join(' ');
    const salaryNpr = extractSalaryNear(`${line} ${trailing}`);
    const country = resolveCountry(extractCountryToken(`${context} ${trailing}`) ?? '') ?? 'NP';

    entries.push({
      employerName: employerName === '' ? 'Undisclosed employer' : employerName,
      employerType: classifyEmployer(employerName),
      title: title === '' ? 'Unspecified role' : title,
      seniorityRank: inferSeniorityRank(title),
      startDate,
      endDate,
      isCurrent,
      salaryNpr,
      country,
    });
  }

  // Chronological, so the progression regression and tenure maths read naturally.
  return entries.sort((a, b) => a.startDate.getTime() - b.startDate.getTime());
}

/**
 * Separates a job title from an employer name.
 *
 * CVs use `Title at Employer`, `Title, Employer`, `Title | Employer` and `Title – Employer`
 * roughly interchangeably. When there is no separator at all we treat the line above as
 * the title and the line itself as the employer, which is the other common layout.
 */
function splitTitleAndEmployer(
  context: string,
  inlineText: string,
  previousLine: string,
): { title: string; employerName: string } {
  const cleaned = context.replace(/[()]/g, ' ').replace(/\s{2,}/g, ' ').trim();

  const separator = /\s+(?:at|@|,|\||–|—|-)\s+/.exec(cleaned);
  if (separator?.index !== undefined) {
    return {
      title: cleaned.slice(0, separator.index).trim(),
      employerName: cleaned.slice(separator.index + separator[0].length).trim(),
    };
  }

  // No separator: if the date line carried text, treat it as the employer and the line
  // above as the title.
  if (inlineText.length >= 4 && previousLine !== '' && isPlausibleTitle(previousLine)) {
    return { title: previousLine.trim(), employerName: inlineText.trim() };
  }

  return isPlausibleTitle(cleaned)
    ? { title: cleaned, employerName: '' }
    : { title: '', employerName: cleaned };
}

function isPlausibleTitle(text: string): boolean {
  return inferSeniorityRank(text) > 1 || /\b(officer|manager|engineer|analyst|director|head|lead|intern)\b/i.test(text);
}

function extractCountryToken(text: string): string | null {
  const countries = extractCountries(text);
  return countries[0] ?? null;
}

/** Finds a salary figure only when the text actually says it is one. */
function extractSalaryNear(text: string): number | null {
  const pattern =
    /(?:salary|ctc|remuneration|package|compensation|pay)\D{0,20}((?:npr|rs\.?|inr|usd|\$)?\s*[\d,]+(?:\.\d+)?\s*(?:lakh|lac|crore|k|million|mn)?)/i;
  const match = pattern.exec(text);
  if (match?.[1] === undefined) {
    return null;
  }
  const amount = parseAmount(match[1]);
  // A "salary" under 1,000 is a typo, a percentage or a year — not a monthly wage.
  return amount !== null && amount >= 1000 ? amount : null;
}

/* -------------------------------------------------------------------------- */
/* Education (§4.3)                                                            */
/* -------------------------------------------------------------------------- */

/** Takes the highest qualification listed, with its institution and country. */
function extractEducation(sections: Sections): ExtractedEducation {
  const lines = sections.byName.get('EDUCATION') ?? [];
  if (lines.length === 0) {
    return {
      level: 'NONE',
      institution: null,
      country: null,
      isAbroad: false,
      graduationYear: null,
      gpa: null,
    };
  }

  let best: ExtractedEducation | null = null;

  for (const [index, line] of lines.entries()) {
    const level = inferEducationLevel(line);
    if (level === 'NONE') {
      continue;
    }

    // Institution and year are often on the same line or the next one.
    const window = [line, lines[index + 1] ?? ''].join(' ');
    const institution = extractInstitution(window);
    const country = resolveCountry(extractCountryToken(window) ?? '');
    const graduationYear = extractYear(window);
    const gpa = extractGpa(window);

    const candidate: ExtractedEducation = {
      level,
      institution,
      country,
      // §4.3 prices international qualifications above local ones. Anything explicitly
      // outside Nepal counts as abroad; an unstated country defaults to domestic, which
      // is the conservative reading.
      isAbroad: country !== null && country !== 'NP',
      graduationYear,
      gpa,
    };

    if (best === null || EDUCATION_RANK[level] > EDUCATION_RANK[best.level]) {
      best = candidate;
    }
  }

  return (
    best ?? {
      level: 'NONE',
      institution: null,
      country: null,
      isAbroad: false,
      graduationYear: null,
      gpa: null,
    }
  );
}

function extractInstitution(text: string): string | null {
  const pattern =
    /((?:[A-Z][\w.&'-]*\s+){0,5}(?:University|College|Institute|School|Academy|Campus|Polytechnic)(?:\s+of\s+[\w\s]{2,40})?)/;
  const match = pattern.exec(text);
  const value = match?.[1]?.replace(/\s{2,}/g, ' ').trim();
  return value !== undefined && value.length > 3 ? value : null;
}

function extractYear(text: string): number | null {
  // Prefer the latest four-digit year in range — a degree line often carries both the
  // start and completion year.
  const years = [...text.matchAll(/\b(19[5-9]\d|20[0-4]\d)\b/g)]
    .map((match) => Number(match[1]))
    .filter((year) => year >= 1950 && year <= new Date().getUTCFullYear() + 6);
  return years.length === 0 ? null : Math.max(...years);
}

function extractGpa(text: string): number | null {
  // "CGPA 3.7", "GPA: 3.75/4", "3.6 CGPA"
  const labelled = /\b(?:c?gpa|grade point)\D{0,6}(\d(?:\.\d{1,2})?)/i.exec(text);
  if (labelled?.[1] !== undefined) {
    const value = Number.parseFloat(labelled[1]);
    return value >= 0 && value <= 4.5 ? value : null;
  }
  const trailing = /(\d\.\d{1,2})\s*(?:c?gpa)/i.exec(text);
  if (trailing?.[1] !== undefined) {
    const value = Number.parseFloat(trailing[1]);
    return value >= 0 && value <= 4.5 ? value : null;
  }
  // Percentage marks, converted to a 4.0 scale so the field means one thing.
  const percent = /\b(\d{2}(?:\.\d+)?)\s*%/.exec(text);
  if (percent?.[1] !== undefined) {
    const value = Number.parseFloat(percent[1]);
    if (value >= 30 && value <= 100) {
      return Math.round((value / 25) * 100) / 100;
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Certifications, references, awards, travel                                  */
/* -------------------------------------------------------------------------- */

function extractCertifications(sections: Sections): ExtractedCertification[] {
  const lines = sections.byName.get('CERTIFICATIONS') ?? [];
  const results: ExtractedCertification[] = [];

  for (const line of lines) {
    const cleaned = line.replace(/^[-•*·o]\s*/, '').trim();
    if (cleaned.length < 3 || cleaned.length > 200) {
      continue;
    }
    // Skip lines that are clearly prose rather than a certification name.
    if (cleaned.split(/\s+/).length > 18) {
      continue;
    }

    const year = extractYear(cleaned);
    const issuerMatch = /(?:from|by|issued by|–|—|-|,)\s*([A-Z][\w.&'\s-]{2,60})$/.exec(cleaned);

    results.push({
      name: cleaned.replace(/\s*\(\d{4}\)\s*$/, '').trim(),
      issuer: issuerMatch?.[1]?.trim() ?? null,
      isInternational: isInternationalCertification(cleaned),
      issuedYear: year,
    });
  }
  return results;
}

function extractReferences(sections: Sections): ExtractedReference[] {
  const lines = sections.byName.get('REFERENCES') ?? [];
  const results: ExtractedReference[] = [];

  for (const [index, line] of lines.entries()) {
    const cleaned = line.replace(/^[-•*·o]\s*/, '').trim();
    if (/available on request/i.test(cleaned)) {
      continue;
    }

    // A reference entry starts with a person's name; designation and organisation follow
    // on the same line after a separator, or on the next line.
    const parts = cleaned.split(/\s*[,|–—]\s*|\s+-\s+/).map((part) => part.trim());
    const name = parts[0] ?? '';
    if (!isPlausibleName(name)) {
      continue;
    }

    const window = [cleaned, lines[index + 1] ?? ''].join(' , ');
    const designation = parts[1] ?? extractDesignation(lines[index + 1] ?? '');
    const organisation = parts[2] ?? null;

    const email = EMAIL_PATTERN.exec(window)?.[0] ?? null;
    const phone = PHONE_PATTERN.exec(window)?.[0] ?? null;

    results.push({
      name: cleanName(name),
      designation: designation ?? null,
      organisation,
      tier: inferReferenceTier(designation ?? null),
      relationship: /\b(supervisor|manager|colleague|professor|mentor|client)\b/i.exec(window)?.[0] ?? null,
      contact: email ?? phone,
    });
  }
  return results;
}

function extractDesignation(text: string): string | null {
  const cleaned = text.replace(/^[-•*·o]\s*/, '').trim();
  if (cleaned === '' || EMAIL_PATTERN.test(cleaned)) {
    return null;
  }
  return inferSeniorityRank(cleaned) > 1 ? cleaned.split(/\s*[,|–—]\s*/)[0]?.trim() ?? null : null;
}

function extractAwards(sections: Sections): ExtractedAward[] {
  const lines = sections.byName.get('AWARDS') ?? [];
  return lines
    .map((line) => line.replace(/^[-•*·o]\s*/, '').trim())
    .filter((line) => line.length >= 4 && line.length <= 200 && line.split(/\s+/).length <= 20)
    .map((line) => ({
      title: line.replace(/\s*\(\d{4}\)\s*$/, '').trim(),
      scope: inferAwardScope(line),
      year: extractYear(line),
    }));
}

/**
 * Countries travelled (§4.4).
 *
 * Read from the TRAVEL section only. Scanning the whole CV would count the country of
 * every employer and university as somewhere the applicant "travelled", inflating the
 * mobility score for someone who has never left home.
 */
function extractTravel(sections: Sections): { countries: string[]; premiumVisas: string[] } {
  const lines = sections.byName.get('TRAVEL') ?? [];
  if (lines.length === 0) {
    return { countries: [], premiumVisas: [] };
  }

  const text = lines.join(' ');
  const countries = extractCountries(text);
  const premiumVisas = countries.filter((iso) => PREMIUM_VISA_COUNTRIES.includes(iso));

  // An explicitly named visa counts even if the country was not listed separately.
  if (/\bschengen\b/i.test(text) && !premiumVisas.includes('DE')) {
    premiumVisas.push('DE');
  }

  return { countries, premiumVisas };
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

/** Scoring-relevant fields, weighted by how much the score depends on them. */
const CONFIDENCE_WEIGHTS: readonly { field: string; weight: number }[] = [
  { field: 'fullName', weight: 1 },
  { field: 'email', weight: 1 },
  { field: 'phone', weight: 1 },
  { field: 'employment', weight: 4 },
  { field: 'education', weight: 2 },
  { field: 'pastSalary', weight: 2 },
  { field: 'certifications', weight: 1 },
  { field: 'references', weight: 1 },
];

export function parseResume(text: string): ResumeExtraction {
  const lines = normaliseLines(text);
  const sections = splitSections(lines);
  const wholeText = lines.join('\n');

  const fullName = extractFullName(sections);
  const email = EMAIL_PATTERN.exec(wholeText)?.[0]?.toLowerCase() ?? null;
  const phone = PHONE_PATTERN.exec(wholeText)?.[0]?.replace(/\s+/g, '') ?? null;

  const personalLines = [...sections.header, ...(sections.byName.get('PERSONAL') ?? [])];
  const fatherName = findLabelledValue(personalLines, [
    "father's name",
    'father name',
    'fathers name',
    'father',
  ]);
  const nationalId = findLabelledValue(personalLines, [
    'citizenship no',
    'citizenship number',
    'citizenship',
    'nid',
    'national id',
    'national identity',
  ]);
  const passportNumber = findLabelledValue(personalLines, ['passport no', 'passport number', 'passport']);
  const currentAddress = findLabelledValue(personalLines, [
    'address',
    'current address',
    'permanent address',
    'residence',
  ]);

  const yearsAtAddressRaw = findLabelledValue(personalLines, [
    'years at address',
    'duration at address',
    'residing since',
  ]);
  const yearsAtAddress = parseYearsAtAddress(yearsAtAddressRaw);

  const employment = extractEmployment(sections);
  const education = extractEducation(sections);
  const certifications = extractCertifications(sections);
  const references = extractReferences(sections);
  const awards = extractAwards(sections);
  const { countries, premiumVisas } = extractTravel(sections);

  // Salary: an explicit label anywhere wins; otherwise fall back to the most recent role.
  const pastSalaryNpr =
    parseSalaryLabel(lines, ['current salary', 'present salary', 'last salary', 'salary', 'ctc']) ??
    employment.at(-1)?.salaryNpr ??
    null;
  const expectedSalaryNpr = parseSalaryLabel(lines, [
    'expected salary',
    'salary expectation',
    'expected ctc',
    'desired salary',
  ]);

  const present: Record<string, boolean> = {
    fullName: fullName !== null,
    email: email !== null,
    phone: phone !== null,
    employment: employment.length > 0,
    education: education.level !== 'NONE',
    pastSalary: pastSalaryNpr !== null,
    certifications: certifications.length > 0,
    references: references.length > 0,
  };

  const totalWeight = CONFIDENCE_WEIGHTS.reduce((sum, entry) => sum + entry.weight, 0);
  const earned = CONFIDENCE_WEIGHTS.reduce(
    (sum, entry) => sum + (present[entry.field] === true ? entry.weight : 0),
    0,
  );

  const missingFields = CONFIDENCE_WEIGHTS.filter((entry) => present[entry.field] !== true).map(
    (entry) => entry.field,
  );

  return {
    fullName,
    fatherName,
    email,
    phone,
    nationalId,
    passportNumber,
    currentAddress,
    yearsAtAddress,
    pastSalaryNpr,
    expectedSalaryNpr,
    employment,
    education,
    countriesTraveled: countries,
    premiumVisas,
    references,
    certifications,
    awards,
    confidence: Math.round((earned / totalWeight) * 10000) / 10000,
    missingFields,
  };
}

function parseSalaryLabel(lines: readonly string[], labels: readonly string[]): number | null {
  const raw = findLabelledValue(lines, labels);
  if (raw === null) {
    return null;
  }
  const amount = parseAmount(raw);
  return amount !== null && amount >= 1000 ? amount : null;
}

/** Accepts "4 years", "since 2019" or a bare number. */
function parseYearsAtAddress(raw: string | null): number | null {
  if (raw === null) {
    return null;
  }
  const since = /\b(19|20)\d{2}\b/.exec(raw);
  if (/since/i.test(raw) && since?.[0] !== undefined) {
    const years = new Date().getUTCFullYear() - Number(since[0]);
    return years >= 0 && years <= 100 ? years : null;
  }
  const amount = parseAmount(raw);
  return amount !== null && amount >= 0 && amount <= 100 ? amount : null;
}

/** Re-exported for the education-level comparison in tests. */
export type { EducationLevel };
