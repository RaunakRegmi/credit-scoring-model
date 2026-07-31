/**
 * Staff identity, authority and the SOP-004 review contract.
 *
 * Lives in `contracts` for the same reason the risk-band table does: the dashboard needs to know
 * which roles may see the review queue and which may second-authorise a lenient override, and the
 * API needs to enforce it. Two copies of an authority table is how an access-control rule ends up
 * being true on one side of the wire only.
 */
import { z } from 'zod';

import { DECISIONS, DECISION_SEVERITY, type Decision } from './enums';

/* -------------------------------------------------------------------------- */
/* Roles and authority                                                         */
/* -------------------------------------------------------------------------- */

export const STAFF_ROLES = [
  'UNDERWRITER',
  'SENIOR_UNDERWRITER',
  'CREDIT_MANAGER',
  'COMPLIANCE_OFFICER',
  'ADMIN',
] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/**
 * Audit actor types (`DecisionAudit.actorType`). Distinct from `StaffRole`: this includes actors
 * that never log in.
 */
export const ACTOR_TYPES = [
  'SYSTEM',
  'UNDERWRITER',
  'CREDIT_MANAGER',
  'COMPLIANCE_OFFICER',
  'APPLICANT',
  'ADMIN',
] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

/**
 * The single mapping from "what this login may do" to "what the audit trail records".
 *
 * A senior underwriter audits as `UNDERWRITER` — the audit trail records the function performed,
 * and the reviewer's exact grade is preserved separately on `UnderwriterReview.reviewerRole`.
 */
export const ACTOR_TYPE_FOR_ROLE: Readonly<Record<StaffRole, ActorType>> = {
  UNDERWRITER: 'UNDERWRITER',
  SENIOR_UNDERWRITER: 'UNDERWRITER',
  CREDIT_MANAGER: 'CREDIT_MANAGER',
  COMPLIANCE_OFFICER: 'COMPLIANCE_OFFICER',
  ADMIN: 'ADMIN',
};

/**
 * Credit authority, ascending. Compared numerically rather than by string equality so a new grade
 * can be inserted without rewriting every access check.
 *
 * `COMPLIANCE_OFFICER` sits above the underwriting grades but is *not* a credit-approval role —
 * see `CAN_SECOND_AUTHORISE`. Compliance oversees decisions; it does not co-sign them, and
 * conflating oversight with approval authority defeats the point of having both.
 */
export const STAFF_ROLE_AUTHORITY: Readonly<Record<StaffRole, number>> = {
  UNDERWRITER: 1,
  SENIOR_UNDERWRITER: 2,
  COMPLIANCE_OFFICER: 3,
  CREDIT_MANAGER: 4,
  ADMIN: 5,
};

/**
 * Roles permitted to capture an application, and to record a decision from the review queue.
 *
 * `ADMIN` is **not** here, and that is the substantive access-control decision in this file.
 * An administrator can create staff accounts; if it could also approve credit, then one
 * compromised administrator could mint an underwriter, approve a loan as that underwriter, and
 * co-sign it as itself — which is exactly the collusion SOP-004's dual authorisation exists to
 * prevent. Separating account administration from credit authority is what makes the co-signature
 * meaningful rather than ceremonial.
 *
 * The practical consequence is intended: the bootstrap administrator cannot lend. It provisions
 * the people who can.
 */
export const CAN_REVIEW_APPLICATIONS: readonly StaffRole[] = [
  'UNDERWRITER',
  'SENIOR_UNDERWRITER',
  'CREDIT_MANAGER',
];

/**
 * Roles permitted to act as the SOP-004 second authoriser on an override more lenient than the
 * engine's recommendation.
 *
 * Two exclusions, for different reasons:
 *
 *   · **Compliance** oversees decisions after the fact. A compliance officer who co-signed an
 *     approval cannot then independently examine it.
 *   · **Admin**, per `CAN_REVIEW_APPLICATIONS` above — an account that provisions users must not
 *     be able to complete a lending decision on its own.
 *
 * That leaves credit management, which is where delegated credit authority sits (§12.1). Note this
 * requires at least two people with credit authority to be provisioned before any lenient override
 * can be recorded — a reviewer cannot co-sign their own decision. That is a real operational
 * requirement of dual authorisation, not an accident of this list.
 *
 * Whether a senior underwriter should also be able to co-sign is a policy question for Fintara's
 * credit committee; SOP-004 requires "a second authoriser" without grading it. The stricter
 * reading ships.
 */
