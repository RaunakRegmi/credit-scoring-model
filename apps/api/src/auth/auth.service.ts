/**
 * Staff authentication.
 *
 * The security properties this file is responsible for, stated so they can be checked:
 *
 *   · A wrong password, an unknown email, a deactivated account and a locked account are one
 *     response to the caller. Distinguishing them turns the login form into a directory of who
 *     works here.
 *   · An unknown email still costs a password hash. Returning early would make user enumeration
 *     a timing measurement rather than a message comparison.
 *   · Consecutive failures lock the account; success clears the counter. Locking is per account,
 *     with `LoginThrottle` covering the spread-across-accounts case.
 *   · Credentials are never logged, including at debug level.
 */
import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ACTOR_TYPE_FOR_ROLE,
  type ChangePasswordInput,
  type LoginInput,
  type LoginResult,
  type StaffIdentity,
  type StaffRole,
} from '@aics/contracts';

import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';

import { hashPassword, needsRehash, verifyPassword } from './password.util';
import { TokenService, type AuthenticatedStaff } from './token.service';

/**
 * The one message every authentication failure returns. Deliberately says nothing about which of
 * the possible causes applied.
 */
const GENERIC_FAILURE = 'Email or password is incorrect.';

/**
 * Verified against on an unknown email so the work performed is indistinguishable from a real
 * lookup. Hashed at module load from a value nobody knows.
 */
