#!/usr/bin/env bash
#
# Renders the plain-text fixtures in `samples/` as realistic PDFs, into `samples/pdf/`.
#
#   ./scripts/generate-sample-pdfs.sh
#
# Why bother: the .txt and .csv fixtures are what the automated tests use, and they are the right
# thing for a test — small, diffable, no binary in git history. They are the wrong thing to hand
# someone in a demo, because nobody submits a credit application as a .txt file, and a reviewer
# watching a .txt get scored has no idea whether the system could cope with a real document.
#
# These PDFs are the same three applicants, rendered as documents that look like what actually
# arrives: a two-column CV with a sidebar, and a bank statement as a proper tabular statement with a
# branch header. Both are formats that broke scoring before `apps/api/src/extraction/pdf-layout.ts`
# existed, so demonstrating on them is also the honest demonstration.
#
# Requires Google Chrome (headless print-to-PDF). Regenerate any time; output is deterministic
# apart from PDF internal timestamps.

set -euo pipefail

cd "$(dirname "$0")/.."

readonly CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
readonly OUT='samples/pdf'
readonly WORK="${TMPDIR:-/tmp}/aics-samples-$$"

[ -x "$CHROME" ] || { echo "Google Chrome not found at $CHROME" >&2; exit 1; }

mkdir -p "$OUT" "$WORK"
trap 'rm -rf "$WORK"' EXIT

