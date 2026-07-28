'use client';

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { PILLAR_SPECS, type PillarResult } from '@aics/contracts';

import { cn } from '@/lib/utils';

/**
 * The four pillars, each expanding to its §4.2–4.5 sub-parameter rows.
 *
 * The sub-scores are the point of this component. A composite of 776 is not actionable; "you
 * lost 44 of 60 points on salary consistency because only 2 of 6 months showed a verified
 * salary credit" is what an underwriter acts on and what an applicant can be told.
 */

const PILLAR_ACCENT: Readonly<Record<string, string>> = {
  FINANCIAL: 'var(--color-brand)',
  PROFESSIONAL: 'var(--color-band-elite)',
  SOCIAL: 'var(--color-band-near)',
  BEHAVIORAL: 'var(--color-band-sub)',
};

interface PillarBreakdownProps {
  readonly pillars: readonly PillarResult[];
}

export function PillarBreakdown({ pillars }: PillarBreakdownProps): React.ReactElement {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (pillars.length === 0) {
    return (
      <p className="text-sm text-[var(--color-ink-muted)]">
        No pillar breakdown is available for this assessment.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {pillars.map((pillar, index) => {
        const spec = PILLAR_SPECS.find((entry) => entry.pillar === pillar.pillar);
        const accent = PILLAR_ACCENT[pillar.pillar] ?? 'var(--color-brand)';
        const ratio = pillar.maxPoints === 0 ? 0 : pillar.points / pillar.maxPoints;
        const isOpen = expanded === pillar.pillar;

        return (
          <div key={pillar.pillar} className="card overflow-hidden">
            <button
              type="button"
              onClick={() => setExpanded(isOpen ? null : pillar.pillar)}
              aria-expanded={isOpen}
              className="flex w-full items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-[var(--color-surface-muted)]"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-sm font-semibold text-[var(--color-ink)]">
                    {spec?.label ?? pillar.pillar}
                  </span>
                  <span className="numeric shrink-0 text-sm text-[var(--color-ink-muted)]">
                    <span className="font-semibold text-[var(--color-ink)]">
                      {pillar.points.toFixed(0)}
                    </span>
                    {' / '}
                    {pillar.maxPoints}
                  </span>
                </div>

                <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--color-surface-muted)]">
                  <div
                    className="animate-bar h-full rounded-full"
                    style={{
                      width: `${(ratio * 100).toFixed(2)}%`,
                      backgroundColor: accent,
                      // Stagger so the four bars read as a sequence rather than a single flash.
                      animationDelay: `${index * 90}ms`,
                    }}
                  />
                </div>

                <div className="mt-1.5 flex items-center gap-2 text-xs text-[var(--color-ink-subtle)]">
                  <span>{spec?.primarySource}</span>
                  <span aria-hidden>·</span>
                  <span className="numeric">{(ratio * 100).toFixed(0)}% earned</span>
                  {pillar.notes.length > 0 && (
                    <>
                      <span aria-hidden>·</span>
                      <span className="font-medium text-[var(--color-caution)]">
                        {pillar.notes.length} note{pillar.notes.length > 1 ? 's' : ''}
                      </span>
                    </>
                  )}
                </div>
              </div>

              <ChevronDown
                size={18}
                className={cn(
                  'shrink-0 text-[var(--color-ink-subtle)] transition-transform',
                  isOpen && 'rotate-180',
                )}
                aria-hidden
              />
            </button>

            {isOpen && (
              <div className="border-t border-[var(--color-line)] bg-[var(--color-surface-muted)] px-4 py-3">
                {pillar.notes.length > 0 && (
                  <ul className="mb-3 flex flex-col gap-1">
                    {pillar.notes.map((note) => (
                      <li
                        key={note}
                        className="rounded-md border border-[var(--color-caution)]/30 bg-[var(--color-caution-soft)] px-2.5 py-1.5 text-xs text-[var(--color-ink)]"
                      >
                        {note}
                      </li>
                    ))}
                  </ul>
                )}

                <div className="overflow-x-auto">
                  <table className="w-full min-w-[34rem] border-collapse text-left text-xs">
                    <thead>
                      <tr className="text-[var(--color-ink-subtle)]">
                        <th scope="col" className="pb-2 pr-3 font-medium">
                          Sub-parameter
                        </th>
                        <th scope="col" className="pb-2 pr-3 text-right font-medium">
                          Points
                        </th>
                        <th scope="col" className="pb-2 font-medium">
                          How it was scored
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {pillar.subScores.map((sub) => {
                        const subRatio = sub.maxPoints === 0 ? 0 : sub.points / sub.maxPoints;
                        return (
                          <tr
                            key={sub.code}
                            className="border-t border-[var(--color-line)] align-top"
                          >
                            <td className="py-2 pr-3 font-medium text-[var(--color-ink)]">
                              {sub.label}
                            </td>
                            <td className="numeric py-2 pr-3 text-right whitespace-nowrap">
                              <span
                                className={cn(
                                  'font-semibold',
                                  subRatio >= 0.75
                                    ? 'text-[var(--color-positive)]'
                                    : subRatio >= 0.4
                                      ? 'text-[var(--color-caution)]'
                                      : 'text-[var(--color-negative)]',
                                )}
                              >
                                {sub.points.toFixed(0)}
                              </span>
                              <span className="text-[var(--color-ink-subtle)]">
                                {' / '}
                                {sub.maxPoints}
                              </span>
                            </td>
                            <td className="py-2 text-[var(--color-ink-muted)]">{sub.detail}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
