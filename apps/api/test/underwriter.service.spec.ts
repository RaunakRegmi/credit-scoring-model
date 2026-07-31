/**
 * SOP-004 manual review controls.
 *
 * The property under test is that a human cannot be more generous than the engine without a second
 * authorised person agreeing. That is the control which makes it safe to let one underwriter act on
 * a referral at all, so it is probed from every direction that could bypass it: a softer decision,
 * the same decision for more money, self-co-signing, a co-signer without credit authority, and a
 * limit above the product ceiling.
 *
 * The mirror property matters just as much and is easy to get wrong in the strict direction: a
 * *harsher* decision than the engine's must NOT require a co-signature. Declining an application
 * the engine would have approved costs the applicant an opportunity, not the bank a loss, and
 * requiring two signatures to say no would push underwriters towards approving.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import {
  CAN_REVIEW_APPLICATIONS,
  CAN_SECOND_AUTHORISE,
  CAN_VIEW_AUDIT,
  type StaffRole,
} from '@aics/contracts';

import { REQUIRED_ROLES_KEY } from '../src/auth/auth.decorators';
import { UnderwriterController } from '../src/underwriter/underwriter.controller';
import { UnderwriterService } from '../src/underwriter/underwriter.service';
import type { AuthenticatedStaff } from '../src/auth/token.service';

/* ========================================================================== */
/* Fixtures                                                                   */
/* ========================================================================== */

const JUSTIFICATION =
  'Verified employer letter and three additional salary slips directly with the employer; ' +
  'the statement gap is explained by a payroll system migration in March.';

function staff(overrides: Partial<AuthenticatedStaff> = {}): AuthenticatedStaff {
  return {
    id: 'underwriter-1',
    email: 'u1@fintara.com.np',
    fullName: 'Underwriter One',
    role: 'UNDERWRITER',
    mustChangePassword: false,
    actorType: 'UNDERWRITER',
    ...overrides,
  };
}

const CREDIT_MANAGER = staff({
  id: 'manager-1',
  email: 'cm@fintara.com.np',
  fullName: 'Credit Manager',
  role: 'CREDIT_MANAGER',
  actorType: 'CREDIT_MANAGER',
});

const COMPLIANCE = staff({
  id: 'compliance-1',
  email: 'co@fintara.com.np',
  fullName: 'Compliance Officer',
  role: 'COMPLIANCE_OFFICER',
  actorType: 'COMPLIANCE_OFFICER',
});

const ADMIN = staff({
  id: 'admin-1',
  email: 'admin@fintara.com.np',
  fullName: 'Administrator',
  role: 'ADMIN',
  actorType: 'ADMIN',
});

interface ScoreOverrides {
  readonly decision?: string;
  readonly approvedLimitNpr?: number | null;
}

/**
 * A referred application: HIGH_RISK band, `REFER_UNDERWRITER`, no offer priced. The exact case
 * that lands in the queue.
 */
function application(scoreOverrides: ScoreOverrides = {}, status = 'UNDER_REVIEW') {
  return {
    id: 'app-1',
    arn: 'ARN-TEST-0001',
    status,
    productType: 'PERSONAL_LOAN',
    requestedAmountNpr: 400_000,
    tenureMonths: 36,
    applicant: { fullName: 'Test Applicant' },
    creditScores: [
      {
        compositeScore: 420,
        riskBand: 'HIGH_RISK',
        decision: scoreOverrides.decision ?? 'REFER_UNDERWRITER',
        approvedLimitNpr: scoreOverrides.approvedLimitNpr ?? null,
        scorecardVersion: '1.0.0',
        featureSetVersion: '1.0.0',
        mlModelVersion: 'pd-xgboost-1',
        degradedFlags: [],
        overrideCodes: [],
        scoredAt: new Date('2026-07-01T00:00:00Z'),
      },
    ],
  };
}

