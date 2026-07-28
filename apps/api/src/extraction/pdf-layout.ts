/**
 * Column-aware reflow for PDF pages.
 *
 * A PDF has no rows. It is positioned glyph runs, and the order they appear in the content stream
 * is the order the generator happened to emit them — which for a two-column CV is frequently
 * left-cell, right-cell, left-cell, right-cell. Extracted as a flat string that interleaves the
 * sidebar into the middle of the work history, and the resume parser is section-oriented: it
 * decides what a line means from the heading above it. Interleaving destroys exactly the signal it
 * depends on.
 *
 * Measured on a two-column CV carrying identical content to the plain-text fixture, naive
 * extraction lost 28 composite points — 25 of them from the Professional pillar, through employment
 * entries that never got parsed. That is enough to move an applicant across the Prime boundary at
 * 750 and reprice them, with nothing in the output indicating the document's layout was involved.
 *
 * So: rebuild the reading order geometrically. Assign runs to vertical bands, group each band's
 * runs into lines independently, and emit band by band.
 *
 * ## Why this returns a *candidate* rather than a verdict
 *
 * There is no reliable way to tell two-column prose from a two-column **table** by geometry. A
 * `Name:        Anjali Sharma` label/value layout produces exactly the same clean vertical gutter,
 * and reordering it band-by-band would emit every label followed by every value — detaching each
 * field from its own value, which is worse than the interleaving this file exists to fix. The
 * obvious discriminators do not work either: side-by-side columns and table rows *both* put runs at
 * coincident baselines on either side of the gutter.
 *
 * So this function does not decide. It returns the column-ordered reading as one candidate, and the
 * caller keeps whichever candidate its own parser recovers more structure from. That turns an
 * unanswerable geometric question into a measurable one.
 */

/* -------------------------------------------------------------------------- */
/* Tuning                                                                      */
/* -------------------------------------------------------------------------- */

/** Coverage-histogram resolution, in PDF points. Fine enough for a gutter, coarse enough to be cheap. */
const BIN_POINTS = 2;

/**
 * A gutter must be at least this wide to count. 18pt is a quarter inch — comfortably wider than
 * inter-word spacing at any body size, so ordinary prose cannot manufacture one.
 */
const MIN_GUTTER_POINTS = 18;

/** ...and at least this share of the page, so the threshold scales with paper size. */
const MIN_GUTTER_FRACTION = 0.025;

/** A band holding fewer lines than this is decoration — a rule, a bullet gutter — not a column. */
const MIN_LINES_PER_BAND = 3;

/** Fraction of font size a horizontal gap must exceed to be a word break rather than a font change. */
const WORD_GAP_RATIO = 0.25;

/**
 * How close to the text block's right edge a line must reach to count as having been filled — and
 * therefore as a soft wrap rather than a deliberate line ending. Expressed in font sizes, so it
 * scales with the type.
 */
const FILLED_LINE_SLACK_RATIO = 0.75;

/** Marks a line that crosses a gutter and therefore belongs to no single band. */
const SPANNING = -1;

/* -------------------------------------------------------------------------- */
/* Structural types for the pdf.js objects we touch                            */
/* -------------------------------------------------------------------------- */

/**
 * Minimal shapes rather than pdf.js's own types: `unpdf` re-exports the proxy objects without
 * their declarations, and the four properties read here are stable across pdf.js versions in a way
 * the full type surface is not.
 */
export interface PdfPageLike {
  getViewport(params: { scale: number }): { width: number; height: number };
  getTextContent(): Promise<{ items: readonly unknown[] }>;
}

interface Run {
  readonly text: string;
  /** Left edge, PDF user space. */
  readonly left: number;
  readonly right: number;
  /** Baseline. Larger is higher up the page — PDF y grows upward. */
  readonly y: number;
  /** Glyph height, used as a proxy for font size. */
  readonly height: number;
}

interface Line {
  readonly text: string;
  readonly y: number;
  readonly left: number;
  /** Right edge of the rendered line, used to reconstruct where the text wrapped. */
  readonly right: number;
  /** Representative glyph height on the line — a proxy for font size. */
  readonly height: number;
  /** Band index, or `SPANNING`. */
  readonly band: number;
}

