// The full Marwin price book from its markdown extraction: pipe tables per
// page, a size-labelled header, then model rows whose "xxx" expands to the
// size code per column. Two row families: matrix rows (a part template
// priced across size columns) and triple rows (SIZE, MODEL, LIST, often two
// triples side by side on the automated pages, where the part number is
// complete and carries its actuator code).
//
// Size codes are the trap. The book uses numeric codes for most series
// (2000F-050, 5801F-800) and letter codes for a few (8700F-05A, 4700F-25A),
// so a template's xxx is expanded by the convention its own series proves
// with complete part numbers elsewhere in the book. A series with no
// complete code follows the book's stated numeric rule and is named in the
// report so a human checks a sample; a series that mixed conventions would
// have its templates refused outright. A letter expansion only uses codes
// that series actually prints somewhere; it never extrapolates the pattern.
//
// The refusals are the point. A cell holding more than one price is a
// collapsed extraction row and prices nothing. A priced row with no part
// number (the book prints a few L-port twins this way) prices nothing. The
// same code printed twice at different prices is two products under one
// printed code. The book says which: page 79 glosses the pair (ER2-5-4) and
// (ER2-5-7), the electric actuator in its Nema 4 and Nema 7 forms, at the
// lower and higher list. James's 24 July 2026 ruling, Nema 4 lower and Nema 7
// higher, holds; it placed the split at the limit switch, and the conflicted
// codes all carry limit switch 00, so the actuator is the position. They still
// price nothing here, because the printed code records only the Nema 4
// operation and the gloss is not part of it; the withheld codes are listed so
// the two-way resolution can be wired against their real shapes. CV3000 and CV4700 pages are
// skipped here because the applied PDF ingest owns them; repair-kit and
// accessory pages are skipped because a kit or a solenoid must never become
// "the cheapest Marwin valve".

const SIZE_CODE = {
  '1/4"': '025', '3/8"': '038', '1/2"': '050', '3/4"': '075', '1"': '100',
  '1 1/4"': '125', '1 1/2"': '150', '2"': '200', '2 1/2"': '250', '3"': '300',
  '4"': '400', '6"': '600', '8"': '800',
};
const LETTER_CODE = {
  '1/2"': '05A', '3/4"': '07A', '1"': '10A', '1 1/4"': '12A', '1 1/2"': '15A',
  '2"': '20A', '2 1/2"': '25A', '3"': '30A', '4"': '40A',
};
const SIZE_SEG = '025|038|050|075|100|125|150|200|250|300|400|600|800';
const LETTER_SEG = '05A|07A|10A|12A|15A|20A|25A|30A|40A';
const CODE_LABEL = Object.fromEntries([
  ...Object.entries(SIZE_CODE).map(([k, v]) => [v, k]),
  ...Object.entries(LETTER_CODE).map(([k, v]) => [v, k]),
]);

// Series per page from the book's own table of contents. Titles are not
// trusted for this because a few pages carry the sheet footer as their title.
const PAGE_SERIES = [
  [3, 6, '9000'], [7, 7, '9700'], [8, 11, '8700'], [12, 15, '4700'],
  [16, 21, '3000'], [22, 26, '10000'], [27, 31, 'CV3000'], [32, 34, 'CV4700'],
  [35, 35, 'FW4700'], [36, 39, 'CF8901'], [40, 43, 'MS3000'], [44, 44, 'MS11000'],
  [45, 51, '2000'], [52, 58, '5801'], [59, 62, '6801'],
  [63, 66, '3T-3700/3L-3800'], [67, 79, '3T-2100/3L-2100'],
  [80, 83, '600'], [84, 84, '4600'], [85, 88, '3T-3300/3L-3400'], [89, 89, '3T-3100/3L-3200'],
];
const seriesFor = n => (PAGE_SERIES.find(([a, b]) => n >= a && n <= b) || [])[2] || null;

// A matrix-row part template: segments of codes with a literal xxx size
// placeholder, an optional /options group and an optional printed gloss.
const PART_TEMPLATE = /^([A-Z0-9]*\d[A-Z0-9]*(?:-[A-Z0-9]+)*-xxx(?:-[A-Z0-9]+)*)\s*(?:\/\s*([A-Z0-9]+))?\s*(?:\(([^)]*)\))?\s*$/;
// A complete part number with its size code embedded, as the automated pages
// print them.
const PART_FULL = new RegExp(
  `^([A-Z0-9]*\\d[A-Z0-9]*(?:-[A-Z0-9]+)*-(?:${SIZE_SEG}|${LETTER_SEG})(?:-[A-Z0-9]+)*)\\s*(?:\\/\\s*([A-Z0-9]+))?\\s*(?:\\(([^)]*)\\))?\\s*$`);
const SIZE_OF_FULL = new RegExp(`-(${SIZE_SEG}|${LETTER_SEG})(?:-|$)`);

