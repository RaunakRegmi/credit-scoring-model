'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ChevronLeft, ChevronRight, Clock, Inbox, Loader2 } from 'lucide-react';
import type { QueueItem } from '@aics/contracts';

import { getReviewQueue } from '@/lib/api';
import { formatDateTime, formatNpr, humanise } from '@/lib/utils';

const PAGE_SIZE = 25;

/**
 * The underwriter review queue.
 *
 * Ordered oldest-first by the API, and the wait time is shown on every row rather than only on the
 * late ones. An SLA you can only see once it is breached is an SLA nobody manages — the point of
 * the column is to make the item approaching 48 hours visible while there is still time.
 */
export default function QueuePage(): React.ReactElement {
  const [offset, setOffset] = useState(0);

  const queue = useQuery({
    queryKey: ['review-queue', offset],
    queryFn: () => getReviewQueue({ limit: PAGE_SIZE, offset }),
    refetchInterval: 60_000,
  });

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-8 sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-[var(--color-ink)]">Review queue</h1>
          <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
            Applications the engine referred for a human decision (SOP-004). Oldest first.
          </p>
        </div>

        {queue.data !== undefined && (
          <div className="flex items-center gap-5 text-sm">
            <Stat label="Awaiting review" value={queue.data.total} />
            <Stat
              label={`Past ${queue.data.slaHours}h`}
              value={queue.data.breachedCount}
              alert={queue.data.breachedCount > 0}
            />
          </div>
        )}
      </header>

      {queue.isPending && (
        <div className="card flex items-center justify-center px-5 py-12">
          <Loader2 size={18} className="animate-spin text-[var(--color-ink-subtle)]" aria-label="Loading" />
        </div>
      )}

      {queue.isError && (
        <div
          role="alert"
          className="card border-[var(--color-negative)]/40 bg-[var(--color-negative-soft)] px-5 py-4 text-sm"
        >
          <p className="font-semibold text-[var(--color-negative)]">Could not load the queue</p>
          <p className="mt-1 text-[var(--color-ink)]">
            {queue.error instanceof Error ? queue.error.message : 'An unexpected error occurred.'}
          </p>
        </div>
      )}

      {queue.data !== undefined && queue.data.items.length === 0 && (
        <div className="card flex flex-col items-center gap-2 px-5 py-12 text-center">
          <Inbox size={22} className="text-[var(--color-ink-subtle)]" aria-hidden />
          <p className="text-sm font-medium text-[var(--color-ink)]">Nothing awaiting review</p>
          <p className="text-sm text-[var(--color-ink-muted)]">
            Referred applications appear here as soon as the engine routes them to a human.
          </p>
        </div>
      )}

      {queue.data !== undefined && queue.data.items.length > 0 && (
        <>
          {/*
            Two presentations of the same data, not a compromise between them. Eight columns cannot
            be read on a 390px screen even inside a horizontal scroller — and the scroller was not
            even engaging, because a flex item defaults to `min-width: auto` and the table's
            `min-w` was forcing the whole page 400px wider than the viewport.
          */}
          <ul className="flex list-none flex-col gap-3 sm:hidden">
            {queue.data.items.map((item) => (
              <QueueCard key={item.applicationId} item={item} />
            ))}
          </ul>

          <div className="card hidden min-w-0 overflow-x-auto sm:block">
            <table className="w-full min-w-[52rem] text-sm">
              <thead>
                <tr className="border-b border-[var(--color-line)] text-left text-xs tracking-wide text-[var(--color-ink-subtle)] uppercase">
                  <th scope="col" className="px-4 py-3 font-medium">Reference</th>
                  <th scope="col" className="px-4 py-3 font-medium">Applicant</th>
                  <th scope="col" className="px-4 py-3 font-medium">Product</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Requested</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Score</th>
                  <th scope="col" className="px-4 py-3 font-medium">Why referred</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Waiting</th>
                  <th scope="col" className="px-4 py-3"><span className="sr-only">Open</span></th>
                </tr>
              </thead>
              <tbody>
                {queue.data.items.map((item) => (
                  <QueueRow key={item.applicationId} item={item} />
                ))}
              </tbody>
            </table>
          </div>

          <nav
            className="flex flex-wrap items-center justify-between gap-3 text-sm"
            aria-label="Pagination"
          >
            <p className="text-[var(--color-ink-muted)]">
              {offset + 1}–{Math.min(offset + PAGE_SIZE, queue.data.total)} of {queue.data.total}
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
                disabled={offset + PAGE_SIZE >= queue.data.total}
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
 * The engine's reason for referring, condensed to the one thing an underwriter triages on, plus a
 * count of everything else that fired. Shared by both presentations so they cannot drift.
 */
function referralReason(item: QueueItem): { readonly text: string; readonly extra: number } {
  const text =
    item.overrideCodes.length > 0
      ? humanise(item.overrideCodes[0] ?? '')
      : item.degradedFlags.length > 0
        ? humanise(item.degradedFlags[0] ?? '')
        : `${humanise(item.riskBand)} band`;

  return { text, extra: item.overrideCodes.length + item.degradedFlags.length - 1 };
}

/** Wait time, shown on every item rather than only the late ones. */
function WaitingBadge({ item }: { readonly item: QueueItem }): React.ReactElement {
  return (
    <span
      className={
        item.slaBreached
          ? 'numeric inline-flex items-center gap-1 rounded-md bg-[var(--color-negative-soft)] px-2 py-1 text-xs font-semibold text-[var(--color-negative)]'
          : 'numeric inline-flex items-center gap-1 text-xs text-[var(--color-ink-muted)]'
      }
      title={`Referred ${formatDateTime(item.referredAt)}`}
    >
      {item.slaBreached ? (
        <AlertTriangle size={12} aria-hidden />
      ) : (
        <Clock size={12} aria-hidden />
      )}
      {item.waitingHours}h waiting
    </span>
  );
}

/** Phone presentation: one card per referral, whole card tappable. */
function QueueCard({ item }: { readonly item: QueueItem }): React.ReactElement {
  const reason = referralReason(item);

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

        <p className="text-sm text-[var(--color-ink)]">
          {reason.text}
          {reason.extra > 0 && (
            <span className="ml-1 text-xs text-[var(--color-ink-subtle)]">
              +{reason.extra} more
            </span>
          )}
        </p>

        <div className="mt-0.5 flex items-center justify-between gap-3">
          <WaitingBadge item={item} />
          <span className="inline-flex items-center gap-1 text-sm font-medium text-[var(--color-brand)]">
            Review
            <ChevronRight size={14} aria-hidden />
          </span>
        </div>
      </Link>
    </li>
  );
}

function QueueRow({ item }: { readonly item: QueueItem }): React.ReactElement {
  const { text: reason, extra } = referralReason(item);

  return (
    <tr className="border-b border-[var(--color-line)] last:border-0 hover:bg-[var(--color-surface-muted)]">
      <td className="numeric px-4 py-3 font-medium text-[var(--color-ink)]">{item.arn}</td>
      <td className="px-4 py-3 text-[var(--color-ink)]">{item.applicantName}</td>
      <td className="px-4 py-3 text-[var(--color-ink-muted)]">{humanise(item.productType)}</td>
      <td className="numeric px-4 py-3 text-right text-[var(--color-ink)]">
        {formatNpr(item.requestedAmountNpr, { compact: true })}
      </td>
      <td className="numeric px-4 py-3 text-right font-semibold text-[var(--color-ink)]">
        {item.compositeScore.toFixed(0)}
      </td>
      <td className="px-4 py-3 text-[var(--color-ink-muted)]">
        {reason}
        {extra > 0 && (
          <span className="ml-1 text-xs text-[var(--color-ink-subtle)]">+{extra} more</span>
        )}
      </td>
      <td className="px-4 py-3 text-right">
        <WaitingBadge item={item} />
      </td>
      <td className="px-4 py-3 text-right">
        <Link
          href={`/queue/${item.applicationId}`}
          className="rounded-md border border-[var(--color-line-strong)] px-2.5 py-1.5 text-xs font-medium text-[var(--color-ink)] transition-colors hover:bg-[var(--color-surface)]"
        >
          Review
        </Link>
      </td>
    </tr>
  );
}

function Stat({
  label,
  value,
  alert = false,
}: {
  readonly label: string;
  readonly value: number;
  readonly alert?: boolean;
}): React.ReactElement {
  return (
    <div className="text-right">
      <p
        className={
          alert
            ? 'numeric text-lg font-semibold text-[var(--color-negative)]'
            : 'numeric text-lg font-semibold text-[var(--color-ink)]'
        }
      >
        {value}
      </p>
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
