/**
 * Global error boundary.
 *
 * Two responsibilities, both about not leaking:
 *
 *   · Unexpected errors return a generic message and a correlation id. A stack trace or a
 *     database error string reaching an applicant's browser is an information disclosure, and
 *     in this system those strings can contain PII.
 *   · The full detail is logged against that correlation id, so support can find it.
 */
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';

import { EmptyExtractionError } from '../extraction/document-extractor.port';
import { CryptoConfigError, DecryptionError } from './crypto.util';

interface ErrorBody {
  readonly statusCode: number;
  readonly message: string;
  readonly correlationId: string;
  readonly path: string;
  readonly timestamp: string;
  readonly details?: unknown;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();
    const correlationId = randomUUID();

    const { status, message, details, logLevel } = this.classify(exception);

    const body: ErrorBody = {
      statusCode: status,
      message,
      correlationId,
      path: request.url,
      timestamp: new Date().toISOString(),
      ...(details === undefined ? {} : { details }),
    };

    const logLine = `[${correlationId}] ${request.method} ${request.url} -> ${status}: ${
      exception instanceof Error ? exception.message : String(exception)
    }`;

    if (logLevel === 'error') {
      this.logger.error(logLine, exception instanceof Error ? exception.stack : undefined);
    } else {
      this.logger.warn(logLine);
    }

    response.status(status).json(body);
  }

  private classify(exception: unknown): {
    status: number;
    message: string;
    details?: unknown;
    logLevel: 'warn' | 'error';
  } {
    if (exception instanceof HttpException) {
      const payload = exception.getResponse();
      const status = exception.getStatus();
      return {
        status,
        message:
          typeof payload === 'string'
            ? payload
            : ((payload as { message?: string }).message ?? exception.message),
        details:
          typeof payload === 'object' && payload !== null && 'issues' in payload
            ? (payload as { issues: unknown }).issues
            : undefined,
        // 4xx is the client's problem and expected traffic; 5xx is ours.
        logLevel: status >= 500 ? 'error' : 'warn',
      };
    }

    // A document we genuinely cannot read is the applicant's problem to fix, and the message
    // is written to be actionable.
    if (exception instanceof EmptyExtractionError) {
      return {
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        message: exception.message,
        logLevel: 'warn',
      };
    }

    // Never surface crypto internals. A misconfigured key is an operational emergency, and
    // a failed decryption may indicate tampering — the client learns nothing either way.
    if (exception instanceof CryptoConfigError || exception instanceof DecryptionError) {
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        message: 'A secure storage operation failed. Support has been notified.',
        logLevel: 'error',
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      message:
        'An unexpected error occurred while processing the request. Quote the correlation id ' +
        'when contacting support.',
      logLevel: 'error',
    };
  }
}
