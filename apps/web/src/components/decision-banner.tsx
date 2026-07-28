'use client';

import {
  AlertTriangle,
  CheckCircle2,
  FileWarning,
  ShieldAlert,
  UserCheck,
  XCircle,
} from 'lucide-react';
import type { Decision, DegradedFlag, PricedOffer, TriggeredOverride } from '@aics/contracts';

import { formatNpr, formatPercent, humanise } from '@/lib/utils';

/**
 * The decision, the offer, and — when the answer is not a clean yes — precisely why.
 *
 * The "why" is the part that matters. A referral or a decline that does not say what triggered
 * it forces an underwriter to reverse-engineer the engine, and leaves the applicant with nothing
 * actionable. Overrides, degradation flags and the ordered reason list are all surfaced.
 */

interface DecisionPresentation {
  readonly label: string;
  readonly sublabel: string;
  readonly accent: string;
  readonly soft: string;
  readonly Icon: typeof CheckCircle2;
}

const PRESENTATION: Readonly<Record<Decision, DecisionPresentation>> = {
  AUTO_APPROVE: {
    label: 'Approved',
    sublabel: 'Automatically approved — no manual underwriting required',
    accent: 'var(--color-band-prime)',
    soft: 'var(--color-positive-soft)',
    Icon: CheckCircle2,
  },
  APPROVE_STANDARD: {
    label: 'Approved',
    sublabel: 'Approved on standard terms',
    accent: 'var(--color-band-near)',
    soft: 'var(--color-positive-soft)',
    Icon: CheckCircle2,
  },
  APPROVE_WITH_CONDITIONS: {
    label: 'Approved with conditions',
    sublabel: 'Conditional approval — the conditions below must be met before disbursement',
    accent: 'var(--color-band-sub)',
    soft: 'var(--color-caution-soft)',
    Icon: UserCheck,
  },
  REFER_UNDERWRITER: {
    label: 'Referred for review',
    sublabel: 'Referred to a human underwriter — decision within 2 business days (SOP-004)',
    accent: 'var(--color-band-high)',
    soft: 'var(--color-caution-soft)',
    Icon: AlertTriangle,
  },
  DECLINE: {
    label: 'Declined',
    sublabel: 'This application cannot be approved',
    accent: 'var(--color-band-reject)',
    soft: 'var(--color-negative-soft)',
    Icon: XCircle,
  },
};

interface DecisionBannerProps {
  readonly decision: Decision;
  readonly offer: PricedOffer | null;
  readonly overrides: readonly TriggeredOverride[];
  readonly degradedFlags: readonly DegradedFlag[];
  readonly degraded: boolean;
  readonly reasons: readonly string[];
  readonly expectedLossNpr: number;
  readonly pDefault: number;
}

