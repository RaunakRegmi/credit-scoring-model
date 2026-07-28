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
import { extractPlainText } from './text-extraction.util';

@Injectable()
export class LocalDocumentExtractor implements DocumentExtractor {
  readonly name = 'local-deterministic-v1';

  private readonly logger = new Logger(LocalDocumentExtractor.name);

  async extractResume(document: RawDocument): Promise<ResumeExtraction> {
    const text = await extractPlainText(document);
    const result = parseResume(text);

    this.logger.debug(
      `Resume "${document.originalName}": confidence ${result.confidence.toFixed(2)}, ` +
        `${result.employment.length} roles, education ${result.education.level}` +
        (result.missingFields.length > 0 ? `, missing: ${result.missingFields.join(', ')}` : ''),
    );

    return result;
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
