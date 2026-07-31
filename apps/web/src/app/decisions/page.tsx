'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Archive,
  ChevronLeft,
  ChevronRight,
  Loader2,
  ShieldCheck,
  UserCheck,
} from 'lucide-react';
import type { DecisionHistoryItem } from '@aics/contracts';

import { getDecisionHistory } from '@/lib/api';
import { formatDateTime, formatNpr, humanise } from '@/lib/utils';

const PAGE_SIZE = 25;

/**
 * Decided applications — the oversight counterpart to the review queue.
 *
 * The queue shows work outstanding and drops an application the moment it is decided. This shows
 * the opposite set, for the roles whose job starts after the decision: what was decided, by whom,
 * against what the engine recommended, and who co-signed where SOP-004 required it.
 *
 * Engine-only decisions are listed alongside the human ones rather than filtered out. Most
 * applications never reach the queue, and a history of only the reviewed ones would read as though
 * every decision passed through a person.
 */
export default function DecisionsPage(): React.ReactElement {
  const [offset, setOffset] = useState(0);

  const history = useQuery({
    queryKey: ['decision-history', offset],
    queryFn: () => getDecisionHistory({ limit: PAGE_SIZE, offset }),
  });

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-8 sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-[var(--color-ink)]">Decisions</h1>
          <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
            Every application that has been decided, newest first — by the engine or by a
            reviewer (§10.4).
          </p>
        </div>

        {history.data !== undefined && (
          <div className="flex items-center gap-5 text-sm">
            <Stat label="Decided" value={history.data.total} />
            <Stat label="By a reviewer" value={history.data.humanReviewedCount} />
            <Stat label="Co-signed" value={history.data.coSignedCount} />
          </div>
        )}
      </header>

      {history.isPending && (
        <div className="card flex items-center justify-center px-5 py-12">
          <Loader2
            size={18}
            className="animate-spin text-[var(--color-ink-subtle)]"
            aria-label="Loading"
          />
        </div>
      )}

      {history.isError && (
        <div
          role="alert"
          className="card border-[var(--color-negative)]/40 bg-[var(--color-negative-soft)] px-5 py-4 text-sm"
        >
          <p className="font-semibold text-[var(--color-negative)]">Could not load decisions</p>
          <p className="mt-1 text-[var(--color-ink)]">
            {history.error instanceof Error
              ? history.error.message
              : 'An unexpected error occurred.'}
          </p>
        </div>
      )}

      {history.data !== undefined && history.data.items.length === 0 && (
        <div className="card flex flex-col items-center gap-2 px-5 py-12 text-center">
          <Archive size={22} className="text-[var(--color-ink-subtle)]" aria-hidden />
          <p className="text-sm font-medium text-[var(--color-ink)]">Nothing decided yet</p>
          <p className="text-sm text-[var(--color-ink-muted)]">
            Applications appear here once the engine decides them or a reviewer records a decision.
          </p>
        </div>
      )}

      {history.data !== undefined && history.data.items.length > 0 && (
        <>
          {/* Same two-presentation approach as the queue: cards on a phone, table from `sm` up. */}
          <ul className="flex list-none flex-col gap-3 sm:hidden">
            {history.data.items.map((item) => (
              <DecisionCard key={item.applicationId} item={item} />
            ))}
          </ul>

          <div className="card hidden min-w-0 overflow-x-auto sm:block">
            <table className="w-full min-w-[54rem] text-sm">
              <thead>
                <tr className="border-b border-[var(--color-line)] text-left text-xs tracking-wide text-[var(--color-ink-subtle)] uppercase">
                  <th scope="col" className="px-4 py-3 font-medium">Reference</th>
                  <th scope="col" className="px-4 py-3 font-medium">Applicant</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Score</th>
                  <th scope="col" className="px-4 py-3 font-medium">Engine said</th>
                  <th scope="col" className="px-4 py-3 font-medium">Decision</th>
                  <th scope="col" className="px-4 py-3 font-medium">Decided by</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">When</th>
                  <th scope="col" className="px-4 py-3"><span className="sr-only">Open</span></th>
                </tr>
              </thead>
              <tbody>
                {history.data.items.map((item) => (
                  <DecisionRow key={item.applicationId} item={item} />
                ))}
              </tbody>
            </table>
          </div>

          <nav
            className="flex flex-wrap items-center justify-between gap-3 text-sm"
            aria-label="Pagination"
          >
            <p className="text-[var(--color-ink-muted)]">
              {offset + 1}–{Math.min(offset + PAGE_SIZE, history.data.total)} of{' '}
              {history.data.total}
            </p>
            <div className="flex gap-2">
              <PageButton
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                <ChevronLeft size={15} aria-hidden />
                Previous
              </PageButton>
              <PageButton
                disabled={offset + PAGE_SIZE >= history.data.total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next
                <ChevronRight size={15} aria-hidden />
              </PageButton>
            </div>
          </nav>
        </>
      )}
    </main>
  );
}

/**
 * Approvals and declines read differently at a glance, which is the whole job of this column in a
 * list someone is scanning for the one decision they came to look at.
 */
