/**
 * SOP-004 manual underwriter review.
 *
 * `REFER_UNDERWRITER` has been a real decision path since the engine shipped, and the applicant is
 * told a human will decide within two business days. This is the code behind that sentence: the
 * queue those referrals land in, and the controls on acting on one.
 *
 * The rules SOP-004 states, and where each is enforced:
 *
 *   · A review needs written justification — length floor in the zod schema, substance checked
 *     here (a schema cannot tell forty characters of reasoning from forty spaces).
 *   · Overriding the engine *in the applicant's favour* needs a second authoriser — enforced
 *     here, by re-authenticating that person against their own credentials.
 *   · The second authoriser must be a different person, and must hold credit authority.
 *   · Every review is recorded with what the engine recommended, so the override is legible to an
 *     auditor from one row.
 *
 * All of it lives in the service rather than in the controller or the UI. A rule enforced in a
 * form is a rule that holds until someone calls the API directly.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CAN_SECOND_AUTHORISE,
  MIN_JUSTIFICATION_LENGTH,
  PRODUCT_SPECS,
  REVIEW_SLA_HOURS,
  isLenientOverride,
  type Decision,
  type DecisionHistoryItem,
  type DecisionHistoryPage,
  type ProductType,
  type QueueItem,
  type QueuePage,
  type ReviewRecord,
  type StaffRole,
  type SubmitReviewInput,
} from '@aics/contracts';

import { AuthService } from '../auth/auth.service';
import { toJson } from '../common/json.util';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedStaff } from '../auth/token.service';

/** Cap on one page of the queue, so a client cannot ask for the whole table. */
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

export interface QueueQuery {
  readonly limit?: number;
  readonly offset?: number;
}

@Injectable()
export class UnderwriterService {
  private readonly logger = new Logger(UnderwriterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
  ) {}

  /* ====================================================================== */
  /* The queue                                                              */
  /* ====================================================================== */

  /**
   * Applications awaiting a human decision, oldest first.
   *
   * FIFO is the right default and not merely the obvious one: ordering by score or by amount
   * would mean a low-value applicant can be overtaken indefinitely, which is exactly how an SLA
   * is met on average and breached for the people at the back.
   */
  async queue(query: QueueQuery = {}): Promise<QueuePage> {
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const offset = Math.max(query.offset ?? 0, 0);

    const [total, applications] = await Promise.all([
      this.prisma.db.loanApplication.count({ where: { status: 'UNDER_REVIEW' } }),
      this.prisma.db.loanApplication.findMany({
        where: { status: 'UNDER_REVIEW' },
        orderBy: { createdAt: 'asc' },
        skip: offset,
        take: limit,
        include: {
          applicant: { select: { fullName: true } },
          creditScores: { orderBy: { scoredAt: 'desc' }, take: 1 },
        },
      }),
    ]);

    // One clock for the whole page. Reading `Date.now()` per row would let two items referred in
    // the same second report different waiting times.
    const now = Date.now();

    const items: QueueItem[] = applications.flatMap((application) => {
      const score = application.creditScores[0];
      // An application parked in UNDER_REVIEW with no score is a data defect, not a queue item —
      // there is nothing for an underwriter to review. Logged, and left out rather than rendered
      // as a row with zeros.
      if (score === undefined) {
        this.logger.error(
          `Application ${application.arn} is UNDER_REVIEW with no credit score; excluded from queue`,
        );
        return [];
      }

      const referredAt = score.scoredAt;
      const waitingHours = Math.floor((now - referredAt.getTime()) / (60 * 60 * 1000));

      return [
        {
          applicationId: application.id,
          arn: application.arn,
          applicantName: application.applicant.fullName,
          productType: application.productType,
          requestedAmountNpr: Number(application.requestedAmountNpr),
          tenureMonths: application.tenureMonths,
          compositeScore: Number(score.compositeScore),
          riskBand: score.riskBand,
          systemDecision: score.decision,
          overrideCodes: score.overrideCodes,
          degradedFlags: score.degradedFlags,
          degraded: score.degraded,
          referredAt: referredAt.toISOString(),
          waitingHours,
          slaBreached: waitingHours >= REVIEW_SLA_HOURS,
        },
      ];
    });

    // Counted across the whole queue, not the page. A breach count that only reflects the first
    // 25 rows is worse than none — it reads as "nothing is late" while the backlog grows.
    const breachedCount = await this.prisma.db.loanApplication.count({
      where: {
        status: 'UNDER_REVIEW',
        creditScores: {
          some: {
            scoredAt: { lte: new Date(now - REVIEW_SLA_HOURS * 60 * 60 * 1000) },
          },
        },
      },
    });

    return { items, total, limit, offset, breachedCount, slaHours: REVIEW_SLA_HOURS };
  }

