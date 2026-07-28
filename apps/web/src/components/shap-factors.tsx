'use client';

import { TrendingDown, TrendingUp } from 'lucide-react';
import type { ShapFactor } from '@aics/contracts';

import { cn } from '@/lib/utils';

/**
 * The §6.3 explainability panel: top 5 supporting factors and top 3 adverse ones.
 *
 * Every row shows the plain-language `description`, never the raw feature name. That is not
 * cosmetic — SOP-003 requires the top 3 adverse factors to be communicated to a declined
 * applicant verbatim, so what appears here is what goes into the adverse action notice. A row
 * reading `dsr` would be unusable for that purpose.
 *
 * Bars are scaled against the largest magnitude in the panel, so the relative weight of factors
 * is visible without asking anyone to interpret a log-odds value.
 */

interface ShapFactorsProps {
  readonly positive: readonly ShapFactor[];
  readonly negative: readonly ShapFactor[];
  /** True when SHAP was unavailable and the factors came from the scorecard sub-scores. */
  readonly derivedFromScorecard: boolean;
}

function FactorList({
  factors,
  tone,
  emptyMessage,
  scale,
}: {
  readonly factors: readonly ShapFactor[];
  readonly tone: 'positive' | 'negative';
  readonly emptyMessage: string;
  readonly scale: number;
}): React.ReactElement {
  if (factors.length === 0) {
    return <p className="px-1 py-2 text-xs text-[var(--color-ink-subtle)]">{emptyMessage}</p>;
  }

  const accent = tone === 'positive' ? 'var(--color-positive)' : 'var(--color-negative)';
  const soft = tone === 'positive' ? 'var(--color-positive-soft)' : 'var(--color-negative-soft)';

  return (
    <ul className="flex flex-col gap-1.5">
      {factors.map((factor, index) => {
        const magnitude = Math.abs(factor.shapValue);
        const width = scale === 0 ? 0 : Math.max(4, (magnitude / scale) * 100);

        return (
          <li
            key={`${factor.feature}-${index}`}
            className="rounded-lg border border-[var(--color-line)] px-3 py-2.5"
            style={{ backgroundColor: soft }}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm leading-snug font-medium text-[var(--color-ink)]">
                  {factor.description}
                </p>
                <p className="mt-0.5 text-xs text-[var(--color-ink-subtle)]">{factor.label}</p>
              </div>
              <span
                className="numeric shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold text-white"
                style={{ backgroundColor: accent }}
                title="Contribution magnitude"
              >
                {magnitude.toFixed(2)}
              </span>
            </div>

            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/60">
              <div
                className="animate-bar h-full rounded-full"
                style={{
                  width: `${width.toFixed(1)}%`,
                  backgroundColor: accent,
                  animationDelay: `${index * 70}ms`,
                }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function ShapFactors({
  positive,
  negative,
  derivedFromScorecard,
}: ShapFactorsProps): React.ReactElement {
  // One shared scale across both columns so a strong positive and a strong negative are
  // visually comparable rather than each filling its own column.
  const scale = Math.max(
    ...positive.map((factor) => Math.abs(factor.shapValue)),
    ...negative.map((factor) => Math.abs(factor.shapValue)),
    0,
  );

  return (
    <div className="flex flex-col gap-4">
      {derivedFromScorecard && (
        <p className="rounded-md border border-[var(--color-line)] bg-[var(--color-surface-muted)] px-3 py-2 text-xs text-[var(--color-ink-muted)]">
          The scoring model was unavailable, so these factors were derived from the deterministic
          scorecard&apos;s sub-scores rather than from SHAP values. The ranking reflects points
          earned and forfeited.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <section>
          <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-[var(--color-ink)]">
            <TrendingDown size={16} className="text-[var(--color-positive)]" aria-hidden />
            Supporting this application
            <span className="ml-1 text-xs font-normal text-[var(--color-ink-subtle)]">
              top {positive.length}
            </span>
          </h3>
          <FactorList
            factors={positive}
            tone="positive"
            scale={scale}
            emptyMessage="No materially favourable factors were identified."
          />
        </section>

        <section>
          <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-[var(--color-ink)]">
            <TrendingUp size={16} className="text-[var(--color-negative)]" aria-hidden />
            Counting against this application
            <span className="ml-1 text-xs font-normal text-[var(--color-ink-subtle)]">
              top {negative.length}
            </span>
          </h3>
          <FactorList
            factors={negative}
            tone="negative"
            scale={scale}
            emptyMessage="No adverse factors were identified."
          />
          {negative.length > 0 && (
            <p className="mt-2 text-xs text-[var(--color-ink-subtle)]">
              These are the reasons communicated to the applicant on a declined decision
              (SOP-003).
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

/** Shared by the decision banner to colour its accent consistently. */
export function factorTone(direction: ShapFactor['direction']): string {
  return cn(
    direction === 'DECREASES_RISK'
      ? 'text-[var(--color-positive)]'
      : 'text-[var(--color-negative)]',
  );
}
