#!/usr/bin/env bash
#
# Exports everything captured from uploaded documents into a folder you can open, analyse or hand to
# a data scientist.
#
# Nothing here collects new data. The API already persists every upload and everything derived from
# it; the raw files just live in the `api-storage` Docker volume rather than in the project
# directory, which makes them easy to miss. This pulls all of it onto the host.
#
#   ./scripts/export-data.sh [OUTDIR]        default: ./export/<UTC timestamp>
#
# Requires the stack to be running (`docker compose up -d`).

set -euo pipefail

cd "$(dirname "$0")/.."

OUT="${1:-export/$(date -u '+%Y%m%dT%H%M%SZ')}"
PSQL=(docker compose exec -T postgres psql -U "${POSTGRES_USER:-aics}" -d "${POSTGRES_DB:-aics}")

if ! docker compose ps --status running --services 2>/dev/null | grep -qx postgres; then
  echo "postgres is not running — start the stack first: docker compose up -d" >&2
  exit 1
fi

mkdir -p "$OUT/documents"
echo "exporting to $OUT"

# ---------------------------------------------------------------------------
# 1. One row per application: applicant, CV-derived, statement-derived, outcome.
#    The wide human-readable view — open it in Excel or Sheets.
# ---------------------------------------------------------------------------
"${PSQL[@]}" --csv -c "
select
  la.arn, la.\"productType\", la.status,
  la.\"requestedAmountNpr\", la.\"tenureMonths\", la.\"createdAt\",

  ap.\"fullName\", ap.email, ap.phone, ap.nationality,
  ap.\"residenceStatus\", ap.\"nidVerificationStatus\", ap.\"amlWatchlistHit\", ap.\"isPep\",

  rp.\"highestEducation\", rp.institution, rp.\"graduationYear\", rp.gpa,
  rp.\"isEducationAbroad\", rp.\"totalExperienceYears\", rp.\"jobChangesCount\",
  rp.\"pastSalaryNpr\", rp.\"salaryGrowthRate\", rp.\"careerProgressionSlope\",
  rp.\"extractionConfidence\" as resume_confidence,
  array_to_string(rp.\"missingFields\", '|') as resume_missing_fields,

  fa.\"avgBalance6mNpr\", fa.\"avgMonthlyIncomeNpr\", fa.\"debtServiceRatio\",
  fa.\"savingsRate\", fa.\"salaryConsistencyMonths\", fa.\"bounceCount6m\",
  fa.\"cashBufferMonths\", fa.\"incomeStreamCount\", fa.\"discretionaryRatio\",

  cso.\"financialScore\", cso.\"professionalScore\", cso.\"socialScore\",
  cso.\"behavioralScore\", cso.\"compositeScore\", cso.\"riskBand\", cso.decision,
  cso.\"pdProbability\", cso.\"mlPDefaultShadow\", cso.\"approvedLimitNpr\",
  cso.\"monthlyInterestRate\", cso.degraded,
  array_to_string(cso.\"degradedFlags\", '|') as degraded_flags,
  array_to_string(cso.\"overrideCodes\"::text[], '|') as override_codes,
  cso.\"scorecardVersion\", cso.\"featureSetVersion\", cso.\"mlModelVersion\", cso.\"mlProvenance\"
from loan_application la
join applicant_profile ap on ap.id = la.\"applicantId\"
left join resume_profile rp on rp.\"applicationId\" = la.id
left join financial_analytics fa on fa.\"applicationId\" = la.id
left join credit_score_output cso on cso.\"applicationId\" = la.id
order by la.\"createdAt\";
" > "$OUT/applications.csv"

# ---------------------------------------------------------------------------
# 2. The model-ready matrix: the full feature vector per application, plus the
#    outcome columns. One JSON object per line.
#      pandas.read_json('features.jsonl', lines=True)
# ---------------------------------------------------------------------------
"${PSQL[@]}" -t -A -c "
select jsonb_build_object(
         'arn', la.arn,
         'applicationId', la.id,
         'productType', la.\"productType\",
         'requestedAmountNpr', la.\"requestedAmountNpr\",
         'tenureMonths', la.\"tenureMonths\",
         'scoredAt', cso.\"scoredAt\",
         'featureSetVersion', fa.\"featureSetVersion\",
         'compositeScore', cso.\"compositeScore\",
         'riskBand', cso.\"riskBand\",
         'decision', cso.decision,
         'pdProbability', cso.\"pdProbability\",
         'mlPDefaultShadow', cso.\"mlPDefaultShadow\",
         'degraded', cso.degraded
       ) || fa.features
from loan_application la
join financial_analytics fa on fa.\"applicationId\" = la.id
join credit_score_output cso on cso.\"applicationId\" = la.id
order by la.\"createdAt\";
" > "$OUT/features.jsonl"

# ---------------------------------------------------------------------------
# 3. Document manifest, including the filename each blob is exported as.
# ---------------------------------------------------------------------------
"${PSQL[@]}" --csv -c "
select
  la.arn, d.type, d.\"originalName\", d.\"mimeType\", d.\"sizeBytes\", d.sha256,
  d.\"storageKey\", d.\"extractionStatus\", d.\"extractionConfidence\",
  d.\"rawJson\"::text as raw_extraction, d.\"createdAt\", d.\"purgeAfter\",
  la.arn || '__' || d.type || '__' || substring(d.sha256, 1, 8) || '__' || d.\"originalName\"
    as exported_as
from document d
join loan_application la on la.id = d.\"applicationId\"
order by d.\"createdAt\";
" > "$OUT/documents.csv"

# ---------------------------------------------------------------------------
# 4. The raw uploaded files themselves, renamed so a human can navigate them.
#    Blobs are content-addressed (<applicationId>/<sha256>.bin), so the stored
#    name carries no hint of what the file is.
# ---------------------------------------------------------------------------
TMP="$OUT/.blobs"
rm -rf "$TMP"
docker compose cp api:/data/storage "$TMP" >/dev/null

# A dedicated two-column, tab-separated manifest rather than re-parsing documents.csv: that CSV
# carries the raw extraction JSON, which contains commas and quotes and defeats naive splitting.
# `originalName` is reduced to filesystem-safe characters here — it is the one value in the row
# that came from a user, and it is about to become a path.
"${PSQL[@]}" -t -A -F $'\t' -c "
select
  d.\"storageKey\",
  la.arn || '__' || d.type || '__' || substring(d.sha256, 1, 8) || '__' ||
    regexp_replace(d.\"originalName\", '[^A-Za-z0-9._-]', '_', 'g')
from document d
join loan_application la on la.id = d.\"applicationId\"
order by d.\"createdAt\";
" > "$OUT/.manifest.tsv"

copied=0
missing=0
while IFS=$'\t' read -r key exported; do
  [ -z "$key" ] && continue
  if [ -f "$TMP/$key" ]; then
    cp "$TMP/$key" "$OUT/documents/$exported"
    copied=$((copied + 1))
  else
    missing=$((missing + 1))
  fi
done < "$OUT/.manifest.tsv"

rm -rf "$TMP" "$OUT/.manifest.tsv"

# ---------------------------------------------------------------------------
echo
echo "applications.csv   $(($(wc -l < "$OUT/applications.csv") - 1)) applications"
echo "features.jsonl     $(wc -l < "$OUT/features.jsonl" | tr -d ' ') scored feature vectors"
echo "documents.csv      $(($(wc -l < "$OUT/documents.csv") - 1)) document records"
echo "documents/         $copied files copied$([ "$missing" -gt 0 ] && echo ", $missing blob(s) missing" || echo "")"
echo
echo "done: $OUT"

if [ "$missing" -gt 0 ]; then
  echo
  echo "note: $missing document row(s) had no blob on the volume. That happens when the" >&2
  echo "      api-storage volume was recreated (docker compose down -v) after those rows" >&2
  echo "      were written — the metadata survives in Postgres, the file does not." >&2
fi