function harness(app: ReturnType<typeof application> | null = application()) {
  const created = {
    id: 'review-1',
    decision: 'APPROVE_WITH_CONDITIONS',
    systemDecision: 'REFER_UNDERWRITER',
    justification: JUSTIFICATION,
    overrodeModel: true,
    reviewerName: 'Underwriter One',
    reviewerRole: 'UNDERWRITER',
    dualAuthByName: null as string | null,
    dualAuthByRole: null as string | null,
    dualAuthAt: null as Date | null,
    approvedLimitNpr: null as number | null,
    reviewedAt: new Date('2026-07-28T00:00:00Z'),
  };

  const tx = {
    underwriterReview: { create: vi.fn().mockImplementation(({ data }) => ({ ...created, ...data })) },
    decisionAudit: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
    loanApplication: { update: vi.fn().mockResolvedValue({}) },
  };

  const prisma = {
    db: {
      loanApplication: {
        findUnique: vi.fn().mockResolvedValue(app),
        count: vi.fn().mockResolvedValue(0),
        findMany: vi.fn().mockResolvedValue([]),
      },
      underwriterReview: { findMany: vi.fn().mockResolvedValue([]) },
    },
    transaction: vi.fn().mockImplementation(async (work: (t: typeof tx) => Promise<unknown>) =>
      work(tx),
    ),
  };

  const auth = {
    authenticateSecondAuthoriser: vi.fn(),
  };

  // The service only ever uses these two collaborators; the casts keep the test honest about
  // that rather than constructing the whole Nest graph.
  const service = new UnderwriterService(
    prisma as unknown as ConstructorParameters<typeof UnderwriterService>[0],
    auth as unknown as ConstructorParameters<typeof UnderwriterService>[1],
  );

  return { service, prisma, auth, tx };
}

/* ========================================================================== */
/* The dual-authorisation trigger                                             */
/* ========================================================================== */

