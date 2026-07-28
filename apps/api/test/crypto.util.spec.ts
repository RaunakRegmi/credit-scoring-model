/**
 * Field-level encryption (§10.1).
 *
 * The important properties: ciphertext is randomised so it leaks nothing, tampering is
 * detected rather than silently decrypting to garbage, and the lookup hash is deterministic
 * and normalising so a reformatted national ID still matches.
 */
import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  CryptoConfigError,
  DecryptionError,
  FieldCrypto,
  maskAccountNumber,
} from '../src/common/crypto.util';

const KEY_A = randomBytes(32).toString('hex');
const KEY_B = randomBytes(32).toString('hex');

const crypto = new FieldCrypto(KEY_A, KEY_B);

describe('key validation', () => {
  it('rejects a key of the wrong length', () => {
    expect(() => new FieldCrypto('abcd', KEY_B)).toThrow(CryptoConfigError);
  });

  it('rejects a non-hex key', () => {
    expect(() => new FieldCrypto('z'.repeat(64), KEY_B)).toThrow(CryptoConfigError);
  });

  it('rejects the all-zero placeholder from .env.example', () => {
    expect(() => new FieldCrypto('0'.repeat(64), KEY_B)).toThrow(/placeholder/i);
  });

  it('rejects a key of uniform bytes', () => {
    expect(() => new FieldCrypto('ab'.repeat(32), KEY_B)).toThrow(/placeholder/i);
  });

  it('refuses to reuse one key for both encryption and lookup hashing', () => {
    expect(() => new FieldCrypto(KEY_A, KEY_A)).toThrow(/must differ/i);
  });
});

describe('encryptField / decryptField', () => {
  it('round-trips a value', () => {
    const nid = '27-01-75-04821';
    expect(crypto.decryptField(crypto.encryptField(nid))).toBe(nid);
  });

  it('round-trips unicode and long values', () => {
    const value = 'राजेश श्रेष्ठ — 身份证 — '.repeat(20);
    expect(crypto.decryptField(crypto.encryptField(value))).toBe(value);
  });

  it('round-trips an empty string', () => {
    expect(crypto.decryptField(crypto.encryptField(''))).toBe('');
  });

  it('produces different ciphertext each time for the same plaintext', () => {
    // Randomised encryption: an observer must not be able to tell that two rows hold the same
    // national ID. This is exactly why the schema carries a separate deterministic hash column.
    const first = crypto.encryptField('27-01-75-04821');
    const second = crypto.encryptField('27-01-75-04821');
    expect(first).not.toBe(second);
    expect(crypto.decryptField(first)).toBe(crypto.decryptField(second));
  });

  it('emits a self-describing versioned envelope', () => {
    const envelope = crypto.encryptField('secret');
    expect(envelope.startsWith('v1:')).toBe(true);
    expect(envelope.split(':')).toHaveLength(4);
  });

  it('detects a tampered ciphertext instead of returning garbage', () => {
    const envelope = crypto.encryptField('27-01-75-04821');
    const parts = envelope.split(':');
    // Flip the ciphertext while leaving the auth tag alone.
    const corrupted = Buffer.from(parts[3] as string, 'base64');
    corrupted[0] = (corrupted[0] ?? 0) ^ 0xff;
    parts[3] = corrupted.toString('base64');

    expect(() => crypto.decryptField(parts.join(':'))).toThrow(DecryptionError);
  });

  it('rejects a malformed envelope', () => {
    expect(() => crypto.decryptField('not-an-envelope')).toThrow(DecryptionError);
    expect(() => crypto.decryptField('v1:a:b')).toThrow(DecryptionError);
  });

  it('rejects an unknown envelope version', () => {
    const envelope = crypto.encryptField('x').replace(/^v1:/, 'v2:');
    expect(() => crypto.decryptField(envelope)).toThrow(/version/i);
  });

  it('cannot decrypt with a different key', () => {
    const other = new FieldCrypto(randomBytes(32).toString('hex'), KEY_B);
    const envelope = crypto.encryptField('27-01-75-04821');
    expect(() => other.decryptField(envelope)).toThrow(DecryptionError);
  });

  it('does not leak the plaintext or the key in the error message', () => {
    const other = new FieldCrypto(randomBytes(32).toString('hex'), KEY_B);
    const envelope = crypto.encryptField('27-01-75-04821');
    try {
      other.decryptField(envelope);
      expect.unreachable('expected a DecryptionError');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain('27-01-75-04821');
      expect(message).not.toContain(KEY_A);
    }
  });
});

describe('hashField', () => {
  it('is deterministic', () => {
    expect(crypto.hashField('27-01-75-04821')).toBe(crypto.hashField('27-01-75-04821'));
  });

  it('normalises formatting so a reformatted ID still matches', () => {
    // Without this, a returning applicant who types their citizenship number differently
    // becomes a second applicant and the duplicate check silently fails.
    const canonical = crypto.hashField('27-01-75-04821');
    expect(crypto.hashField('27 01 75 04821')).toBe(canonical);
    expect(crypto.hashField('270175 04821')).toBe(canonical);
    expect(crypto.hashField('  27-01-75-04821  ')).toBe(canonical);
    expect(crypto.hashField('27/01/75/04821')).toBe(canonical);
  });

  it('is case-insensitive', () => {
    expect(crypto.hashField('pa1234567')).toBe(crypto.hashField('PA1234567'));
  });

  it('distinguishes genuinely different values', () => {
    expect(crypto.hashField('27-01-75-04821')).not.toBe(crypto.hashField('27-01-75-04822'));
  });

  it('is keyed — a different hash key gives a different digest', () => {
    const other = new FieldCrypto(KEY_A, randomBytes(32).toString('hex'));
    expect(other.hashField('27-01-75-04821')).not.toBe(crypto.hashField('27-01-75-04821'));
  });

  it('produces a 64-character hex digest that fits the CHAR(64) column', () => {
    expect(crypto.hashField('27-01-75-04821')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('compares hashes in constant time', () => {
    const hash = crypto.hashField('27-01-75-04821');
    expect(crypto.hashesMatch(hash, hash)).toBe(true);
    expect(crypto.hashesMatch(hash, crypto.hashField('other'))).toBe(false);
    expect(crypto.hashesMatch(hash, 'abcd')).toBe(false);
  });
});

describe('maskAccountNumber', () => {
  it('reveals only the last four digits', () => {
    expect(maskAccountNumber('01234567890123')).toBe('********0123');
    expect(maskAccountNumber('1234-5678-9012')).toBe('********9012');
  });

  it('handles short inputs without revealing them', () => {
    expect(maskAccountNumber('123')).toBe('***');
    expect(maskAccountNumber('')).toBe('');
  });

  it('never returns more than four consecutive real digits', () => {
    const masked = maskAccountNumber('987654321098765');
    expect(masked).toBe('********8765');
    expect(masked).not.toContain('9876543');
  });
});
