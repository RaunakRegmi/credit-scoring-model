/**
 * The underwriter review queue.
 *
 * Read access is broad — any authenticated staff member, compliance included, may look at the
 * queue and at a referral's full assessment. Write access is narrow: recording a decision is
 * restricted to the roles that hold credit authority.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  CAN_REVIEW_APPLICATIONS,
  submitReviewSchema,
  type CreditAssessmentResult,
  type QueuePage,
  type ReviewRecord,
} from '@aics/contracts';
import { z } from 'zod';

import { CurrentStaff, Roles } from '../auth/auth.decorators';
import { CreditAssessmentService } from '../credit-assessment/credit-assessment.service';

import { UnderwriterService } from './underwriter.service';
import type { AuthenticatedStaff } from '../auth/token.service';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

interface ReferralDetail {
  readonly assessment: CreditAssessmentResult;
  readonly reviews: readonly ReviewRecord[];
}

@Controller('api/underwriter')
export class UnderwriterController {
  constructor(
    private readonly underwriter: UnderwriterService,
    private readonly assessments: CreditAssessmentService,
  ) {}

  /** Referrals awaiting a decision, oldest first. */
  @Get('queue')
  async queue(@Query() query: unknown): Promise<QueuePage> {
    const parsed = querySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: 'Invalid queue query',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    return this.underwriter.queue(parsed.data);
  }

  /**
   * Everything needed to decide one referral: the same assessment payload the assessment view
   * renders, plus any prior reviews.
   *
   * Deliberately the *same* payload rather than an underwriter-specific summary. A human deciding
   * an application should see exactly what the engine produced — score, pillar breakdown, factor
   * attributions, degradation flags — not a condensed version of it that quietly drops the
   * caveats.
   */
  @Get('applications/:id')
  async detail(@Param('id', ParseUUIDPipe) applicationId: string): Promise<ReferralDetail> {
    const [assessment, reviews] = await Promise.all([
      this.assessments.getAssessment(applicationId),
      this.underwriter.reviewHistory(applicationId),
    ]);

    if (assessment === null) {
      throw new NotFoundException(`No completed assessment found for application ${applicationId}`);
    }

    return { assessment, reviews };
  }

  /** SOP-004: record a human decision on a referred application. */
  @Roles(...CAN_REVIEW_APPLICATIONS)
  @Post('applications/:id/review')
  async review(
    @Param('id', ParseUUIDPipe) applicationId: string,
    @CurrentStaff() staff: AuthenticatedStaff,
    @Body() body: unknown,
  ): Promise<ReviewRecord> {
    const parsed = submitReviewSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: 'Invalid review payload',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    return this.underwriter.submitReview(applicationId, staff, parsed.data);
  }
}
