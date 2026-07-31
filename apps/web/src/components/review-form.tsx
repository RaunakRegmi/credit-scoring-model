'use client';

import { useState } from 'react';
import { AlertCircle, Loader2, ShieldCheck, UserCheck } from 'lucide-react';
import {
  CAN_SECOND_AUTHORISE,
  DECISIONS,
  MIN_JUSTIFICATION_LENGTH,
  isLenientOverride,
  type CreditAssessmentResult,
  type Decision,
} from '@aics/contracts';

import { ApiError, submitReview } from '@/lib/api';
import { formatNpr, humanise } from '@/lib/utils';

/**
 * The SOP-004 review form.
 *
 * The dual-authorisation panel appears from the same predicate the API enforces —
 * `isLenientOverride` in `@aics/contracts`, imported by both sides. That is the point of putting it
 * in the contracts package: the form cannot come to a different conclusion about whether a second
 * signature is needed than the service that will refuse the request.
 *
 * The form is a convenience, not a control. Every rule here is enforced again server-side, so a
 * request built by hand against the API is subject to the same checks.
 */
export function ReviewForm({
  assessment,
  onReviewed,
}: {
  readonly assessment: CreditAssessmentResult;
  readonly onReviewed: () => void;
}): React.ReactElement {
  const systemDecision = assessment.decision;
  const engineLimit = assessment.offer?.approvedLimitNpr ?? 0;

  // Defaults to what the engine decided, not to DECLINE. A reviewer agrees with the engine most
  // of the time, so agreement should be the cheap action and disagreement the deliberate one —
  // and pre-selecting the harshest outcome made the approval options read as absent. Nothing is
  // recorded until submit, and every rule is enforced again server-side, so the default carries
  // no authority of its own.
  const [decision, setDecision] = useState<Decision>(systemDecision);
  const [justification, setJustification] = useState('');
  const [limitInput, setLimitInput] = useState('');
  const [dualAuthEmail, setDualAuthEmail] = useState('');
  const [dualAuthPassword, setDualAuthPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const releasesFunds = decision !== 'DECLINE' && decision !== 'REFER_UNDERWRITER';
  const parsedLimit = limitInput.trim() === '' ? undefined : Number(limitInput);
  const limitValid = parsedLimit === undefined || (Number.isFinite(parsedLimit) && parsedLimit > 0);
  const effectiveLimit = parsedLimit ?? engineLimit;

  // Two independent routes to "more generous than the engine": a softer decision, or the same
  // decision for more money. Both need a co-signature, so both are computed here.
  const exceedsEngineLimit = releasesFunds && effectiveLimit > engineLimit;
  const needsDualAuth = isLenientOverride(systemDecision, decision) || exceedsEngineLimit;

  const trimmedJustification = justification.trim();
  const justificationShort = trimmedJustification.length < MIN_JUSTIFICATION_LENGTH;

  const canSubmit =
    !justificationShort &&
    limitValid &&
    (!needsDualAuth || (dualAuthEmail.trim() !== '' && dualAuthPassword !== '')) &&
    !pending;

  async function onSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setPending(true);

    try {
      await submitReview(assessment.applicationId, {
        decision,
        justification: trimmedJustification,
        ...(releasesFunds && parsedLimit !== undefined ? { approvedLimitNpr: parsedLimit } : {}),
        ...(needsDualAuth
          ? { dualAuthEmail: dualAuthEmail.trim(), dualAuthPassword }
          : {}),
      });
      onReviewed();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not record the review. Try again.',
      );
    } finally {
      // Never retained across an attempt, successful or not.
      setDualAuthPassword('');
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card flex flex-col gap-4 px-5 py-4">
      <div>
        <h2 className="text-sm font-semibold text-[var(--color-ink)]">Record a decision</h2>
        <p className="mt-0.5 text-xs text-[var(--color-ink-muted)]">
          The engine recommended{' '}
          <span className="font-semibold text-[var(--color-ink)]">
            {humanise(systemDecision)}
          </span>
          {engineLimit > 0 && <> at {formatNpr(engineLimit)}</>}. Your decision and its
          justification are recorded against your name (SOP-004, §10.4).
        </p>
      </div>

      {error !== null && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-[var(--color-negative)]/40 bg-[var(--color-negative-soft)] px-3 py-2 text-sm text-[var(--color-ink)]"
        >
          <AlertCircle size={15} className="mt-0.5 shrink-0 text-[var(--color-negative)]" aria-hidden />
          <span>{error}</span>
        </div>
      )}

      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-xs font-medium tracking-wide text-[var(--color-ink-muted)] uppercase">
          Decision
        </legend>
        <div className="flex flex-wrap gap-2">
          {DECISIONS.map((option) => (
            <label
              key={option}
              className={
                decision === option
                  ? 'cursor-pointer rounded-lg border border-[var(--color-brand)] bg-[var(--color-brand-soft)] px-3 py-2 text-sm font-medium text-[var(--color-brand)]'
                  : 'cursor-pointer rounded-lg border border-[var(--color-line-strong)] px-3 py-2 text-sm font-medium text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-surface-muted)]'
              }
            >
              <input
                type="radio"
                name="decision"
                value={option}
                checked={decision === option}
                onChange={() => setDecision(option)}
                className="sr-only"
              />
              {humanise(option)}
            </label>
          ))}
        </div>
      </fieldset>

      {releasesFunds && (
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium tracking-wide text-[var(--color-ink-muted)] uppercase">
            Approved limit (NPR)
          </span>
          <input
            type="number"
            min={1}
            step={1000}
            value={limitInput}
            onChange={(event) => setLimitInput(event.target.value)}
            placeholder={engineLimit > 0 ? String(engineLimit) : 'Enter an amount'}
            className="numeric rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-ink)] outline-none focus:border-[var(--color-brand)] focus:ring-2 focus:ring-[var(--color-brand)]/20"
          />
          <span className="text-xs text-[var(--color-ink-subtle)]">
            {engineLimit > 0
              ? `Leave blank to accept the engine's ${formatNpr(engineLimit)}.`
              : 'The engine priced no offer, so an explicit limit is required.'}
          </span>
          {!limitValid && (
            <span className="text-xs text-[var(--color-negative)]">
              Enter a positive amount.
            </span>
          )}
        </label>
      )}

      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium tracking-wide text-[var(--color-ink-muted)] uppercase">
          Written justification
        </span>
        <textarea
          value={justification}
          onChange={(event) => setJustification(event.target.value)}
          rows={4}
          required
          placeholder="What you verified, how, and why it supports this decision."
          className="rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-ink)] outline-none focus:border-[var(--color-brand)] focus:ring-2 focus:ring-[var(--color-brand)]/20"
        />
        <span
          className={
            justificationShort && trimmedJustification.length > 0
              ? 'numeric text-xs text-[var(--color-caution)]'
              : 'numeric text-xs text-[var(--color-ink-subtle)]'
          }
        >
          {trimmedJustification.length} / {MIN_JUSTIFICATION_LENGTH} characters minimum
        </span>
      </label>

      {needsDualAuth && (
        <div className="flex flex-col gap-3 rounded-lg border border-[var(--color-caution)]/40 bg-[var(--color-caution-soft)] px-4 py-3">
          <div className="flex items-start gap-2">
            <ShieldCheck
              size={16}
              className="mt-0.5 shrink-0 text-[var(--color-caution)]"
              aria-hidden
            />
            <div>
              <p className="text-sm font-semibold text-[var(--color-ink)]">
                Second authoriser required
              </p>
              <p className="mt-0.5 text-xs text-[var(--color-ink-muted)]">
                {exceedsEngineLimit && !isLenientOverride(systemDecision, decision)
                  ? `This approves more than the engine's ${formatNpr(engineLimit)}.`
                  : 'This is more favourable to the applicant than the engine recommended.'}{' '}
                SOP-004 requires a {CAN_SECOND_AUTHORISE.map(humanise).join(' or ')} to co-sign it,
                using their own credentials.
              </p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-[var(--color-ink-muted)]">
                Co-signer email
              </span>
              <input
                type="email"
                value={dualAuthEmail}
                onChange={(event) => setDualAuthEmail(event.target.value)}
                autoComplete="off"
                className="rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-ink)] outline-none focus:border-[var(--color-brand)]"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-[var(--color-ink-muted)]">
                Co-signer password
              </span>
              <input
                type="password"
                value={dualAuthPassword}
                onChange={(event) => setDualAuthPassword(event.target.value)}
                autoComplete="new-password"
                className="rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-ink)] outline-none focus:border-[var(--color-brand)]"
              />
            </label>
          </div>

          <p className="text-xs text-[var(--color-ink-subtle)]">
            The co-signer should enter this themselves. Their name and role are recorded on the
            decision.
          </p>
        </div>
      )}

      <button
        type="submit"
        disabled={!canSubmit}
        className="inline-flex items-center justify-center gap-2 rounded-lg bg-[var(--color-brand)] px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {pending ? (
          <Loader2 size={15} className="animate-spin" aria-hidden />
        ) : (
          <UserCheck size={15} aria-hidden />
        )}
        {pending ? 'Recording…' : `Record ${humanise(decision).toLowerCase()}`}
      </button>
    </form>
  );
}