describe('SOP-004 dual authorisation', () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness();
  });

  it('refuses a lenient override with no co-signer', async () => {
    await expect(
      h.service.submitReview('app-1', staff(), {
        // REFER_UNDERWRITER -> APPROVE_WITH_CONDITIONS releases money the engine did not approve.
        decision: 'APPROVE_WITH_CONDITIONS',
        justification: JUSTIFICATION,
        approvedLimitNpr: 200_000,
      }),
    ).rejects.toThrow(/second authoriser/i);

    // Nothing was written — not the review, not the audit row, not the status transition.
    expect(h.tx.underwriterReview.create).not.toHaveBeenCalled();
    expect(h.tx.decisionAudit.create).not.toHaveBeenCalled();
    expect(h.tx.loanApplication.update).not.toHaveBeenCalled();
  });

  it('accepts a lenient override co-signed by a credit manager', async () => {
    h.auth.authenticateSecondAuthoriser.mockResolvedValue(CREDIT_MANAGER);

    const review = await h.service.submitReview('app-1', staff(), {
      decision: 'APPROVE_WITH_CONDITIONS',
      justification: JUSTIFICATION,
      dualAuthEmail: CREDIT_MANAGER.email,
      dualAuthPassword: 'the-co-signers-own-password',
      approvedLimitNpr: 200_000,
    });

    expect(review.dualAuthByName).toBe('Credit Manager');
    expect(review.overrodeModel).toBe(true);
    expect(h.tx.loanApplication.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'DECIDED' }) }),
    );
  });

  it('requires the co-signer to re-authenticate, not merely be named', async () => {
    h.auth.authenticateSecondAuthoriser.mockResolvedValue(CREDIT_MANAGER);

    await h.service.submitReview('app-1', staff(), {
      decision: 'APPROVE_WITH_CONDITIONS',
      justification: JUSTIFICATION,
      dualAuthEmail: CREDIT_MANAGER.email,
      dualAuthPassword: 'the-co-signers-own-password',
      approvedLimitNpr: 200_000,
    });

    // The password reached the authenticator. An email-only field would be evidence of nothing.
    expect(h.auth.authenticateSecondAuthoriser).toHaveBeenCalledWith(
      CREDIT_MANAGER.email,
      'the-co-signers-own-password',
    );
  });

  it('rejects self-co-signing', async () => {
    const reviewer = staff();
    // Even with correct credentials — it is the same person twice.
    h.auth.authenticateSecondAuthoriser.mockResolvedValue(reviewer);

    await expect(
      h.service.submitReview('app-1', reviewer, {
        decision: 'APPROVE_WITH_CONDITIONS',
        justification: JUSTIFICATION,
        dualAuthEmail: reviewer.email,
        dualAuthPassword: 'own-password',
        approvedLimitNpr: 200_000,
      }),
    ).rejects.toThrow(ForbiddenException);

    expect(h.tx.underwriterReview.create).not.toHaveBeenCalled();
  });

  it('rejects a compliance officer as co-signer — oversight is not approval authority', async () => {
    h.auth.authenticateSecondAuthoriser.mockResolvedValue(COMPLIANCE);

    await expect(
      h.service.submitReview('app-1', staff(), {
        decision: 'APPROVE_WITH_CONDITIONS',
        justification: JUSTIFICATION,
        dualAuthEmail: COMPLIANCE.email,
        dualAuthPassword: 'own-password',
        approvedLimitNpr: 200_000,
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects an administrator as co-signer — separation of duties', async () => {
    // The account that can create staff must not be able to complete a lending decision. If it
    // could, one compromised administrator could mint an underwriter, approve as that underwriter
    // and co-sign as itself — the exact collusion dual authorisation exists to prevent.
    h.auth.authenticateSecondAuthoriser.mockResolvedValue(ADMIN);

    await expect(
      h.service.submitReview('app-1', staff(), {
        decision: 'APPROVE_WITH_CONDITIONS',
        justification: JUSTIFICATION,
        dualAuthEmail: ADMIN.email,
        dualAuthPassword: 'own-password',
        approvedLimitNpr: 200_000,
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('keeps administration and credit authority disjoint', () => {
    // Asserted on the tables themselves, so this cannot regress by someone adding ADMIN back to a
    // list without noticing what it unlocks.
    expect(CAN_REVIEW_APPLICATIONS).not.toContain('ADMIN');
    expect(CAN_SECOND_AUTHORISE).not.toContain('ADMIN');
    expect(CAN_SECOND_AUTHORISE).not.toContain('COMPLIANCE_OFFICER');
    // And dual authorisation is only meaningful if somebody can actually provide it.
    expect(CAN_SECOND_AUTHORISE.length).toBeGreaterThan(0);
    for (const role of CAN_SECOND_AUTHORISE) {
      expect(CAN_REVIEW_APPLICATIONS).toContain(role);
    }
  });

  /* ---------------------------------------------------------------------- */
  /* The same decision for more money is also a lenient override            */
  /* ---------------------------------------------------------------------- */

  it('treats a limit above the engine offer as a lenient override', async () => {
    const raised = harness(
      application({ decision: 'APPROVE_WITH_CONDITIONS', approvedLimitNpr: 100_000 }),
    );

    await expect(
      raised.service.submitReview('app-1', staff(), {
        // Same decision as the engine — but for two and a half times the money.
        decision: 'APPROVE_WITH_CONDITIONS',
        justification: JUSTIFICATION,
        approvedLimitNpr: 250_000,
      }),
    ).rejects.toThrow(/second authoriser/i);
  });

  it('does not require a co-signer to approve at or below the engine offer', async () => {
    const same = harness(
      application({ decision: 'APPROVE_WITH_CONDITIONS', approvedLimitNpr: 100_000 }),
    );

    const review = await same.service.submitReview('app-1', staff(), {
      decision: 'APPROVE_WITH_CONDITIONS',
      justification: JUSTIFICATION,
      approvedLimitNpr: 80_000,
    });

    expect(review.dualAuthByName).toBeNull();
    expect(same.auth.authenticateSecondAuthoriser).not.toHaveBeenCalled();
  });

  /* ---------------------------------------------------------------------- */
  /* The strict direction needs no second signature                         */
  /* ---------------------------------------------------------------------- */

  it('allows a harsher decision than the engine with one signature', async () => {
    const approved = harness(
      application({ decision: 'APPROVE_WITH_CONDITIONS', approvedLimitNpr: 100_000 }),
    );

    const review = await approved.service.submitReview('app-1', staff(), {
      decision: 'DECLINE',
      justification: JUSTIFICATION,
    });

    expect(review.decision).toBe('DECLINE');
    expect(review.overrodeModel).toBe(true);
    expect(review.dualAuthByName).toBeNull();
    expect(approved.auth.authenticateSecondAuthoriser).not.toHaveBeenCalled();
  });
});

/* ========================================================================== */
/* Limits                                                                     */
/* ========================================================================== */

describe('approved limit', () => {
  it('refuses a limit above the §1.2 product ceiling even with a co-signer', async () => {
    const h = harness();
    h.auth.authenticateSecondAuthoriser.mockResolvedValue(CREDIT_MANAGER);

    await expect(
      h.service.submitReview('app-1', staff(), {
        decision: 'APPROVE_WITH_CONDITIONS',
        justification: JUSTIFICATION,
        dualAuthEmail: CREDIT_MANAGER.email,
        dualAuthPassword: 'own-password',
        // PERSONAL_LOAN tops out at NPR 2,500,000 in PRODUCT_SPECS.
        approvedLimitNpr: 5_000_000,
      }),
    ).rejects.toThrow(/product ceiling/i);
  });

  it('refuses to record a limit against a decision that releases no funds', async () => {
    const h = harness();

    await expect(
      h.service.submitReview('app-1', staff(), {
        decision: 'DECLINE',
        justification: JUSTIFICATION,
        approvedLimitNpr: 100_000,
      }),
    ).rejects.toThrow(/releases no funds/i);
  });
});

/* ========================================================================== */
/* Preconditions                                                              */
/* ========================================================================== */

describe('review preconditions', () => {
  it('refuses to re-decide an application that is no longer under review', async () => {
    const decided = harness(application({}, 'DECIDED'));

    await expect(
      decided.service.submitReview('app-1', staff(), {
        decision: 'DECLINE',
        justification: JUSTIFICATION,
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('rejects a justification that is only whitespace padding', async () => {
    const h = harness();

    await expect(
      h.service.submitReview('app-1', staff(), {
        // Long enough to clear the schema's length floor, empty of reasoning.
        decision: 'DECLINE',
        justification: `${' '.repeat(80)}ok`,
      }),
    ).rejects.toThrow(/at least 40 characters/i);
  });

  it('records the engine recommendation on the review row', async () => {
    const h = harness();

    await h.service.submitReview('app-1', staff(), {
      decision: 'DECLINE',
      justification: JUSTIFICATION,
    });

    // One row answers "what did the system say, what did the human say, and why" without
    // reconstructing the score history.
    expect(h.tx.underwriterReview.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          systemDecision: 'REFER_UNDERWRITER',
          decision: 'DECLINE',
          reviewerRole: 'UNDERWRITER',
        }),
      }),
    );
  });

  it('never puts a credential in the audit snapshot', async () => {
    const h = harness();
    h.auth.authenticateSecondAuthoriser.mockResolvedValue(CREDIT_MANAGER);

    await h.service.submitReview('app-1', staff(), {
      decision: 'APPROVE_WITH_CONDITIONS',
      justification: JUSTIFICATION,
      dualAuthEmail: CREDIT_MANAGER.email,
      dualAuthPassword: 'super-secret-co-signer-password',
      approvedLimitNpr: 200_000,
    });

    const call = h.tx.decisionAudit.create.mock.calls[0]?.[0] as { data: unknown };
    const serialised = JSON.stringify(call.data);

    expect(serialised).not.toContain('super-secret-co-signer-password');
    // The co-signer's identity IS recorded — that is the evidence the control was satisfied.
    expect(serialised).toContain(CREDIT_MANAGER.email);
  });
});

/* -------------------------------------------------------------------------- */
/* Decision history                                                            */
/* -------------------------------------------------------------------------- */

describe('decision history access', () => {
  // Asserted against the route metadata rather than an HTTP round trip, matching how the rest of
  // this file checks authority: the claim is about who the route admits, not about Nest's plumbing.
  const requiredRoles = Reflect.getMetadata(
    REQUIRED_ROLES_KEY,
    UnderwriterController.prototype.decisions,
  ) as readonly StaffRole[] | undefined;

  it('restricts the decision history to the audit roles', () => {
    expect(requiredRoles).toEqual(CAN_VIEW_AUDIT);
  });

  it('excludes both underwriting grades — reading past decisions is oversight, not underwriting', () => {
    expect(requiredRoles).not.toContain('UNDERWRITER');
    expect(requiredRoles).not.toContain('SENIOR_UNDERWRITER');
  });

  it('admits compliance, which can read every decision and record none', () => {
    expect(requiredRoles).toContain('COMPLIANCE_OFFICER');
    // The same officer is still barred from co-signing one. Oversight and approval stay disjoint.
    expect(CAN_SECOND_AUTHORISE).not.toContain('COMPLIANCE_OFFICER');
  });

  it('leaves the queue itself broadly readable — only the history is narrowed', () => {
    const queueRoles = Reflect.getMetadata(
      REQUIRED_ROLES_KEY,
      UnderwriterController.prototype.queue,
    ) as readonly StaffRole[] | undefined;

    expect(queueRoles).toBeUndefined();
  });
});
