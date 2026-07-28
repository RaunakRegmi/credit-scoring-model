/**
 * Password hashing.
 *
 * The properties worth pinning are the ones whose absence is invisible: a hash that verifies
 * against anything, a salt that is not actually random, a stored format that silently loses its
 * work factor. None of these produce an error at runtime — they produce a system that appears to
 * authenticate correctly while being trivially attackable offline.
 */
import { describe, expect, it } from 'vitest';

import { hashPassword, needsRehash, verifyPassword } from '../src/auth/password.util';

const PASSWORD = 'correct horse battery staple';

describe('password hashing', () => {
  it('verifies a correct password', async () => {
    const stored = await hashPassword(PASSWORD);
    await expect(verifyPassword(PASSWORD, stored)).resolves.toBe(true);
  });

  it('rejects a wrong password, including near misses', async () => {
    const stored = await hashPassword(PASSWORD);

    for (const wrong of [
      'Correct horse battery staple', // case
      'correct horse battery stapl', // truncated
      'correct  horse battery staple', // extra space
      '',
    ]) {
      await expect(verifyPassword(wrong, stored)).resolves.toBe(false);
    }
  });

  it('salts, so the same password hashes differently every time', async () => {
    const [a, b] = await Promise.all([hashPassword(PASSWORD), hashPassword(PASSWORD)]);

    expect(a).not.toBe(b);
    // Both still verify — different salt, same password.
    await expect(verifyPassword(PASSWORD, a)).resolves.toBe(true);
    await expect(verifyPassword(PASSWORD, b)).resolves.toBe(true);
  });

  it('stores the work factor in the hash, so it can be raised without a migration', async () => {
    const stored = await hashPassword(PASSWORD);
    const [scheme, n, r, p, salt, digest] = stored.split('$');

    expect(scheme).toBe('scrypt');
    expect(Number(n)).toBeGreaterThanOrEqual(65_536);
    expect(Number(r)).toBeGreaterThanOrEqual(8);
    expect(Number(p)).toBeGreaterThanOrEqual(1);
    // 16-byte salt and 32-byte digest, base64.
    expect(Buffer.from(salt ?? '', 'base64')).toHaveLength(16);
    expect(Buffer.from(digest ?? '', 'base64')).toHaveLength(32);
  });

  it('normalises unicode, so the same typed password verifies across input methods', async () => {
    // Written as escapes on purpose: these two strings are visually identical, so a reader has
    // no way to tell them apart if they are spelled literally.
    //   U+00E9         — \u00e9, one precomposed code point (most keyboards and input methods)
    //   U+0065 U+0301  — e followed by a combining acute (macOS file names, some Android IMs)
    const composed = 'caf\u00e9-pass-2026';
    const decomposed = 'cafe\u0301-pass-2026';
    expect(composed).not.toBe(decomposed);

    const stored = await hashPassword(composed);
    await expect(verifyPassword(decomposed, stored)).resolves.toBe(true);
  });

  /* ---------------------------------------------------------------------- */
  /* Malformed stored hashes                                                */
  /* ---------------------------------------------------------------------- */

  it('returns false rather than throwing on a malformed stored hash', async () => {
    for (const malformed of [
      '',
      'not-a-hash',
      'scrypt$65536$8$2$onlyfourparts',
      'bcrypt$65536$8$2$c2FsdA==$ZGlnZXN0',
      'scrypt$abc$8$2$c2FsdA==$ZGlnZXN0',
    ]) {
      await expect(verifyPassword(PASSWORD, malformed)).resolves.toBe(false);
    }
  });

  it('refuses absurd stored parameters instead of trying to honour them', async () => {
    // A corrupted row claiming N=2^30 would otherwise allocate gigabytes on every attempt,
    // turning one bad record into a denial of service on the login endpoint.
    await expect(
      verifyPassword(PASSWORD, 'scrypt$1073741824$8$2$c2FsdA==$ZGlnZXN0'),
    ).resolves.toBe(false);
  });

  /* ---------------------------------------------------------------------- */
  /* Rehash detection                                                       */
  /* ---------------------------------------------------------------------- */

  it('does not ask to rehash a current hash', async () => {
    expect(needsRehash(await hashPassword(PASSWORD))).toBe(false);
  });

  it('asks to rehash a weaker or unreadable hash', () => {
    expect(needsRehash('scrypt$16384$8$1$c2FsdA==$ZGlnZXN0')).toBe(true);
    expect(needsRehash('garbage')).toBe(true);
  });
});
