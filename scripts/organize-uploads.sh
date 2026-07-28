#!/usr/bin/env bash
#
# Builds a browsable copy of every uploaded document, sorted into folders by type.
#
# The canonical store in ./storage is content-addressed — `<applicationId>/<sha256>.bin`. That is
# deliberate (no user-supplied text ever becomes a path, and a file uploaded twice occupies one
# blob), but it means you cannot tell a CV from a bank statement by looking. This produces the
# readable view: real filenames, grouped by document type, named after the applicant.
#
#   ./scripts/organize-uploads.sh
#
#   uploads/
#     CV/                 ONE-20260728-8FB473__Anjali-Sharma__resume.txt
#     bank-statements/     ONE-20260728-8FB473__Anjali-Sharma__statement.csv
#
# Safe to re-run — it rebuilds the tree from scratch each time, so deleting an application in the
# database removes it here on the next run. Copies, never moves: ./storage stays authoritative.
#
# Requires the stack to be running (the manifest comes from Postgres).

set -euo pipefail

cd "$(dirname "$0")/.."

STORE="storage"
OUT="uploads"
PSQL=(docker compose exec -T postgres psql -U "${POSTGRES_USER:-aics}" -d "${POSTGRES_DB:-aics}")

if ! docker compose ps --status running --services 2>/dev/null | grep -qx postgres; then
  echo "postgres is not running — start the stack first: docker compose up -d" >&2
  exit 1
fi

if [ ! -d "$STORE" ]; then
  echo "no $STORE/ directory — nothing has been uploaded yet, or the bind mount is not in place" >&2
  exit 1
fi

# Folder name per document type. Anything not listed lands in a folder named after the type
# itself, so a new DocumentType shows up rather than being silently dropped.
folder_for() {
  case "$1" in
    RESUME)         echo 'CV' ;;
    BANK_STATEMENT) echo 'bank-statements' ;;
    NID_FRONT|NID_BACK|PASSPORT|PAN_CARD|SELFIE) echo 'kyc' ;;
    ADDRESS_PROOF)  echo 'address-proof' ;;
    EMPLOYER_LETTER|SALARY_SLIP) echo 'employment' ;;
    *)              echo "$1" ;;
  esac
}

rm -rf "$OUT"
mkdir -p "$OUT"

# Tab-separated so commas and quotes in an applicant name or filename cannot split a field.
# `originalName` and `fullName` both originate from user input and are about to become a path, so
# each is reduced to filesystem-safe characters.
"${PSQL[@]}" -t -A -F $'\t' -c "
select
  d.type,
  d.\"storageKey\",
  la.arn || '__' ||
    regexp_replace(ap.\"fullName\", '[^A-Za-z0-9]+', '-', 'g') || '__' ||
    regexp_replace(d.\"originalName\", '[^A-Za-z0-9._-]', '_', 'g')
from document d
join loan_application la on la.id = d.\"applicationId\"
join applicant_profile ap on ap.id = la.\"applicantId\"
order by d.\"createdAt\";
" > "$OUT/.manifest.tsv"

copied=0
missing=0
declare -a missing_keys=()

while IFS=$'\t' read -r type key name; do
  [ -z "${key:-}" ] && continue
  dir="$OUT/$(folder_for "$type")"
  mkdir -p "$dir"

  if [ -f "$STORE/$key" ]; then
    target="$dir/$name"
    # Same applicant re-uploading a differently-named file can collide; keep both.
    if [ -e "$target" ]; then
      target="$dir/$(printf '%s' "${key%%/*}" | cut -c1-8)__$name"
    fi
    cp "$STORE/$key" "$target"
    copied=$((copied + 1))
  else
    missing=$((missing + 1))
    missing_keys+=("$key")
  fi
done < "$OUT/.manifest.tsv"

rm -f "$OUT/.manifest.tsv"

echo "uploads/"
for dir in "$OUT"/*/; do
  [ -d "$dir" ] || continue
  printf '  %-18s %s file(s)\n' "$(basename "$dir")/" "$(find "$dir" -type f | wc -l | tr -d ' ')"
done
echo
echo "$copied file(s) organised into $OUT/"

if [ "$missing" -gt 0 ]; then
  echo
  echo "warning: $missing document row(s) have no file in $STORE/." >&2
  echo "         Their metadata is in Postgres but the blob is gone — this is what an earlier" >&2
  echo "         'docker compose down -v' looks like after the fact. First few:" >&2
  printf '           %s\n' "${missing_keys[@]:0:3}" >&2
fi
