/**
 * Database access.
 *
 * Prisma 7 requires a driver adapter, so the connection string is handed to
 * `@prisma/adapter-pg` rather than read from the schema. The client is then extended with
 * field-level encryption, which changes its type — hence the exported
 * `ExtendedPrismaClient` alias that every consumer types against.
 */
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../../prisma/generated/prisma/client';
import { FieldCrypto } from '../common/crypto.util';
import { APP_CONFIG, type AppConfig } from '../config/configuration';

import { PiiCodec, encryptionExtension } from './encryption.extension';

function buildClient(config: AppConfig, crypto: FieldCrypto) {
  const adapter = new PrismaPg({ connectionString: config.database.url });

  const base = new PrismaClient({
    adapter,
    log: config.isProduction
      ? [{ emit: 'event', level: 'warn' }, { emit: 'event', level: 'error' }]
      : [{ emit: 'event', level: 'warn' }, { emit: 'event', level: 'error' }],
  });

  return base.$extends(encryptionExtension(crypto));
}

export type ExtendedPrismaClient = ReturnType<typeof buildClient>;

/**
 * Transaction-scoped client. `$transaction` hands back a client without the
 * transaction-control methods, so services that accept either a client or a transaction
 * should type against this.
 */
export type PrismaTransaction = Omit<
  ExtendedPrismaClient,
  '$connect' | '$disconnect' | '$transaction' | '$extends'
>;

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  /** The extended client. Use as `prisma.db.applicant.findMany(...)`. */
  public readonly db: ExtendedPrismaClient;

  /** Write-side PII encoder, sharing the same keys as the read-side extension. */
  public readonly pii: PiiCodec;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    const crypto = new FieldCrypto(config.crypto.encryptionKey, config.crypto.hashKey);
    this.db = buildClient(config, crypto);
    this.pii = new PiiCodec(crypto);
  }

  async onModuleInit(): Promise<void> {
    await this.db.$connect();
    this.logger.log('Connected to PostgreSQL');
  }

  async onModuleDestroy(): Promise<void> {
    await this.db.$disconnect();
    this.logger.log('Disconnected from PostgreSQL');
  }

  /**
   * Runs `work` in a single transaction.
   *
   * Scoring writes the feature store, the credit score, the policy evaluations and the
   * audit record. Those must land together — an audit row without its score, or a score
   * without its audit row, is a compliance defect (§10.4), not a partial success.
   */
  async transaction<T>(work: (tx: PrismaTransaction) => Promise<T>): Promise<T> {
    return this.db.$transaction(async (tx) => work(tx as PrismaTransaction), {
      // The pipeline's own budget is ~4s (§6.2); a transaction outliving that is stuck.
      timeout: 15_000,
      maxWait: 5_000,
    });
  }

  /** Liveness probe used by the health endpoint. */
  async ping(): Promise<boolean> {
    try {
      await this.db.$queryRaw`SELECT 1`;
      return true;
    } catch (error) {
      this.logger.error(`Database ping failed: ${error instanceof Error ? error.message : error}`);
      return false;
    }
  }
}