function DecisionPill({ decision }: { readonly decision: string }): React.ReactElement {
  const declined = decision === 'DECLINE';
  const referred = decision === 'REFER_UNDERWRITER';

  return (
    <span
      className={
        declined
          ? 'inline-flex rounded-md bg-[var(--color-negative-soft)] px-2 py-1 text-xs font-semibold text-[var(--color-negative)]'
          : referred
            ? 'inline-flex rounded-md bg-[var(--color-surface-muted)] px-2 py-1 text-xs font-semibold text-[var(--color-ink-muted)]'
            : 'inline-flex rounded-md bg-[var(--color-positive-soft)] px-2 py-1 text-xs font-semibold text-[var(--color-positive)]'
      }
    >
      {humanise(decision)}
    </span>
  );
}

/** Who decided, and whether a second signature was required to do it. */
function DecidedBy({ item }: { readonly item: DecisionHistoryItem }): React.ReactElement {
  if (item.review === null) {
    return (
      <span className="text-xs text-[var(--color-ink-subtle)]">Engine — no human review</span>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      <span className="inline-flex items-center gap-1 text-[var(--color-ink)]">
        <UserCheck size={13} className="text-[var(--color-ink-subtle)]" aria-hidden />
        {item.review.reviewerName}
        <span className="text-xs text-[var(--color-ink-subtle)]">
          · {humanise(item.review.reviewerRole)}
        </span>
      </span>
      {item.review.dualAuthByName !== null && (
        <span className="inline-flex items-center gap-1 text-xs text-[var(--color-brand)]">
          <ShieldCheck size={12} aria-hidden />
          Co-signed by {item.review.dualAuthByName}
        </span>
      )}
    </div>
  );
}

/** Phone presentation: one card per decision. */
function DecisionCard({ item }: { readonly item: DecisionHistoryItem }): React.ReactElement {
  return (
    <li className="card min-w-0">
      <Link
        href={`/queue/${item.applicationId}`}
        className="flex min-w-0 flex-col gap-2 px-4 py-3.5 active:bg-[var(--color-surface-muted)]"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate font-medium text-[var(--color-ink)]">{item.applicantName}</p>
            <p className="numeric truncate text-xs text-[var(--color-ink-subtle)]">{item.arn}</p>
          </div>
          <div className="shrink-0 text-right">
            <p className="numeric text-lg leading-none font-semibold text-[var(--color-ink)]">
              {item.compositeScore.toFixed(0)}
            </p>
            <p className="text-[11px] text-[var(--color-ink-subtle)]">{humanise(item.riskBand)}</p>
          </div>
        </div>

        <p className="text-sm text-[var(--color-ink-muted)]">
          {humanise(item.productType)} · {formatNpr(item.requestedAmountNpr, { compact: true })}
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <DecisionPill decision={item.finalDecision} />
          {item.overrodeEngine && (
            <span className="text-xs text-[var(--color-ink-subtle)]">
              engine said {humanise(item.systemDecision)}
            </span>
          )}
        </div>

        <DecidedBy item={item} />

        <p className="text-xs text-[var(--color-ink-subtle)]">{formatDateTime(item.decidedAt)}</p>
      </Link>
    </li>
  );
}

function DecisionRow({ item }: { readonly item: DecisionHistoryItem }): React.ReactElement {
  return (
    <tr className="border-b border-[var(--color-line)] last:border-0 hover:bg-[var(--color-surface-muted)]">
      <td className="numeric px-4 py-3 font-medium text-[var(--color-ink)]">{item.arn}</td>
      <td className="px-4 py-3 text-[var(--color-ink)]">{item.applicantName}</td>
      <td className="numeric px-4 py-3 text-right font-semibold text-[var(--color-ink)]">
        {item.compositeScore.toFixed(0)}
      </td>
      <td className="px-4 py-3 text-xs text-[var(--color-ink-muted)]">
        {humanise(item.systemDecision)}
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-col items-start gap-1">
          <DecisionPill decision={item.finalDecision} />
          {item.overrodeEngine && (
            <span className="text-[11px] font-medium text-[var(--color-brand)]">
              overrode the engine
            </span>
          )}
        </div>
      </td>
      <td className="px-4 py-3">
        <DecidedBy item={item} />
      </td>
      <td className="px-4 py-3 text-right text-xs text-[var(--color-ink-muted)]">
        {formatDateTime(item.decidedAt)}
      </td>
      <td className="px-4 py-3 text-right">
        <Link
          href={`/queue/${item.applicationId}`}
          className="rounded-md border border-[var(--color-line-strong)] px-2.5 py-1.5 text-xs font-medium text-[var(--color-ink)] transition-colors hover:bg-[var(--color-surface)]"
        >
          Open
        </Link>
      </td>
    </tr>
  );
}

function Stat({ label, value }: { readonly label: string; readonly value: number }): React.ReactElement {
  return (
    <div className="text-right">
      <p className="numeric text-lg font-semibold text-[var(--color-ink)]">{value}</p>
      <p className="text-[11px] tracking-wide text-[var(--color-ink-subtle)] uppercase">{label}</p>
    </div>
  );
}

function PageButton({
  disabled,
  onClick,
  children,
}: {
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-1.5 text-sm font-medium text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-surface-muted)] disabled:opacity-40"
    >
      {children}
    </button>
  );
}