export const CAN_SECOND_AUTHORISE: readonly StaffRole[] = ['CREDIT_MANAGER'];

/** Roles permitted to read the audit trail and the compliance views. */
export const CAN_VIEW_AUDIT: readonly StaffRole[] = ['COMPLIANCE_OFFICER', 'CREDIT_MANAGER', 'ADMIN'];

export function hasAuthority(role: StaffRole, atLeast: StaffRole): boolean {
  return STAFF_ROLE_AUTHORITY[role] >= STAFF_ROLE_AUTHORITY[atLeast];
}

/* -------------------------------------------------------------------------- */
/* SOP-004: when does an override need a second signature                      */
/* -------------------------------------------------------------------------- */

/**
 * True when `humanDecision` is more favourable to the applicant than `systemDecision`.
 *
 * This is the whole of the SOP-004 trigger, and it is expressed once here rather than at each call
 * site. `DECISION_SEVERITY` is ascending in strictness, so a *lower* severity is the lenient
 * direction — the direction that releases money the engine did not agree to release.
 *
 * A stricter-than-recommended decision needs no co-signature: declining an application the engine
 * would have approved costs the applicant an opportunity, not the bank a loss, and it is already
 * fully recorded with its justification.
 */
export function isLenientOverride(systemDecision: Decision, humanDecision: Decision): boolean {
  return DECISION_SEVERITY[humanDecision] < DECISION_SEVERITY[systemDecision];
}

/** Minimum characters of written justification SOP-004 accepts on a review. */
export const MIN_JUSTIFICATION_LENGTH = 40;

/* -------------------------------------------------------------------------- */
/* Authentication wire format                                                  */
/* -------------------------------------------------------------------------- */

export const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(1).max(500),
});
export type RefreshInput = z.infer<typeof refreshSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  /**
   * Length is the only automatically enforceable property that reliably correlates with
   * resistance to guessing. Composition rules (one digit, one symbol) push users towards
   * predictable substitutions, so they are deliberately absent.
   */
  newPassword: z.string().min(12).max(200),
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

/** The authenticated principal, as the dashboard sees it. Never carries a credential. */
export interface StaffIdentity {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly role: StaffRole;
  readonly mustChangePassword: boolean;
}

export interface AuthTokens {
  readonly accessToken: string;
  /** Seconds until `accessToken` expires. The client refreshes ahead of this. */
  readonly expiresInSeconds: number;
  readonly refreshToken: string;
}

export interface LoginResult extends AuthTokens {
  readonly staff: StaffIdentity;
}

/* -------------------------------------------------------------------------- */
/* Staff provisioning                                                          */
/* -------------------------------------------------------------------------- */

/** Roles permitted to create, deactivate and re-role staff accounts. */
export const CAN_MANAGE_STAFF: readonly StaffRole[] = ['ADMIN'];

export const createStaffSchema = z.object({
  email: z.string().email().max(254),
  fullName: z.string().min(2).max(200),
  role: z.enum(STAFF_ROLES),
  /**
   * The temporary password. Provided by the administrator rather than generated server-side and
   * returned in a response body: a credential in an HTTP response ends up in proxy logs, browser
   * history and screenshots. The administrator communicates it out of band, and the account cannot
   * do anything until the holder replaces it.
   */
  temporaryPassword: z.string().min(12).max(200),
});
export type CreateStaffInput = z.infer<typeof createStaffSchema>;

