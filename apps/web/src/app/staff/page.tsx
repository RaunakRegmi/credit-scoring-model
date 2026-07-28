'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  KeyRound,
  Loader2,
  Lock,
  ShieldCheck,
  UserPlus,
  UserX,
} from 'lucide-react';
import {
  CAN_MANAGE_STAFF,
  STAFF_ROLES,
  type StaffRole,
  type StaffSummary,
} from '@aics/contracts';

import { useAuth } from '@/components/auth-provider';
import { ApiError, createStaff, listStaff, resetStaffPassword, updateStaff } from '@/lib/api';
import { formatDateTime, humanise } from '@/lib/utils';

/**
 * Staff accounts.
 *
 * Administrators provision and revoke; compliance can read the same list, because "who held
 * approval authority on the day this decision was made" is an audit question.
 *
 * Temporary passwords are typed in by the administrator and never generated into a response body.
 * A credential returned over HTTP ends up in proxy logs and browser history, and this page would
 * be the thing that put it there.
 */
export default function StaffPage(): React.ReactElement {
  const { can, staff: currentUser } = useAuth();
  const queryClient = useQueryClient();
  const mayManage = can(CAN_MANAGE_STAFF);

  const staffList = useQuery({ queryKey: ['staff'], queryFn: listStaff });
  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['staff'] });
  };

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-8 sm:px-6 lg:px-8">
      <header>
        <h1 className="text-2xl font-semibold text-[var(--color-ink)]">Staff accounts</h1>
        <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
          {mayManage
            ? 'Provision, re-role and revoke access. Role changes and deactivations end that person’s active sessions immediately.'
            : 'Read-only view of who holds access and what they may approve.'}
        </p>
      </header>

      {mayManage && <CreateStaffPanel onCreated={invalidate} />}

      {staffList.isPending && (
        <div className="card flex items-center justify-center px-5 py-12">
          <Loader2 size={18} className="animate-spin text-[var(--color-ink-subtle)]" aria-label="Loading" />
        </div>
      )}

      {staffList.isError && (
        <ErrorPanel
          title="Could not load staff accounts"
          error={staffList.error}
        />
      )}

      {/*
        Phone presentation: one card per account. A seven-column table is not readable at 390px, and
        without `min-w-0` the table's `min-w` would push the whole page wider than the viewport —
        a flex item defaults to `min-width: auto`, so the scroll container never engages.
      */}
      {staffList.data !== undefined && (
        <ul className="flex list-none flex-col gap-3 sm:hidden">
          {staffList.data.map((account) => (
            <StaffCard
              key={account.id}
              account={account}
              isSelf={account.id === currentUser?.id}
              mayManage={mayManage}
              onChanged={invalidate}
            />
          ))}
        </ul>
      )}

      {staffList.data !== undefined && (
        <div className="card hidden min-w-0 overflow-x-auto sm:block">
          <table className="w-full min-w-[48rem] text-sm">
            <thead>
              <tr className="border-b border-[var(--color-line)] text-left text-xs tracking-wide text-[var(--color-ink-subtle)] uppercase">
                <th scope="col" className="px-4 py-3 font-medium">Name</th>
                <th scope="col" className="px-4 py-3 font-medium">Email</th>
                <th scope="col" className="px-4 py-3 font-medium">Role</th>
                <th scope="col" className="px-4 py-3 font-medium">Status</th>
                <th scope="col" className="px-4 py-3 font-medium">Last sign-in</th>
                {mayManage && (
                  <th scope="col" className="px-4 py-3"><span className="sr-only">Actions</span></th>
                )}
              </tr>
            </thead>
            <tbody>
              {staffList.data.map((account) => (
                <StaffRow
                  key={account.id}
                  account={account}
                  isSelf={account.id === currentUser?.id}
                  mayManage={mayManage}
                  onChanged={invalidate}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

/* -------------------------------------------------------------------------- */

function CreateStaffPanel({ onCreated }: { readonly onCreated: () => void }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState<StaffRole>('UNDERWRITER');
  const [temporaryPassword, setTemporaryPassword] = useState('');

  const create = useMutation({
    mutationFn: () =>
      createStaff({ email: email.trim(), fullName: fullName.trim(), role, temporaryPassword }),
    onSuccess: () => {
      setEmail('');
      setFullName('');
      setTemporaryPassword('');
      setOpen(false);
      onCreated();
    },
  });

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex w-fit items-center gap-2 rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90"
      >
        <UserPlus size={15} aria-hidden />
        New staff account
      </button>
    );
  }

  const canSubmit =
    email.trim() !== '' &&
    fullName.trim().length >= 2 &&
    temporaryPassword.length >= 12 &&
    !create.isPending;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate();
      }}
      className="card flex flex-col gap-4 px-5 py-4"
    >
      <h2 className="text-sm font-semibold text-[var(--color-ink)]">New staff account</h2>

      {create.isError && <ErrorPanel title="Could not create the account" error={create.error} inline />}

      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Full name" value={fullName} onChange={setFullName} />
        <TextField label="Work email" value={email} onChange={setEmail} type="email" />

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium tracking-wide text-[var(--color-ink-muted)] uppercase">
            Role
          </span>
          <select
            value={role}
            onChange={(event) => setRole(event.target.value as StaffRole)}
            className="rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-ink)] outline-none focus:border-[var(--color-brand)]"
          >
            {STAFF_ROLES.map((option) => (
              <option key={option} value={option}>
                {humanise(option)}
              </option>
            ))}
          </select>
        </label>

        <TextField
          label="Temporary password (12+ characters)"
          value={temporaryPassword}
          onChange={setTemporaryPassword}
          type="password"
        />
      </div>

      <p className="text-xs text-[var(--color-ink-subtle)]">
        Give this password to the account holder out of band. They must replace it before the
        account can do anything — including co-signing a decision.
      </p>

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!canSubmit}
          className="inline-flex items-center gap-2 rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {create.isPending && <Loader2 size={15} className="animate-spin" aria-hidden />}
          Create account
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-lg border border-[var(--color-line-strong)] px-4 py-2 text-sm font-medium text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-muted)]"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/* -------------------------------------------------------------------------- */

