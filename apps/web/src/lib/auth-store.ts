/**
 * Where the session lives in the browser.
 *
 * The access token is held **in memory only**. That is the substantive decision in this file: a
 * token in `localStorage` is readable by any script that ends up on the page, so a single XSS
 * becomes a stolen underwriter session that outlives the tab. In memory, the same XSS has to
 * exfiltrate during its own execution and gets nothing after a refresh.
 *
 * The cost is that a page reload loses the access token, so the refresh token has to survive
 * somewhere. It goes in `sessionStorage`: cleared when the tab closes, not shared with other tabs,
 * and never sent automatically with a request the way a cookie would be — so there is no CSRF
 * surface to defend. It is still script-readable, which is why it is the short-lived, single-use,
 * server-revocable half of the pair rather than the credential that grants access directly.
 *
 * The genuinely correct answer for a bank deployment is an httpOnly, Secure, SameSite=Strict
 * refresh cookie issued by a same-origin backend. That needs the API and the dashboard behind one
 * origin, which is the ingress work item in `docs/04-bank-deployment-readiness.md` §2 — so this is
 * the right shape for the architecture as it stands today, and it is deliberately isolated in one
 * module so that change touches nothing else.
 */
import type { StaffIdentity } from '@aics/contracts';

const REFRESH_TOKEN_KEY = 'aics.refresh';
const IDENTITY_KEY = 'aics.staff';

/** Access token and its expiry. Module-scoped, so it dies with the page. */
let accessToken: string | null = null;
let accessTokenExpiresAt = 0;

type Listener = () => void;
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/* -------------------------------------------------------------------------- */
/* Access token (memory)                                                       */
/* -------------------------------------------------------------------------- */

export function getAccessToken(): string | null {
  // Treat a token inside its last few seconds as already gone, so a request cannot be sent with
  // one that expires in flight.
  if (accessToken !== null && Date.now() >= accessTokenExpiresAt - 5_000) {
    accessToken = null;
  }
  return accessToken;
}

export function setAccessToken(token: string, expiresInSeconds: number): void {
  accessToken = token;
  accessTokenExpiresAt = Date.now() + expiresInSeconds * 1000;
}

/* -------------------------------------------------------------------------- */
/* Refresh token and identity (sessionStorage)                                 */
/* -------------------------------------------------------------------------- */

function storage(): Storage | null {
  // Server-rendered passes and privacy modes that deny storage both land here.
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function getRefreshToken(): string | null {
  return storage()?.getItem(REFRESH_TOKEN_KEY) ?? null;
}

export function getCachedIdentity(): StaffIdentity | null {
  const raw = storage()?.getItem(IDENTITY_KEY);
  if (raw === null || raw === undefined) {
    return null;
  }
  try {
    return JSON.parse(raw) as StaffIdentity;
  } catch {
    // Corrupted entry — drop it rather than crash the app on boot.
    storage()?.removeItem(IDENTITY_KEY);
    return null;
  }
}

/**
 * Records a full session.
 *
 * The cached identity is a rendering convenience — it lets the shell draw the user's name without
 * waiting on `/api/auth/me`. It is never trusted for authorisation: every protected action goes to
 * the API, which re-derives the role from the token it verifies itself.
 */
export function saveSession(session: {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
  readonly refreshToken: string;
  readonly staff: StaffIdentity;
}): void {
  setAccessToken(session.accessToken, session.expiresInSeconds);
  const store = storage();
  store?.setItem(REFRESH_TOKEN_KEY, session.refreshToken);
  store?.setItem(IDENTITY_KEY, JSON.stringify(session.staff));
  notify();
}

export function clearSession(): void {
  accessToken = null;
  accessTokenExpiresAt = 0;
  const store = storage();
  store?.removeItem(REFRESH_TOKEN_KEY);
  store?.removeItem(IDENTITY_KEY);
  notify();
}

/** True when there is any credential worth attempting a request with. */
export function hasSession(): boolean {
  return getAccessToken() !== null || getRefreshToken() !== null;
}
