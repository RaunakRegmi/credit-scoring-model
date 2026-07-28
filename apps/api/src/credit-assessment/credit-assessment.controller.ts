/**
 * HTTP surface for the assessment pipeline.
 *
 * Validation happens at the edge with the zod schemas from `@aics/contracts`, so the request
 * shape the dashboard sends and the shape this controller accepts cannot drift.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import {
  CAN_REVIEW_APPLICATIONS,
  DOCUMENT_TYPES,
  RESIDENCE_STATUSES,
  createApplicationSchema,
  type CreditAssessmentResult,
  type DocumentType,
  type ResidenceStatus,
} from '@aics/contracts';
import { z } from 'zod';

import { Roles } from '../auth/auth.decorators';
import { APP_CONFIG, type AppConfig } from '../config/configuration';

import {
  CreditAssessmentService,
  type UploadedFile,
} from './credit-assessment.service';

/** Optional multipart fields accompanying the two documents. */
const uploadMetadataSchema = z.object({
  kycDocuments: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((value) => {
      if (value === undefined) {
        return [] as DocumentType[];
      }
      const raw = Array.isArray(value) ? value : value.split(',');
      return raw
        .map((entry) => entry.trim().toUpperCase())
        .filter((entry): entry is DocumentType =>
          (DOCUMENT_TYPES as readonly string[]).includes(entry),
        );
    }),
  residenceStatus: z
    .string()
    .optional()
    .transform((value) => {
      const upper = value?.trim().toUpperCase();
      return upper !== undefined && (RESIDENCE_STATUSES as readonly string[]).includes(upper)
        ? (upper as ResidenceStatus)
        : undefined;
    }),
});

interface UploadedFileMap {
  readonly resume?: UploadedFile[];
  readonly statement?: UploadedFile[];
}

/**
 * Every route here requires an authenticated staff session — the global guard in `AuthModule`
 * closes them by default and none of them opt out.
 *
 * This is a staff-operated intake, not a public applicant portal: an underwriter or credit
 * officer captures the application and uploads the documents. A self-service portal would need
 * its own controller with applicant-scoped authorisation, because "any authenticated staff member
 * may read any assessment" is correct for internal use and completely wrong for an applicant.
 */
@Controller('api/credit-assessment')
export class CreditAssessmentController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly service: CreditAssessmentService,
  ) {}

  /** SOP-001 steps 1–5: create the application and capture consent. */
  @Roles(...CAN_REVIEW_APPLICATIONS)
  @Post('applications')
  async createApplication(@Body() body: unknown): Promise<{ id: string; arn: string }> {
    const parsed = createApplicationSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: 'Invalid application payload',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    return this.service.createApplication(parsed.data);
  }

  /**
   * SOP-001 step 2 onward: upload documents, extract, score and decide.
   *
   * Synchronous by design. §6.2 budgets the whole pipeline under four seconds, which is well
   * inside a request, and returning the decision directly avoids the applicant polling for a
   * result that is already computed.
   */
  @Roles(...CAN_REVIEW_APPLICATIONS)
  @Post('applications/:id/documents')
  @HttpCode(200)
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'resume', maxCount: 1 },
        { name: 'statement', maxCount: 1 },
      ],
      {
        limits: {
          // SOP-001 step 6: 10MB per document.
          fileSize: 10 * 1024 * 1024,
          files: 2,
        },
      },
    ),
  )
  async uploadDocuments(
    @Param('id', ParseUUIDPipe) applicationId: string,
    @UploadedFiles() files: UploadedFileMap,
    @Body() body: unknown,
  ): Promise<CreditAssessmentResult> {
    const resume = files.resume?.[0];
    const statement = files.statement?.[0];

    const missing: string[] = [];
    if (resume === undefined) missing.push('resume');
    if (statement === undefined) missing.push('statement');
    if (resume === undefined || statement === undefined) {
      throw new BadRequestException(
        `Missing required document(s): ${missing.join(', ')}. Both a resume and a 6-month bank ` +
          'statement are required (SOP-001 steps 6–7).',
      );
    }

    for (const [field, file] of [
      ['resume', resume],
      ['statement', statement],
    ] as const) {
      if (file.size > this.config.storage.maxUploadBytes) {
        throw new BadRequestException(
          `${field} exceeds the ${Math.floor(
            this.config.storage.maxUploadBytes / 1024 / 1024,
          )}MB limit`,
        );
      }
    }

    const metadata = uploadMetadataSchema.safeParse(body ?? {});
    const options = metadata.success
      ? {
          kycDocuments: metadata.data.kycDocuments,
          ...(metadata.data.residenceStatus !== undefined
            ? { residenceStatus: metadata.data.residenceStatus }
            : {}),
        }
      : {};

    return this.service.processDocumentUpload(applicationId, resume, statement, options);
  }

  /**
   * Latest assessment for an application.
   *
   * No `@Roles` — readable by any authenticated staff member, compliance included. Read access to
   * a decision is exactly what a compliance officer's job requires; write access is not.
   */
  @Get('applications/:id')
  async getAssessment(
    @Param('id', ParseUUIDPipe) applicationId: string,
  ): Promise<CreditAssessmentResult> {
    const result = await this.service.getAssessment(applicationId);
    if (result === null) {
      throw new NotFoundException(
        `No completed assessment found for application ${applicationId}`,
      );
    }
    return result;
  }
}
