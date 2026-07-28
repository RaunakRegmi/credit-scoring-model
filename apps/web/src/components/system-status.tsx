'use client';

import { useQuery } from '@tanstack/react-query';
import { Activity, AlertTriangle, CircleCheck, CircleX } from 'lucide-react';

import { getReadiness } from '@/lib/api';

/**
 * System posture strip.
 *
 * Present because "degraded" is a real, expected operating state for this system, not an
 * anomaly. When the scoring model is down the engine keeps deciding on the deterministic
 * scorecard but stops auto-approving — an underwriter seeing a run of referrals needs to know
 * that immediately, rather than inferring it from the pattern.
 *
 * It also surfaces the model's provenance, so nobody forgets the launch model was trained on
 * synthetic data.
 */
export function SystemStatus(): React.ReactElement | null {
  const { data, isError } = useQuery({
    queryKey: ['readiness'],
    queryFn: getReadiness,
    refetchInterval: 30_000,
    retry: 0,
  });

  if (isError) {
    return (
      <Strip
        tone="error"
        icon={<CircleX size={14} aria-hidden />}
        text="Cannot reach the assessment API."
      />
    );
  }

  if (data === undefined) {
    return null;
  }

  if (!data.database) {
    return (
      <Strip
        tone="error"
        icon={<CircleX size={14} aria-hidden />}
        text="Database unavailable — assessments cannot run."
      />
    );
  }

  if (!data.mlService.reachable) {
    return (
      <Strip
        tone="warn"
        icon={<AlertTriangle size={14} aria-hidden />}
        text={
          `Scoring model unreachable (circuit ${data.mlService.circuit.toLowerCase()}). ` +
          'Assessments continue on the deterministic scorecard, but automated approval is withheld.'
        }
      />
    );
  }

  return (
    <Strip
      tone="ok"
      icon={<CircleCheck size={14} aria-hidden />}
      text={
        <>
          All systems operational.
          <span className="mx-1.5 text-[var(--color-ink-subtle)]" aria-hidden>
            ·
          </span>
          <span className="text-[var(--color-ink-muted)]">
            scorecard v{data.versions.scorecard}, features v{data.versions.featureSet}, policy v
            {data.versions.policy}
          </span>
          {data.mlService.provenance === 'SYNTHETIC_SEED' && (
            <>
              <span className="mx-1.5 text-[var(--color-ink-subtle)]" aria-hidden>
                ·
              </span>
              <span className="font-medium text-[var(--color-caution)]">
                model trained on synthetic seed data, running in shadow mode
              </span>
            </>
          )}
        </>
      }
    />
  );
}

function Strip({
  tone,
  icon,
  text,
}: {
  readonly tone: 'ok' | 'warn' | 'error';
  readonly icon: React.ReactNode;
  readonly text: React.ReactNode;
}): React.ReactElement {
  const palette = {
    ok: {
      border: 'var(--color-line)',
      background: 'var(--color-surface)',
      color: 'var(--color-positive)',
    },
    warn: {
      border: 'color-mix(in oklch, var(--color-caution) 40%, transparent)',
      background: 'var(--color-caution-soft)',
      color: 'var(--color-caution)',
    },
    error: {
      border: 'color-mix(in oklch, var(--color-negative) 40%, transparent)',
      background: 'var(--color-negative-soft)',
      color: 'var(--color-negative)',
    },
  }[tone];

  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-lg border px-3 py-2 text-xs"
      style={{ borderColor: palette.border, backgroundColor: palette.background }}
    >
      <span className="mt-0.5 shrink-0" style={{ color: palette.color }}>
        {icon}
      </span>
      <p className="text-[var(--color-ink)]">{text}</p>
      <Activity size={12} className="ml-auto shrink-0 text-[var(--color-ink-subtle)]" aria-hidden />
    </div>
  );
}