/** Phone presentation of one staff account. Same actions as the table row, stacked. */
function StaffCard({
  account,
  isSelf,
  mayManage,
  onChanged,
}: {
  readonly account: StaffSummary;
  readonly isSelf: boolean;
  readonly mayManage: boolean;
  readonly onChanged: () => void;
}): React.ReactElement {
  const [resetting, setResetting] = useState(false);
  const [newPassword, setNewPassword] = useState('');

  const setActive = useMutation({
    mutationFn: (isActive: boolean) => updateStaff(account.id, { isActive }),
    onSuccess: onChanged,
  });
  const setRole = useMutation({
    mutationFn: (role: StaffRole) => updateStaff(account.id, { role }),
    onSuccess: onChanged,
  });
  const reset = useMutation({
    mutationFn: () => resetStaffPassword(account.id, { temporaryPassword: newPassword }),
    onSuccess: () => {
      setNewPassword('');
      setResetting(false);
      onChanged();
    },
  });

  const busy = setActive.isPending || setRole.isPending || reset.isPending;
  const error = setActive.error ?? setRole.error ?? reset.error;

  return (
    <li className="card flex min-w-0 flex-col gap-3 px-4 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium text-[var(--color-ink)]">
            {account.fullName}
            {isSelf && (
              <span className="ml-1.5 text-xs font-normal text-[var(--color-ink-subtle)]">
                (you)
              </span>
            )}
          </p>
          <p className="numeric truncate text-xs text-[var(--color-ink-muted)]">{account.email}</p>
        </div>
        {mayManage && !isSelf && (
          <button
            type="button"
            disabled={busy}
            onClick={() => setActive.mutate(!account.isActive)}
            aria-label={`${account.isActive ? 'Deactivate' : 'Reactivate'} ${account.fullName}`}
            className="shrink-0 rounded-lg border border-[var(--color-line-strong)] p-2.5 text-[var(--color-ink-muted)] disabled:opacity-50"
          >
            {account.isActive ? <UserX size={16} aria-hidden /> : <ShieldCheck size={16} aria-hidden />}
          </button>
        )}
      </div>

      <StatusBadges account={account} />

      <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
        <div className="flex gap-1.5">
          <dt className="text-[var(--color-ink-subtle)]">Last sign-in</dt>
          <dd className="numeric text-[var(--color-ink-muted)]">
            {account.lastLoginAt === null ? 'never' : formatDateTime(account.lastLoginAt)}
          </dd>
        </div>
      </dl>

      {mayManage && !isSelf ? (
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-[var(--color-ink-muted)]">Role</span>
          <select
            value={account.role}
            disabled={busy}
            onChange={(event) => setRole.mutate(event.target.value as StaffRole)}
            className="min-h-11 rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-ink)] disabled:opacity-50"
          >
            {STAFF_ROLES.map((option) => (
              <option key={option} value={option}>
                {humanise(option)}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="text-xs text-[var(--color-ink-muted)]">Role: {humanise(account.role)}</p>
      )}

      {error != null && (
        <p className="flex items-center gap-1.5 text-xs text-[var(--color-negative)]">
          <AlertCircle size={13} aria-hidden />
          {error instanceof ApiError ? error.message : 'The change could not be applied.'}
        </p>
      )}

      {mayManage && (
        <>
          <button
            type="button"
            onClick={() => setResetting(!resetting)}
            className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-[var(--color-line-strong)] px-3 text-sm font-medium text-[var(--color-ink-muted)]"
          >
            <KeyRound size={14} aria-hidden />
            Reset password
          </button>

          {resetting && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                reset.mutate();
              }}
              className="flex flex-col gap-2"
            >
              <input
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                autoComplete="new-password"
                placeholder="New temporary password (12+)"
                className="min-h-11 rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 text-sm"
              />
              <button
                type="submit"
                disabled={newPassword.length < 12 || reset.isPending}
                className="min-h-11 rounded-lg bg-[var(--color-brand)] px-3 text-sm font-semibold text-white disabled:opacity-50"
              >
                Reset and end all sessions
              </button>
            </form>
          )}
        </>
      )}
    </li>
  );
}

