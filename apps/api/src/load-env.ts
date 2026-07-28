/**
 * Loads the shared `.env` before anything else reads `process.env`.
 *
 * Kept as its own module and imported first in `main.ts`: TypeScript hoists `import`
 * statements above other top-level code when emitting CommonJS, so inline env loading in
 * `main.ts` would run *after* every other module had already been required. Import order is
 * the only ordering guarantee available here.
 *
 * The file is found by walking upward from this module rather than by a fixed relative path,
 * because the number of directories between here and the repository root differs between
 * running from `src/` and from `dist/src/`. A hardcoded `../../../.env` is correct in exactly
 * one of those layouts and silently wrong in the other.
 *
 * A real deployment injects variables directly and finds no file, which is fine — validation
 * happens in `loadConfig()`, not here.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const MAX_LEVELS = 8;

function findEnvFile(): string | null {
  let directory = __dirname;

  for (let level = 0; level < MAX_LEVELS; level += 1) {
    const candidate = resolve(directory, '.env');
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      break; // Reached the filesystem root.
    }
    directory = parent;
  }
  return null;
}

const envFile = findEnvFile() ?? (existsSync(resolve(process.cwd(), '.env')) ? resolve(process.cwd(), '.env') : null);

if (envFile !== null) {
  process.loadEnvFile(envFile);
}