  /* ====================================================================== */
  /* Decision history                                                       */
  /* ====================================================================== */

  /**
   * Every decided application, newest first — the oversight counterpart to the queue.
   *
   * The queue filters on `UNDER_REVIEW`, so an application disappears from it the moment it is
   * decided. That is correct for a work queue and wrong for compliance, which needs to read a
   * decision precisely because it has already been made. Restricted to `CAN_VIEW_AUDIT` at the
   * controller.
   *
   * Includes engine-only decisions, not just reviewed ones. Most applications never reach the
   * queue — they are decided at submission — and a history that omitted them would suggest the
   * book is far smaller and far more human-mediated than it is.
   */
  async decisionHistory(query: QueueQuery = {}): Promise<DecisionHistoryPage> {
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const offset = Math.max(query.offset ?? 0, 0);

    const [total, applications, humanReviewedCount, coSignedCount] = await Promise.all([
      this.prisma.db.loanApplication.count({ where: { status: 'DECIDED' } }),
      this.prisma.db.loanApplication.findMany({
        where: { status: 'DECIDED' },
        // Decided-at, not created-at: the history is read in the order decisions were taken.
        orderBy: [{ decidedAt: 'desc' }, { createdAt: 'desc' }],
        skip: offset,
        take: limit,
        include: {
          applicant: { select: { fullName: true } },
          creditScores: { orderBy: { scoredAt: 'desc' }, take: 1 },
          underwriterReviews: { orderBy: { reviewedAt: 'desc' }, take: 1 },
        },
      }),
      this.prisma.db.loanApplication.count({
        where: { status: 'DECIDED', underwriterReviews: { some: {} } },
      }),
      this.prisma.db.loanApplication.count({
        where: { status: 'DECIDED', underwriterReviews: { some: { dualAuthById: { not: null } } } },
      }),
    ]);

    const items: DecisionHistoryItem[] = applications.flatMap((application) => {
      const score = application.creditScores[0];
      // Same defect as the queue guards against: decided with no score means there is nothing to
      // show. Logged and omitted rather than rendered as a row of zeros.
      if (score === undefined) {
        this.logger.error(
          `Application ${application.arn} is DECIDED with no credit score; excluded from history`,
        );
        return [];
      }

      const row = application.underwriterReviews[0];
      const review: ReviewRecord | null =
        row === undefined
          ? null
          : {
              id: row.id,
              decision: row.decision,
              systemDecision: row.systemDecision,
              justification: row.justification,
              overrodeModel: row.overrodeModel,
              reviewerName: row.reviewerName,
              reviewerRole: row.reviewerRole as StaffRole,
              dualAuthByName: row.dualAuthByName,
              dualAuthByRole: row.dualAuthByRole as StaffRole | null,
              dualAuthAt: row.dualAuthAt?.toISOString() ?? null,
              approvedLimitNpr: row.approvedLimitNpr === null ? null : Number(row.approvedLimitNpr),
              reviewedAt: row.reviewedAt.toISOString(),
            };

      return [
        {
          applicationId: application.id,
          arn: application.arn,
          applicantName: application.applicant.fullName,
          productType: application.productType,
          requestedAmountNpr: Number(application.requestedAmountNpr),
          compositeScore: Number(score.compositeScore),
          riskBand: score.riskBand,
          systemDecision: score.decision,
          finalDecision: review?.decision ?? score.decision,
          review,
          overrodeEngine: review !== null && review.decision !== review.systemDecision,
          // `decidedAt` is nullable in the schema; a DECIDED row without one is a data defect,
          // and falling back to the score time keeps the column readable rather than empty.
          decidedAt: (application.decidedAt ?? score.scoredAt).toISOString(),
        },
      ];
    });

    return { items, total, limit, offset, humanReviewedCount, coSignedCount };
  }