function StaffRow({
  account,
  isSelf,
  mayManage,
  onChanged,
}: {
  readonly account: StaffSummary;
  readonly isSelf: boolean;
  readonly mayManage: boolean;
  readonly onChanged: () => void;
}): React.ReactElement {
  const [resetting, setResetting] = useState(false);
  const [newPassword, setNewPassword] = useState('');

  const setActive = useMutation({
    mutationFn: (isActive: boolean) => updateStaff(account.id, { isActive }),
    onSuccess: onChanged,
  });

  const setRole = useMutation({
    mutationFn: (role: StaffRole) => updateStaff(account.id, { role }),
    onSuccess: onChanged,
  });

  const reset = useMutation({
    mutationFn: () => resetStaffPassword(account.id, { temporaryPassword: newPassword }),
    onSuccess: () => {
      setNewPassword('');
      setResetting(false);
      onChanged();
    },
  });

  const busy = setActive.isPending || setRole.isPending || reset.isPending;
  const error = setActive.error ?? setRole.error ?? reset.error;

  return (
    <>
      <tr className="border-b border-[var(--color-line)] last:border-0">
        <td className="px-4 py-3 font-medium text-[var(--color-ink)]">
          {account.fullName}
          {isSelf && (
            <span className="ml-1.5 text-xs font-normal text-[var(--color-ink-subtle)]">(you)</span>
          )}
        </td>
        <td className="numeric px-4 py-3 text-[var(--color-ink-muted)]">{account.email}</td>
        <td className="px-4 py-3">
          {mayManage && !isSelf ? (
            <select
              value={account.role}
              disabled={busy}
              onChange={(event) => setRole.mutate(event.target.value as StaffRole)}
              className="rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-ink)] outline-none focus:border-[var(--color-brand)] disabled:opacity-50"
            >
              {STAFF_ROLES.map((option) => (
                <option key={option} value={option}>
                  {humanise(option)}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-[var(--color-ink-muted)]">{humanise(account.role)}</span>
          )}
        </td>
        <td className="px-4 py-3">
          <StatusBadges account={account} />
        </td>
        <td className="numeric px-4 py-3 text-xs text-[var(--color-ink-muted)]">
          {account.lastLoginAt === null ? 'never' : formatDateTime(account.lastLoginAt)}
        </td>
        {mayManage && (
          <td className="px-4 py-3">
            <div className="flex justify-end gap-1.5">
              <button
                type="button"
                onClick={() => setResetting(!resetting)}
                title="Reset password"
                aria-label={`Reset password for ${account.fullName}`}
                className="rounded-md border border-[var(--color-line-strong)] p-1.5 text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-muted)]"
              >
                <KeyRound size={14} aria-hidden />
              </button>
              {!isSelf && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setActive.mutate(!account.isActive)}
                  title={account.isActive ? 'Deactivate' : 'Reactivate'}
                  aria-label={`${account.isActive ? 'Deactivate' : 'Reactivate'} ${account.fullName}`}
                  className="rounded-md border border-[var(--color-line-strong)] p-1.5 text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-muted)] disabled:opacity-50"
                >
                  {account.isActive ? <UserX size={14} aria-hidden /> : <ShieldCheck size={14} aria-hidden />}
                </button>
              )}
            </div>
          </td>
        )}
      </tr>

      {(resetting || error != null) && (
        <tr className="border-b border-[var(--color-line)] bg-[var(--color-surface-muted)]">
          <td colSpan={mayManage ? 6 : 5} className="px-4 py-3">
            {error != null && (
              <p className="mb-2 flex items-center gap-1.5 text-xs text-[var(--color-negative)]">
                <AlertCircle size={13} aria-hidden />
                {error instanceof ApiError ? error.message : 'The change could not be applied.'}
              </p>
            )}
            {resetting && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  reset.mutate();
                }}
                className="flex flex-wrap items-end gap-2"
              >
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-[var(--color-ink-muted)]">
                    New temporary password (12+ characters)
                  </span>
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                    autoComplete="new-password"
                    className="w-64 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--color-brand)]"
                  />
                </label>
                <button
                  type="submit"
                  disabled={newPassword.length < 12 || reset.isPending}
                  className="rounded-md bg-[var(--color-brand)] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                >
                  Reset and end all sessions
                </button>
              </form>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function StatusBadges({ account }: { readonly account: StaffSummary }): React.ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {!account.isActive && (
        <Badge tone="negative">
          <UserX size={11} aria-hidden />
          Deactivated
        </Badge>
      )}
      {account.locked && (
        <Badge tone="negative">
          <Lock size={11} aria-hidden />
          Locked
        </Badge>
      )}
      {account.mustChangePassword && <Badge tone="caution">Password not set</Badge>}
      {account.isActive && !account.locked && !account.mustChangePassword && (
        <Badge tone="positive">Active</Badge>
      )}
      {account.activeSessionCount > 0 && (
        <span className="numeric text-[11px] text-[var(--color-ink-subtle)]">
          {account.activeSessionCount} session{account.activeSessionCount === 1 ? '' : 's'}
        </span>
      )}
    </div>
  );
}

function Badge({
  tone,
  children,
}: {
  readonly tone: 'positive' | 'caution' | 'negative';
  readonly children: React.ReactNode;
}): React.ReactElement {
  const styles = {
    positive: 'bg-[var(--color-positive-soft)] text-[var(--color-positive)]',
    caution: 'bg-[var(--color-caution-soft)] text-[var(--color-caution)]',
    negative: 'bg-[var(--color-negative-soft)] text-[var(--color-negative)]',
  } as const;

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium ${styles[tone]}`}
    >
      {children}
    </span>
  );
}

function TextField({
  label,
  value,
  onChange,
  type = 'text',
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly type?: 'text' | 'email' | 'password';
}): React.ReactElement {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium tracking-wide text-[var(--color-ink-muted)] uppercase">
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required
        autoComplete={type === 'password' ? 'new-password' : 'off'}
        className="rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-ink)] outline-none focus:border-[var(--color-brand)] focus:ring-2 focus:ring-[var(--color-brand)]/20"
      />
    </label>
  );
}

function ErrorPanel({
  title,
  error,
  inline = false,
}: {
  readonly title: string;
  readonly error: unknown;
  readonly inline?: boolean;
}): React.ReactElement {
  return (
    <div
      role="alert"
      className={
        inline
          ? 'rounded-md border border-[var(--color-negative)]/40 bg-[var(--color-negative-soft)] px-3 py-2 text-sm'
          : 'card border-[var(--color-negative)]/40 bg-[var(--color-negative-soft)] px-5 py-4 text-sm'
      }
    >
      <p className="font-semibold text-[var(--color-negative)]">{title}</p>
      <p className="mt-1 text-[var(--color-ink)]">
        {error instanceof Error ? error.message : 'An unexpected error occurred.'}
      </p>
    </div>
  );
}
