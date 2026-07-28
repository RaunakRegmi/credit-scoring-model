/**
 * PDF page reconstruction.
 *
 * Two failures motivated this code, and both were silent — the extraction succeeded, the score came
 * out lower, and nothing in the output said the document's layout was the reason:
 *
 *   · a two-column CV interleaves its sidebar into the work history, and
 *   · every PDF hard-wraps its lines, so a work-history entry whose date range breaks across the
 *     wrap stops being recognisable as a role at all.
 *
 * Measured on the fixture CV, those cost 28 and 16 composite points respectively — enough to move an
 * applicant across the Prime boundary at 750 and reprice them.
 *
 * The tests are built from synthetic glyph geometry rather than real PDFs on purpose: it makes the
 * exact spatial condition under test visible in the test itself, which a binary fixture cannot.
 */
import { describe, expect, it } from 'vitest';

import { reconstructPage, type PdfPageLike } from '../src/extraction/pdf-layout';

/* ========================================================================== */
/* Synthetic pages                                                            */
/* ========================================================================== */

interface Glyphs {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height?: number;
}

function page(pageWidth: number, runs: readonly Glyphs[]): PdfPageLike {
  return {
    getViewport: () => ({ width: pageWidth, height: 842 }),
    getTextContent: () =>
      Promise.resolve({
        items: runs.map((run) => ({
          str: run.text,
          // pdf.js text matrix: indices 4 and 5 are the x and y of the baseline origin.
          transform: [1, 0, 0, 1, run.x, run.y],
          width: run.width,
          height: run.height ?? 10,
        })),
      }),
  };
}

/** A line of body text, priced at a plausible average glyph width for 10pt Latin type. */
function line(text: string, x: number, y: number): Glyphs {
  return { text, x, y, width: text.length * 5 };
}

const lines = (text: string | null): string[] => (text ?? '').split('\n');

/**
 * Position of a fragment in the reconstructed text.
 *
 * Ordering tests assert on this rather than on an exact array of lines, because line *segmentation*
 * is the wrap logic's business and is exercised separately below. Coupling an ordering test to
 * segmentation makes it fail for reasons that have nothing to do with what it is checking.
 */
function positionOf(text: string | null, fragment: string): number {
  const index = (text ?? '').indexOf(fragment);
  expect(index, `"${fragment}" should appear in the reconstructed text`).toBeGreaterThanOrEqual(0);
  return index;
}

/* ========================================================================== */
/* Soft-wrap rejoining                                                        */
/* ========================================================================== */

