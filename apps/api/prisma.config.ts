import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig } from 'prisma/config';

/**
 * Prisma 7 configuration.
 *
 * v7 removed Prisma's implicit `.env` loading, so the CLI would otherwise start with no
 * `DATABASE_URL`. The monorepo keeps a single `.env` at the root; we load it here with Node's
 * built-in loader (no `dotenv` dependency) and fall back to the app-local file so a container
 * that mounts only `apps/api` still works.
 */
for (const candidate of [resolve(__dirname, '../../.env'), resolve(__dirname, '.env')]) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}

const databaseUrl = process.env.DATABASE_URL;

/**
 * The datasource is attached only when a URL is actually available.
 *
 * `prisma generate` reads the schema and emits a client; it never opens a connection. Docker
 * image builds run exactly that command, with no `.env` in the build context — correctly, since
 * secrets must not enter a build layer. Throwing on a missing `DATABASE_URL` here therefore broke
 * the image build for a command that had no use for the variable.
 *
 * Commands that DO need a connection (`migrate deploy`, `migrate dev`, `db push`, `studio`) still
 * fail without it — Prisma raises its own missing-datasource error — so nothing is silently
 * papered over. The warning below makes the reason obvious in build logs.
 */
if (databaseUrl === undefined || databaseUrl === '') {
  process.emitWarning(
    'DATABASE_URL is not set. `prisma generate` will still work (it needs only the schema), but ' +
      'any command that connects to the database will fail. Copy .env.example to .env at the ' +
      'repository root if you intended to run a migration.',
  );
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'node dist/prisma/seed.js',
  },
  ...(databaseUrl === undefined || databaseUrl === ''
    ? {}
    : { datasource: { url: databaseUrl } }),
});