const MONEY_CELL = /^\$\s?([\d,]+)(?:\.\d{2})?$/;
const moneyCount = cell => (String(cell).match(/\$\s?[\d,]+/g) || []).length;
const SKIP_LABEL = /^(weight|torque|repair kit|not applicable|maximum p\/t|socketweld is)/i;
const SKIP_TABLE = /adder|solenoid|limit switch|accessor|repair kit|option \d|designator/i;
const NOT_CONTEXT = /^(valve size|size|model|list)$/i;
const CF = /^(cf|consult factory)$/i;

const MATERIAL = { CS: 'carbon steel', S6: '316 stainless steel', BR: 'brass' };
const materialOf = part => {
  for (const seg of String(part).split(/[-/]/)) if (MATERIAL[seg]) return MATERIAL[seg];
  return null;
};

function describe({ series, variant, size, part, context, gloss }) {
  const bits = [`Marwin ${series} series${variant ? ` ${variant.toLowerCase()}` : ''}`, size];
  const mat = materialOf(part);
  if (mat) bits.push(mat);
  if (context) bits.push(context);
  if (gloss) bits.push(gloss);
  return bits.filter(Boolean).join(', ').replace(/\s+/g, ' ').slice(0, 160);
}

const pageOf = section => {
  const head = section.match(/^Page (\d+)(?:\s+—\s+(.*))?/);
  if (!head) return null;
  const n = parseInt(head[1], 10);
  const title = (head[2] || '').trim();
  const skip = (n >= 27 && n <= 34) ? 'cv' : n >= 90 ? 'accessories' : /repair kits/i.test(title) ? 'kits' : null;
  return { n, title, skip, series: seriesFor(n) };
};

