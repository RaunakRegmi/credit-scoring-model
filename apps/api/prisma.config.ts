import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig } from 'prisma/config';

/**
 * Prisma 7 configuration.
 *
 * v7 removed Prisma's implicit `.env` loading, so the CLI would otherwise start with no
 * `DATABASE_URL`. The monorepo keeps a single `.env` at the root; we load it here with
 * Node's built-in loader (no `dotenv` dependency) and fall back to the app-local file so
 * a container that mounts only `apps/api` still works.
 */
for (const candidate of [resolve(__dirname, '../../.env'), resolve(__dirname, '.env')]) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    'DATABASE_URL is not set. Copy .env.example to .env at the repository root before ' +
      'running any Prisma command.',
  );
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: databaseUrl,
  },
});