# Node does the templating: escaping CV text into HTML with sed is how you get a mangled document.
render() {
  local key=$1 label=$2
  node - "$key" "$label" <<'NODE' > "$WORK/$1.html"
const { readFileSync } = require('node:fs');
const [key, label] = process.argv.slice(2);

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const resume = readFileSync(`samples/${key}-resume.txt`, 'utf8');
const lines = resume.split('\n');

// Pull a named section out of the flat CV text, so the sidebar and the main column can be composed
// from the same source the tests use.
const section = (heading) => {
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) return '';
  let end = start + 1;
  while (end < lines.length && !/^[A-Z][A-Z' ]{3,}$/.test(lines[end].trim())) end += 1;
  return lines.slice(start, end).join('\n').trim();
};

const contact = lines.slice(1, 4).filter((l) => l.trim()).join('\n');

process.stdout.write(`<!doctype html><meta charset="utf-8"><title>${esc(label)} — CV</title>
<style>
  @page { margin: 0; size: A4; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 10pt/1.45 -apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #1a1a1a; }
  .banner { background: #17365d; color: #fff; padding: 14mm 14mm 10mm; }
  .banner h1 { margin: 0; font-size: 21pt; font-weight: 600; letter-spacing: 0.4pt; }
  .banner p { margin: 2mm 0 0; font-size: 9.5pt; color: #c8d6e8; }
  .cols { display: flex; gap: 11mm; padding: 11mm 14mm 14mm; }
  .side { width: 56mm; flex: none; }
  .main { flex: 1; min-width: 0; }
  /* Deliberately no letter-spacing here. It looks good, and it positions every glyph
     independently in the PDF, so the text layer reads "W O R K  E X P E R I E N C E" — the parser
     now copes with that (see despaceHeading in resume.parser.ts), but a sample file should
     demonstrate the system rather than its workarounds. */
  h2 { font-size: 9.5pt; text-transform: uppercase; color: #17365d; font-weight: 600;
       margin: 0 0 2.5mm; padding-bottom: 1.2mm; border-bottom: 0.6pt solid #c9d4e2; }
  section { margin-bottom: 7mm; }
  pre { font: inherit; white-space: pre-wrap; margin: 0; }
  .side pre { font-size: 9pt; }
</style>
<div class="banner">
  <h1>${esc(lines[0] ?? label)}</h1>
  <p>Curriculum Vitae</p>
</div>
<div class="cols">
  <aside class="side">
    <section><h2>Contact</h2><pre>${esc(contact)}</pre></section>
    ${section('PERSONAL DETAILS') ? `<section><h2>Personal details</h2><pre>${esc(section('PERSONAL DETAILS').split('\n').slice(1).join('\n'))}</pre></section>` : ''}
    ${section('CERTIFICATIONS') ? `<section><h2>Certifications</h2><pre>${esc(section('CERTIFICATIONS').split('\n').slice(1).join('\n'))}</pre></section>` : ''}
    ${section('TRAVEL HISTORY') ? `<section><h2>Travel history</h2><pre>${esc(section('TRAVEL HISTORY').split('\n').slice(1).join('\n'))}</pre></section>` : ''}
  </aside>
  <main class="main">
    ${section('PROFESSIONAL SUMMARY') ? `<section><h2>Professional summary</h2><pre>${esc(section('PROFESSIONAL SUMMARY').split('\n').slice(1).join('\n'))}</pre></section>` : ''}
    ${section('WORK EXPERIENCE') ? `<section><h2>Work experience</h2><pre>${esc(section('WORK EXPERIENCE').split('\n').slice(1).join('\n'))}</pre></section>` : ''}
    ${section('EDUCATION') ? `<section><h2>Education</h2><pre>${esc(section('EDUCATION').split('\n').slice(1).join('\n'))}</pre></section>` : ''}
    ${section('AWARDS') ? `<section><h2>Awards</h2><pre>${esc(section('AWARDS').split('\n').slice(1).join('\n'))}</pre></section>` : ''}
    ${section('REFERENCES') ? `<section><h2>References</h2><pre>${esc(section('REFERENCES').split('\n').slice(1).join('\n'))}</pre></section>` : ''}
  </main>
</div>`);
NODE

  node - "$key" "$label" <<'NODE' > "$WORK/$1-statement.html"
const { readFileSync } = require('node:fs');
const [key, label] = process.argv.slice(2);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const csv = readFileSync(`samples/${key}-statement.csv`, 'utf8').trim().split('\n').map((r) => r.split(','));
const header = csv[0];
const rows = csv.slice(1);
const numeric = header.map((h) => /amount|balance|debit|credit/i.test(h));

process.stdout.write(`<!doctype html><meta charset="utf-8"><title>${esc(label)} — Statement</title>
<style>
  @page { margin: 12mm 10mm; size: A4; }
  body { margin: 0; font: 7.6pt/1.3 -apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #1a1a1a; }
  header { border-bottom: 1.4pt solid #17365d; padding-bottom: 3mm; margin-bottom: 4mm; }
  header h1 { margin: 0; font-size: 13pt; color: #17365d; font-weight: 600; }
  header p { margin: 1mm 0 0; font-size: 8pt; color: #555; }
  .meta { display: flex; gap: 12mm; margin-bottom: 4mm; font-size: 8pt; }
  .meta div span { color: #666; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 7.2pt; letter-spacing: 0.4pt; text-transform: uppercase;
       color: #17365d; border-bottom: 0.8pt solid #17365d; padding: 1.6mm 2mm; }
  td { padding: 1.3mm 2mm; border-bottom: 0.2pt solid #dfe4ea; white-space: nowrap; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  tbody tr:nth-child(even) { background: #f6f8fa; }
  footer { margin-top: 5mm; font-size: 7pt; color: #777; }
</style>
<header>
  <h1>Nepal Investment Mega Bank Limited</h1>
  <p>Durbar Marg Branch, Kathmandu · Statement of Account</p>
</header>
<div class="meta">
  <div><span>Account holder</span><br><strong>${esc(label)}</strong></div>
  <div><span>Account type</span><br>Savings — NPR</div>
  <div><span>Statement period</span><br>Six months to date</div>
</div>
<table>
  <thead><tr>${header.map((h, i) => `<th class="${numeric[i] ? 'num' : ''}">${esc(h)}</th>`).join('')}</tr></thead>
  <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td class="${numeric[i] ? 'num' : ''}">${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>
</table>
<footer>This is a computer-generated statement. Synthetic data — for demonstration only.</footer>`);
NODE
}

to_pdf() {
  "$CHROME" --headless --disable-gpu --no-pdf-header-footer \
    --print-to-pdf="$2" "file://$1" 2>/dev/null
}

echo 'Generating sample PDFs...'

# label is the applicant's display name, used in the statement header.
for entry in \
  'prime-professional|Anjali Sharma' \
  'thin-file-gig-worker|Prakash Gurung' \
  'overleveraged-high-risk|Bibek Adhikari'
do
  key=${entry%%|*}
  label=${entry##*|}

  render "$key" "$label"
  to_pdf "$WORK/$key.html"            "$PWD/$OUT/$key-resume.pdf"
  to_pdf "$WORK/$key-statement.html"  "$PWD/$OUT/$key-statement.pdf"
  printf '  %-24s resume + statement\n' "$key"
done

echo
echo "Written to $OUT/:"
ls -1sh "$OUT" | tail -n +2 | sed 's/^/  /'
echo
echo 'Upload a matching pair — the resume and statement with the same prefix.'
