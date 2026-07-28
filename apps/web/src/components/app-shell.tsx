'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { Route } from 'next';
import { useQuery } from '@tanstack/react-query';
import { ClipboardList, FilePlus2, Loader2, LogOut, Users } from 'lucide-react';
import { CAN_MANAGE_STAFF, CAN_REVIEW_APPLICATIONS, CAN_VIEW_AUDIT } from '@aics/contracts';

import { AuthProvider, useAuth } from '@/components/auth-provider';
import { ChangePasswordForm } from '@/components/change-password-form';
import { SignInForm } from '@/components/sign-in-form';
import { getReviewQueue } from '@/lib/api';
import { humanise } from '@/lib/utils';

/**
 * The authenticated shell.
 *
 * Wraps every page: nothing renders until the session has resolved. Route protection is
 * client-side because the access token lives in memory rather than in a cookie, so Next's
 * middleware cannot see it — and it does not need to. The API is the enforcement point; this gate
 * exists so an unauthenticated user sees a sign-in form instead of a page full of failed requests.
 */
export function AppShell({
  children,
}: {
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <AuthProvider>
      <SessionGate>{children}</SessionGate>
    </AuthProvider>
  );
}

function SessionGate({ children }: { readonly children: React.ReactNode }): React.ReactElement {
  const { status, staff } = useAuth();

  if (status === 'restoring') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2
          size={20}
          className="animate-spin text-[var(--color-ink-subtle)]"
          aria-label="Restoring session"
        />
      </div>
    );
  }

  if (status === 'anonymous' || staff === null) {
    return <SignInForm />;
  }

  // A provisioned account gets one screen and nothing else, matching what the API permits.
  if (staff.mustChangePassword) {
    return <ChangePasswordForm />;
  }

  return (
    <div className="flex min-h-screen flex-col">
      <TopBar />
      {children}
    </div>
  );
}

function TopBar(): React.ReactElement {
  const { staff, signOut, can } = useAuth();
  const pathname = usePathname();
  const mayReview = can(CAN_REVIEW_APPLICATIONS);

  // Badge on the queue tab. Polled rather than pushed — an underwriter needs to notice a referral
  // arriving without reloading, and a minute is well inside the two-business-day SLA.
  const queue = useQuery({
    queryKey: ['review-queue-count'],
    queryFn: () => getReviewQueue({ limit: 1 }),
    enabled: mayReview,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const waiting = queue.data?.total ?? 0;
  const breached = queue.data?.breachedCount ?? 0;

  return (
    <header className="border-b border-[var(--color-line)] bg-[var(--color-surface)]">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 sm:px-6 lg:px-8">
        <div className="mr-auto">
          <p className="text-[10px] font-semibold tracking-widest text-[var(--color-brand)] uppercase">
            Fintara Solutions · ONE BNPL
          </p>
          <p className="text-sm font-semibold text-[var(--color-ink)]">Credit Assessment</p>
        </div>

        <nav className="flex items-center gap-1" aria-label="Main">
          {mayReview && (
            <NavLink href="/" active={pathname === '/'} Icon={FilePlus2}>
              New assessment
            </NavLink>
          )}
          <NavLink
            href="/queue"
            active={pathname?.startsWith('/queue') ?? false}
            Icon={ClipboardList}
            badge={waiting > 0 ? waiting : undefined}
            badgeTone={breached > 0 ? 'alert' : 'neutral'}
          >
            Review queue
          </NavLink>
          {/* Administrators manage accounts; compliance reads the same list for audit. */}
          {can([...CAN_MANAGE_STAFF, ...CAN_VIEW_AUDIT]) && (
            <NavLink
              href="/staff"
              active={pathname?.startsWith('/staff') ?? false}
              Icon={Users}
            >
              Staff
            </NavLink>
          )}
        </nav>

        <div className="flex items-center gap-3 border-l border-[var(--color-line)] pl-4">
          <div className="text-right leading-tight">
            <p className="text-xs font-medium text-[var(--color-ink)]">{staff?.fullName}</p>
            <p className="text-[11px] text-[var(--color-ink-subtle)]">
              {staff === null ? '' : humanise(staff.role)}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void signOut()}
            title="Sign out"
            aria-label="Sign out"
            className="rounded-lg border border-[var(--color-line-strong)] p-2 text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-surface-muted)]"
          >
            <LogOut size={15} aria-hidden />
          </button>
        </div>
      </div>
    </header>
  );
}

function NavLink({
  href,
  active,
  Icon,
  badge,
  badgeTone = 'neutral',
  children,
}: {
  /** `Route` rather than `string`: `typedRoutes` is on, so a link to a nonexistent page fails to compile. */
  readonly href: Route;
  readonly active: boolean;
  readonly Icon: typeof ClipboardList;
  readonly badge?: number;
  readonly badgeTone?: 'neutral' | 'alert';
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={
        active
          ? 'inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-brand-soft)] px-3 py-2 text-sm font-medium text-[var(--color-brand)]'
          : 'inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-surface-muted)]'
      }
    >
      <Icon size={15} aria-hidden />
      {children}
      {badge !== undefined && (
        <span
          className={
            badgeTone === 'alert'
              ? 'numeric ml-0.5 rounded-full bg-[var(--color-negative)] px-1.5 py-0.5 text-[10px] font-semibold text-white'
              : 'numeric ml-0.5 rounded-full bg-[var(--color-line-strong)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-ink)]'
          }
        >
          {badge}
        </span>
      )}
    </Link>
  );
}
