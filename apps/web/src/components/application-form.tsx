'use client';

import { useState } from 'react';
import { Loader2, Send } from 'lucide-react';
import {
  DOCUMENT_TYPES,
  KYC_SCORED_DOCUMENTS,
  PRODUCT_SPECS,
  PRODUCT_TYPES,
  RESIDENCE_STATUSES,
  type CreateApplicationInput,
  type DocumentType,
  type ProductType,
  type ResidenceStatus,
} from '@aics/contracts';

import { FileDropzone } from '@/components/file-dropzone';
import { cn, formatNpr, humanise } from '@/lib/utils';

/**
 * SOP-001 intake: product selection, applicant details, consent, and the two mandatory documents.
 *
 * Consent is three separate checkboxes rather than one. SOP-001 step 5 lists them individually,
 * and under the Individual Privacy Act 2075 a single bundled tick is not meaningful consent to
 * three distinct processing activities. The submit button stays disabled until all three are
 * given, because the API rejects the application otherwise — and it should.
 */

export interface SubmitPayload {
  readonly application: CreateApplicationInput;
  readonly resume: File;
  readonly statement: File;
  readonly kycDocuments: readonly DocumentType[];
  readonly residenceStatus: ResidenceStatus;
}

interface ApplicationFormProps {
  readonly onSubmit: (payload: SubmitPayload) => void;
  readonly isSubmitting: boolean;
}

const KYC_OPTIONS = DOCUMENT_TYPES.filter(
  (type) => KYC_SCORED_DOCUMENTS.includes(type) || type === 'NID_BACK',
);

