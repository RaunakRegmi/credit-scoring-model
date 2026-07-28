/**
 * Field-level cryptography for personally identifiable data (§10.1).
 *
 * Two distinct operations, deliberately not the same primitive:
 *
 *   · `encryptField` / `decryptField` — AES-256-GCM. Randomised, so the same NID
 *     encrypts differently every time. Authenticated, so tampering is detected rather
 *     than silently decrypting to garbage. This is what protects the data at rest.
 *
 *   · `hashField` — HMAC-SHA256 with a separate key. Deterministic, so it can carry a
 *     unique index and answer "have we seen this national ID before" without a plaintext
 *     column and without decrypting every row. Keyed rather than a bare SHA-256 because
 *     national ID number spaces are small enough to enumerate offline.
 *
 * The two keys are separate on purpose: the lookup key is used in far more places, and
 * compromising it must not also decrypt the data.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96-bit nonce, the GCM standard.
const AUTH_TAG_BYTES = 16;

/** Version prefix, so a future key rotation or algorithm change stays decryptable. */
const ENVELOPE_VERSION = 'v1';

export class CryptoConfigError extends Error {}
export class DecryptionError extends Error {}

function parseKey(hex: string, label: string): Buffer {
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new CryptoConfigError(`${label} must be hex encoded`);
  }
  const key = Buffer.from(hex, 'hex');
  if (key.length !== KEY_BYTES) {
    throw new CryptoConfigError(
      `${label} must be ${KEY_BYTES} bytes (${KEY_BYTES * 2} hex chars); got ${key.length}. ` +
        'Generate one with: openssl rand -hex 32',
    );
  }
  return key;
}

/**
 * Rejects the all-zero placeholder shipped in `.env.example`. An encryption key that
 * everyone with the repository already knows is not an encryption key, and this is the
 * kind of thing that reaches production precisely because nothing complains.
 */
function assertNotPlaceholder(key: Buffer, label: string): void {
  if (key.every((byte) => byte === 0) || key.every((byte) => byte === key[0])) {
    throw new CryptoConfigError(
      `${label} is a placeholder value. Generate a real key with: openssl rand -hex 32`,
    );
  }
}

export class FieldCrypto {
  private readonly encryptionKey: Buffer;
  private readonly hashKey: Buffer;

  constructor(encryptionKeyHex: string, hashKeyHex: string) {
    this.encryptionKey = parseKey(encryptionKeyHex, 'FIELD_ENCRYPTION_KEY');
    this.hashKey = parseKey(hashKeyHex, 'FIELD_HASH_KEY');

    assertNotPlaceholder(this.encryptionKey, 'FIELD_ENCRYPTION_KEY');
    assertNotPlaceholder(this.hashKey, 'FIELD_HASH_KEY');

    if (this.encryptionKey.equals(this.hashKey)) {
      throw new CryptoConfigError(
        'FIELD_ENCRYPTION_KEY and FIELD_HASH_KEY must differ — reusing one key for both ' +
          'encryption and lookup hashing means a leaked lookup key also decrypts the data.',
      );
    }
  }

  /**
   * Encrypts a plaintext field.
   *
   * Envelope: `v1:<iv>:<authTag>:<ciphertext>`, all base64. Self-describing so
   * `decryptField` needs no out-of-band metadata.
   */
  encryptField(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return [
      ENVELOPE_VERSION,
      iv.toString('base64'),
      authTag.toString('base64'),
      ciphertext.toString('base64'),
    ].join(':');
  }

  /** Decrypts an envelope produced by `encryptField`. Throws if it has been tampered with. */
  decryptField(envelope: string): string {
    const parts = envelope.split(':');
    if (parts.length !== 4) {
      throw new DecryptionError('Malformed ciphertext envelope');
    }

    const [version, ivB64, authTagB64, ciphertextB64] = parts as [string, string, string, string];
    if (version !== ENVELOPE_VERSION) {
      throw new DecryptionError(`Unsupported ciphertext version "${version}"`);
    }

    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(authTagB64, 'base64');
    if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
      throw new DecryptionError('Ciphertext envelope has invalid IV or auth tag length');
    }

    try {
      const decipher = createDecipheriv(ALGORITHM, this.encryptionKey, iv);
      decipher.setAuthTag(authTag);
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertextB64, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch (cause) {
      // Deliberately opaque: a caller (or an attacker probing) learns only that it failed.
      throw new DecryptionError(
        'Failed to decrypt field — wrong key or the ciphertext has been altered',
      );
    }
  }

  /**
   * Deterministic keyed hash for equality lookups and uniqueness constraints.
   *
   * Input is normalised (trimmed, uppercased, internal whitespace and separators
   * removed) so `12-345-678` and `12345678` collapse to the same subject. Without that,
   * the duplicate-applicant check misses trivially reformatted IDs.
   */
  hashField(value: string): string {
    const normalised = value.trim().toUpperCase().replace(/[\s\-/]/g, '');
    return createHmac('sha256', this.hashKey).update(normalised, 'utf8').digest('hex');
  }

  /** Constant-time comparison of two lookup hashes. */
  hashesMatch(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'hex');
    const bufB = Buffer.from(b, 'hex');
    return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
  }
}

/**
 * Masks an account number down to its last four digits, for display.
 * The full number lives only in the encrypted column.
 */
export function maskAccountNumber(accountNumber: string): string {
  const digits = accountNumber.replace(/\D/g, '');
  if (digits.length <= 4) {
    return '*'.repeat(Math.max(0, digits.length));
  }
  return `${'*'.repeat(Math.min(8, digits.length - 4))}${digits.slice(-4)}`;
}