describe('soft-wrap rejoining', () => {
  it('rejoins a line whose next word did not fit', async () => {
    // The exact shape that dropped a role: the date range breaks across the wrap.
    const text = await reconstructPage(
      page(600, [
        line('WORK EXPERIENCE', 50, 700),
        // Reaches x=480. "Present" (7 chars ~ 40pt) could not follow within the 500pt measure.
        { text: 'Senior Manager - Corporate Credit, Nepal Bank | Jan 2021 -', x: 50, y: 680, width: 430 },
        { text: 'Present', x: 50, y: 666, width: 40 },
        // Establishes the block's right edge at 500.
        { text: 'Leading the corporate credit portfolio and the risk team.', x: 50, y: 652, width: 450 },
      ]),
    );

    expect(lines(text)).toContain('Senior Manager - Corporate Credit, Nepal Bank | Jan 2021 - Present');
  });

  it('does not join a line that ends in sentence-final punctuation', async () => {
    // A proportional font lets a complete sentence end within a few points of the margin. Joining
    // there would fuse two work-history entries and lose the second — worse than the wrap bug.
    const text = await reconstructPage(
      page(600, [
        { text: 'Leading the corporate credit portfolio. Kathmandu, Nepal.', x: 50, y: 680, width: 448 },
        { text: 'Manager - Credit Risk, Standard Chartered | Mar 2017 - Dec 2020', x: 50, y: 666, width: 450 },
        line('Managed credit risk assessment for commercial lending.', 50, 652),
      ]),
    );

    // The terminated line stands alone...
    expect(lines(text)).toContain('Leading the corporate credit portfolio. Kathmandu, Nepal.');
    // ...and specifically is not fused with the entry below it, which is the damage this brake
    // prevents: one line carrying two date ranges yields one parsed role instead of two.
    for (const emitted of lines(text)) {
      expect(emitted).not.toMatch(/Nepal\..*Manager - Credit Risk/);
    }
  });

  it('joins an unterminated line into the following body text', async () => {
    // Recorded deliberately, because it is the flip side of the rule above and a real limitation:
    // a line that reaches the measure and ends without punctuation IS continued, even when the
    // author meant it to end there. The damage is bounded — an over-joined line keeps its date
    // range intact, so a role is still parsed from it — and the extractor's final protection is
    // that this reading only wins if it recovers *more* structure than the untouched one.
    const text = await reconstructPage(
      page(600, [
        { text: 'Manager - Credit Risk, Standard Chartered | Mar 2017 - Dec 2020', x: 50, y: 680, width: 450 },
        line('Managed credit risk assessment for commercial lending', 50, 666),
      ]),
    );

    expect(lines(text)).toHaveLength(1);
    expect(text).toContain('Mar 2017 - Dec 2020 Managed credit risk assessment');
  });

  it('does not join into a bullet, a numbered item or an ALL-CAPS heading', async () => {
    for (const follower of ['- CFA Level II, CFA Institute, 2016', '1. First item', 'EDUCATION']) {
      const text = await reconstructPage(
        page(600, [
          { text: 'A line that runs right up to the measure and does not end in a full stop', x: 50, y: 680, width: 448 },
          { text: follower, x: 50, y: 666, width: 200 },
          line('Some further body text on the following line here.', 50, 652),
        ]),
      );
      expect(lines(text), follower).toContain(follower);
    }
  });

  it('does not fuse consecutive labelled fields in a narrow column', async () => {
    // The regression that cost the last 7 points: in a 62mm sidebar each `Label: value` all but
    // fills the measure and none ends in punctuation, so the overflow test alone read every one of
    // them as a wrap and fused the whole personal-details block into a single line.
    const text = await reconstructPage(
      page(600, [
        { text: "Father's Name: Ramesh Sharma", x: 50, y: 700, width: 148 },
        { text: 'Citizenship No: 27-01-75-04821', x: 50, y: 686, width: 150 },
        { text: 'Passport No: PA1234567', x: 50, y: 672, width: 130 },
        { text: 'Address: Jhamsikhel, Lalitpur', x: 50, y: 658, width: 149 },
      ]),
    );

    expect(lines(text)).toEqual([
      "Father's Name: Ramesh Sharma",
      'Citizenship No: 27-01-75-04821',
      'Passport No: PA1234567',
      'Address: Jhamsikhel, Lalitpur',
    ]);
  });

  it('treats a colon later in a sentence as prose, not a field label', async () => {
    // `Salary:` here is mid-sentence. If the label rule matched it, a genuine wrap would be missed.
    const text = await reconstructPage(
      page(600, [
        { text: 'Assistant Manager - Credit, Himalayan Bank | Jun 2013 -', x: 50, y: 680, width: 430 },
        { text: 'Feb 2017', x: 50, y: 666, width: 45 },
        { text: 'Credit appraisal and documentation. Salary: NPR 96,000 pm', x: 50, y: 652, width: 450 },
      ]),
    );

    expect(lines(text)).toContain('Assistant Manager - Credit, Himalayan Bank | Jun 2013 - Feb 2017');
  });
});

/* ========================================================================== */
/* Column ordering                                                            */
/* ========================================================================== */

