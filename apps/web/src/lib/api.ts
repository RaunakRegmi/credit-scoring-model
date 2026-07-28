/**
 * Typed API client.
 *
 * Response shapes come from `@aics/contracts`, the same package the NestJS API builds its
 * responses from, so a change to the assessment payload is a compile error here rather than an
 * `undefined` rendered into the UI.
 *
 * Every request goes through `request()`, which attaches the access token and — on a 401 — spends
 * the refresh token once and retries. That retry is centralised deliberately: scattered per-call
 * refresh logic is how a token race turns into two parallel refreshes, and with rotation enabled
 * server-side the second one looks like token theft and terminates every session the user has.
 */
import type {
  ApplicationSummary,
  ChangePasswordInput,
  CreateApplicationInput,
  CreateStaffInput,
  CreditAssessmentResult,
  DocumentType,
  LoginInput,
  LoginResult,
  QueuePage,
  ResetStaffPasswordInput,
  ResidenceStatus,
  ReviewRecord,
  StaffIdentity,
  StaffSummary,
  SubmitReviewInput,
  UpdateStaffInput,
} from '@aics/contracts';

import {
  clearSession,
  getAccessToken,
  getRefreshToken,
  saveSession,
  setAccessToken,
} from './auth-store';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly correlationId?: string,
    public readonly issues?: readonly { path: string; message: string }[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Thrown when the session is gone and the caller must sign in again. */
export class SessionExpiredError extends ApiError {
  constructor(message = 'Your session has expired. Please sign in again.') {
    super(message, 401);
    this.name = 'SessionExpiredError';
  }
}

interface ErrorBody {
  readonly message?: string;
  readonly correlationId?: string;
  readonly details?: readonly { path: string; message: string }[];
}

async function toApiError(response: Response): Promise<ApiError> {
  let body: ErrorBody = {};
  try {
    body = (await response.json()) as ErrorBody;
  } catch {
    // A non-JSON error body (a proxy timeout page, for instance) is not worth surfacing raw.
  }

  return new ApiError(
    body.message ?? `Request failed with status ${response.status}`,
    response.status,
    body.correlationId,
    body.details,
  );
}

/* -------------------------------------------------------------------------- */
/* Transport                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A single in-flight refresh, shared by every caller that needs one.
 *
 * Without this, three queries whose tokens expire together each POST `/api/auth/refresh`. The
 * first rotates the token; the other two present one that has just been revoked, which the API
 * correctly reads as reuse and responds to by killing every session for that user. Signing an
 * underwriter out mid-review because their dashboard loaded three panels at once is not a
 * theoretical failure.
 */
let refreshInFlight: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  if (refreshToken === null) {
    return false;
  }

  const response = await fetch(`${API_BASE}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });

  if (!response.ok) {
    clearSession();
    return false;
  }

  const result = (await response.json()) as LoginResult;
  saveSession(result);
  return true;
}

function refreshOnce(): Promise<boolean> {
  refreshInFlight ??= refreshAccessToken().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

interface RequestOptions {
  readonly method?: string;
  readonly body?: BodyInit;
  readonly headers?: Record<string, string>;
  /** Skips the Authorization header and the refresh retry. For login and refresh themselves. */
  readonly anonymous?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const send = async (): Promise<Response> => {
    const headers: Record<string, string> = { ...options.headers };

    if (options.anonymous !== true) {
      const token = getAccessToken();
      if (token !== null) {
        headers.Authorization = `Bearer ${token}`;
      }
    }

    return fetch(`${API_BASE}${path}`, {
      ...(options.method === undefined ? {} : { method: options.method }),
      ...(options.body === undefined ? {} : { body: options.body }),
      headers,
    });
  };

  let response = await send();

  // One retry, and only for 401. A 403 is a role the user genuinely lacks — refreshing the token
  // would return the same role and the same refusal.
  if (response.status === 401 && options.anonymous !== true) {
    if (!(await refreshOnce())) {
      clearSession();
      throw new SessionExpiredError();
    }
    response = await send();
    if (response.status === 401) {
      clearSession();
      throw new SessionExpiredError();
    }
  }

  if (!response.ok) {
    throw await toApiError(response);
  }

  // 204 No Content — nothing to parse.
  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

function json(body: unknown): RequestOptions {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/* -------------------------------------------------------------------------- */
/* Authentication                                                              */
/* -------------------------------------------------------------------------- */

export async function login(input: LoginInput): Promise<LoginResult> {
  const result = await request<LoginResult>('/api/auth/login', {
    ...json(input),
    anonymous: true,
  });
  saveSession(result);
  return result;
}

export async function logout(): Promise<void> {
  const refreshToken = getRefreshToken();
  try {
    if (refreshToken !== null) {
      await request<void>('/api/auth/logout', {
        ...json({ refreshToken }),
        anonymous: true,
      });
    }
  } finally {
    // Local state is cleared even if the server call fails. A user who clicked sign out must end
    // up signed out of this browser regardless of what the network did.
    clearSession();
  }
}

export async function getCurrentStaff(): Promise<StaffIdentity> {
  return request<StaffIdentity>('/api/auth/me');
}

export async function changePassword(input: ChangePasswordInput): Promise<void> {
  await request<void>('/api/auth/change-password', json(input));
}

/**
 * Restores a session on page load by spending the stored refresh token.
 *
 * Returns the identity, or `null` when there is nothing to restore — which the shell reads as
 * "show the sign-in screen".
 */
export async function restoreSession(): Promise<StaffIdentity | null> {
  if (getAccessToken() !== null) {
    try {
      return await getCurrentStaff();
    } catch {
      // Fall through to a refresh attempt.
    }
  }
  if (!(await refreshOnce())) {
    return null;
  }
  try {
    return await getCurrentStaff();
  } catch {
    clearSession();
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Credit assessment                                                           */
/* -------------------------------------------------------------------------- */

export async function createApplication(
  input: CreateApplicationInput,
): Promise<{ id: string; arn: string }> {
  return request<{ id: string; arn: string }>(
    '/api/credit-assessment/applications',
    json(input),
  );
}

export interface UploadDocumentsInput {
  readonly applicationId: string;
  readonly resume: File;
  readonly statement: File;
  readonly kycDocuments?: readonly DocumentType[];
  readonly residenceStatus?: ResidenceStatus;
}

export async function uploadDocuments(
  input: UploadDocumentsInput,
): Promise<CreditAssessmentResult> {
  const form = new FormData();
  form.append('resume', input.resume);
  form.append('statement', input.statement);
  if (input.kycDocuments !== undefined && input.kycDocuments.length > 0) {
    form.append('kycDocuments', input.kycDocuments.join(','));
  }
  if (input.residenceStatus !== undefined) {
    form.append('residenceStatus', input.residenceStatus);
  }

  // No Content-Type: the browser must set the multipart boundary itself.
  return request<CreditAssessmentResult>(
    `/api/credit-assessment/applications/${input.applicationId}/documents`,
    { method: 'POST', body: form },
  );
}

export async function getAssessment(applicationId: string): Promise<CreditAssessmentResult> {
  return request<CreditAssessmentResult>(`/api/credit-assessment/applications/${applicationId}`);
}

/* -------------------------------------------------------------------------- */
/* Underwriter queue                                                           */
/* -------------------------------------------------------------------------- */

export async function getReviewQueue(
  params: { readonly limit?: number; readonly offset?: number } = {},
): Promise<QueuePage> {
  const query = new URLSearchParams();
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.offset !== undefined) query.set('offset', String(params.offset));
  const suffix = query.size === 0 ? '' : `?${query.toString()}`;

  return request<QueuePage>(`/api/underwriter/queue${suffix}`);
}

export interface ReferralDetail {
  readonly assessment: CreditAssessmentResult;
  readonly reviews: readonly ReviewRecord[];
}

export async function getReferral(applicationId: string): Promise<ReferralDetail> {
  return request<ReferralDetail>(`/api/underwriter/applications/${applicationId}`);
}

export async function submitReview(
  applicationId: string,
  input: SubmitReviewInput,
): Promise<ReviewRecord> {
  return request<ReviewRecord>(
    `/api/underwriter/applications/${applicationId}/review`,
    json(input),
  );
}

/* -------------------------------------------------------------------------- */
/* Staff administration                                                        */
/* -------------------------------------------------------------------------- */

export async function listStaff(): Promise<readonly StaffSummary[]> {
  return request<readonly StaffSummary[]>('/api/staff');
}

export async function createStaff(input: CreateStaffInput): Promise<StaffSummary> {
  return request<StaffSummary>('/api/staff', json(input));
}

export async function updateStaff(
  staffId: string,
  input: UpdateStaffInput,
): Promise<StaffSummary> {
  return request<StaffSummary>(`/api/staff/${staffId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function resetStaffPassword(
  staffId: string,
  input: ResetStaffPasswordInput,
): Promise<void> {
  await request<void>(`/api/staff/${staffId}/reset-password`, json(input));
}

/* -------------------------------------------------------------------------- */
/* Health                                                                      */
/* -------------------------------------------------------------------------- */

export interface ReadinessReport {
  readonly status: 'ready' | 'degraded' | 'unavailable';
  readonly database: boolean;
  readonly mlService: {
    readonly reachable: boolean;
    readonly circuit: string;
    readonly modelVersion: string | null;
    readonly provenance: string | null;
  };
  readonly versions: {
    readonly scorecard: string;
    readonly featureSet: string;
    readonly policy: string;
  };
}

export async function getReadiness(): Promise<ReadinessReport> {
  const response = await fetch(`${API_BASE}/readyz`);
  // A degraded system answers 200 with status 'degraded'; only a hard failure is non-OK.
  if (!response.ok && response.status !== 503) {
    throw await toApiError(response);
  }
  return (await response.json()) as ReadinessReport;
}

export type {
  ApplicationSummary,
  CreditAssessmentResult,
  QueuePage,
  ReviewRecord,
  StaffSummary,
};
export { setAccessToken };
