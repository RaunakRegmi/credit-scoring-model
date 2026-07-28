/**
 * The document extraction boundary (§3.1, §3.2).
 *
 * Both adapters — LlamaParse and the built-in local parser — return exactly these shapes
 * plus a confidence score. Everything downstream (feature engineering, scoring) is written
 * against this port and has no idea which extractor produced the data, which is what makes
 * the vendor swappable and the pipeline testable without network access.
 */
import type { EducationLevel, EmployerType, ReferenceTier } from '@aics/contracts';

/* -------------------------------------------------------------------------- */
/* Resume (§3.1)                                                               */
/* -------------------------------------------------------------------------- */

export interface ExtractedEmployment {
  readonly employerName: string;
  readonly employerType: EmployerType;
  readonly title: string;
  /** Normalised 1 (entry) – 10 (C-suite); the regressand for career progression. */
  readonly seniorityRank: number;
  readonly startDate: Date;
  /** `null` for the current role. */
  readonly endDate: Date | null;
  readonly isCurrent: boolean;
  readonly salaryNpr: number | null;
  /** ISO 3166-1 alpha-2. */
  readonly country: string;
}

export interface ExtractedEducation {
  readonly level: EducationLevel;
  readonly institution: string | null;
  readonly country: string | null;
  readonly isAbroad: boolean;
  readonly graduationYear: number | null;
  readonly gpa: number | null;
}

export interface ExtractedReference {
  readonly name: string;
  readonly designation: string | null;
  readonly organisation: string | null;
  readonly tier: ReferenceTier;
  readonly relationship: string | null;
  readonly contact: string | null;
}

export interface ExtractedCertification {
  readonly name: string;
  readonly issuer: string | null;
  readonly isInternational: boolean;
  readonly issuedYear: number | null;
}

export interface ExtractedAward {
  readonly title: string;
  readonly scope: 'INTERNATIONAL' | 'NATIONAL' | 'COMPANY';
  readonly year: number | null;
}

export interface ResumeExtraction {
  readonly fullName: string | null;
  readonly fatherName: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly nationalId: string | null;
  readonly passportNumber: string | null;
  readonly currentAddress: string | null;
  readonly yearsAtAddress: number | null;

  readonly pastSalaryNpr: number | null;
  readonly expectedSalaryNpr: number | null;

  readonly employment: readonly ExtractedEmployment[];
  readonly education: ExtractedEducation;
  /** ISO alpha-2 codes. */
  readonly countriesTraveled: readonly string[];
  /** Schengen / US / UK style high-scrutiny visas (§4.4 "2x premium"). */
  readonly premiumVisas: readonly string[];
  readonly references: readonly ExtractedReference[];
  readonly certifications: readonly ExtractedCertification[];
  readonly awards: readonly ExtractedAward[];

  /** 0–1. Below the policy floor the application goes to manual review. */
  readonly confidence: number;
  /** Named fields the extractor could not find, surfaced to the applicant. */
  readonly missingFields: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Bank statement (§3.2)                                                       */
/* -------------------------------------------------------------------------- */

export interface ExtractedTransaction {
  readonly date: Date;
  readonly description: string;
  /** Exactly one of these is non-zero. */
  readonly debitNpr: number;
  readonly creditNpr: number;
  /** Running balance if the statement prints one. */
  readonly balanceAfterNpr: number | null;
}

export interface StatementExtraction {
  readonly bankName: string | null;
  readonly accountNumber: string | null;
  readonly accountType: string | null;
  readonly currency: string;
  readonly periodFrom: Date | null;
  readonly periodTo: Date | null;
  readonly openingBalanceNpr: number | null;
  readonly closingBalanceNpr: number | null;
  readonly transactions: readonly ExtractedTransaction[];
  readonly confidence: number;
  readonly missingFields: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Port                                                                        */
/* -------------------------------------------------------------------------- */

export interface RawDocument {
  readonly buffer: Buffer;
  readonly originalName: string;
  readonly mimeType: string;
}

export interface DocumentExtractor {
  /** Human-readable adapter name, recorded in the audit trail. */
  readonly name: string;
  extractResume(document: RawDocument): Promise<ResumeExtraction>;
  extractStatement(document: RawDocument): Promise<StatementExtraction>;
}

/** DI token for the selected extractor. */
export const DOCUMENT_EXTRACTOR = 'DOCUMENT_EXTRACTOR';

/**
 * Thrown when a document yields no usable text at all — an image-only scan handed to the
 * local parser, an encrypted PDF, a zero-byte upload. Distinct from low confidence: there
 * is nothing to score, so the caller must route to manual review rather than proceed.
 */
export class EmptyExtractionError extends Error {
  constructor(
    public readonly documentName: string,
    reason: string,
  ) {
    super(`No text could be extracted from "${documentName}": ${reason}`);
    this.name = 'EmptyExtractionError';
  }
}

/** An empty resume result, used when extraction fails but the pipeline must continue. */
export function emptyResumeExtraction(missing: readonly string[] = []): ResumeExtraction {
  return {
    fullName: null,
    fatherName: null,
    email: null,
    phone: null,
    nationalId: null,
    passportNumber: null,
    currentAddress: null,
    yearsAtAddress: null,
    pastSalaryNpr: null,
    expectedSalaryNpr: null,
    employment: [],
    education: {
      level: 'NONE',
      institution: null,
      country: null,
      isAbroad: false,
      graduationYear: null,
      gpa: null,
    },
    countriesTraveled: [],
    premiumVisas: [],
    references: [],
    certifications: [],
    awards: [],
    confidence: 0,
    missingFields: missing,
  };
}

export function emptyStatementExtraction(missing: readonly string[] = []): StatementExtraction {
  return {
    bankName: null,
    accountNumber: null,
    accountType: null,
    currency: 'NPR',
    periodFrom: null,
    periodTo: null,
    openingBalanceNpr: null,
    closingBalanceNpr: null,
    transactions: [],
    confidence: 0,
    missingFields: missing,
  };
}