describe('column ordering', () => {
  /** Sidebar 40–240, gutter 240–300 (60pt, comfortably over the threshold), main 300–560. */
  function twoColumnPage(): PdfPageLike {
    return page(600, [
      line('PERSONAL DETAILS', 40, 700),
      line('Passport No: PA1234567', 40, 686),
      line('CERTIFICATIONS', 40, 660),
      line('CFA Level II', 40, 646),
      line('WORK EXPERIENCE', 300, 700),
      line('Senior Manager, Nepal Bank', 300, 686),
      line('EDUCATION', 300, 660),
      line('MBA, University of Melbourne', 300, 646),
    ]);
  }

  it('emits each column contiguously instead of interleaving them', async () => {
    const text = await reconstructPage(twoColumnPage());

    // The whole point: the sidebar must not land in the middle of the work history, because the
    // resume parser decides what a line means from the heading above it. Naive extraction returns
    // these in content-stream order, which interleaves the two columns.
    const order = [
      'PERSONAL DETAILS',
      'Passport No: PA1234567',
      'CERTIFICATIONS',
      'CFA Level II',
      'WORK EXPERIENCE',
      'Senior Manager, Nepal Bank',
      'EDUCATION',
      'MBA, University of Melbourne',
    ].map((fragment) => positionOf(text, fragment));

    for (let i = 1; i < order.length; i += 1) {
      expect(order[i], `item ${i} should follow item ${i - 1}`).toBeGreaterThan(order[i - 1] ?? -1);
    }
  });

  it('keeps content under its own heading', async () => {
    const text = await reconstructPage(twoColumnPage());

    // The sidebar's certification must sit under CERTIFICATIONS, not under the main column's
    // WORK EXPERIENCE — which is exactly what interleaving does to it.
    expect(positionOf(text, 'CFA Level II')).toBeGreaterThan(positionOf(text, 'CERTIFICATIONS'));
    expect(positionOf(text, 'CFA Level II')).toBeLessThan(positionOf(text, 'WORK EXPERIENCE'));
  });

  it('finds the columns under a full-width header, and puts the header first', async () => {
    // The header crosses the gutter. Before full-width runs were excluded from the coverage
    // histogram it marked those bins as covered, no gutter was found, and the columns silently
    // reverted to being read as one — on one of the commonest CV layouts there is.
    const text = await reconstructPage(
      page(600, [
        { text: 'ANJALI SHARMA — CURRICULUM VITAE', x: 40, y: 760, width: 500 },
        line('PERSONAL DETAILS', 40, 700),
        line('Passport No: PA1234567', 40, 686),
        line('Citizenship No: 27-01-75', 40, 672),
        line('WORK EXPERIENCE', 300, 700),
        line('Senior Manager, Nepal Investment Bank', 300, 686),
        line('Manager, Standard Chartered Nepal', 300, 672),
      ]),
    );

    expect(lines(text)[0]).toBe('ANJALI SHARMA — CURRICULUM VITAE');
    // And the columns really were separated, rather than read across.
    expect(positionOf(text, 'Citizenship No: 27-01-75')).toBeLessThan(
      positionOf(text, 'WORK EXPERIENCE'),
    );
  });

  it('uses a mid-page full-width line as a boundary rather than hoisting it', async () => {
    // A simpler "spanning lines first" rule would lift this heading to the top of the page and
    // detach it from the content beneath it.
    const text = await reconstructPage(
      page(600, [
        line('Sidebar upper one', 40, 700),
        line('Sidebar upper two', 40, 686),
        line('Sidebar upper three', 40, 672),
        line('Main upper one', 300, 700),
        line('Main upper two', 300, 686),
        line('Main upper three', 300, 672),
        { text: 'REFERENCES — SPANNING BOTH COLUMNS', x: 40, y: 600, width: 500 },
        line('Sidebar lower one', 40, 560),
        line('Sidebar lower two', 40, 546),
        line('Sidebar lower three', 40, 532),
        line('Main lower one', 300, 560),
        line('Main lower two', 300, 546),
        line('Main lower three', 300, 532),
      ]),
    );

    const divider = positionOf(text, 'REFERENCES — SPANNING BOTH COLUMNS');
    expect(positionOf(text, 'Main upper one')).toBeLessThan(divider);
    expect(positionOf(text, 'Sidebar lower one')).toBeGreaterThan(divider);
  });

  it('ignores a gutter too narrow to be a column break', async () => {
    // A wide word space is not a column. The gap here is 8pt, under the 18pt floor, so the two
    // halves must stay on one line rather than being pulled apart into separate columns.
    const text = await reconstructPage(
      page(600, [
        { text: 'Left', x: 40, y: 700, width: 100 },
        { text: 'Right', x: 148, y: 700, width: 100 },
        { text: 'Left two', x: 40, y: 686, width: 100 },
        { text: 'Right two', x: 148, y: 686, width: 100 },
        { text: 'Left three', x: 40, y: 672, width: 100 },
        { text: 'Right three', x: 148, y: 672, width: 100 },
      ]),
    );

    expect(text).toContain('Left Right');
    expect(text).toContain('Left two Right two');
  });

  it('does not split the page on a sparse marginal element', async () => {
    // A page number sitting alone with its own wide gutter must not be promoted to a column. The
    // page collapses to a single band rather than bailing out, so it still gets wrap rejoining.
    const text = await reconstructPage(
      page(600, [
        line('Body line one goes here', 200, 700),
        line('Body line two goes here', 200, 686),
        line('Body line three goes here', 200, 672),
        line('Body line four goes here', 200, 658),
        { text: '1', x: 40, y: 700, width: 5 },
      ]),
    );

    expect(text).toContain('Body line one goes here');
    expect(text).toContain('Body line four goes here');
  });
});

