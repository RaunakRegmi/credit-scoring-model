'use client';

import { RISK_BAND_BY_NAME, type RiskBand } from '@aics/contracts';

import { cn } from '@/lib/utils';

/**
 * The composite score, 0–1,000, as a 270° SVG arc.
 *
 * Hand-drawn rather than pulled from a chart library: it is two arcs and a label, and a charting
 * dependency would be an order of magnitude more code than the thing it draws.
 *
 * The band boundaries are rendered as tick marks on the track so the score is readable in
 * context — 776 means little on its own, but 776 sitting just past the Prime threshold is the
 * whole story. Boundaries come from the shared contract, so they cannot drift from the engine.
 */

const START_ANGLE = 135; // Bottom-left.
const SWEEP = 270; // Leaves a gap at the bottom for the label.
const RADIUS = 88;
const STROKE = 14;
const SIZE = 240;
const CENTRE = SIZE / 2;

function polar(angleDegrees: number, radius: number): { x: number; y: number } {
  const radians = (angleDegrees * Math.PI) / 180;
  return {
    x: CENTRE + radius * Math.cos(radians),
    y: CENTRE + radius * Math.sin(radians),
  };
}

/** SVG arc path from `fromAngle` to `toAngle`, clockwise. */
function arcPath(fromAngle: number, toAngle: number, radius: number): string {
  const start = polar(fromAngle, radius);
  const end = polar(toAngle, radius);
  const largeArc = Math.abs(toAngle - fromAngle) > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

const BAND_VAR: Readonly<Record<RiskBand, string>> = {
  ELITE_PRIME: 'var(--color-band-elite)',
  PRIME: 'var(--color-band-prime)',
  NEAR_PRIME: 'var(--color-band-near)',
  SUBPRIME: 'var(--color-band-sub)',
  HIGH_RISK: 'var(--color-band-high)',
  REJECT: 'var(--color-band-reject)',
};

interface ScoreGaugeProps {
  readonly score: number;
  readonly band: RiskBand;
  readonly className?: string;
}

export function ScoreGauge({ score, band, className }: ScoreGaugeProps): React.ReactElement {
  const clamped = Math.max(0, Math.min(1000, score));
  const fraction = clamped / 1000;

  const circumference = 2 * Math.PI * RADIUS;
  const arcLength = circumference * (SWEEP / 360);
  const filled = arcLength * fraction;

  const spec = RISK_BAND_BY_NAME[band];
  const accent = BAND_VAR[band];

  // Band thresholds as tick marks, excluding 0 which is the arc's own start.
  const ticks = Object.values(RISK_BAND_BY_NAME)
    .map((entry) => entry.minScore)
    .filter((minScore) => minScore > 0)
    .sort((a, b) => a - b);

  return (
    <div className={cn('relative inline-flex flex-col items-center', className)}>
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="img"
        aria-label={`Credit score ${Math.round(clamped)} out of 1000, risk band ${spec.label}`}
        className="overflow-visible"
      >
        {/* Track */}
        <path
          d={arcPath(START_ANGLE, START_ANGLE + SWEEP, RADIUS)}
          fill="none"
          stroke="var(--color-surface-muted)"
          strokeWidth={STROKE}
          strokeLinecap="round"
        />

        {/* Band boundary ticks */}
        {ticks.map((threshold) => {
          const angle = START_ANGLE + SWEEP * (threshold / 1000);
          const inner = polar(angle, RADIUS - STROKE / 2 - 1);
          const outer = polar(angle, RADIUS + STROKE / 2 + 1);
          return (
            <line
              key={threshold}
              x1={inner.x}
              y1={inner.y}
              x2={outer.x}
              y2={outer.y}
              stroke="var(--color-line-strong)"
              strokeWidth={1.5}
            />
          );
        })}

        {/* Value arc. Drawn full-length and revealed with a dash offset so it animates. */}
        <path
          d={arcPath(START_ANGLE, START_ANGLE + SWEEP, RADIUS)}
          fill="none"
          stroke={accent}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={`${arcLength} ${circumference}`}
          className="animate-gauge"
          style={
            {
              '--gauge-empty': arcLength,
              '--gauge-offset': arcLength - filled,
              strokeDashoffset: arcLength - filled,
            } as React.CSSProperties
          }
        />

        <text
          x={CENTRE}
          y={CENTRE - 6}
          textAnchor="middle"
          className="numeric fill-[var(--color-ink)] text-[2.75rem] font-semibold"
        >
          {Math.round(clamped)}
        </text>
        <text
          x={CENTRE}
          y={CENTRE + 18}
          textAnchor="middle"
          className="fill-[var(--color-ink-subtle)] text-[0.7rem] font-medium tracking-wide uppercase"
        >
          of 1,000
        </text>
      </svg>

      <div className="-mt-6 flex flex-col items-center gap-1">
        <span
          className="rounded-full px-3 py-1 text-sm font-semibold text-white"
          style={{ backgroundColor: accent }}
        >
          {spec.label}
        </span>
        <span className="numeric text-xs text-[var(--color-ink-subtle)]">
          band range {spec.minScore}–{spec.maxScore}
        </span>
      </div>
    </div>
  );
}
