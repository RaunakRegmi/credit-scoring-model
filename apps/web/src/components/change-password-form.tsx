'use client';

import { useState } from 'react';
import { AlertCircle, KeyRound, Loader2 } from 'lucide-react';

import { useAuth } from '@/components/auth-provider';
import { ApiError } from '@/lib/api';

/** Matches the floor in `changePasswordSchema`, so the form refuses what the API would refuse. */
const MIN_LENGTH = 12;

/**
 * Forced password change for a provisioned account.
 *
 * Shown instead of the application, not alongside it. The API enforces the same restriction — a
 * token with `mustChangePassword` reaches only `/me`, `/change-password` and `/logout` — so this
 * screen is the usable path through a state the server is already enforcing, not the enforcement
 * itself.
 */
export function ChangePasswordForm(): React.ReactElement {
  const { staff, changePassword, signOut } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;
  const tooShort = newPassword.length > 0 && newPassword.length < MIN_LENGTH;
  const canSubmit =
    currentPassword.length > 0 &&
    newPassword.length >= MIN_LENGTH &&
    newPassword === confirmPassword &&
    !pending;

  async function onSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      await changePassword(currentPassword, newPassword);
      // On success the provider signs out, because the change revoked every session. The sign-in
      // screen replaces this one.
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the assessment service. Try again.',
      );
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <KeyRound size={20} className="mx-auto text-[var(--color-brand)]" aria-hidden />
          <h1 className="mt-2 text-xl font-semibold text-[var(--color-ink)]">
            Set a new password
          </h1>
          <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
            This account was provisioned with a temporary password. It cannot be used for anything
            else until you replace it.
          </p>
          {staff !== null && (
            <p className="numeric mt-2 text-xs text-[var(--color-ink-subtle)]">{staff.email}</p>
          )}
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

          <Field
            label="Temporary password"
            value={currentPassword}
            onChange={setCurrentPassword}
            autoComplete="current-password"
            autoFocus
          />
          <Field
            label={`New password (at least ${MIN_LENGTH} characters)`}
            value={newPassword}
            onChange={setNewPassword}
            autoComplete="new-password"
            hint={tooShort ? `At least ${MIN_LENGTH} characters.` : undefined}
          />
          <Field
            label="Confirm new password"
            value={confirmPassword}
            onChange={setConfirmPassword}
            autoComplete="new-password"
            hint={mismatch ? 'The two passwords do not match.' : undefined}
          />

          <button
            type="submit"
            disabled={!canSubmit}
            className="mt-1 inline-flex items-center justify-center gap-2 rounded-lg bg-[var(--color-brand)] px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {pending && <Loader2 size={15} className="animate-spin" aria-hidden />}
            {pending ? 'Saving…' : 'Set password and sign in again'}
          </button>

          <button
            type="button"
            onClick={() => void signOut()}
            className="text-xs text-[var(--color-ink-subtle)] underline-offset-2 hover:underline"
          >
            Sign out instead
          </button>
        </form>

        <p className="mt-4 text-xs text-[var(--color-ink-subtle)]">
          Changing your password ends every other active session on your account.
        </p>
      </div>
    </main>
  );
}

function Field({
  label,
  value,
  onChange,
  autoComplete,
  autoFocus = false,
  hint,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly autoComplete: string;
  readonly autoFocus?: boolean;
  readonly hint?: string;
}): React.ReactElement {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium tracking-wide text-[var(--color-ink-muted)] uppercase">
        {label}
      </span>
      <input
        type="password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        className="rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-ink)] outline-none focus:border-[var(--color-brand)] focus:ring-2 focus:ring-[var(--color-brand)]/20"
      />
      {hint !== undefined && (
        <span className="text-xs text-[var(--color-caution)]">{hint}</span>
      )}
    </label>
  );
}