/* ========================================================================== */
/* Degenerate input                                                           */
/* ========================================================================== */

describe('degenerate input', () => {
  it('returns null for a page with no text layer', async () => {
    // An image-only scan. The caller keeps the library's extraction, which then trips the
    // empty-extraction path and routes the application to a human rather than scoring it on nothing.
    await expect(reconstructPage(page(600, []))).resolves.toBeNull();
  });

  it('ignores runs with unusable geometry rather than throwing', async () => {
    const malformed: PdfPageLike = {
      getViewport: () => ({ width: 600, height: 842 }),
      getTextContent: () =>
        Promise.resolve({
          items: [
            { str: 'Good line here', transform: [1, 0, 0, 1, 50, 700], width: 80, height: 10 },
            { str: 'no transform', width: 50, height: 10 },
            { str: 'short transform', transform: [1, 0, 0], width: 50, height: 10 },
            { str: 'nan position', transform: [1, 0, 0, 1, Number.NaN, 680], width: 50, height: 10 },
            { str: '   ', transform: [1, 0, 0, 1, 50, 666], width: 10, height: 10 },
            null,
            'not an object',
            // Zero height would otherwise collapse every geometric threshold to zero.
            { str: 'Zero height run', transform: [1, 0, 0, 1, 50, 652], width: 80, height: 0 },
          ],
        }),
    };

    const text = await reconstructPage(malformed);
    expect(text).toContain('Good line here');
    expect(text).toContain('Zero height run');
    expect(text).not.toContain('no transform');
    expect(text).not.toContain('short transform');
    expect(text).not.toContain('nan position');
  });

  it('joins glyph runs on one line without inventing spaces mid-word', async () => {
    // pdf.js splits a run at every font change, so a bolded word arrives as its own item with no
    // gap. Joining unconditionally with a space would corrupt the token.
    const result = lines(
      await reconstructPage(
        page(600, [
          { text: 'Senior', x: 50, y: 700, width: 30 },
          // Abuts the previous run exactly — a font change, not a word break.
          { text: 'Manager', x: 80, y: 700, width: 38 },
          // A real gap follows.
          { text: 'at', x: 128, y: 700, width: 10 },
          line('Second line of the document body', 50, 686),
          line('Third line of the document body', 50, 672),
        ]),
      ),
    );

    expect(result[0]).toBe('SeniorManager at');
  });
});
