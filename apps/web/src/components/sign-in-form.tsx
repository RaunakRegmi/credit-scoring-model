'use client';

import { useState } from 'react';
import { AlertCircle, Loader2, LogIn, ShieldCheck } from 'lucide-react';

import { useAuth } from '@/components/auth-provider';
import { ApiError } from '@/lib/api';

/**
 * Staff sign-in.
 *
 * The error text is whatever the API returned, unmodified. The API answers a wrong password, an
 * unknown email, a locked account and a deactivated account identically on purpose, and helpfully
 * distinguishing them here — "no account with that email" — would undo that server-side care and
 * turn this form into a staff directory.
 */
export function SignInForm(): React.ReactElement {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      await signIn(email.trim(), password);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the assessment service. Check your connection and try again.',
      );
      // Cleared on failure so a retry cannot resubmit a stale value, and so the password is not
      // sitting in a DOM node after a failed attempt.
      setPassword('');
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <p className="text-xs font-semibold tracking-widest text-[var(--color-brand)] uppercase">
            Fintara Solutions · ONE BNPL
          </p>
          <h1 className="mt-1 text-xl font-semibold text-[var(--color-ink)]">
            Credit Assessment
          </h1>
          <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
            Staff sign-in. Authorised users only.
          </p>
        </div>

        <form onSubmit={onSubmit} className="card flex flex-col gap-4 px-5 py-5">
          {error !== null && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-[var(--color-negative)]/40 bg-[var(--color-negative-soft)] px-3 py-2 text-sm text-[var(--color-ink)]"
            >
              <AlertCircle size={15} className="mt-0.5 shrink-0 text-[var(--color-negative)]" aria-hidden />
              <span>{error}</span>
            </div>
          )}

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium tracking-wide text-[var(--color-ink-muted)] uppercase">
              Work email
            </span>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              autoComplete="username"
              autoFocus
              className="rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-ink)] outline-none focus:border-[var(--color-brand)] focus:ring-2 focus:ring-[var(--color-brand)]/20"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium tracking-wide text-[var(--color-ink-muted)] uppercase">
              Password
            </span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              autoComplete="current-password"
              className="rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-ink)] outline-none focus:border-[var(--color-brand)] focus:ring-2 focus:ring-[var(--color-brand)]/20"
            />
          </label>

          <button
            type="submit"
            disabled={pending}
            className="mt-1 inline-flex items-center justify-center gap-2 rounded-lg bg-[var(--color-brand)] px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {pending ? (
              <Loader2 size={15} className="animate-spin" aria-hidden />
            ) : (
              <LogIn size={15} aria-hidden />
            )}
            {pending ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="mt-4 flex items-start gap-1.5 text-xs text-[var(--color-ink-subtle)]">
          <ShieldCheck size={13} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            Access is logged. Credit decisions recorded through this system carry your name and
            role in an immutable audit record (§10.4).
          </span>
        </p>
      </div>
    </main>
  );
}