interface Band {
  readonly left: number;
  readonly right: number;
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Rebuilds a page's text from glyph geometry: columns in reading order, soft wraps rejoined.
 *
 * Returns `null` only when the page has no readable positioned text at all, in which case the
 * caller keeps the library's extraction.
 *
 * ## Soft-wrap rejoining is the bigger of the two fixes
 *
 * Columns were the visible problem; line wrapping turned out to be the larger one, and it affects
 * *every* PDF rather than only two-column ones. A PDF stores hard line breaks at whatever width the
 * text happened to wrap, so a work-history entry that is one logical line in a plain-text CV
 * arrives as:
 *
 *     Senior Manager - Corporate Credit, Nepal Investment Mega Bank Limited | Jan 2021 -
 *     Present
 *
 * The resume parser needs a complete date range on one line to recognise a role, so that entry is
 * silently dropped. Measured on the fixture CV: the plain-text original yields four roles, the same
 * content as a single-column PDF yields three, and as a two-column PDF — where the narrower measure
 * wraps more lines — two.
 *
 * A line is treated as a soft wrap when it reaches the text block's right edge *and* does not end in
 * sentence-final punctuation. Both conditions are needed. Fill alone is not enough, because a
 * proportional font lets a complete sentence end within a few points of the margin, and joining
 * there would fuse two work-history entries into one and lose the second — worse than the bug being
 * fixed. Requiring an unterminated ending keeps the rule conservative: it repairs the dangling
 * `Jan 2021 -` case and declines to guess on anything ambiguous.
 */
export async function reconstructPage(page: PdfPageLike): Promise<string | null> {
  const { width } = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();

  const runs = content.items.map(toRun).filter((run): run is Run => run !== null);
  if (runs.length === 0) {
    return null;
  }

  const fullSpan = spanOf(runs);
  let bands = detectBands(runs, width) ?? [fullSpan];
  let lines = layout(runs, bands, lineTolerance(runs));

  // A band that holds almost nothing is decoration — a vertical rule, a bullet gutter — not a
  // column. Collapse to a single band rather than bailing out: the page still benefits from
  // soft-wrap rejoining even when the column claim does not hold up.
  if (bands.length > 1) {
    const weak = bands.some(
      (_band, index) => lines.filter((line) => line.band === index).length < MIN_LINES_PER_BAND,
    );
    if (weak) {
      bands = [fullSpan];
      lines = layout(runs, bands, lineTolerance(runs));
    }
  }

  return emit(lines, bands);
}

/** Assigns runs to bands and groups each band's runs into lines independently. */
function layout(runs: readonly Run[], bands: readonly Band[], tolerance: number): Line[] {
  // Lines are grouped *within* a band, never across the page. Grouping globally by baseline is the
  // subtle mistake here: a sidebar entry and a work-history entry printed at the same height share
  // a baseline, so a page-wide grouping merges them into one line that straddles the gutter — and
  // then every line looks like a spanning line and the columns vanish.
  const perBand: Run[][] = bands.map(() => []);
  const spanning: Run[] = [];

  for (const run of runs) {
    const index = bandOf(run, bands);
    if (index === SPANNING) {
      spanning.push(run);
    } else {
      perBand[index]?.push(run);
    }
  }

  const lines: Line[] = [];
  perBand.forEach((bandRuns, index) => {
    for (const line of groupIntoLines(bandRuns, tolerance)) {
      lines.push({ ...line, band: index });
    }
  });
  for (const line of groupIntoLines(spanning, tolerance)) {
    lines.push({ ...line, band: SPANNING });
  }

  return lines;
}

/** The horizontal extent of all content on the page. */
function spanOf(runs: readonly Run[]): Band {
  return {
    left: Math.min(...runs.map((run) => run.left)),
    right: Math.max(...runs.map((run) => run.right)),
  };
}

/* -------------------------------------------------------------------------- */
/* Runs and lines                                                              */
/* -------------------------------------------------------------------------- */

function toRun(item: unknown): Run | null {
  if (typeof item !== 'object' || item === null) {
    return null;
  }
  const candidate = item as {
    str?: unknown;
    transform?: unknown;
    width?: unknown;
    height?: unknown;
  };

  if (typeof candidate.str !== 'string' || candidate.str.trim().length === 0) {
    return null;
  }
  if (!Array.isArray(candidate.transform) || candidate.transform.length < 6) {
    return null;
  }

  const x: unknown = candidate.transform[4];
  const y: unknown = candidate.transform[5];
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }

  const width = typeof candidate.width === 'number' && candidate.width > 0 ? candidate.width : 0;
  // A zero height would collapse the word-gap and line-grouping thresholds to zero.
  const height =
    typeof candidate.height === 'number' && candidate.height > 0 ? candidate.height : 10;

  return { text: candidate.str, left: x, right: x + width, y, height };
}

/**
 * Line-grouping tolerance, from the median glyph height rather than a constant, so an 8pt footnote
 * and a 24pt heading on the same page are both grouped correctly.
 */
function lineTolerance(runs: readonly Run[]): number {
  const heights = runs.map((run) => run.height).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)] ?? 10;
  return Math.max(1.5, median * 0.5);
}

/** Groups runs sharing a baseline into lines, ordered top to bottom. */
function groupIntoLines(
  runs: readonly Run[],
  tolerance: number,
): Omit<Line, 'band'>[] {
  if (runs.length === 0) {
    return [];
  }

  const sorted = [...runs].sort((a, b) => (b.y - a.y !== 0 ? b.y - a.y : a.left - b.left));

  const lines: Omit<Line, 'band'>[] = [];
  let current: Run[] = [];

  const flush = (): void => {
    if (current.length === 0) {
      return;
    }
    const ordered = [...current].sort((a, b) => a.left - b.left);
    const text = joinRuns(ordered);
    if (text.length > 0) {
      lines.push({
        text,
        y: Math.max(...ordered.map((run) => run.y)),
        left: Math.min(...ordered.map((run) => run.left)),
        right: Math.max(...ordered.map((run) => run.right)),
        height: Math.max(...ordered.map((run) => run.height)),
      });
    }
    current = [];
  };

  for (const run of sorted) {
    const reference = current[0];
    if (reference !== undefined && Math.abs(reference.y - run.y) > tolerance) {
      flush();
    }
    current.push(run);
  }
  flush();

  return lines;
}

/**
 * Concatenates runs on one line, inserting a space only where the geometry implies one.
 *
 * pdf.js splits a run at every font change, so "**Senior** Manager" arrives as two items with no
 * gap between them. Joining unconditionally with a space would corrupt words mid-token — and
 * hyphenated job titles and email addresses are exactly where that shows up.
 */
function joinRuns(ordered: readonly Run[]): string {
  let text = '';
  let previous: Run | null = null;

  for (const run of ordered) {
    if (previous !== null) {
      const gap = run.left - previous.right;
      const threshold = Math.max(previous.height, run.height) * WORD_GAP_RATIO;
      if (gap > threshold) {
        text += ' ';
      }
    }
    text += run.text;
    previous = run;
  }

  return text.replace(/\s{2,}/g, ' ').trim();
}

/* -------------------------------------------------------------------------- */
/* Column detection                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A run this wide relative to the page's content cannot be column text — a column is at most about
 * half the measure. It is a header, a footer or a rule.
 */
const FULL_WIDTH_RUN_RATIO = 0.7;

