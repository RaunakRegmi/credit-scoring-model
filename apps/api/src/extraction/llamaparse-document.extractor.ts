/**
 * LlamaParse adapter (§3.1.1 — "LLM pipeline using NER, OCR and structured JSON extraction").
 *
 * Selected automatically when `LLAMA_CLOUD_API_KEY` is present. It uploads the document,
 * polls for completion, and returns the parsed markdown — which the same deterministic
 * parsers then interpret.
 *
 * That last point is the important design decision: LlamaParse replaces the *text
 * acquisition* step, not the *interpretation* step. Its job is to turn a scanned or
 * awkwardly-laid-out PDF into clean, linearised markdown, which it does far better than a
 * local text layer read. But the mapping from text to scoring fields stays in
 * `resume.parser.ts` and `statement.parser.ts`, so:
 *
 *   · Both adapters produce identical field semantics — no "the LLM decided differently
 *     today" drift between an application scored with a key and one scored without.
 *   · The rules that assign points remain auditable, which is what §6.3 and NRB require.
 *   · A vendor outage degrades to the local path rather than taking scoring down.
 */
import { Injectable, Logger } from '@nestjs/common';

import { EmptyExtractionError } from './document-extractor.port';
import type {
  DocumentExtractor,
  RawDocument,
  ResumeExtraction,
  StatementExtraction,
} from './document-extractor.port';
import { LocalDocumentExtractor } from './local-document.extractor';
import { parseResume } from './resume.parser';
import { parseStatement } from './statement.parser';

interface UploadResponse {
  readonly id: string;
}

interface JobStatusResponse {
  readonly status: string;
}

interface MarkdownResponse {
  readonly markdown?: string;
  readonly text?: string;
}

export interface LlamaParseOptions {
  readonly apiKey: string;
  readonly baseUrl: string;
  /** Overall ceiling for upload + poll + fetch. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 1_500;

@Injectable()
export class LlamaParseDocumentExtractor implements DocumentExtractor {
  readonly name = 'llamaparse-v1';

  private readonly logger = new Logger(LlamaParseDocumentExtractor.name);
  private readonly timeoutMs: number;

  constructor(
    private readonly options: LlamaParseOptions,
    /**
     * Used when LlamaParse is unreachable. Falling back to a lower-quality extraction that
     * flags itself is better than failing the application outright — the confidence score
     * carries the loss of quality into the decision, where it belongs.
     */
    private readonly fallback: LocalDocumentExtractor,
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async extractResume(document: RawDocument): Promise<ResumeExtraction> {
    const text = await this.parseToText(document);
    if (text === null) {
      this.logger.warn(
        `LlamaParse unavailable for "${document.originalName}"; falling back to the local extractor.`,
      );
      return this.fallback.extractResume(document);
    }
    return parseResume(text);
  }

  async extractStatement(document: RawDocument): Promise<StatementExtraction> {
    const text = await this.parseToText(document);
    if (text === null) {
      this.logger.warn(
        `LlamaParse unavailable for "${document.originalName}"; falling back to the local extractor.`,
      );
      return this.fallback.extractStatement(document);
    }
    return parseStatement(text);
  }

  /**
   * Runs a document through LlamaParse.
   *
   * Returns `null` on any transport or vendor failure, which signals the caller to fall
   * back. Throws only for `EmptyExtractionError` — a document that genuinely contains
   * nothing is not a vendor problem and must not be retried locally.
   */
  private async parseToText(document: RawDocument): Promise<string | null> {
    const deadline = Date.now() + this.timeoutMs;

    try {
      const jobId = await this.upload(document, deadline);
      await this.awaitCompletion(jobId, deadline);
      const text = await this.fetchMarkdown(jobId, deadline);

      if (text.trim().length < 20) {
        throw new EmptyExtractionError(
          document.originalName,
          'LlamaParse returned no usable content',
        );
      }
      return text;
    } catch (error) {
      if (error instanceof EmptyExtractionError) {
        throw error;
      }
      this.logger.error(
        `LlamaParse failed for "${document.originalName}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  private async upload(document: RawDocument, deadline: number): Promise<string> {
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(document.buffer)], { type: document.mimeType }),
      document.originalName,
    );
    // Markdown preserves the table structure that statement parsing depends on.
    form.append('result_type', 'markdown');

    const response = await this.request(
      `${this.options.baseUrl}/api/parsing/upload`,
      { method: 'POST', body: form },
      deadline,
    );

    const payload = (await response.json()) as UploadResponse;
    if (typeof payload.id !== 'string' || payload.id === '') {
      throw new Error('LlamaParse upload returned no job id');
    }
    return payload.id;
  }

  private async awaitCompletion(jobId: string, deadline: number): Promise<void> {
    while (Date.now() < deadline) {
      const response = await this.request(
        `${this.options.baseUrl}/api/parsing/job/${jobId}`,
        { method: 'GET' },
        deadline,
      );
      const payload = (await response.json()) as JobStatusResponse;
      const status = payload.status.toUpperCase();

      if (status === 'SUCCESS' || status === 'COMPLETED') {
        return;
      }
      if (status === 'ERROR' || status === 'FAILED' || status === 'CANCELLED') {
        throw new Error(`LlamaParse job ${jobId} finished with status ${status}`);
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        break;
      }
      await sleep(Math.min(POLL_INTERVAL_MS, remaining));
    }
    throw new Error(`LlamaParse job ${jobId} did not complete within ${this.timeoutMs}ms`);
  }

  private async fetchMarkdown(jobId: string, deadline: number): Promise<string> {
    const response = await this.request(
      `${this.options.baseUrl}/api/parsing/job/${jobId}/result/markdown`,
      { method: 'GET' },
      deadline,
    );
    const payload = (await response.json()) as MarkdownResponse;
    return payload.markdown ?? payload.text ?? '';
  }

  /** Adds auth, enforces the shared deadline and turns non-2xx into a thrown error. */
  private async request(url: string, init: RequestInit, deadline: number): Promise<Response> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error('LlamaParse deadline exceeded');
    }

    const response = await fetch(url, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${this.options.apiKey}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(remaining),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`LlamaParse ${response.status} ${response.statusText}: ${body.slice(0, 300)}`);
    }
    return response;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
