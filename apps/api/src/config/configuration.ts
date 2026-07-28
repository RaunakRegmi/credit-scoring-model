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
