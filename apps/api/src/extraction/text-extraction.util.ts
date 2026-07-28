/**
 * Buffer -> plain text, for the local extractor.
 *
 * Format detection uses the magic bytes first and the filename only as a tiebreaker.
 * Browsers routinely send `application/octet-stream` for a PDF, and users rename files;
 * trusting the declared MIME type is how a valid document gets rejected as unsupported.
 */
import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';

import { EmptyExtractionError, type RawDocument } from './document-extractor.port';
import { reconstructPage, type PdfPageLike } from './pdf-layout';

export type DetectedFormat = 'PDF' | 'DOCX' | 'CSV' | 'TEXT' | 'UNKNOWN';

/** Sniffs the format from the file's leading bytes. */
export function detectFormat(document: RawDocument): DetectedFormat {
  const { buffer, originalName, mimeType } = document;

  if (buffer.length >= 4) {
    // "%PDF"
    if (buffer.subarray(0, 4).toString('latin1') === '%PDF') {
      return 'PDF';
    }
    // "PK\x03\x04" — a zip container. DOCX is a zip; so is xlsx, which we do not accept.
    if (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
      return /\.docx$/i.test(originalName) || mimeType.includes('wordprocessingml')
        ? 'DOCX'
        : 'UNKNOWN';
    }
  }

  const lowerName = originalName.toLowerCase();
  if (lowerName.endsWith('.csv') || mimeType === 'text/csv') {
    return 'CSV';
  }
  if (lowerName.endsWith('.txt') || mimeType.startsWith('text/')) {
    return 'TEXT';
  }

  // Fall back to a printable-character heuristic: statements are often uploaded as CSV
  // with an unhelpful MIME type.
  const sample = buffer.subarray(0, Math.min(2048, buffer.length)).toString('utf8');
  if (sample.length > 0) {
    const printableRatio =
      sample.split('').filter((char) => char >= ' ' || char === '\n' || char === '\r' || char === '\t')
        .length / sample.length;
    if (printableRatio > 0.9) {
      return sample.includes(',') || sample.includes('\t') ? 'CSV' : 'TEXT';
    }
  }

  return 'UNKNOWN';
}

/**
 * Extracts text from a document.
 *
 * Throws `EmptyExtractionError` when there is nothing to work with. That is a meaningfully
 * different outcome from "parsed but found few fields": an image-only scan needs OCR, not
 * a second look at the regexes, and the caller routes it to manual review on that basis.
 */
export async function extractPlainText(document: RawDocument): Promise<string> {
  const [primary] = await extractTextCandidates(document);
  return primary;
}

/**
 * Every plausible reading of the document, best-guess first.
 *
 * A PDF can yield two: the content-stream order, and — when the page geometry shows columns — the
 * column-ordered reflow. Which one is *correct* cannot be settled geometrically (see
 * `pdf-layout.ts`), so both are returned and the caller picks using its own parser as the judge.
 * Callers that do not care can use `extractPlainText` and get the first.
 *
 * Non-PDF formats have exactly one reading.
 */
export async function extractTextCandidates(
  document: RawDocument,
): Promise<[string, ...string[]]> {
  if (document.buffer.length === 0) {
    throw new EmptyExtractionError(document.originalName, 'file is empty');
  }

  const format = detectFormat(document);

  switch (format) {
    case 'PDF': {
      const { reading, geometric } = await extractPdfReadings(document);
      if (reading.trim().length < 20 && (geometric ?? '').trim().length < 20) {
        throw new EmptyExtractionError(
          document.originalName,
          'the PDF contains no extractable text layer — it is most likely a scan and needs OCR ' +
            '(set LLAMA_CLOUD_API_KEY to route it through LlamaParse)',
        );
      }
      return geometric === null ? [reading] : [reading, geometric];
    }

    case 'DOCX': {
      const result = await mammoth.extractRawText({ buffer: document.buffer });
      if (result.value.trim().length < 20) {
        throw new EmptyExtractionError(document.originalName, 'the document contains no text');
      }
      return [result.value];
    }

    case 'CSV':
    case 'TEXT': {
      const text = document.buffer.toString('utf8');
      if (text.trim().length === 0) {
        throw new EmptyExtractionError(document.originalName, 'the file contains no text');
      }
      return [text];
    }

    case 'UNKNOWN':
    default:
      throw new EmptyExtractionError(
        document.originalName,
        `unsupported format (declared MIME type "${document.mimeType}"). ` +
          'Accepted: PDF, DOCX, CSV, TXT.',
      );
  }
}