export function ApplicationForm({
  onSubmit,
  isSubmitting,
}: ApplicationFormProps): React.ReactElement {
  const [productType, setProductType] = useState<ProductType>('HIRE_PURCHASE');
  const [requestedAmount, setRequestedAmount] = useState('2500000');
  const [tenureMonths, setTenureMonths] = useState('36');

  const [fullName, setFullName] = useState('');
  const [fatherName, setFatherName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [nationalId, setNationalId] = useState('');
  const [address, setAddress] = useState('');
  const [yearsAtAddress, setYearsAtAddress] = useState('');
  const [residenceStatus, setResidenceStatus] = useState<ResidenceStatus>('RENTED');

  const [kycDocuments, setKycDocuments] = useState<DocumentType[]>(['NID_FRONT', 'NID_BACK']);

  const [resume, setResume] = useState<File | null>(null);
  const [statement, setStatement] = useState<File | null>(null);

  const [consentData, setConsentData] = useState(false);
  const [consentBureau, setConsentBureau] = useState(false);
  const [consentAutomated, setConsentAutomated] = useState(false);

  const spec = PRODUCT_SPECS[productType];
  const amount = Number(requestedAmount);
  const tenure = Number(tenureMonths);

  const allConsentsGiven = consentData && consentBureau && consentAutomated;
  const detailsComplete =
    fullName.trim().length >= 2 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) &&
    phone.trim().length >= 7 &&
    nationalId.trim().length >= 4;
  const amountValid = Number.isFinite(amount) && amount > 0;
  const tenureValid =
    Number.isFinite(tenure) && tenure >= spec.minTenureMonths && tenure <= spec.maxTenureMonths;

  const canSubmit =
    detailsComplete &&
    amountValid &&
    tenureValid &&
    allConsentsGiven &&
    resume !== null &&
    statement !== null &&
    !isSubmitting;

  function handleSubmit(event: React.FormEvent): void {
    event.preventDefault();
    if (!canSubmit || resume === null || statement === null) {
      return;
    }

    onSubmit({
      application: {
        productType,
        requestedAmountNpr: amount,
        tenureMonths: tenure,
        applicant: {
          fullName: fullName.trim(),
          ...(fatherName.trim() === '' ? {} : { fatherName: fatherName.trim() }),
          email: email.trim().toLowerCase(),
          phone: phone.trim(),
          nationalId: nationalId.trim(),
          nationality: 'NP',
          ...(address.trim() === '' ? {} : { currentAddress: address.trim() }),
          ...(yearsAtAddress.trim() === ''
            ? {}
            : { yearsAtAddress: Number(yearsAtAddress) }),
        },
        consent: {
          dataProcessing: true,
          creditBureauPull: true,
          automatedAssessment: true,
        },
      },
      resume,
      statement,
      kycDocuments,
      residenceStatus,
    });
  }

  function toggleKyc(type: DocumentType): void {
    setKycDocuments((current) =>
      current.includes(type) ? current.filter((entry) => entry !== type) : [...current, type],
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6">
      {/* Product */}
      <fieldset className="card px-5 py-4" disabled={isSubmitting}>
        <legend className="px-1 text-sm font-semibold text-[var(--color-ink)]">
          Product and amount
        </legend>

        <div className="mt-3 grid gap-4 sm:grid-cols-3">
          <Field label="Product">
            <select
              value={productType}
              onChange={(event) => {
                const next = event.target.value as ProductType;
                setProductType(next);
                // Snap the tenure into the newly selected product's published range.
                const nextSpec = PRODUCT_SPECS[next];
                const current = Number(tenureMonths);
                if (!Number.isFinite(current) || current < nextSpec.minTenureMonths) {
                  setTenureMonths(String(nextSpec.minTenureMonths));
                } else if (current > nextSpec.maxTenureMonths) {
                  setTenureMonths(String(nextSpec.maxTenureMonths));
                }
              }}
              className={inputClass}
            >
              {PRODUCT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {PRODUCT_SPECS[type].label}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Requested amount (NPR)"
            hint={`Product ceiling ${formatNpr(spec.maxLimitNpr, { compact: true })}`}
            error={requestedAmount !== '' && !amountValid ? 'Enter a positive amount.' : undefined}
          >
            <input
              type="number"
              inputMode="numeric"
              min={1}
              value={requestedAmount}
              onChange={(event) => setRequestedAmount(event.target.value)}
              className={cn(inputClass, 'numeric')}
            />
          </Field>

          <Field
            label="Tenure (months)"
            hint={`${spec.minTenureMonths}–${spec.maxTenureMonths} months`}
            error={
              tenureMonths !== '' && !tenureValid
                ? `Must be between ${spec.minTenureMonths} and ${spec.maxTenureMonths}.`
                : undefined
            }
          >
            <input
              type="number"
              inputMode="numeric"
              min={spec.minTenureMonths}
              max={spec.maxTenureMonths}
              value={tenureMonths}
              onChange={(event) => setTenureMonths(event.target.value)}
              className={cn(inputClass, 'numeric')}
            />
          </Field>
        </div>
      </fieldset>

      {/* Applicant */}
      <fieldset className="card px-5 py-4" disabled={isSubmitting}>
        <legend className="px-1 text-sm font-semibold text-[var(--color-ink)]">
          Applicant details
        </legend>

        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <Field label="Full name" required>
            <input
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              autoComplete="name"
              className={inputClass}
            />
          </Field>

          <Field label="Father's name">
            <input
              value={fatherName}
              onChange={(event) => setFatherName(event.target.value)}
              className={inputClass}
            />
          </Field>

          <Field label="Email" required>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              className={inputClass}
            />
          </Field>

          <Field label="Phone" required>
            <input
              type="tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              autoComplete="tel"
              placeholder="98XXXXXXXX"
              className={inputClass}
            />
          </Field>

          <Field
            label="Citizenship / NID number"
            required
            hint="Encrypted at rest; never stored in plain text (§10.1)"
          >
            <input
              value={nationalId}
              onChange={(event) => setNationalId(event.target.value)}
              className={inputClass}
            />
          </Field>

          <Field label="Residence status">
            <select
              value={residenceStatus}
              onChange={(event) => setResidenceStatus(event.target.value as ResidenceStatus)}
              className={inputClass}
            >
              {RESIDENCE_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {humanise(status)}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Current address">
            <input
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              autoComplete="street-address"
              className={inputClass}
            />
          </Field>

          <Field label="Years at this address">
            <input
              type="number"
              inputMode="decimal"
              min={0}
              step="0.5"
              value={yearsAtAddress}
              onChange={(event) => setYearsAtAddress(event.target.value)}
              className={cn(inputClass, 'numeric')}
            />
          </Field>
        </div>
      </fieldset>

      {/* Documents */}
      <fieldset className="card px-5 py-4" disabled={isSubmitting}>
        <legend className="px-1 text-sm font-semibold text-[var(--color-ink)]">
          Documents
        </legend>

        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <FileDropzone
            label="Resume / CV"
            hint="PDF, DOCX or TXT · max 10 MB"
            accept={['.pdf', '.docx', '.txt']}
            file={resume}
            onChange={setResume}
            disabled={isSubmitting}
          />
          <FileDropzone
            label="Bank statement — minimum 6 months"
            hint="PDF or CSV · max 10 MB"
            accept={['.pdf', '.csv', '.txt']}
            file={statement}
            onChange={setStatement}
            disabled={isSubmitting}
          />
        </div>

        <div className="mt-4">
          <p className="text-sm font-medium text-[var(--color-ink)]">
            KYC documents on file
            <span className="ml-1.5 text-xs font-normal text-[var(--color-ink-subtle)]">
              affects the identity completeness score (§4.4)
            </span>
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {KYC_OPTIONS.map((type) => {
              const selected = kycDocuments.includes(type);
              return (
                <button
                  key={type}
                  type="button"
                  onClick={() => toggleKyc(type)}
                  aria-pressed={selected}
                  className={cn(
                    'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                    selected
                      ? 'border-[var(--color-brand)] bg-[var(--color-brand-soft)] text-[var(--color-brand)]'
                      : 'border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-muted)]',
                  )}
                >
                  {humanise(type)}
                </button>
              );
            })}
          </div>
        </div>
      </fieldset>

      {/* Consent — SOP-001 step 5 */}
      <fieldset className="card px-5 py-4" disabled={isSubmitting}>
        <legend className="px-1 text-sm font-semibold text-[var(--color-ink)]">
          Consent
        </legend>
        <p className="mt-2 text-xs text-[var(--color-ink-muted)]">
          Recorded individually and timestamped. All three are required before an assessment can
          run (SOP-001 step 5).
        </p>

        <div className="mt-3 flex flex-col gap-2.5">
          <Consent
            checked={consentData}
            onChange={setConsentData}
            label="I consent to my personal and financial data being processed for this application."
          />
          <Consent
            checked={consentBureau}
            onChange={setConsentBureau}
            label="I consent to a credit bureau enquiry being made."
          />
          <Consent
            checked={consentAutomated}
            onChange={setConsentAutomated}
            label="I consent to an automated, AI-assisted assessment, and understand I may request human review within 14 days."
          />
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={!canSubmit}
          className={cn(
            'inline-flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-semibold text-white transition-colors',
            canSubmit
              ? 'bg-[var(--color-brand)] hover:opacity-90'
              : 'cursor-not-allowed bg-[var(--color-ink-subtle)]',
          )}
        >
          {isSubmitting ? (
            <>
              <Loader2 size={16} className="animate-spin" aria-hidden />
              Assessing…
            </>
          ) : (
            <>
              <Send size={16} aria-hidden />
              Run credit assessment
            </>
          )}
        </button>

        {!canSubmit && !isSubmitting && (
          <p className="text-xs text-[var(--color-ink-subtle)]">
            {!detailsComplete
              ? 'Complete the required applicant details.'
              : !amountValid || !tenureValid
                ? 'Check the requested amount and tenure.'
                : resume === null || statement === null
                  ? 'Upload both a resume and a bank statement.'
                  : 'All three consents are required.'}
          </p>
        )}
      </div>
    </form>
  );
}

const inputClass =
  'w-full rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-ink)] outline-none transition-colors focus:border-[var(--color-brand)] disabled:opacity-60';

function Field({
  label,
  children,
  hint,
  error,
  required = false,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
  readonly hint?: string;
  readonly error?: string;
  readonly required?: boolean;
}): React.ReactElement {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-[var(--color-ink-muted)]">
        {label}
        {required && <span className="ml-0.5 text-[var(--color-negative)]">*</span>}
      </span>
      {children}
      {error !== undefined ? (
        <span className="text-xs font-medium text-[var(--color-negative)]">{error}</span>
      ) : hint !== undefined ? (
        <span className="text-xs text-[var(--color-ink-subtle)]">{hint}</span>
      ) : null}
    </label>
  );
}

function Consent({
  checked,
  onChange,
  label,
}: {
  readonly checked: boolean;
  readonly onChange: (value: boolean) => void;
  readonly label: string;
}): React.ReactElement {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-brand)]"
      />
      <span className="text-sm text-[var(--color-ink-muted)]">{label}</span>
    </label>
  );
}
