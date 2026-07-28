'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, FileText, Loader2, ShieldCheck } from 'lucide-react';
import { CAN_REVIEW_APPLICATIONS, type ReviewRecord } from '@aics/contracts';

import { useAuth } from '@/components/auth-provider';
import { DecisionBanner } from '@/components/decision-banner';
import { PillarBreakdown } from '@/components/pillar-breakdown';
import { ReviewForm } from '@/components/review-form';
import { ScoreGauge } from '@/components/score-gauge';
import { ShapFactors } from '@/components/shap-factors';
import { getReferral } from '@/lib/api';
import { formatDateTime, formatNpr, humanise } from '@/lib/utils';

/**
 * One referral, in full, with the form to decide it.
 *
 * Renders the same score, pillar breakdown and factor attribution the assessment view shows —
 * literally the same components against the same payload. An underwriter deciding an application
 * must see exactly what the engine produced, including the degradation flags and overrides; a
 * condensed "underwriter summary" would be a second version of the truth, and the caveats are the
 * first thing such a summary drops.
 */
export default function ReferralPage(): React.ReactElement {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { can } = useAuth();

  const applicationId = params.id;

  const referral = useQuery({
    queryKey: ['referral', applicationId],
    queryFn: () => getReferral(applicationId),
  });

  if (referral.isPending) {
    return (
      <main className="flex flex-1 items-center justify-center py-20">
        <Loader2 size={20} className="animate-spin text-[var(--color-ink-subtle)]" aria-label="Loading" />
      </main>
    );
  }

  if (referral.isError) {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6">
        <BackLink />
        <div
          role="alert"
          className="card mt-4 border-[var(--color-negative)]/40 bg-[var(--color-negative-soft)] px-5 py-4 text-sm"
        >
          <p className="font-semibold text-[var(--color-negative)]">Could not load this referral</p>
          <p className="mt-1 text-[var(--color-ink)]">
            {referral.error instanceof Error
              ? referral.error.message
              : 'An unexpected error occurred.'}
          </p>
        </div>
      </main>
    );
  }

  const { assessment, reviews } = referral.data;
  const alreadyReviewed = reviews.length > 0;
  const mayReview = can(CAN_REVIEW_APPLICATIONS);
  const derivedFromScorecard = assessment.mlModelVersion === null;

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
      <div>
        <BackLink />
        <div className="card mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3 text-sm">
          <span className="numeric flex items-center gap-1.5 font-medium text-[var(--color-ink)]">
            <FileText size={15} className="text-[var(--color-ink-subtle)]" aria-hidden />
            {assessment.arn}
          </span>
          <span className="text-[var(--color-ink-muted)]">
            {humanise(assessment.productType)} · requested{' '}
            {formatNpr(assessment.requestedAmountNpr)}
          </span>
          <span className="numeric ml-auto text-xs text-[var(--color-ink-subtle)]">
            scored {formatDateTime(assessment.scoredAt)}
          </span>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[auto_1fr]">
        <div className="card flex items-center justify-center px-6 py-6">
          <ScoreGauge score={assessment.compositeScore} band={assessment.riskBand} />
        </div>
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-[var(--color-ink)]">
            Pillar breakdown
            <span className="ml-1.5 text-xs font-normal text-[var(--color-ink-subtle)]">
              select a pillar for its sub-parameter detail
            </span>
          </h2>
          <PillarBreakdown pillars={assessment.pillars} />
        </section>
      </div>

      <DecisionBanner
        decision={assessment.decision}
        offer={assessment.offer}
        overrides={assessment.triggeredOverrides}
        degradedFlags={assessment.degradedFlags}
        degraded={assessment.degraded}
        reasons={assessment.reasons}
        expectedLossNpr={assessment.expectedLossNpr}
        pDefault={assessment.pDefault}
      />

      <section className="card px-5 py-4">
        <h2 className="mb-3 text-sm font-semibold text-[var(--color-ink)]">
          Why this score
          <span className="ml-1.5 text-xs font-normal text-[var(--color-ink-subtle)]">
            explainable AI attribution (§6.3)
          </span>
        </h2>
        <ShapFactors
          positive={assessment.positiveFactors}
          negative={assessment.negativeFactors}
          derivedFromScorecard={derivedFromScorecard}
        />
      </section>

      {reviews.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-[var(--color-ink)]">Review history</h2>
          {reviews.map((review) => (
            <ReviewCard key={review.id} review={review} />
          ))}
        </section>
      )}

      {/* A decided application shows its history and no form. The API refuses a second review
          anyway (409); hiding the form means an underwriter is not invited to write a
          justification that will be thrown away. */}
      {!alreadyReviewed && mayReview && (
        <ReviewForm
          assessment={assessment}
          onReviewed={() => {
            // Both the detail and the queue are now stale — the item has left the queue.
            void queryClient.invalidateQueries({ queryKey: ['referral', applicationId] });
            void queryClient.invalidateQueries({ queryKey: ['review-queue'] });
            void queryClient.invalidateQueries({ queryKey: ['review-queue-count'] });
            router.push('/queue');
          }}
        />
      )}

      {!alreadyReviewed && !mayReview && (
        <p className="card px-5 py-4 text-sm text-[var(--color-ink-muted)]">
          Your role has read access to this referral but cannot record a credit decision.
        </p>
      )}
    </main>
  );
}

function BackLink(): React.ReactElement {
  return (
    <Link
      href="/queue"
      className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
    >
      <ArrowLeft size={15} aria-hidden />
      Review queue
    </Link>
  );
}

function ReviewCard({ review }: { readonly review: ReviewRecord }): React.ReactElement {
  return (
    <div className="card px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <CheckCircle2 size={15} className="text-[var(--color-positive)]" aria-hidden />
        <span className="font-semibold text-[var(--color-ink)]">
          {humanise(review.decision)}
        </span>
        {review.overrodeModel && (
          <span className="rounded-md bg-[var(--color-caution-soft)] px-2 py-0.5 text-xs font-medium text-[var(--color-caution)]">
            overrode {humanise(review.systemDecision)}
          </span>
        )}
        {review.approvedLimitNpr !== null && (
          <span className="numeric text-[var(--color-ink-muted)]">
            {formatNpr(review.approvedLimitNpr)}
          </span>
        )}
        <span className="numeric ml-auto text-xs text-[var(--color-ink-subtle)]">
          {formatDateTime(review.reviewedAt)}
        </span>
      </div>

      <p className="mt-2 text-sm text-[var(--color-ink)]">{review.justification}</p>

      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-[var(--color-ink-muted)]">
        <div className="flex gap-1.5">
          <dt className="text-[var(--color-ink-subtle)]">Reviewer</dt>
          <dd className="font-medium text-[var(--color-ink)]">
            {review.reviewerName} · {humanise(review.reviewerRole)}
          </dd>
        </div>
        {review.dualAuthByName !== null && (
          <div className="flex items-center gap-1.5">
            <ShieldCheck size={12} className="text-[var(--color-positive)]" aria-hidden />
            <dt className="text-[var(--color-ink-subtle)]">Co-signed by</dt>
            <dd className="font-medium text-[var(--color-ink)]">
              {review.dualAuthByName}
              {review.dualAuthByRole !== null && ` · ${humanise(review.dualAuthByRole)}`}
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}