export function parseMarwinMd(text) {
  const sections = String(text || '').split(/^## /m);

  // Evidence pass: which size-code convention does each series prove with the
  // complete part numbers on its own pages, and which letter codes exist.
  const evidence = new Map(); // series -> { numeric: bool, letters: Set }
  for (const section of sections) {
    const page = pageOf(section);
    if (!page || page.skip || !page.series) continue;
    for (const line of section.split(/\r?\n/)) {
      if (!/^\|/.test(line.trim())) continue;
      for (const cell of line.trim().split('|').slice(1, -1)) {
        const m = cell.trim().match(PART_FULL);
        if (!m) continue;
        const seg = m[1].match(SIZE_OF_FULL)?.[1];
        if (!seg) continue;
        const e = evidence.get(page.series) || { numeric: false, letters: new Set() };
        if (/A$/.test(seg)) e.letters.add(seg); else e.numeric = true;
        evidence.set(page.series, e);
      }
    }
  }
  const conventionFor = series => {
    const e = evidence.get(series);
    if (!e) return { kind: 'numeric', defaulted: true };
    if (e.numeric && e.letters.size) return { kind: 'mixed' };
    if (e.letters.size) return { kind: 'letter', letters: e.letters };
    return { kind: 'numeric', defaulted: false };
  };

  const parts = [];
  const byPart = new Map();
  const conflicts = new Set();
  const report = {
    pages: 0, tables: 0, parts: 0, cf: 0, spanRefused: 0, modelless: 0,
    unevidencedSize: 0, conflicts: 0, skippedTables: 0,
    skippedPages: { cv: 0, kits: 0, accessories: 0 },
  };
  const defaulted = new Set(), mixed = new Set();

  const push = (part, listUsd, desc) => {
    if (byPart.has(part)) {
      if (byPart.get(part) !== listUsd) conflicts.add(part);
      return;
    }
    byPart.set(part, listUsd);
    parts.push({ part, description: desc, listUsd });
  };

  for (const section of sections) {
    const page = pageOf(section);
    if (!page) continue;
    if (page.skip) { report.skippedPages[page.skip]++; continue; }
    const { series, title } = page;
    if (!series) continue;
    const convention = conventionFor(series);
    if (convention.kind === 'mixed') mixed.add(series);
    if (convention.defaulted) defaulted.add(series);
    const variant = title.includes(' - ') ? title.split(' - ').slice(1).join(' - ').trim() : '';
    report.pages++;

    // The size code for a template's xxx at a given printed size, under this
    // series' proven convention. Null means the expansion would be a guess.
    const codeFor = size => {
      if (convention.kind === 'mixed') return null;
      if (convention.kind === 'letter') {
        const code = LETTER_CODE[size];
        return code && convention.letters.has(code) ? code : null;
      }
      return SIZE_CODE[size] || null;
    };

    // Tables are runs of pipe rows; the size header carries over between
    // tables on a page, since continuation tables repeat the column shape
    // with an unlabelled header.
    let header = null; // { bySlot: Map(colIndex -> size label), width }
    let context = '';
    let rows = [];
    const flush = () => {
      if (!rows.length) return;
      report.tables++;
      const lead = rows.slice(0, 2).flatMap(r => r.slice(0, 2)).join(' ');
      if (SKIP_TABLE.test(lead)) { report.skippedTables++; rows = []; return; }
      const firstCell = (rows[0] || [])[0] || '';
      if (firstCell && !PART_TEMPLATE.test(firstCell) && !PART_FULL.test(firstCell)
          && !SIZE_CODE[firstCell] && !NOT_CONTEXT.test(firstCell)) {
        context = firstCell;
      }
      for (const cells of rows) {
        // A size header names at least two columns and carries no prices and
        // no part numbers; a doubled SIZE, MODEL, LIST row also holds two
        // size cells, so those two conditions are what tell them apart.
        const sized = cells.map((c, i) => ({ c, i })).filter(x => SIZE_CODE[x.c]);
        if (sized.length >= 2 && !SIZE_CODE[cells[0]]
            && !cells.some(c => moneyCount(c) >= 1)
            && !cells.some(c => PART_FULL.test(c) || PART_TEMPLATE.test(c))) {
          header = { bySlot: new Map(sized.map(x => [x.i, x.c])), width: cells.length };
          continue;
        }
        const first = cells[0] || '';
        if (SKIP_LABEL.test(first)) continue;

        // Triple rows: SIZE, MODEL, LIST, possibly twice across the row.
        let emitted = false;
        for (let i = 0; i + 2 < cells.length + 1; i++) {
          const size = cells[i], model = cells[i + 1] || '', price = cells[i + 2] || '';
          if (!SIZE_CODE[size]) continue;
          const pm = model.match(PART_FULL);
          if (!pm) continue;
          const money = price.match(MONEY_CELL);
          if (!money) { if (CF.test(price)) report.cf++; continue; }
          const part = pm[1] + (pm[2] ? `/${pm[2]}` : '');
          push(part, parseFloat(money[1].replace(/,/g, '')),
            describe({ series, variant, size, part, context, gloss: pm[3] || null }));
          emitted = true;
        }
        if (emitted) continue;

        // Matrix rows: a template priced across the active size columns.
        const tm = first.match(PART_TEMPLATE);
        if (tm) {
          if (cells.some(c => moneyCount(c) > 1)) { report.spanRefused++; continue; }
          if (!header || header.width !== cells.length) {
            if (cells.some(c => moneyCount(c) === 1)) report.modelless++;
            continue;
          }
          for (const [slot, size] of header.bySlot) {
            const cell = cells[slot] || '';
            const money = cell.match(MONEY_CELL);
            if (!money) { if (CF.test(cell)) report.cf++; continue; }
            const code = codeFor(size);
            if (!code) { report.unevidencedSize++; continue; }
            const part = tm[1].replace('xxx', code) + (tm[2] ? `/${tm[2]}` : '');
            push(part, parseFloat(money[1].replace(/,/g, '')),
              describe({ series, variant, size, part, context, gloss: tm[3] || null }));
          }
          continue;
        }

        // A complete part with a single price on the row (the list-column pages).
        const fm = first.match(PART_FULL);
        if (fm) {
          const money = cells.map(c => c.match(MONEY_CELL)).filter(Boolean);
          if (money.length === 1) {
            const part = fm[1] + (fm[2] ? `/${fm[2]}` : '');
            const seg = fm[1].match(SIZE_OF_FULL)?.[1];
            push(part, parseFloat(money[0][1].replace(/,/g, '')),
              describe({ series, variant, size: CODE_LABEL[seg] || null, part, context, gloss: fm[3] || null }));
          } else if (cells.some(c => CF.test(c))) report.cf++;
          continue;
        }

        // A priced row with no part number prices nothing, and is counted.
        if (cells.some(c => moneyCount(c) >= 1)) {
          report.modelless++;
        } else if (first && cells.slice(1).every(c => !c) && !NOT_CONTEXT.test(first)) {
          context = first;
        }
      }
      rows = [];
    };

    for (const raw of section.split(/\r?\n/)) {
      if (/^\|/.test(raw.trim())) {
        const cells = raw.trim().split('|').slice(1, -1).map(c => c.trim());
        if (cells.every(c => /^-*$/.test(c))) continue;
        rows.push(cells);
      } else flush();
    }
    flush();
  }

  // The same code printed at two different prices prices nothing until a
  // ruling; both readings are withdrawn.
  if (conflicts.size) {
    for (let i = parts.length - 1; i >= 0; i--) if (conflicts.has(parts[i].part)) parts.splice(i, 1);
    report.conflicts = conflicts.size;
  }
  report.parts = parts.length;
  return {
    parts, report, conflictParts: [...conflicts],
    defaultedSeries: [...defaulted], mixedSeries: [...mixed],
  };
}
