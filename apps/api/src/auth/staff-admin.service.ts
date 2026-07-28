/**
 * Staff account administration.
 *
 * Exists because the bootstrap administrator otherwise cannot create the underwriters and credit
 * managers the review queue needs — and cannot approve credit itself, deliberately. Without this,
 * authentication is installed but unusable.
 *
 * Two properties are enforced here rather than left to the caller:
 *
 *   · Changing a role or deactivating an account revokes that person's live sessions. A role held
 *     in an access token is valid until the token expires; without revocation, "we removed their
 *     approval authority" is true in the database and false in the browser they still have open.
 *   · An administrator cannot deactivate or demote themselves. Locking the last administrator out
 *     of the system is unrecoverable without database access.
 */
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  CreateStaffInput,
  ResetStaffPasswordInput,
  StaffRole,
  StaffSummary,
  UpdateStaffInput,
} from '@aics/contracts';

import { PrismaService } from '../prisma/prisma.service';

import { hashPassword } from './password.util';
import { TokenService } from './token.service';

@Injectable()
export class StaffAdminService {
  private readonly logger = new Logger(StaffAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
  ) {}

  async list(): Promise<readonly StaffSummary[]> {
    const now = new Date();
    const users = await this.prisma.db.staffUser.findMany({
      orderBy: [{ isActive: 'desc' }, { fullName: 'asc' }],
      include: {
        sessions: {
          where: { revokedAt: null, expiresAt: { gt: now } },
          select: { id: true },
        },
      },
    });

    return users.map((user) => ({
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role as StaffRole,
      isActive: user.isActive,
      mustChangePassword: user.mustChangePassword,
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      locked: user.lockedUntil !== null && user.lockedUntil.getTime() > now.getTime(),
      activeSessionCount: user.sessions.length,
      createdAt: user.createdAt.toISOString(),
    }));
  }

  async create(input: CreateStaffInput, actorEmail: string): Promise<StaffSummary> {
    const email = input.email.trim().toLowerCase();

    const existing = await this.prisma.db.staffUser.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existing !== null) {
      throw new ConflictException(`A staff account already exists for ${email}.`);
    }

    const created = await this.prisma.db.staffUser.create({
      data: {
        email,
        fullName: input.fullName.trim(),
        role: input.role,
        passwordHash: await hashPassword(input.temporaryPassword),
        // Always. The administrator knows this password, so it is not yet a credential that
        // identifies the holder — which is what a co-signature has to mean.
        mustChangePassword: true,
      },
    });

    this.logger.log(`${actorEmail} created staff account ${email} (${input.role})`);

    return {
      id: created.id,
      email: created.email,
      fullName: created.fullName,
      role: created.role as StaffRole,
      isActive: created.isActive,
      mustChangePassword: created.mustChangePassword,
      lastLoginAt: null,
      locked: false,
      activeSessionCount: 0,
      createdAt: created.createdAt.toISOString(),
    };
  }

  async update(
    staffId: string,
    input: UpdateStaffInput,
    actor: { readonly id: string; readonly email: string },
  ): Promise<StaffSummary> {
    const user = await this.prisma.db.staffUser.findUnique({ where: { id: staffId } });
    if (user === null) {
      throw new NotFoundException('Staff account not found.');
    }

    if (staffId === actor.id) {
      if (input.isActive === false) {
        throw new BadRequestException('You cannot deactivate your own account.');
      }
      if (input.role !== undefined && input.role !== user.role) {
        throw new BadRequestException(
          'You cannot change your own role. Ask another administrator.',
        );
      }
    }

    // Deactivating the last administrator would leave nobody able to provision accounts, and no
    // way back without direct database access.
    const losingAdmin =
      user.role === 'ADMIN' &&
      ((input.isActive === false) || (input.role !== undefined && input.role !== 'ADMIN'));

    if (losingAdmin) {
      const remaining = await this.prisma.db.staffUser.count({
        where: { role: 'ADMIN', isActive: true, id: { not: staffId } },
      });
      if (remaining === 0) {
        throw new BadRequestException(
          'This is the last active administrator. Promote another account first.',
        );
      }
    }

    const updated = await this.prisma.db.staffUser.update({
      where: { id: staffId },
      data: {
        ...(input.role === undefined ? {} : { role: input.role }),
        ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
      },
    });

    // The reason this is not optional: an access token carries the role it was minted with.
    const roleChanged = input.role !== undefined && input.role !== user.role;
    if (roleChanged || input.isActive === false) {
      const revoked = await this.tokens.revokeAllForUser(staffId);
      this.logger.log(
        `${actor.email} updated ${user.email} (${roleChanged ? `role -> ${updated.role}` : ''}` +
          `${input.isActive === false ? ' deactivated' : ''}); revoked ${revoked} session(s)`,
      );
    }

    const now = new Date();
    const sessions = await this.prisma.db.staffSession.count({
      where: { staffUserId: staffId, revokedAt: null, expiresAt: { gt: now } },
    });

    return {
      id: updated.id,
      email: updated.email,
      fullName: updated.fullName,
      role: updated.role as StaffRole,
      isActive: updated.isActive,
      mustChangePassword: updated.mustChangePassword,
      lastLoginAt: updated.lastLoginAt?.toISOString() ?? null,
      locked: updated.lockedUntil !== null && updated.lockedUntil.getTime() > now.getTime(),
      activeSessionCount: sessions,
      createdAt: updated.createdAt.toISOString(),
    };
  }

  /**
   * Issues a new temporary password and clears any lockout.
   *
   * Also revokes every session: a password reset is either a locked-out colleague or a suspected
   * compromise, and in the second case leaving the existing sessions alive defeats the reset.
   */
  async resetPassword(
    staffId: string,
    input: ResetStaffPasswordInput,
    actorEmail: string,
  ): Promise<void> {
    const user = await this.prisma.db.staffUser.findUnique({
      where: { id: staffId },
      select: { email: true },
    });
    if (user === null) {
      throw new NotFoundException('Staff account not found.');
    }

    await this.prisma.db.staffUser.update({
      where: { id: staffId },
      data: {
        passwordHash: await hashPassword(input.temporaryPassword),
        mustChangePassword: true,
        failedLoginAttempts: 0,
        lockedUntil: null,
        passwordChangedAt: new Date(),
      },
    });

    const revoked = await this.tokens.revokeAllForUser(staffId);
    this.logger.log(
      `${actorEmail} reset the password for ${user.email}; revoked ${revoked} session(s)`,
    );
  }
}
