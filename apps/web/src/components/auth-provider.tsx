'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { StaffIdentity, StaffRole } from '@aics/contracts';

import * as api from '@/lib/api';
import { getCachedIdentity } from '@/lib/auth-store';

/**
 * Session state for the dashboard.
 *
 * `status` is deliberately three-valued. A two-valued signed-in flag forces the first render to
 * guess, and the guess is wrong on every page reload: the access token lives in memory only, so a
 * returning user briefly looks signed out while the refresh token is being spent. `restoring`
 * exists so the shell can wait instead of flashing the sign-in screen at someone who is signed in.
 *
 * `role` here drives *presentation only* — which navigation items render, which buttons appear.
 * Every action is authorised again by the API against the token it verifies itself. The client
 * copy is a convenience and is never the control.
 */
type Status = 'restoring' | 'authenticated' | 'anonymous';

interface AuthContextValue {
  readonly status: Status;
  readonly staff: StaffIdentity | null;
  readonly signIn: (email: string, password: string) => Promise<void>;
  readonly signOut: () => Promise<void>;
  readonly changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  readonly can: (roles: readonly StaffRole[]) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({
  children,
}: {
  readonly children: React.ReactNode;
}): React.ReactElement {
  const [status, setStatus] = useState<Status>('restoring');
  const [staff, setStaff] = useState<StaffIdentity | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Paint the cached name immediately so the shell does not reflow once the session resolves.
    // Authorisation still waits for the API.
    const cached = getCachedIdentity();
    if (cached !== null) {
      setStaff(cached);
    }

    void api
      .restoreSession()
      .then((identity) => {
        if (cancelled) return;
        setStaff(identity);
        setStatus(identity === null ? 'anonymous' : 'authenticated');
      })
      .catch(() => {
        if (cancelled) return;
        setStaff(null);
        setStatus('anonymous');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const result = await api.login({ email, password });
    setStaff(result.staff);
    setStatus('authenticated');
  }, []);

  const signOut = useCallback(async () => {
    await api.logout();
    setStaff(null);
    setStatus('anonymous');
  }, []);

  const changePassword = useCallback(
    async (currentPassword: string, newPassword: string) => {
      await api.changePassword({ currentPassword, newPassword });
      // Changing a password revokes every session server-side, including this one. Signing back
      // in with the new credential is the only coherent next step.
      await api.logout();
      setStaff(null);
      setStatus('anonymous');
    },
    [],
  );

  const can = useCallback(
    (roles: readonly StaffRole[]) => staff !== null && roles.includes(staff.role),
    [staff],
  );

  const value = useMemo<AuthContextValue>(
    () => ({ status, staff, signIn, signOut, changePassword, can }),
    [status, staff, signIn, signOut, changePassword, can],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (context === null) {
    throw new Error('useAuth must be used inside <AuthProvider>');
  }
  return context;
}