export const updateStaffSchema = z
  .object({
    role: z.enum(STAFF_ROLES).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => value.role !== undefined || value.isActive !== undefined, {
    message: 'Specify at least one of role or isActive',
  });
export type UpdateStaffInput = z.infer<typeof updateStaffSchema>;

export const resetStaffPasswordSchema = z.object({
  temporaryPassword: z.string().min(12).max(200),
});
export type ResetStaffPasswordInput = z.infer<typeof resetStaffPasswordSchema>;

/** A staff account as the administration view sees it. Never includes a credential. */
export interface StaffSummary {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly role: StaffRole;
  readonly isActive: boolean;
  readonly mustChangePassword: boolean;
  readonly lastLoginAt: string | null;
  /** True while a lockout is in force, rather than the timestamp — the reason is what matters. */
  readonly locked: boolean;
  readonly activeSessionCount: number;
  readonly createdAt: string;
}

/* -------------------------------------------------------------------------- */
/* Underwriter queue wire format                                               */
/* -------------------------------------------------------------------------- */

/** One row of the review queue. Enough to triage without opening every application. */
export interface QueueItem {
  readonly applicationId: string;
  readonly arn: string;
  readonly applicantName: string;
  readonly productType: string;
  readonly requestedAmountNpr: number;
  readonly tenureMonths: number;

  readonly compositeScore: number;
  readonly riskBand: string;
  readonly systemDecision: Decision;

  readonly overrideCodes: readonly string[];
  readonly degradedFlags: readonly string[];
  readonly degraded: boolean;

  /** When the engine referred it. The SLA clock starts here, not at application creation. */
  readonly referredAt: string;
  /** Whole hours the item has been waiting, computed server-side against one clock. */
  readonly waitingHours: number;
  /** True once `waitingHours` exceeds the SOP-004 two-business-day commitment. */
  readonly slaBreached: boolean;
}

export interface QueuePage {
  readonly items: readonly QueueItem[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  /** Count of queue items past the SOP-004 SLA across the whole queue, not just this page. */
  readonly breachedCount: number;
  /** Hours the SLA allows, so the dashboard states the same number the API enforces. */
  readonly slaHours: number;
}

/** A recorded review, as returned to the dashboard. */
export interface ReviewRecord {
  readonly id: string;
  readonly decision: Decision;
  readonly systemDecision: Decision;
  readonly justification: string;
  readonly overrodeModel: boolean;
  readonly reviewerName: string;
  readonly reviewerRole: StaffRole;
  readonly dualAuthByName: string | null;
  readonly dualAuthByRole: StaffRole | null;
  readonly dualAuthAt: string | null;
  readonly approvedLimitNpr: number | null;
  readonly reviewedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Decision history wire format                                                */
/* -------------------------------------------------------------------------- */

/**
 * One decided application, as the oversight view renders it.
 *
 * Covers both routes to a decision, because a history that only showed the human ones would
 * misrepresent the book: most applications are decided by the engine at submission and never
 * reach the queue at all. `review` is null for those, and `finalDecision` is the engine's.
 */
export interface DecisionHistoryItem {
  readonly applicationId: string;
  readonly arn: string;
  readonly applicantName: string;
  readonly productType: string;
  readonly requestedAmountNpr: number;

  readonly compositeScore: number;
  readonly riskBand: string;
  /** What the engine decided. Retained even when a human overrode it. */
  readonly systemDecision: Decision;
  /** The decision that stands: the reviewer's where there was one, otherwise the engine's. */
  readonly finalDecision: Decision;

  /** The human review, or null where the engine decided alone. */
  readonly review: ReviewRecord | null;
  /** True when a human recorded something other than what the engine recommended. */
  readonly overrodeEngine: boolean;

  readonly decidedAt: string;
}

export interface DecisionHistoryPage {
  readonly items: readonly DecisionHistoryItem[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  /** Across the whole history, not the page — how many a human decided. */
  readonly humanReviewedCount: number;
  /** Across the whole history — how many carry a SOP-004 co-signature. */
  readonly coSignedCount: number;
}

export const submitReviewSchema = z.object({
  decision: z.enum(DECISIONS),
  justification: z.string().min(MIN_JUSTIFICATION_LENGTH).max(5000),
  /**
   * Required when the decision is more lenient than the engine's. Validated in the service
   * rather than here: the rule depends on the stored system decision, which the client does not
   * get to assert.
   */
  dualAuthEmail: z.string().email().max(254).optional(),
  dualAuthPassword: z.string().min(1).max(200).optional(),
  /** Overrides the band ceiling. Absent means "accept the priced offer as computed". */
  approvedLimitNpr: z.number().positive().max(50_000_000).optional(),
});
export type SubmitReviewInput = z.infer<typeof submitReviewSchema>;

/** SOP-004's two-business-day commitment, expressed in the hours the API actually measures. */
export const REVIEW_SLA_HOURS = 48;