let decoyHashPromise: Promise<string> | null = null;
function decoyHash(): Promise<string> {
  decoyHashPromise ??= hashPassword(
    `decoy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  );
  return decoyHashPromise;
}

export interface RequestContext {
  readonly userAgent?: string;
  readonly ipAddress?: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
  ) {}

  /* ---------------------------------------------------------------------- */
  /* Login                                                                  */
  /* ---------------------------------------------------------------------- */

  async login(input: LoginInput, context: RequestContext): Promise<LoginResult> {
    const email = input.email.trim().toLowerCase();
    const user = await this.prisma.db.staffUser.findUnique({ where: { email } });

    if (user === null) {
      // Same work, same message, same timing profile as a real user with a wrong password.
      await verifyPassword(input.password, await decoyHash());
      throw new UnauthorizedException(GENERIC_FAILURE);
    }

    const now = new Date();
    const locked = user.lockedUntil !== null && user.lockedUntil.getTime() > now.getTime();

    if (locked || !user.isActive) {
      // Still pay the hash cost: a locked or disabled account must not answer faster than a live
      // one, or the lock itself becomes observable.
      await verifyPassword(input.password, user.passwordHash);
      this.logger.warn(
        `Rejected login for ${email}: ${locked ? 'account locked' : 'account deactivated'}`,
      );
      throw new UnauthorizedException(GENERIC_FAILURE);
    }

    const valid = await verifyPassword(input.password, user.passwordHash);

    if (!valid) {
      await this.recordFailure(user.id, user.failedLoginAttempts, email);
      throw new UnauthorizedException(GENERIC_FAILURE);
    }

    // A successful password check against a stale work factor is the only moment we hold the
    // plaintext, so it is the only moment the hash can be upgraded.
    const upgradedHash = needsRehash(user.passwordHash)
      ? await hashPassword(input.password)
      : null;

    await this.prisma.db.staffUser.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: now,
        ...(upgradedHash === null ? {} : { passwordHash: upgradedHash }),
      },
    });

    if (upgradedHash !== null) {
      this.logger.log(`Re-hashed password for ${email} at the current work factor`);
    }

    const staff = toPrincipal({
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role as StaffRole,
      mustChangePassword: user.mustChangePassword,
    });

    const [accessToken, refreshToken] = await Promise.all([
      this.tokens.issueAccessToken(staff),
      this.tokens.issueRefreshToken(user.id, context),
    ]);

    this.logger.log(`Staff login: ${email} (${user.role})`);

    return {
      staff: toIdentity(staff),
      accessToken,
      refreshToken,
      expiresInSeconds: this.tokens.accessTokenTtlSeconds,
    };
  }

  private async recordFailure(
    userId: string,
    priorFailures: number,
    email: string,
  ): Promise<void> {
    const attempts = priorFailures + 1;
    const shouldLock = attempts >= this.config.auth.loginMaxAttempts;

    await this.prisma.db.staffUser.update({
      where: { id: userId },
      data: {
        failedLoginAttempts: attempts,
        ...(shouldLock
          ? {
              lockedUntil: new Date(
                Date.now() + this.config.auth.loginLockoutMinutes * 60 * 1000,
              ),
            }
          : {}),
      },
    });

    if (shouldLock) {
      // Locking is a security event worth an operator seeing; the failed attempt itself is not.
      this.logger.warn(
        `Locked ${email} after ${attempts} consecutive failures for ` +
          `${this.config.auth.loginLockoutMinutes} minutes`,
      );
      await this.tokens.revokeAllForUser(userId);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Refresh and logout                                                     */
  /* ---------------------------------------------------------------------- */

  async refresh(refreshToken: string, context: RequestContext): Promise<LoginResult> {
    const rotated = await this.tokens.rotateRefreshToken(refreshToken, context);

    const user = await this.prisma.db.staffUser.findUnique({
      where: { id: rotated.staffUserId },
    });

    // Re-checked on every refresh, not just at login. Deactivating an account must take effect
    // within the access-token lifetime rather than at the end of the refresh window.
    if (user === null || !user.isActive) {
      await this.tokens.revokeAllForUser(rotated.staffUserId);
      throw new UnauthorizedException('Session expired or invalid. Sign in again.');
    }

    const staff = toPrincipal({
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role as StaffRole,
      mustChangePassword: user.mustChangePassword,
    });

    return {
      staff: toIdentity(staff),
      accessToken: await this.tokens.issueAccessToken(staff),
      refreshToken: rotated.refreshToken,
      expiresInSeconds: this.tokens.accessTokenTtlSeconds,
    };
  }

  async logout(refreshToken: string): Promise<void> {
    await this.tokens.revokeRefreshToken(refreshToken);
  }

  /* ---------------------------------------------------------------------- */
  /* Password change                                                        */
  /* ---------------------------------------------------------------------- */

  /**
   * Changes a password and ends every other session.
   *
   * Revoking on change is the point of the operation. Someone changing their password because
   * they believe it was exposed has gained nothing if the exposed session is still live.
   */
  async changePassword(staffId: string, input: ChangePasswordInput): Promise<void> {
    const user = await this.prisma.db.staffUser.findUnique({ where: { id: staffId } });
    if (user === null || !user.isActive) {
      throw new UnauthorizedException('Session expired or invalid. Sign in again.');
    }

    if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
      throw new UnauthorizedException('Current password is incorrect.');
    }

    if (await verifyPassword(input.newPassword, user.passwordHash)) {
      throw new ForbiddenException('The new password must differ from the current one.');
    }

    const passwordHash = await hashPassword(input.newPassword);

    await this.prisma.db.staffUser.update({
      where: { id: staffId },
      data: {
        passwordHash,
        mustChangePassword: false,
        passwordChangedAt: new Date(),
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });

    const revoked = await this.tokens.revokeAllForUser(staffId);
    this.logger.log(`Password changed for ${user.email}; revoked ${revoked} session(s)`);
  }

  /* ---------------------------------------------------------------------- */
  /* Second-authoriser verification (SOP-004)                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Authenticates a co-signer without issuing them a session.
   *
   * Deliberately a re-authentication rather than a lookup by email. SOP-004's second signature is
   * evidence that a second authorised person was present and agreed; an email field the first
   * reviewer types in on their own would be evidence of nothing.
   */
  async authenticateSecondAuthoriser(
    email: string,
    password: string,
  ): Promise<AuthenticatedStaff> {
    const normalised = email.trim().toLowerCase();
    const user = await this.prisma.db.staffUser.findUnique({ where: { email: normalised } });

    if (user === null) {
      await verifyPassword(password, await decoyHash());
      throw new UnauthorizedException('Second authoriser credentials are incorrect.');
    }

    const locked = user.lockedUntil !== null && user.lockedUntil.getTime() > Date.now();
    const valid = await verifyPassword(password, user.passwordHash);

    if (!valid || locked || !user.isActive) {
      if (!valid) {
        await this.recordFailure(user.id, user.failedLoginAttempts, normalised);
      }
      throw new UnauthorizedException('Second authoriser credentials are incorrect.');
    }

    // A co-signer who has not yet set their own password has not established that the credential
    // is theirs alone, so it cannot stand as a second signature.
    if (user.mustChangePassword) {
      throw new ForbiddenException(
        'The second authoriser must set a permanent password before co-signing a decision.',
      );
    }

    return toPrincipal({
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role as StaffRole,
      mustChangePassword: false,
    });
  }

  /** Current principal, re-read from the database rather than from token claims. */
  async currentStaff(staffId: string): Promise<StaffIdentity> {
    const user = await this.prisma.db.staffUser.findUnique({ where: { id: staffId } });
    if (user === null || !user.isActive) {
      throw new UnauthorizedException('Session expired or invalid. Sign in again.');
    }
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role as StaffRole,
      mustChangePassword: user.mustChangePassword,
    };
  }
}

function toPrincipal(identity: StaffIdentity): AuthenticatedStaff {
  return { ...identity, actorType: ACTOR_TYPE_FOR_ROLE[identity.role] };
}

function toIdentity(staff: AuthenticatedStaff): StaffIdentity {
  return {
    id: staff.id,
    email: staff.email,
    fullName: staff.fullName,
    role: staff.role,
    mustChangePassword: staff.mustChangePassword,
  };
}