/** Finds the vertical bands of the page, or `null` when there is only one. */
function detectBands(runs: readonly Run[], pageWidth: number): Band[] | null {
  if (!Number.isFinite(pageWidth) || pageWidth <= 0) {
    return null;
  }

  const binCount = Math.ceil(pageWidth / BIN_POINTS);
  if (binCount <= 0) {
    return null;
  }

  // Full-width runs are excluded from the histogram before gutters are looked for. A page header or
  // a horizontal rule crosses the gutter, so leaving it in marks those bins as covered and the
  // columns disappear — which is not an edge case: a CV with its name banner across the top and two
  // columns beneath is one of the commonest layouts there is. The excluded runs are still assigned
  // to bands afterwards, where their width makes them `SPANNING` by construction.
  const span = spanOf(runs);
  const spanWidth = span.right - span.left;
  const columnCandidates =
    spanWidth > 0
      ? runs.filter((run) => run.right - run.left < spanWidth * FULL_WIDTH_RUN_RATIO)
      : runs;
  const histogramRuns = columnCandidates.length > 0 ? columnCandidates : runs;

  const covered = new Array<boolean>(binCount).fill(false);

  for (const run of histogramRuns) {
    const from = Math.max(0, Math.floor(run.left / BIN_POINTS));
    const to = Math.min(binCount - 1, Math.ceil(run.right / BIN_POINTS));
    for (let bin = from; bin <= to; bin += 1) {
      covered[bin] = true;
    }
  }

  const firstCovered = covered.indexOf(true);
  const lastCovered = covered.lastIndexOf(true);
  if (firstCovered === -1 || lastCovered <= firstCovered) {
    return null;
  }

  const minGutter = Math.max(MIN_GUTTER_POINTS, pageWidth * MIN_GUTTER_FRACTION);
  const gutters: { from: number; to: number }[] = [];

  // Scanned strictly between the outermost content, so page margins are never mistaken for
  // gutters — they are the widest empty runs on any page.
  let runStart: number | null = null;
  for (let bin = firstCovered; bin <= lastCovered; bin += 1) {
    if (covered[bin] !== true) {
      runStart ??= bin;
      continue;
    }
    if (runStart !== null) {
      if ((bin - runStart) * BIN_POINTS >= minGutter) {
        gutters.push({ from: runStart, to: bin });
      }
      runStart = null;
    }
  }

  if (gutters.length === 0) {
    return null;
  }

  const bands: Band[] = [];
  let cursor = firstCovered;
  for (const gutter of gutters) {
    bands.push({ left: cursor * BIN_POINTS, right: gutter.from * BIN_POINTS });
    cursor = gutter.to;
  }
  bands.push({ left: cursor * BIN_POINTS, right: (lastCovered + 1) * BIN_POINTS });

  return bands.length >= 2 ? bands : null;
}

/** The band a run sits in, or `SPANNING` when it crosses a gutter. */
function bandOf(run: Run, bands: readonly Band[]): number {
  let found = SPANNING;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    if (band === undefined) {
      continue;
    }
    // A hair of tolerance: a glyph's advance width can round a fraction of a point into its
    // neighbour, which would otherwise mark a confined run as straddling.
    if (run.right > band.left + 1 && run.left < band.right - 1) {
      if (found !== SPANNING) {
        return SPANNING;
      }
      found = index;
    }
  }
  return found;
}

/* -------------------------------------------------------------------------- */
/* Emission                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Rebuilds reading order as a horizontal cut followed by a vertical one.
 *
 * Full-width lines — a page header, a rule spanning both columns, a footer — are boundaries. They
 * divide the page into horizontal strips, and each strip is read column by column. This is what
 * keeps a mid-page spanning heading attached to the content beneath it, instead of being hoisted to
 * the top with the page header as a simpler "spanning lines first" rule would do.
 */
function emit(lines: readonly Line[], bands: readonly Band[]): string {
  const byPosition = [...lines].sort((a, b) => (b.y - a.y !== 0 ? b.y - a.y : a.band - b.band));

  // Measured from the content, not from the band's nominal edge: a band's right boundary is where
  // its text actually reaches, and a sidebar's measure is narrower than the gutter position implies.
  const bandRightEdge = bands.map((_band, index) => {
    const inBand = lines.filter((line) => line.band === index);
    return inBand.length === 0 ? 0 : Math.max(...inBand.map((line) => line.right));
  });
  const spanningRightEdge = Math.max(
    0,
    ...lines.filter((line) => line.band === SPANNING).map((line) => line.right),
  );

  const output: string[] = [];
  let strip: Line[] = [];

  const flushStrip = (): void => {
    if (strip.length === 0) {
      return;
    }
    bands.forEach((_band, index) => {
      const inBand = strip.filter((entry) => entry.band === index).sort((a, b) => b.y - a.y);
      output.push(...unwrap(inBand, bandRightEdge[index] ?? 0));
    });
    strip = [];
  };

  let spanningRun: Line[] = [];
  const flushSpanning = (): void => {
    if (spanningRun.length === 0) {
      return;
    }
    output.push(...unwrap(spanningRun, spanningRightEdge));
    spanningRun = [];
  };

  for (const line of byPosition) {
    if (line.band === SPANNING) {
      flushStrip();
      spanningRun.push(line);
      continue;
    }
    flushSpanning();
    strip.push(line);
  }
  flushStrip();
  flushSpanning();

  return output.join('\n');
}

