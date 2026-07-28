/**
 * The global authentication gate.
 *
 * The property that matters is the default, not the happy path: a route that says nothing about
 * authentication must be closed. This dashboard shipped unauthenticated once, and the failure mode
 * was not a broken guard — it was the absence of one on a route nobody thought about. So the first
 * test here is a controller with no decorators at all.
 */
import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { IS_PUBLIC_KEY, REQUIRED_ROLES_KEY } from '../src/auth/auth.decorators';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import type { AuthenticatedStaff } from '../src/auth/token.service';

import type { StaffRole } from '@aics/contracts';

function principal(overrides: Partial<AuthenticatedStaff> = {}): AuthenticatedStaff {
  return {
    id: 'staff-1',
    email: 'u1@fintara.com.np',
    fullName: 'Underwriter One',
    role: 'UNDERWRITER',
    mustChangePassword: false,
    actorType: 'UNDERWRITER',
    ...overrides,
  };
}

interface Options {
  readonly isPublic?: boolean;
  readonly requiredRoles?: readonly StaffRole[];
  readonly authorization?: string;
  readonly path?: string;
  readonly staff?: AuthenticatedStaff;
  /** Simulates a token that fails verification. */
  readonly tokenInvalid?: boolean;
}

function harness(options: Options = {}) {
  const request: {
    headers: Record<string, string>;
    path: string;
    staff?: AuthenticatedStaff;
  } = {
    headers:
      options.authorization === undefined ? {} : { authorization: options.authorization },
    path: options.path ?? '/api/underwriter/queue',
  };

  const context = {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request }),
  };

  // Real Reflector, stubbed lookup — exercises the guard's own metadata handling rather than a
  // reimplementation of it.
  const reflector = new Reflector();
  vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key: unknown) => {
    if (key === IS_PUBLIC_KEY) return options.isPublic as never;
    if (key === REQUIRED_ROLES_KEY) return options.requiredRoles as never;
    return undefined as never;
  });

  const tokens = {
    verifyAccessToken: vi.fn().mockImplementation(() => {
      if (options.tokenInvalid === true) {
        throw new UnauthorizedException('Session expired or invalid. Sign in again.');
      }
      return options.staff ?? principal();
    }),
  };

  const guard = new JwtAuthGuard(
    reflector,
    tokens as unknown as ConstructorParameters<typeof JwtAuthGuard>[1],
  );

  return {
    guard,
    request,
    tokens,
    run: () => guard.canActivate(context as never),
  };
}

/* ========================================================================== */
/* Closed by default                                                          */
/* ========================================================================== */

describe('default posture', () => {
  it('rejects a request to an undecorated route with no credential', () => {
    // No @Public(), no @Roles(), no Authorization header. This is the case that matters.
    expect(() => harness().run()).toThrow(UnauthorizedException);
  });

  it('allows an undecorated route with a valid token', () => {
    const h = harness({ authorization: 'Bearer valid-token' });
    expect(h.run()).toBe(true);
  });

  it('attaches the principal to the request for @CurrentStaff to read', () => {
    const h = harness({ authorization: 'Bearer valid-token' });
    h.run();
    expect(h.request.staff?.email).toBe('u1@fintara.com.np');
  });

  it('allows a @Public() route with no credential, without verifying a token', () => {
    const h = harness({ isPublic: true });
    expect(h.run()).toBe(true);
    expect(h.tokens.verifyAccessToken).not.toHaveBeenCalled();
  });
});

/* ========================================================================== */
/* Bearer scheme parsing                                                      */
/* ========================================================================== */

describe('Authorization header handling', () => {
  it('rejects malformed schemes rather than trying to be helpful', () => {
    for (const header of [
      'valid-token', // bare token, no scheme
      'bearer valid-token', // wrong case
      'Basic dXNlcjpwYXNz', // wrong scheme
      'Bearer', // no token
      'Bearer ', // empty token
      'Bearer token extra', // trailing junk
      'Bearer  token', // double space parses as an empty token
    ]) {
      expect(() => harness({ authorization: header }).run(), header).toThrow(
        UnauthorizedException,
      );
    }
  });

  it('surfaces a failed verification as an authentication failure', () => {
    expect(() =>
      harness({ authorization: 'Bearer expired-token', tokenInvalid: true }).run(),
    ).toThrow(UnauthorizedException);
  });
});

/* ========================================================================== */
/* Role membership                                                            */
/* ========================================================================== */

describe('@Roles', () => {
  it('admits a listed role', () => {
    const h = harness({
      authorization: 'Bearer valid-token',
      requiredRoles: ['UNDERWRITER', 'CREDIT_MANAGER'],
      staff: principal({ role: 'CREDIT_MANAGER', actorType: 'CREDIT_MANAGER' }),
    });
    expect(h.run()).toBe(true);
  });

  it('refuses an unlisted role', () => {
    const h = harness({
      authorization: 'Bearer valid-token',
      requiredRoles: ['CREDIT_MANAGER', 'ADMIN'],
      staff: principal({ role: 'COMPLIANCE_OFFICER', actorType: 'COMPLIANCE_OFFICER' }),
    });
    expect(() => h.run()).toThrow(ForbiddenException);
  });

  it('does not treat ADMIN as implicitly holding every permission', () => {
    // Membership, not seniority. A route restricted to credit managers is not open to an
    // administrator just because ADMIN outranks it — administering the system and approving
    // credit are different authorities.
    const h = harness({
      authorization: 'Bearer valid-token',
      requiredRoles: ['CREDIT_MANAGER'],
      staff: principal({ role: 'ADMIN', actorType: 'ADMIN' }),
    });
    expect(() => h.run()).toThrow(ForbiddenException);
  });

  it('does not leak the caller’s own role in the refusal', () => {
    const h = harness({
      authorization: 'Bearer valid-token',
      requiredRoles: ['CREDIT_MANAGER'],
      staff: principal({ role: 'COMPLIANCE_OFFICER', actorType: 'COMPLIANCE_OFFICER' }),
    });

    try {
      h.run();
      expect.unreachable('expected a ForbiddenException');
    } catch (error) {
      expect((error as Error).message).toContain('CREDIT_MANAGER');
      expect((error as Error).message).not.toContain('COMPLIANCE_OFFICER');
    }
  });
});

/* ========================================================================== */
/* Provisioned accounts                                                       */
/* ========================================================================== */

describe('mustChangePassword', () => {
  const stale = principal({ mustChangePassword: true });

  it('blocks a provisioned account from doing work before it sets a password', () => {
    // Otherwise the seeded bootstrap credential is simply a working credential.
    const h = harness({
      authorization: 'Bearer valid-token',
      path: '/api/underwriter/queue',
      staff: stale,
    });
    expect(() => h.run()).toThrow(ForbiddenException);
  });

  it('lets it reach exactly the routes needed to fix the situation', () => {
    for (const path of ['/api/auth/me', '/api/auth/change-password', '/api/auth/logout']) {
      const h = harness({ authorization: 'Bearer valid-token', path, staff: stale });
      expect(h.run(), path).toBe(true);
    }
  });
});
