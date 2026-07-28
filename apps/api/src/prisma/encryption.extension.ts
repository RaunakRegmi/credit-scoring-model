/**
 * Field-level encryption for PII columns (§10.1).
 *
 * Design note — why decryption is transparent but encryption is not.
 *
 * A fully transparent extension that encrypts on write and decrypts on read looks
 * appealing and behaves badly. AES-GCM is randomised, so an encrypted column cannot
 * appear in a `where`, an `orderBy`, a `groupBy`, a unique constraint or a raw query —
 * and an extension that silently encrypts `where` clauses produces queries that match
 * nothing, which is a data-integrity bug that reads like a missing record. That is
 * precisely why the schema carries a deterministic `*Hash` column alongside each
 * encrypted field: lookups use the hash, never the ciphertext.
 *
 * So the split is deliberate:
 *
 *   READ  — transparent, via lazy computed fields added here. `applicant.nid()` decrypts
 *           on call. Nothing is decrypted unless someone asks for it, so a list query
 *           over ten thousand applicants performs zero crypto.
 *
 *   WRITE — explicit, via `PiiCodec` below. Every site that persists PII names the fact
 *           that it is doing so. In an audited system, "where does the national ID get
 *           written" should be answerable with grep.
 */
import { Prisma } from '../../prisma/generated/prisma/client';

import type { FieldCrypto } from '../common/crypto.util';
import { maskAccountNumber } from '../common/crypto.util';

/**
 * Wraps a decryption in a lazy thunk that never throws at the call site of the query.
 *
 * If a row cannot be decrypted — a rotated key, a corrupted value — we return `null`
 * rather than exploding a list endpoint. The caller decides whether a missing NID is
 * fatal for what it is doing; a KYC check must fail, a summary listing need not.
 */
function lazyDecrypt(
  crypto: FieldCrypto,
  ciphertext: string | null,
): () => string | null {
  return () => {
    if (ciphertext === null || ciphertext === '') {
      return null;
    }
    try {
      return crypto.decryptField(ciphertext);
    } catch {
      return null;
    }
  };
}

/**
 * Builds the Prisma client extension. Call as `client.$extends(encryptionExtension(crypto))`.
 */
export function encryptionExtension(crypto: FieldCrypto) {
  return Prisma.defineExtension({
    name: 'aics-field-encryption',
    result: {
      applicant: {
        /** Decrypted national ID / citizenship number. Call to resolve. */
        nid: {
          needs: { nidEnc: true },
          compute(applicant: { nidEnc: string }) {
            return lazyDecrypt(crypto, applicant.nidEnc);
          },
        },
        passport: {
          needs: { passportEnc: true },
          compute(applicant: { passportEnc: string | null }) {
            return lazyDecrypt(crypto, applicant.passportEnc);
          },
        },
        pan: {
          needs: { panEnc: true },
          compute(applicant: { panEnc: string | null }) {
            return lazyDecrypt(crypto, applicant.panEnc);
          },
        },
      },
      bankAccount: {
        accountNumber: {
          needs: { accountNumberEnc: true },
          compute(account: { accountNumberEnc: string }) {
            return lazyDecrypt(crypto, account.accountNumberEnc);
          },
        },
      },
      professionalReference: {
        contact: {
          needs: { contactEnc: true },
          compute(reference: { contactEnc: string | null }) {
            return lazyDecrypt(crypto, reference.contactEnc);
          },
        },
      },
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Explicit write-side encoding                                                */
/* -------------------------------------------------------------------------- */

export interface EncodedNid {
  readonly nidEnc: string;
  readonly nidHash: string;
}

export interface EncodedAccountNumber {
  readonly accountNumberEnc: string;
  readonly accountNumberHash: string;
  readonly accountNumberMasked: string;
}

/**
 * Turns plaintext PII into the column set the schema expects.
 *
 * Every method returns the complete group of columns for a field — ciphertext plus its
 * lookup hash plus any masked display value — so it is impossible to write the ciphertext
 * and forget the hash, which would silently disable duplicate detection.
 */
export class PiiCodec {
  constructor(private readonly crypto: FieldCrypto) {}

  /** National ID / citizenship number: encrypted for storage, hashed for dedupe. */
  encodeNid(nid: string): EncodedNid {
    const trimmed = nid.trim();
    if (trimmed === '') {
      throw new Error('National ID cannot be empty — it is the applicant identity key');
    }
    return {
      nidEnc: this.crypto.encryptField(trimmed),
      nidHash: this.crypto.hashField(trimmed),
    };
  }

  /** Optional single-value PII (passport, PAN, reference contact). */
  encodeOptional(value: string | null | undefined): string | null {
    const trimmed = value?.trim();
    if (trimmed === undefined || trimmed === '') {
      return null;
    }
    return this.crypto.encryptField(trimmed);
  }

  encodeAccountNumber(accountNumber: string): EncodedAccountNumber {
    const trimmed = accountNumber.trim();
    if (trimmed === '') {
      throw new Error('Account number cannot be empty');
    }
    return {
      accountNumberEnc: this.crypto.encryptField(trimmed),
      accountNumberHash: this.crypto.hashField(trimmed),
      accountNumberMasked: maskAccountNumber(trimmed),
    };
  }

  /** Lookup hash for a `where` clause. The only way to query an encrypted field. */
  lookupHash(value: string): string {
    return this.crypto.hashField(value);
  }
}
