/**
 * Token issuance and verification.
 *
 * Two token types with deliberately different properties:
 *
 *   · **Access token** — a signed JWT, 15 minutes, stateless. Carries the principal and role so
 *     an authorisation check costs no database round trip. Not revocable, which is precisely why
 *     it is short-lived.
 *
 *   · **Refresh token** — 256 bits of CSPRNG output, stored server-side as a SHA-256 digest in
 *     `staff_session`. Opaque, so it carries no claims to be trusted, and revocable, so ending
 *     someone's access is a database write rather than a wait for expiry.
 *
 * Rotation on every refresh: presenting a refresh token invalidates it and issues a new one. A
 * token presented twice is therefore evidence of theft, not of normal use, and every session for
 * that user is terminated — the standard response, since the legitimate holder and the attacker
 * are indistinguishable at that point.
 */
import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import { ACTOR_TYPE_FOR_ROLE, STAFF_ROLES, type ActorType, type StaffRole } from '@aics/contracts';

import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';

/** The principal, as guards and controllers see it. */
export interface AuthenticatedStaff {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly role: StaffRole;
  readonly mustChangePassword: boolean;
  /** Pre-resolved so audit writers never re-derive the mapping. */
  readonly actorType: ActorType;
}

/** Claims we put in the access token, and the only ones we read back out. */
interface AccessTokenClaims {
  readonly sub: string;
  readonly email: string;
  readonly name: string;
  readonly role: string;
  readonly pwd: boolean;
  readonly typ: string;
}

const ACCESS_TOKEN_TYPE = 'aics-staff-access';
const REFRESH_TOKEN_BYTES = 32;

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  get accessTokenTtlSeconds(): number {
    return this.config.auth.accessTokenTtlSeconds;
  }

  /* ---------------------------------------------------------------------- */
  /* Access tokens                                                          */
  /* ---------------------------------------------------------------------- */

  async issueAccessToken(staff: AuthenticatedStaff): Promise<string> {
    const claims: AccessTokenClaims = {
      sub: staff.id,
      email: staff.email,
      name: staff.fullName,
      role: staff.role,
      pwd: staff.mustChangePassword,
      typ: ACCESS_TOKEN_TYPE,
    };
    return this.jwt.signAsync(claims);
  }

  /**
   * Verifies an access token and returns the principal.
   *
   * Every claim is re-validated rather than trusted for its shape. `role` in particular is
   * checked against the known set: a token carrying an unrecognised role must fail closed, not
   * arrive at a guard that compares it against a list and finds no match for reasons nobody can
   * see in the logs.
   */
  verifyAccessToken(token: string): AuthenticatedStaff {
    let claims: AccessTokenClaims;
    try {
      claims = this.jwt.verify<AccessTokenClaims>(token);
    } catch {
      // Expiry, bad signature and malformed input are one outcome to the caller on purpose.
      throw new UnauthorizedException('Session expired or invalid. Sign in again.');
    }

    if (claims.typ !== ACCESS_TOKEN_TYPE) {
      throw new UnauthorizedException('Session expired or invalid. Sign in again.');
    }
    if (!(STAFF_ROLES as readonly string[]).includes(claims.role)) {
      this.logger.warn(`Access token for ${claims.sub} carries unknown role "${claims.role}"`);
      throw new UnauthorizedException('Session expired or invalid. Sign in again.');
    }

    const role = claims.role as StaffRole;
    return {
      id: claims.sub,
      email: claims.email,
      fullName: claims.name,
      role,
      mustChangePassword: claims.pwd,
      actorType: ACTOR_TYPE_FOR_ROLE[role],
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Refresh sessions                                                       */
  /* ---------------------------------------------------------------------- */

  private static digest(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  /** Creates a session row and returns the bearer token, which is never stored. */
  async issueRefreshToken(
    staffUserId: string,
    context: { readonly userAgent?: string; readonly ipAddress?: string },
  ): Promise<string> {
    const token = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
    const expiresAt = new Date(
      Date.now() + this.config.auth.refreshTokenTtlHours * 60 * 60 * 1000,
    );

    await this.prisma.db.staffSession.create({
      data: {
        staffUserId,
        tokenHash: TokenService.digest(token),
        expiresAt,
        userAgent: context.userAgent?.slice(0, 300) ?? null,
        ipAddress: context.ipAddress?.slice(0, 60) ?? null,
      },
    });

    return token;
  }

  /**
   * Consumes a refresh token and issues its replacement.
   *
   * Returns the staff user id. Rotation and reuse detection happen here so no caller can forget
   * either half.
   */
  async rotateRefreshToken(
    token: string,
    context: { readonly userAgent?: string; readonly ipAddress?: string },
  ): Promise<{ readonly staffUserId: string; readonly refreshToken: string }> {
    const tokenHash = TokenService.digest(token);
    const session = await this.prisma.db.staffSession.findUnique({ where: { tokenHash } });

    if (session === null) {
      throw new UnauthorizedException('Session expired or invalid. Sign in again.');
    }

    // Already rotated or explicitly revoked, and being presented again. The legitimate holder
    // and a thief look identical from here, so end every session for the user and make them
    // re-authenticate.
    if (session.revokedAt !== null) {
      this.logger.warn(
        `Refresh token reuse detected for staff ${session.staffUserId}; revoking all sessions`,
      );
      await this.revokeAllForUser(session.staffUserId);
      throw new UnauthorizedException('Session expired or invalid. Sign in again.');
    }

    if (session.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Session expired or invalid. Sign in again.');
    }

    const replacement = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
    const expiresAt = new Date(
      Date.now() + this.config.auth.refreshTokenTtlHours * 60 * 60 * 1000,
    );

    // One transaction: a rotation that revoked the old token without creating the new one would
    // sign the user out mid-review, and the reverse would leave two live tokens.
    await this.prisma.transaction(async (tx) => {
      const created = await tx.staffSession.create({
        data: {
          staffUserId: session.staffUserId,
          tokenHash: TokenService.digest(replacement),
          expiresAt,
          userAgent: context.userAgent?.slice(0, 300) ?? null,
          ipAddress: context.ipAddress?.slice(0, 60) ?? null,
        },
      });
      await tx.staffSession.update({
        where: { id: session.id },
        data: { revokedAt: new Date(), rotatedToId: created.id },
      });
    });

    return { staffUserId: session.staffUserId, refreshToken: replacement };
  }

  /** Revokes one session. Idempotent — signing out twice is not an error. */
  async revokeRefreshToken(token: string): Promise<void> {
    await this.prisma.db.staffSession.updateMany({
      where: { tokenHash: TokenService.digest(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Ends every live session for a user — used on reuse detection, deactivation and role change. */
  async revokeAllForUser(staffUserId: string): Promise<number> {
    const { count } = await this.prisma.db.staffSession.updateMany({
      where: { staffUserId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return count;
  }
}