  /** Review history for one application, newest first. */
  async reviewHistory(applicationId: string): Promise<readonly ReviewRecord[]> {
    const reviews = await this.prisma.db.underwriterReview.findMany({
      where: { applicationId },
      orderBy: { reviewedAt: 'desc' },
    });

    return reviews.map((review) => ({
      id: review.id,
      decision: review.decision,
      systemDecision: review.systemDecision,
      justification: review.justification,
      overrodeModel: review.overrodeModel,
      reviewerName: review.reviewerName,
      reviewerRole: review.reviewerRole as StaffRole,
      dualAuthByName: review.dualAuthByName,
      dualAuthByRole: review.dualAuthByRole as StaffRole | null,
      dualAuthAt: review.dualAuthAt?.toISOString() ?? null,
      approvedLimitNpr: review.approvedLimitNpr === null ? null : Number(review.approvedLimitNpr),
      reviewedAt: review.reviewedAt.toISOString(),
    }));
  }

  /* ====================================================================== */
  /* Recording a decision                                                   */
  /* ====================================================================== */

  async submitReview(
    applicationId: string,
    reviewer: AuthenticatedStaff,
    input: SubmitReviewInput,
  ): Promise<ReviewRecord> {
    const application = await this.prisma.db.loanApplication.findUnique({
      where: { id: applicationId },
      include: {
        applicant: { select: { fullName: true } },
        creditScores: { orderBy: { scoredAt: 'desc' }, take: 1 },
      },
    });

    if (application === null) {
      throw new NotFoundException(`Application ${applicationId} not found`);
    }

    // Not an assertion about the request — an application already decided must not be quietly
    // re-decided by a second reviewer who had the page open.
    if (application.status !== 'UNDER_REVIEW') {
      throw new ConflictException(
        `Application ${application.arn} is not awaiting review (status: ${application.status}). ` +
          'It may have been decided by another reviewer.',
      );
    }

    const score = application.creditScores[0];
    if (score === undefined) {
      throw new ConflictException(
        `Application ${application.arn} has no credit score to review. It must be scored first.`,
      );
    }

    const justification = input.justification.trim();
    if (justification.length < MIN_JUSTIFICATION_LENGTH) {
      throw new BadRequestException(
        `The written justification must be at least ${MIN_JUSTIFICATION_LENGTH} characters of ` +
          'substance (SOP-004). Whitespace is not counted.',
      );
    }

    const systemDecision: Decision = score.decision;
    const humanDecision: Decision = input.decision;

    const approvedLimitNpr = this.resolveApprovedLimit(
      humanDecision,
      application.productType,
      score.approvedLimitNpr === null ? null : Number(score.approvedLimitNpr),
      input.approvedLimitNpr,
    );

    // Two independent ways to be more generous than the engine: a softer decision, or the same
    // decision for more money. Both are the risk SOP-004 exists to control, so both trigger it.
    const engineOffer = score.approvedLimitNpr === null ? 0 : Number(score.approvedLimitNpr);
    const exceedsEngineLimit = approvedLimitNpr !== null && approvedLimitNpr > engineOffer;
    const lenient = isLenientOverride(systemDecision, humanDecision) || exceedsEngineLimit;
    const overrodeModel = humanDecision !== systemDecision || exceedsEngineLimit;

    let secondAuthoriser: AuthenticatedStaff | null = null;

    if (lenient) {
      if (input.dualAuthEmail === undefined || input.dualAuthPassword === undefined) {
        throw new BadRequestException(
          'This decision is more favourable to the applicant than the system recommendation, so ' +
            'SOP-004 requires a second authoriser to co-sign it. Provide the co-signer’s ' +
            'email and password.',
        );
      }

      secondAuthoriser = await this.auth.authenticateSecondAuthoriser(
        input.dualAuthEmail,
        input.dualAuthPassword,
      );

      // Self-co-signing would satisfy the letter of a dual-authorisation field and none of its
      // purpose.
      if (secondAuthoriser.id === reviewer.id) {
        throw new ForbiddenException(
          'The second authoriser must be a different person from the reviewer (SOP-004).',
        );
      }

      if (!CAN_SECOND_AUTHORISE.includes(secondAuthoriser.role)) {
        throw new ForbiddenException(
          `A lenient override must be co-signed by one of: ${CAN_SECOND_AUTHORISE.join(', ')}. ` +
            'Compliance oversight is deliberately not a credit-approval authority.',
        );
      }
    }

    const now = new Date();

    // One transaction. A review row without its status transition leaves the application in the
    // queue for someone else to decide again; a status transition without the review row is a
    // decision with no recorded author, which §10.4 does not permit to exist.
    const created = await this.prisma.transaction(async (tx) => {
      const review = await tx.underwriterReview.create({
        data: {
          applicationId,
          reviewerId: reviewer.id,
          reviewerName: reviewer.fullName,
          reviewerRole: reviewer.role,
          decision: humanDecision,
          systemDecision,
          justification,
          overrodeModel,
          approvedLimitNpr,
          ...(secondAuthoriser === null
            ? {}
            : {
                dualAuthById: secondAuthoriser.id,
                dualAuthByName: secondAuthoriser.fullName,
                dualAuthByRole: secondAuthoriser.role,
                dualAuthAt: now,
              }),
          reviewedAt: now,
        },
      });

      await tx.decisionAudit.create({
        data: {
          applicationId,
          eventType: 'UNDERWRITER_REVIEW',
          actorType: reviewer.actorType,
          actorId: reviewer.id,
          // Credentials are never part of the snapshot. What matters for reconstruction is who
          // co-signed, not what they typed to prove it.
          inputSnapshot: toJson({
            reviewerEmail: reviewer.email,
            reviewerRole: reviewer.role,
            systemDecision,
            systemCompositeScore: Number(score.compositeScore),
            systemRiskBand: score.riskBand,
            systemApprovedLimitNpr: engineOffer,
            scorecardVersion: score.scorecardVersion,
            featureSetVersion: score.featureSetVersion,
            mlModelVersion: score.mlModelVersion,
            degradedFlags: score.degradedFlags,
            overrideCodes: score.overrideCodes,
            requestedDecision: humanDecision,
            requestedLimitNpr: input.approvedLimitNpr ?? null,
          }),
          outputSnapshot: toJson({
            decision: humanDecision,
            approvedLimitNpr,
            overrodeModel,
            lenientOverride: lenient,
            justification,
            reviewId: review.id,
            dualAuthorisation:
              secondAuthoriser === null
                ? null
                : {
                    id: secondAuthoriser.id,
                    email: secondAuthoriser.email,
                    name: secondAuthoriser.fullName,
                    role: secondAuthoriser.role,
                    at: now.toISOString(),
                  },
          }),
        },
      });

      await tx.loanApplication.update({
        where: { id: applicationId },
        data: { status: 'DECIDED', decidedAt: now },
      });

      return review;
    });

    this.logger.log(
      `[${application.arn}] underwriter review by ${reviewer.email} (${reviewer.role}): ` +
        `${systemDecision} -> ${humanDecision}` +
        (secondAuthoriser === null ? '' : ` · co-signed by ${secondAuthoriser.email}`),
    );

    return {
      id: created.id,
      decision: created.decision,
      systemDecision: created.systemDecision,
      justification: created.justification,
      overrodeModel: created.overrodeModel,
      reviewerName: created.reviewerName,
      reviewerRole: created.reviewerRole as StaffRole,
      dualAuthByName: created.dualAuthByName,
      dualAuthByRole: created.dualAuthByRole as StaffRole | null,
      dualAuthAt: created.dualAuthAt?.toISOString() ?? null,
      approvedLimitNpr: created.approvedLimitNpr === null ? null : Number(created.approvedLimitNpr),
      reviewedAt: created.reviewedAt.toISOString(),
    };
  }

