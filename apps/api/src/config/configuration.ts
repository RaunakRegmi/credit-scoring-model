/**
 * Typed, validated application configuration.
 *
 * The whole environment is parsed once at boot and fails loudly if anything is wrong.
 * A credit engine that starts successfully and only discovers at the first application
 * that its encryption key is malformed has failed in the worst possible place.
 */
import { z } from 'zod';

const booleanish = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['error', 'warn', 'log', 'debug', 'verbose']).default('log'),

  API_PORT: z.coerce.number().int().positive().max(65535).default(4000),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // 64 hex chars = 32 bytes. Validated fully in FieldCrypto; length-checked here so a
  // typo is caught at boot rather than on first write.
  FIELD_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'FIELD_ENCRYPTION_KEY must be 64 hex characters (openssl rand -hex 32)'),
  FIELD_HASH_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'FIELD_HASH_KEY must be 64 hex characters (openssl rand -hex 32)'),

  /**
   * HS256 signing key for staff access tokens. Minimum 32 bytes of entropy, hex encoded — the
   * same generation command as the other keys, so there is one thing to remember.
   *
   * No default. A signing key with a default is a signing key everyone with the repository can
   * forge tokens against, and a forged token here is an underwriter session.
   */
  JWT_SECRET: z
    .string()
    .regex(/^[0-9a-fA-F]{64,}$/, 'JWT_SECRET must be at least 64 hex characters (openssl rand -hex 32)'),

  /**
   * Access tokens are short-lived because they are not revocable; the refresh session is the
   * revocable half of the pair. Fifteen minutes bounds how long a stolen access token is useful
   * without making the dashboard re-authenticate mid-review.
   */
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  /** One working day. A refresh session outliving a shift is a session nobody is watching. */
  REFRESH_TOKEN_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(9),

  /** Consecutive failures before an account is locked. */
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(3).max(20).default(5),
  LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),

  /**
   * Bootstrap administrator, created by the seed if absent. Provisioned with
   * `mustChangePassword`, so the seeded credential cannot be used to do work — only to set a
   * real one. Both blank means "do not create an administrator", which is the correct default
   * for any environment whose accounts come from an identity provider.
   */
  BOOTSTRAP_ADMIN_EMAIL: z.string().default(''),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().default(''),

  STORAGE_ROOT: z.string().default('./storage'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),

  ML_SERVICE_URL: z.string().url().default('http://localhost:8000'),
  ML_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  ML_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
  ML_CIRCUIT_RESET_MS: z.coerce.number().int().positive().default(30_000),

  /** Empty string means "no key configured" and selects the local extractor. */
  LLAMA_CLOUD_API_KEY: z.string().default(''),
  LLAMA_PARSE_BASE_URL: z.string().url().default('https://api.cloud.llamaindex.ai'),
  EXTRACTION_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.85),

  /**
   * Escape hatch for local development against a real Postgres without TLS. Never set
   * this in production.
   */
  ALLOW_INSECURE_DB: booleanish.default('false'),
});

export type Env = z.infer<typeof envSchema>;

export interface AppConfig {
  readonly nodeEnv: Env['NODE_ENV'];
  readonly isProduction: boolean;
  readonly logLevel: Env['LOG_LEVEL'];
  readonly port: number;
  readonly corsOrigins: readonly string[];
  readonly database: {
    readonly url: string;
  };
  readonly crypto: {
    readonly encryptionKey: string;
    readonly hashKey: string;
  };
  readonly auth: {
    readonly jwtSecret: string;
    readonly accessTokenTtlSeconds: number;
    readonly refreshTokenTtlHours: number;
    readonly loginMaxAttempts: number;
    readonly loginLockoutMinutes: number;
    /** `null` when no bootstrap administrator should be created. */
    readonly bootstrapAdmin: { readonly email: string; readonly password: string } | null;
  };
  readonly storage: {
    readonly root: string;
    readonly maxUploadBytes: number;
  };
  readonly ml: {
    readonly baseUrl: string;
    readonly timeoutMs: number;
    readonly failureThreshold: number;
    readonly resetMs: number;
  };
  readonly extraction: {
    readonly llamaApiKey: string | null;
    readonly llamaBaseUrl: string;
    readonly minConfidence: number;
  };
}

