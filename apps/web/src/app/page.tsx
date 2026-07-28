'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { AlertCircle, ArrowLeft, FileText } from 'lucide-react';
import type { CreditAssessmentResult } from '@aics/contracts';

import { ApplicationForm, type SubmitPayload } from '@/components/application-form';
import { DecisionBanner } from '@/components/decision-banner';
import { PillarBreakdown } from '@/components/pillar-breakdown';
import { ScoreGauge } from '@/components/score-gauge';
import { ShapFactors } from '@/components/shap-factors';
import { SystemStatus } from '@/components/system-status';
import { ApiError, createApplication, uploadDocuments } from '@/lib/api';
import { formatDateTime, formatNpr, humanise } from '@/lib/utils';

/**
 * The Credit Assessment Dashboard.
 *
 * Two states: the intake form, and the assessment result. Deliberately not a multi-step wizard —
 * §6.2 budgets the entire pipeline under four seconds, so there is nothing to wait through and no
 * reason to fragment the form across screens.
 *
 * Create-then-upload runs as one mutation. Splitting them into two user-visible steps would let
 * an application exist with consent recorded but no documents, which is a state nobody wants to
 * reconcile later.
 */
export default function DashboardPage(): React.ReactElement {
  const [result, setResult] = useState<CreditAssessmentResult | null>(null);

  const assessment = useMutation({
    mutationFn: async (payload: SubmitPayload): Promise<CreditAssessmentResult> => {
      const { id } = await createApplication(payload.application);
      return uploadDocuments({
        applicationId: id,
        resume: payload.resume,
        statement: payload.statement,
        kycDocuments: payload.kycDocuments,
        residenceStatus: payload.residenceStatus,
      });
    },
    onSuccess: setResult,
  });

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs font-semibold tracking-widest text-[var(--color-brand)] uppercase">
              Fintara Solutions · ONE BNPL
            </p>
            <h1 className="mt-1 text-2xl font-semibold text-[var(--color-ink)] sm:text-3xl">
              Credit Assessment
            </h1>
            <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
              Four-pillar AI credit scoring for unsecured lending — financial, professional, social
              and behavioural.
            </p>
          </div>

          {result !== null && (
            <button
              type="button"
              onClick={() => {
                setResult(null);
                assessment.reset();
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-sm font-medium text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-surface-muted)]"
            >
              <ArrowLeft size={15} aria-hidden />
              New assessment
            </button>
          )}
        </div>

        <SystemStatus />
      </header>

      {assessment.isError && <ErrorPanel error={assessment.error} />}

      {result === null ? (
        <ApplicationForm onSubmit={assessment.mutate} isSubmitting={assessment.isPending} />
      ) : (
        <AssessmentResult result={result} />
      )}

      <footer className="mt-auto border-t border-[var(--color-line)] pt-4 text-xs text-[var(--color-ink-subtle)]">
        <p>
          Every decision is recorded with its full input snapshot, model versions and SHAP
          attribution for regulatory inspection (§10.4). Applicants may request a written
          explanation within 30 days and human review of any automated decision within 14 days.
        </p>
      </footer>
    </main>
  );
}