  /**
   * Settles the limit to record, and refuses the combinations that make no sense.
   *
   * The hard product ceiling is enforced regardless of who co-signs. Dual authorisation is a
   * control on judgement within the bank's stated limits, not a key that unlocks a number above
   * the product's approved maximum — that is a board-level change to §1.2, not an underwriting
   * decision.
   */
  private resolveApprovedLimit(
    decision: Decision,
    productType: ProductType,
    engineLimit: number | null,
    requested: number | undefined,
  ): number | null {
    const releasesFunds = decision !== 'DECLINE' && decision !== 'REFER_UNDERWRITER';

    if (!releasesFunds) {
      if (requested !== undefined) {
        throw new BadRequestException(
          `A ${decision} decision releases no funds, so an approved limit cannot be recorded ` +
            'against it.',
        );
      }
      return null;
    }

    const limit = requested ?? engineLimit;
    if (limit === null) {
      throw new BadRequestException(
        'This decision approves credit but the system computed no limit for it, so an explicit ' +
          'approved limit is required.',
      );
    }

    const ceiling = PRODUCT_SPECS[productType].maxLimitNpr;
    if (limit > ceiling) {
      throw new BadRequestException(
        `The approved limit exceeds the ${PRODUCT_SPECS[productType].label} product ceiling of ` +
          `NPR ${ceiling.toLocaleString('en-IN')} (§1.2). This cannot be overridden by ` +
          'dual authorisation.',
      );
    }

    return limit;
  }
}
