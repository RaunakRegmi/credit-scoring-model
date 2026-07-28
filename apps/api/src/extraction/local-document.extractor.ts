/**
 * The built-in, dependency-free extractor.
 *
 * This is the default adapter: it needs no API key, no network and no per-document cost, so
 * the whole pipeline — including the test suite and the demo — runs end to end out of the
 * box. It handles text-layer PDFs, DOCX and CSV/TSV well.
 *
 * Its honest limitation is scanned images: without an OCR engine there is no text to parse,
 * so those raise `EmptyExtractionError` and the application routes to manual review rather
 * than being scored on nothing. That is the correct failure. Setting `LLAMA_CLOUD_API_KEY`
 * swaps in the LlamaParse adapter, which does OCR.
 */
import { Injectable, Logger } from '@nestjs/common';

import {
  type DocumentExtractor,
  type RawDocument,
  type ResumeExtraction,
  type StatementExtraction,
} from './document-extractor.port';
import { parseResume } from './resume.parser';
import { parseStatement } from './statement.parser';
import { extractPlainText, extractTextCandidates } from './text-extraction.util';

/**
 * Ranks a parse so two readings of the same PDF can be compared.
 *
 * Confidence alone is not enough. It is presence-based — "did we find *any* employment" — so a
 * reading that recovers two of four roles scores identically to one that recovers all four, which
 * is exactly the difference a column reflow makes. Employment count is therefore the tiebreaker,
 * and it is the field the Professional and Behavioral pillars draw most of their points from.
 */
function parseQuality(result: ResumeExtraction): number {
  return result.confidence * 1000 + Math.min(result.employment.length, 20);
}

@Injectable()
export class LocalDocumentExtractor implements DocumentExtractor {
  readonly name = 'local-deterministic-v1';

  private readonly logger = new Logger(LocalDocumentExtractor.name);

  /**
   * Parses every reading the extractor can produce and keeps the best.
   *
   * A two-column PDF yields two candidate texts — content-stream order and column-reflowed — and
   * geometry alone cannot say which is right (see `pdf-layout.ts`). Rather than guess, parse both
   * and keep whichever recovers more structure. The parser is a far better judge of whether a
   * reading is coherent than any heuristic about gutters, and for every single-column document
   * there is only one candidate, so this costs nothing in the common case.
   */
  async extractResume(document: RawDocument): Promise<ResumeExtraction> {
    const candidates = await extractTextCandidates(document);

    let best = parseResume(candidates[0]);
    let bestIndex = 0;

    for (let index = 1; index < candidates.length; index += 1) {
      const candidate = parseResume(candidates[index] ?? '');
      if (parseQuality(candidate) > parseQuality(best)) {
        best = candidate;
        bestIndex = index;
      }
    }

    if (candidates.length > 1) {
      this.logger.debug(
        `Resume "${document.originalName}": ${candidates.length} readings considered, ` +
          `kept #${bestIndex}${bestIndex > 0 ? ' (column-reflowed)' : ' (as-read)'}`,
      );
    }

    this.logger.debug(
      `Resume "${document.originalName}": confidence ${best.confidence.toFixed(2)}, ` +
        `${best.employment.length} roles, education ${best.education.level}` +
        (best.missingFields.length > 0 ? `, missing: ${best.missingFields.join(', ')}` : ''),
    );

    return best;
  }

  async extractStatement(document: RawDocument): Promise<StatementExtraction> {
    const text = await extractPlainText(document);
    const result = parseStatement(text);

    this.logger.debug(
      `Statement "${document.originalName}": confidence ${result.confidence.toFixed(2)}, ` +
        `${result.transactions.length} transactions` +
        (result.missingFields.length > 0 ? `, missing: ${result.missingFields.join(', ')}` : ''),
    );

    return result;
  }
}
