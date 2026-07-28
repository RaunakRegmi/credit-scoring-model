/**
 * Staff password hashing.
 *
 * scrypt, from `node:crypto`, rather than bcrypt or argon2. Those are the two conventional
 * choices and both are fine cryptographically — the reason not to use them here is operational:
 * both are native addons requiring a compiler in the build image, and this API ships from a slim
 * Node base with no toolchain. scrypt is a memory-hard KDF in the standard library, is on OWASP's
 * accepted list for password storage, and adds nothing to the dependency tree of a system that
 * decides credit.
 *
 * The stored format is PHC-style — `scrypt$N$r$p$salt$digest` — so the work factor travels with
 * each credential. Raising the cost for new passwords therefore needs no migration and does not
 * invalidate existing ones: verification reads the parameters out of the stored string rather
 * than assuming today's constants.
 */
import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';

/**
 * Hand-wrapped rather than `promisify`d: `promisify` resolves to the three-argument overload of
 * `scrypt`, which has no parameter object, so passing a work factor would not typecheck.
 */
function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (error, derivedKey) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });
}

/**
 * OWASP's minimum for scrypt is N=2^17, r=8, p=1. We use N=2^16 with p=2, the sibling
 * recommendation from the same guidance: equivalent work, half the peak memory, which matters
 * because peak memory is per-concurrent-login and this process also holds a connection pool.
 */
const COST_N = 65_536;
const BLOCK_SIZE_R = 8;
const PARALLELISM_P = 2;

const SALT_BYTES = 16;
const DIGEST_BYTES = 32;

/**
 * `node:crypto` caps scrypt memory at 32 MB by default and throws above it. Our parameters need
 * roughly 128 * N * r = 64 MB, so the ceiling is raised explicitly. Left implicit, the first
 * login on a fresh deployment fails with an opaque error from inside the crypto layer.
 */
const MAX_MEMORY_BYTES = 192 * 1024 * 1024;

const SCHEME = 'scrypt';

export class PasswordFormatError extends Error {}

/** Hashes `plaintext` with a fresh random salt at the current work factor. */
export async function hashPassword(plaintext: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const digest = await scrypt(plaintext.normalize('NFKC'), salt, DIGEST_BYTES, {
    N: COST_N,
    r: BLOCK_SIZE_R,
    p: PARALLELISM_P,
    maxmem: MAX_MEMORY_BYTES,
  });

  return [
    SCHEME,
    COST_N,
    BLOCK_SIZE_R,
    PARALLELISM_P,
    salt.toString('base64'),
    digest.toString('base64'),
  ].join('$');
}

interface ParsedHash {
  readonly n: number;
  readonly r: number;
  readonly p: number;
  readonly salt: Buffer;
  readonly digest: Buffer;
}

function parse(stored: string): ParsedHash {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== SCHEME) {
    throw new PasswordFormatError('Stored password hash is not in the expected scrypt format');
  }

  const [, nRaw, rRaw, pRaw, saltRaw, digestRaw] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];

  const n = Number.parseInt(nRaw, 10);
  const r = Number.parseInt(rRaw, 10);
  const p = Number.parseInt(pRaw, 10);

  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) {
    throw new PasswordFormatError('Stored password hash has non-numeric scrypt parameters');
  }
  // A hash claiming absurd parameters would otherwise let a corrupted row exhaust memory on
  // every verification attempt.
  if (n < 1024 || n > 1_048_576 || r < 1 || r > 32 || p < 1 || p > 16) {
    throw new PasswordFormatError('Stored password hash has out-of-range scrypt parameters');
  }

  return {
    n,
    r,
    p,
    salt: Buffer.from(saltRaw, 'base64'),
    digest: Buffer.from(digestRaw, 'base64'),
  };
}

/**
 * Constant-time verification against a stored hash.
 *
 * Returns `false` for a malformed stored hash rather than throwing. A corrupted row is an
 * operational problem to find in the logs, not a reason to hand the caller a different failure
 * mode than a wrong password — the distinction is exactly what an attacker probes for.
 */
export async function verifyPassword(plaintext: string, stored: string): Promise<boolean> {
  let parsed: ParsedHash;
  try {
    parsed = parse(stored);
  } catch {
    return false;
  }

  const candidate = await scrypt(plaintext.normalize('NFKC'), parsed.salt, parsed.digest.length, {
    N: parsed.n,
    r: parsed.r,
    p: parsed.p,
    maxmem: MAX_MEMORY_BYTES,
  });

  return candidate.length === parsed.digest.length && timingSafeEqual(candidate, parsed.digest);
}

/**
 * True when `stored` was produced at a weaker work factor than the current one, so a successful
 * login can transparently re-hash at the new cost.
 */
export function needsRehash(stored: string): boolean {
  try {
    const parsed = parse(stored);
    return parsed.n < COST_N || parsed.r < BLOCK_SIZE_R || parsed.p < PARALLELISM_P;
  } catch {
    // Unparseable means it cannot be verified against either; replacing it is the only repair.
    return true;
  }
}