/** True when a line ends where a sentence or field legitimately ends. */
function endsCompletely(text: string): boolean {
  return /[.!?:;)\]]$/.test(text.trimEnd());
}

/**
 * A short `Label:` opening a line — `Passport No:`, `Countries Visited:`, `Residing Since:`.
 *
 * The character class deliberately excludes `.`, so a sentence that happens to contain a colon
 * further along ("…portfolio. Salary: NPR 285,000") is not mistaken for a field label.
 */
const FIELD_LABEL_START = /^[A-Za-z][A-Za-z'’/&() -]{0,30}:\s*\S/;

/** True when a line begins something new, so the line above it cannot have wrapped into it. */
function startsNewItem(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    // Bullets and numbered items.
    /^([-–—•*]|\d+[.)])\s/.test(trimmed) ||
    // ALL-CAPS section headings.
    /^[A-Z][A-Z'&\s]{3,}$/.test(trimmed.trim()) ||
    // A new labelled field. This one matters most in a narrow column: a sidebar measure is only
    // wide enough for one field per line, so consecutive `Label: value` pairs each all but fill it
    // and none ends in punctuation — which is precisely the shape the overflow test reads as a
    // wrap. Without this brake the whole personal-details block fuses into a single line and every
    // field lookup on it returns the wrong value.
    FIELD_LABEL_START.test(trimmed)
  );
}

/**
 * Rejoins lines that the page measure wrapped rather than the author ended.
 *
 * The test is the typesetter's own: a line wrapped **because the next word did not fit**. So the
 * question is not "did this line reach the margin" — it never does; it stops short by exactly the
 * width of the word that was pushed down — but "would the next line's first word have overflowed
 * had it stayed here". That is reconstructable, because the following line's width and character
 * count give a usable average character width to price that first word with.
 *
 * Getting this wrong in the lenient direction is what fuses two work-history entries into one, so
 * two independent brakes apply: a line ending in sentence-final punctuation is taken at its word,
 * and a following line that opens a bullet, a number or an ALL-CAPS heading is never treated as a
 * continuation. Anything still ambiguous is left exactly as found — the historical behaviour, and
 * never worse than it.
 */
function unwrap(lines: readonly Line[], rightEdge: number): string[] {
  const output: string[] = [];
  let buffer = '';

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) {
      continue;
    }

    buffer = buffer === '' ? line.text : `${buffer} ${line.text}`;

    const next = lines[index + 1];
    const continues =
      next !== undefined &&
      !endsCompletely(line.text) &&
      !startsNewItem(next.text) &&
      wouldHaveOverflowed(line, next, rightEdge);

    if (!continues) {
      output.push(buffer);
      buffer = '';
    }
  }

  if (buffer !== '') {
    output.push(buffer);
  }

  return output;
}

/** Would `next`'s first word have overflowed the measure if it had stayed on `line`? */
function wouldHaveOverflowed(line: Line, next: Line, rightEdge: number): boolean {
  const firstWord = next.text.trimStart().split(/\s+/)[0] ?? '';
  if (firstWord === '') {
    return false;
  }

  const nextWidth = next.right - next.left;
  const perCharacter =
    next.text.length > 0 && nextWidth > 0
      ? nextWidth / next.text.length
      : // Nothing to measure from; fall back to a fraction of the type size, which is the right
        // order of magnitude for an average Latin glyph.
        line.height * 0.5;

  // +1 for the space that would have preceded it.
  const projected = line.right + perCharacter * (firstWord.length + 1);
  return projected > rightEdge - line.height * FILLED_LINE_SLACK_RATIO;
}