function AssessmentResult({
  result,
}: {
  readonly result: CreditAssessmentResult;
}): React.ReactElement {
  // When the model was unavailable the API still returns factors, derived from the scorecard's
  // sub-scores rather than SHAP. Say so rather than presenting them as model attributions.
  const derivedFromScorecard = result.mlModelVersion === null;

  return (
    <div className="flex flex-col gap-6">
      {/* Application identity */}
      <div className="card flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3 text-sm">
        <span className="flex items-center gap-1.5 font-medium text-[var(--color-ink)]">
          <FileText size={15} className="text-[var(--color-ink-subtle)]" aria-hidden />
          {result.arn}
        </span>
        <span className="text-[var(--color-ink-muted)]">
          {humanise(result.productType)} · requested {formatNpr(result.requestedAmountNpr)}
        </span>
        <span className="numeric ml-auto text-xs text-[var(--color-ink-subtle)]">
          scored {formatDateTime(result.scoredAt)} in {result.latencyMs} ms
        </span>
      </div>

      {/* Score and pillars */}
      <div className="grid gap-6 lg:grid-cols-[auto_1fr]">
        <div className="card flex items-center justify-center px-6 py-6">
          <ScoreGauge score={result.compositeScore} band={result.riskBand} />
        </div>

        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-[var(--color-ink)]">
            Pillar breakdown
            <span className="ml-1.5 text-xs font-normal text-[var(--color-ink-subtle)]">
              select a pillar for its sub-parameter detail
            </span>
          </h2>
          <PillarBreakdown pillars={result.pillars} />
        </section>
      </div>

      {/* Decision */}
      <DecisionBanner
        decision={result.decision}
        offer={result.offer}
        overrides={result.triggeredOverrides}
        degradedFlags={result.degradedFlags}
        degraded={result.degraded}
        reasons={result.reasons}
        expectedLossNpr={result.expectedLossNpr}
        pDefault={result.pDefault}
      />

      {/* Explainability */}
      <section className="card px-5 py-4">
        <h2 className="mb-3 text-sm font-semibold text-[var(--color-ink)]">
          Why this score
          <span className="ml-1.5 text-xs font-normal text-[var(--color-ink-subtle)]">
            explainable AI attribution (§6.3)
          </span>
        </h2>
        <ShapFactors
          positive={result.positiveFactors}
          negative={result.negativeFactors}
          derivedFromScorecard={derivedFromScorecard}
        />
      </section>

      {/* Model lineage */}
      <section className="card px-5 py-4">
        <h2 className="mb-3 text-sm font-semibold text-[var(--color-ink)]">
          Model lineage
          <span className="ml-1.5 text-xs font-normal text-[var(--color-ink-subtle)]">
            recorded on the decision for audit (§10.4)
          </span>
        </h2>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
          <Lineage label="Scorecard" value={`v${result.scorecardVersion}`} />
          <Lineage label="Feature set" value={`v${result.featureSetVersion}`} />
          <Lineage label="PD model" value={result.mlModelVersion ?? 'unavailable'} />
          <Lineage
            label="Training data"
            value={result.mlProvenance === null ? '—' : humanise(result.mlProvenance)}
            warn={result.mlProvenance === 'SYNTHETIC_SEED'}
          />
        </dl>

        {result.mlPDefaultShadow !== null && (
          <p className="mt-3 rounded-md border border-[var(--color-line)] bg-[var(--color-surface-muted)] px-3 py-2 text-xs text-[var(--color-ink-muted)]">
            The gradient-boosting model estimated a{' '}
            <span className="numeric font-semibold text-[var(--color-ink)]">
              {(result.mlPDefaultShadow * 100).toFixed(2)}%
            </span>{' '}
            probability of default, against{' '}
            <span className="numeric font-semibold text-[var(--color-ink)]">
              {(result.pDefault * 100).toFixed(2)}%
            </span>{' '}
            from the scorecard. The model runs in shadow mode: it is recorded and monitored but
            does not drive the decision until it has been validated on at least 500 real repayment
            outcomes (§6.4).
          </p>
        )}
      </section>
    </div>
  );
}

function Lineage({
  label,
  value,
  warn = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly warn?: boolean;
}): React.ReactElement {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium tracking-wide text-[var(--color-ink-subtle)] uppercase">
        {label}
      </dt>
      <dd
        className={
          warn
            ? 'mt-0.5 truncate text-sm font-medium text-[var(--color-caution)]'
            : 'mt-0.5 truncate text-sm font-medium text-[var(--color-ink)]'
        }
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}

function ErrorPanel({ error }: { readonly error: unknown }): React.ReactElement {
  const apiError = error instanceof ApiError ? error : null;

  return (
    <div
      role="alert"
      className="card border-[var(--color-negative)]/40 bg-[var(--color-negative-soft)] px-5 py-4"
    >
      <h2 className="flex items-center gap-1.5 text-sm font-semibold text-[var(--color-negative)]">
        <AlertCircle size={16} aria-hidden />
        Assessment could not be completed
      </h2>
      <p className="mt-1 text-sm text-[var(--color-ink)]">
        {error instanceof Error ? error.message : 'An unexpected error occurred.'}
      </p>

      {apiError?.issues !== undefined && apiError.issues.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {apiError.issues.map((issue) => (
            <li key={`${issue.path}-${issue.message}`} className="text-xs text-[var(--color-ink-muted)]">
              <span className="font-medium">{issue.path}</span>: {issue.message}
            </li>
          ))}
        </ul>
      )}

      {apiError?.correlationId !== undefined && (
        <p className="numeric mt-2 text-xs text-[var(--color-ink-subtle)]">
          Reference {apiError.correlationId} — quote this to support.
        </p>
      )}
    </div>
  );
}