/**
 * Parses `process.env` into `AppConfig`.
 *
 * Aggregates every problem into one message. Reporting the first bad variable and exiting
 * makes fixing a fresh environment a game of whack-a-mole.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  · ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  const env = parsed.data;

  // A signing key of one repeated byte passes the hex regex and is worthless. Same reasoning as
  // the placeholder rejection in FieldCrypto: the failure mode this guards against is a key that
  // was never generated, and nothing else in the system would complain.
  const secretBytes = Buffer.from(env.JWT_SECRET, 'hex');
  if (secretBytes.every((byte) => byte === secretBytes[0])) {
    throw new Error(
      'JWT_SECRET is a placeholder value. Generate a real key with: openssl rand -hex 32',
    );
  }

  const bootstrapEmail = env.BOOTSTRAP_ADMIN_EMAIL.trim().toLowerCase();
  const bootstrapPassword = env.BOOTSTRAP_ADMIN_PASSWORD;

  // Half-configured is the dangerous state: an operator who set the email and expects an account
  // to exist, and a system that silently created nothing.
  if ((bootstrapEmail === '') !== (bootstrapPassword === '')) {
    throw new Error(
      'BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD must be set together, or both left ' +
        'blank to skip creating an administrator.',
    );
  }
  if (bootstrapPassword !== '' && bootstrapPassword.length < 12) {
    throw new Error('BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters.');
  }

  if (env.NODE_ENV === 'production' && !env.DATABASE_URL.includes('sslmode=')) {
    if (!env.ALLOW_INSECURE_DB) {
      throw new Error(
        'Refusing to start in production without TLS to the database. §10.1 requires data ' +
          'in transit to be encrypted. Add `?sslmode=require` to DATABASE_URL, or set ' +
          'ALLOW_INSECURE_DB=true if TLS terminates at a trusted proxy.',
      );
    }
  }

  return {
    nodeEnv: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    logLevel: env.LOG_LEVEL,
    port: env.API_PORT,
    corsOrigins: env.CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    database: {
      url: env.DATABASE_URL,
    },
    crypto: {
      encryptionKey: env.FIELD_ENCRYPTION_KEY,
      hashKey: env.FIELD_HASH_KEY,
    },
    auth: {
      jwtSecret: env.JWT_SECRET,
      accessTokenTtlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenTtlHours: env.REFRESH_TOKEN_TTL_HOURS,
      loginMaxAttempts: env.LOGIN_MAX_ATTEMPTS,
      loginLockoutMinutes: env.LOGIN_LOCKOUT_MINUTES,
      bootstrapAdmin:
        bootstrapEmail === '' || bootstrapPassword === ''
          ? null
          : { email: bootstrapEmail, password: bootstrapPassword },
    },
    storage: {
      root: env.STORAGE_ROOT,
      maxUploadBytes: env.MAX_UPLOAD_BYTES,
    },
    ml: {
      baseUrl: env.ML_SERVICE_URL.replace(/\/+$/, ''),
      timeoutMs: env.ML_TIMEOUT_MS,
      failureThreshold: env.ML_CIRCUIT_FAILURE_THRESHOLD,
      resetMs: env.ML_CIRCUIT_RESET_MS,
    },
    extraction: {
      // Treat blank as absent so an unset variable and an empty one behave identically.
      llamaApiKey: env.LLAMA_CLOUD_API_KEY.trim() === '' ? null : env.LLAMA_CLOUD_API_KEY.trim(),
      llamaBaseUrl: env.LLAMA_PARSE_BASE_URL,
      minConfidence: env.EXTRACTION_MIN_CONFIDENCE,
    },
  };
}

/** DI token for `AppConfig`. */
export const APP_CONFIG = 'APP_CONFIG';
