/**
 * Typed API client.
 *
 * Response shapes come from `@aics/contracts`, the same package the NestJS API builds its
 * responses from, so a change to the assessment payload is a compile error here rather than an
 * `undefined` rendered into the UI.
 */
import type {
  ApplicationSummary,
  CreateApplicationInput,
  CreditAssessmentResult,
  DocumentType,
  ResidenceStatus,
} from '@aics/contracts';

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

export async function createApplication(
  input: CreateApplicationInput,
): Promise<{ id: string; arn: string }> {
  const response = await fetch(`${API_BASE}/api/credit-assessment/applications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    throw await toApiError(response);
  }
  return (await response.json()) as { id: string; arn: string };
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

  const response = await fetch(
    `${API_BASE}/api/credit-assessment/applications/${input.applicationId}/documents`,
    { method: 'POST', body: form },
  );

  if (!response.ok) {
    throw await toApiError(response);
  }
  return (await response.json()) as CreditAssessmentResult;
}

export async function getAssessment(applicationId: string): Promise<CreditAssessmentResult> {
  const response = await fetch(
    `${API_BASE}/api/credit-assessment/applications/${applicationId}`,
  );
  if (!response.ok) {
    throw await toApiError(response);
  }
  return (await response.json()) as CreditAssessmentResult;
}

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

export type { ApplicationSummary, CreditAssessmentResult };
