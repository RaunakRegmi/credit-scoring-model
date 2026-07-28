/**
 * Provisions the bootstrap administrator.
 *
 * Imported by `seed.ts` and safe to run repeatedly: an existing account is left alone, including
 * its password. Re-seeding must never reset a credential someone has already changed.
 *
 * Only one account is created, and only when `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD`
 * are both set. There are deliberately no demo underwriter or compliance logins: a seeded account
 * with a password printed in a repository is a backdoor, and the SOP-004 dual-authorisation
 * control is meaningless if the co-signer's credentials ship with the source. The administrator
 * creates the real accounts, and its own password must be changed before it can do anything else.
 */
import { Logger } from '@nestjs/common';

import { hashPassword } from '../src/auth/password.util';
import type { AppConfig } from '../src/config/configuration';
import type { PrismaService } from '../src/prisma/prisma.service';

export async function seedBootstrapAdmin(
  prisma: PrismaService,
  config: AppConfig,
  logger: Logger,
): Promise<void> {
  const bootstrap = config.auth.bootstrapAdmin;

  if (bootstrap === null) {
    const staffCount = await prisma.db.staffUser.count();
    if (staffCount === 0) {
      logger.warn(
        'No staff accounts exist and no BOOTSTRAP_ADMIN_EMAIL is configured. Nobody can sign in. ' +
          'Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD, or provision accounts through ' +
          'your identity provider.',
      );
    }
    return;
  }

  const existing = await prisma.db.staffUser.findUnique({
    where: { email: bootstrap.email },
    select: { id: true, role: true },
  });

  if (existing !== null) {
    logger.log(`Bootstrap administrator ${bootstrap.email} already exists — left unchanged`);
    return;
  }

  await prisma.db.staffUser.create({
    data: {
      email: bootstrap.email,
      fullName: 'Bootstrap Administrator',
      passwordHash: await hashPassword(bootstrap.password),
      role: 'ADMIN',
      // The whole point of the account. Until this password is changed, the guard permits only
      // `/api/auth/me`, `/api/auth/change-password` and `/api/auth/logout`.
      mustChangePassword: true,
    },
  });

  logger.log(
    `Created bootstrap administrator ${bootstrap.email} — it must set a new password before it ` +
      'can be used for anything else',
  );
}