interface PdfReadings {
  /** Content-stream order, straight from the library. The historical behaviour. */
  readonly reading: string;
  /**
   * Column-ordered reflow, or `null` when no page showed columns worth reordering. Pages without
   * columns contribute their library text unchanged, so this is a whole-document alternative
   * rather than a partial one.
   */
  readonly geometric: string | null;
}

/**
 * PDF -> text, twice: once as the library reads it, once with columns reflowed.
 *
 * Reflow is attempted per page rather than per document, so a CV whose first page is a two-column
 * summary and whose second is plain prose has each page handled on its own terms. If no page offers
 * a column reordering, `columnOrdered` is `null` and there is exactly one reading — which is the
 * common case, and it takes the identical path it took before column handling existed.
 */
async function extractPdfReadings(document: RawDocument): Promise<PdfReadings> {
  try {
    // A fresh Uint8Array: pdf.js takes ownership of the buffer it is handed and will
    // detach it, which corrupts the caller's Buffer if we pass a view over the same memory.
    const bytes = new Uint8Array(document.buffer.byteLength);
    bytes.set(document.buffer);

    const pdf = await getDocumentProxy(bytes);

    const { text } = await extractText(pdf, { mergePages: false });
    const libraryPages = Array.isArray(text) ? text : [String(text)];

    const reconstructedPages: string[] = [];
    let anyReconstructed = false;

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const fallback = libraryPages[pageNumber - 1] ?? '';
      let reconstructed: string | null = null;
      try {
        const page = (await pdf.getPage(pageNumber)) as unknown as PdfPageLike;
        reconstructed = await reconstructPage(page);
      } catch {
        // Reflow is an accuracy improvement, not a correctness requirement. A page whose glyph
        // positions cannot be read still has the library's text, and losing that to an exception
        // raised while trying to improve it would be a strictly worse outcome.
        reconstructed = null;
      }
      if (reconstructed !== null) {
        anyReconstructed = true;
      }
      reconstructedPages.push(reconstructed ?? fallback);
    }

    return {
      reading: libraryPages.join('\n'),
      geometric: anyReconstructed ? reconstructedPages.join('\n') : null,
    };
  } catch (error) {
    if (error instanceof EmptyExtractionError) {
      throw error;
    }
    throw new EmptyExtractionError(
      document.originalName,
      `PDF could not be parsed (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Text helpers                                                                */
/* -------------------------------------------------------------------------- */

/** Normalises whitespace while preserving line structure, which the parsers rely on. */
export function normaliseLines(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    // Non-breaking and zero-width characters are common in PDF text layers.
    .replace(/[ ​‌‍﻿]/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line.length > 0);
}

/**
 * Parses a money amount out of free text.
 *
 * Handles thousands separators, currency symbols and the South Asian lakh/crore units that
 * appear constantly in Nepali and Indian documents ("NPR 2.5 lakh").
 */
export function parseAmount(text: string): number | null {
  const cleaned = text.replace(/[^0-9.,\-a-zA-Z\s]/g, ' ').trim();
  if (cleaned === '') {
    return null;
  }

  const match = /(-?\d[\d,]*(?:\.\d+)?)/.exec(cleaned);
  if (match?.[1] === undefined) {
    return null;
  }

  const base = Number.parseFloat(match[1].replace(/,/g, ''));
  if (!Number.isFinite(base)) {
    return null;
  }

  if (/\bcrore?s?\b/i.test(text)) {
    return base * 10_000_000;
  }
  if (/\blakh?s?\b|\blac\b/i.test(text)) {
    return base * 100_000;
  }
  if (/\bmillions?\b|\bmn\b/i.test(text)) {
    return base * 1_000_000;
  }
  if (/\bthousands?\b|\bk\b/i.test(text)) {
    return base * 1_000;
  }

  return base;
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

/**
 * Parses the date formats that actually turn up in CVs and statements.
 *
 * Everything is built in UTC. Financial aggregation buckets by calendar month, and a
 * local-timezone `Date` silently reassigns a 1st-of-month transaction to the previous
 * month for anyone east of Greenwich — Nepal is UTC+5:45, so this is not hypothetical.
 */
export function parseDate(text: string): Date | null {
  const cleaned = text.trim();
  if (cleaned === '') {
    return null;
  }

  // ISO: 2026-03-15
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(cleaned);
  if (iso) {
    return buildUtcDate(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  }

  // Separated numeric: 15/03/2026, 15-03-2026, 15.03.2026, 03/15/2026
  const separated = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/.exec(cleaned);
  if (separated) {
    const first = Number(separated[1]);
    const second = Number(separated[2]);
    const year = normaliseYear(Number(separated[3]));

    // Only one ordering can be valid when a component exceeds 12. When both are ≤ 12 the
    // date is genuinely ambiguous, and we resolve to day-first: that is the convention in
    // Nepal and across the statement formats this system ingests.
    if (first > 12) {
      return buildUtcDate(year, second - 1, first);
    }
    if (second > 12) {
      return buildUtcDate(year, first - 1, second);
    }
    return buildUtcDate(year, second - 1, first);
  }

  // "15 Mar 2026" / "15 March 2026"
  const dayMonthName = /^(\d{1,2})\s+([A-Za-z]+)\.?\s+(\d{2,4})/.exec(cleaned);
  if (dayMonthName?.[2] !== undefined) {
    const month = MONTHS[dayMonthName[2].toLowerCase()];
    if (month !== undefined) {
      return buildUtcDate(normaliseYear(Number(dayMonthName[3])), month, Number(dayMonthName[1]));
    }
  }

  // "Mar 15, 2026" / "March 2026"
  const monthNameFirst = /^([A-Za-z]+)\.?\s+(\d{1,2})?,?\s*(\d{4})/.exec(cleaned);
  if (monthNameFirst?.[1] !== undefined) {
    const month = MONTHS[monthNameFirst[1].toLowerCase()];
    if (month !== undefined) {
      const day = monthNameFirst[2] === undefined ? 1 : Number(monthNameFirst[2]);
      return buildUtcDate(Number(monthNameFirst[3]), month, day);
    }
  }

  // Bare year: "2026"
  const bareYear = /^(19|20)\d{2}$/.exec(cleaned);
  if (bareYear) {
    return buildUtcDate(Number(cleaned), 0, 1);
  }

  return null;
}

function normaliseYear(year: number): number {
  if (year >= 1000) {
    return year;
  }
  // Two-digit years: 70–99 are 1900s, 00–69 are 2000s.
  return year >= 70 ? 1900 + year : 2000 + year;
}

/** Builds a UTC date, rejecting values that overflow (e.g. 31 February). */
function buildUtcDate(year: number, month: number, day: number): Date | null {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }
  if (year < 1900 || year > 2200 || month < 0 || month > 11 || day < 1 || day > 31) {
    return null;
  }
  const date = new Date(Date.UTC(year, month, day));
  // Date.UTC rolls over; if it did, the input was not a real calendar date.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) {
    return null;
  }
  return date;
}

/** Reads a "Label: value" pair from a set of lines, trying each label in turn. */
export function findLabelledValue(
  lines: readonly string[],
  labels: readonly string[],
): string | null {
  for (const label of labels) {
    const pattern = new RegExp(
      `^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:\\-–]\\s*(.+)$`,
      'i',
    );
    for (const line of lines) {
      const match = pattern.exec(line);
      if (match?.[1] !== undefined && match[1].trim() !== '') {
        return match[1].trim();
      }
    }
  }
  return null;
}