export function DecisionBanner({
  decision,
  offer,
  overrides,
  degradedFlags,
  degraded,
  reasons,
  expectedLossNpr,
  pDefault,
}: DecisionBannerProps): React.ReactElement {
  const presentation = PRESENTATION[decision];
  const { Icon } = presentation;

  return (
    <div className="card overflow-hidden">
      <div
        className="flex items-start gap-3 px-5 py-4"
        style={{ backgroundColor: presentation.soft, borderBottom: '1px solid var(--color-line)' }}
      >
        <Icon size={26} style={{ color: presentation.accent }} className="mt-0.5 shrink-0" aria-hidden />
        <div className="min-w-0">
          <h2 className="text-lg font-semibold" style={{ color: presentation.accent }}>
            {presentation.label}
          </h2>
          <p className="mt-0.5 text-sm text-[var(--color-ink-muted)]">{presentation.sublabel}</p>
        </div>
      </div>

      {/* Priced offer */}
      {offer !== null ? (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 px-5 py-4 sm:grid-cols-4">
          <Metric label="Approved limit" value={formatNpr(offer.approvedLimitNpr)} emphasis />
          <Metric label="Interest rate" value={`${formatPercent(offer.monthlyInterestRate, 2)} / mo`} />
          <Metric label="Tenure" value={`${offer.tenureMonths} months`} />
          <Metric
            label="Processing fee"
            value={`${formatNpr(offer.processingFeeNpr)} (${formatPercent(offer.processingFeePct, 2)})`}
          />
        </dl>
      ) : (
        <p className="px-5 py-4 text-sm text-[var(--color-ink-muted)]">
          No credit limit is offered for this application.
        </p>
      )}

      {offer?.requiresGuarantor === true && (
        <p className="mx-5 mb-4 rounded-md border border-[var(--color-caution)]/40 bg-[var(--color-caution-soft)] px-3 py-2 text-sm text-[var(--color-ink)]">
          A creditworthy guarantor co-signature is required for this limit (§5.1).
        </p>
      )}

      {/* Risk metrics */}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 border-t border-[var(--color-line)] bg-[var(--color-surface-muted)] px-5 py-3 sm:grid-cols-4">
        <Metric label="Probability of default" value={formatPercent(pDefault, 2)} small />
        <Metric label="Expected loss" value={formatNpr(expectedLossNpr)} small />
      </dl>

      {/* §5.3 overrides */}
      {overrides.length > 0 && (
        <section className="border-t border-[var(--color-line)] px-5 py-4">
          <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-[var(--color-negative)]">
            <ShieldAlert size={16} aria-hidden />
            Mandatory override conditions (§5.3)
          </h3>
          <ul className="flex flex-col gap-1.5">
            {overrides.map((override) => (
              <li
                key={override.code}
                className="rounded-md border border-[var(--color-negative)]/30 bg-[var(--color-negative-soft)] px-3 py-2"
              >
                <p className="text-sm font-medium text-[var(--color-ink)]">{override.label}</p>
                <p className="mt-0.5 text-xs text-[var(--color-ink-muted)]">{override.detail}</p>
                {override.escalateToCompliance && (
                  <p className="mt-1 text-xs font-semibold text-[var(--color-negative)]">
                    Escalated to the Compliance Officer.
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Degradation */}
      {degraded && (
        <section className="border-t border-[var(--color-line)] px-5 py-4">
          <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-[var(--color-caution)]">
            <FileWarning size={16} aria-hidden />
            Assessment ran in degraded mode
          </h3>
          <p className="mb-2 text-xs text-[var(--color-ink-muted)]">
            Part of the assessment could not be completed reliably, so automated approval was
            withheld regardless of score. The application is safe to review manually.
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {degradedFlags.map((flag) => (
              <li
                key={flag}
                className="rounded-full border border-[var(--color-caution)]/40 bg-[var(--color-caution-soft)] px-2.5 py-1 text-xs font-medium text-[var(--color-ink)]"
              >
                {humanise(flag)}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Ordered justification */}
      {reasons.length > 0 && (
        <section className="border-t border-[var(--color-line)] px-5 py-4">
          <h3 className="mb-2 text-sm font-semibold text-[var(--color-ink)]">
            How this decision was reached
          </h3>
          <ol className="flex flex-col gap-1.5">
            {reasons.map((reason, index) => (
              <li key={index} className="flex gap-2 text-sm text-[var(--color-ink-muted)]">
                <span className="numeric shrink-0 text-[var(--color-ink-subtle)]">{index + 1}.</span>
                <span>{reason}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  emphasis = false,
  small = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly emphasis?: boolean;
  readonly small?: boolean;
}): React.ReactElement {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium tracking-wide text-[var(--color-ink-subtle)] uppercase">
        {label}
      </dt>
      <dd
        className={
          emphasis
            ? 'numeric mt-0.5 text-lg font-semibold text-[var(--color-ink)]'
            : small
              ? 'numeric mt-0.5 text-sm text-[var(--color-ink)]'
              : 'numeric mt-0.5 text-sm font-medium text-[var(--color-ink)]'
        }
      >
        {value}
      </dd>
    </div>
  );
}
