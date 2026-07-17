// The generic Richards price-book parser, for the house style the Steriflow,
// LowFlow, BestoBell, Hex, Food and Beverage and Jordan lists share: a model
// title per section, size-column tables, price rows labelled by body and
// connection, with options, adders and spares tables interleaved. Two things
// make it safe where a simpler reading would misprice. Prices align to sizes
// by character position against the header's column spans, because these
// books omit empty cells without placeholders, so order-based zipping walks
// prices onto the wrong sizes. And a line carrying only prices merges into
// the following label row, because the layout splits rows that way. Adders,
// options, spares, repair and accessory sections are skipped wholesale; a
// guide price is a base item or nothing.

const SIZE_CODES = {
  '1/4"': '025', '3/8"': '038', '1/2"': '050', '3/4"': '075', '1"': '100',
  '1 1/4"': '125', '1 1/2"': '150', '2"': '200', '2 1/2"': '250', '3"': '300', '4"': '400', '6"': '600',
};
// Sizes appear as 1 1/2" and as 1-1/2" across the books; both canonicalise.
// The global regex exists for matchAll only; boolean checks use the
// non-global twin, because .test on a global regex leaves a cursor behind
// and matchAll clones that cursor, silently skipping the start of the next
// line. That was a live, sequence-dependent parse fault.
const SIZE_RE = /\d+[\s-]+\d\/\d"|\d\/\d"|\d+"/g;
const SIZE_TEST = /\d+[\s-]+\d\/\d"|\d\/\d"|\d+"/;
const canonSize = s => s.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();

// The size header with column spans: label plus [start, end) in characters.
// A single-size table (LowFlow's fractional valves) qualifies only when the
// line reads like a table header, so a stray size in prose never becomes one.
export function parseSizeColumns(line) {
  const cols = [];
  SIZE_RE.lastIndex = 0;
  for (const m of line.matchAll(SIZE_RE)) {
    const label = canonSize(m[0]);
    if (!SIZE_CODES[label]) continue;
    cols.push({ label, start: m.index, end: m.index + m[0].length });
  }
  if (cols.length === 1 && !/\b(body|end|size|conn)/i.test(line)) return null;
  if (cols.length < 1) return null;
  // Widen each span to midpoints so a price anywhere under a column maps to it.
  for (let i = 0; i < cols.length; i++) {
    const leftEdge = i === 0 ? Math.max(0, cols[i].start - 12) : Math.ceil((cols[i - 1].end + cols[i].start) / 2);
    const rightEdge = i === cols.length - 1 ? cols[i].end + 24 : Math.floor((cols[i].end + cols[i + 1].start) / 2);
    cols[i].span = [leftEdge, rightEdge];
  }
  // A connection-orientation qualifier on the header keeps the vertical and
  // horizontal groups of the same model from colliding on one part key.
  const q = (line.match(/horiz\w*\s+in\s+vert\w*\s+out|vert\w*\s+in\s+horiz\w*\s+out|horizontal|vertical/i) || [])[0];
  const QMAP = { vertical: 'V', horizontal: 'H' };
  cols.qualifier = q ? (QMAP[q.toLowerCase()] || q.toLowerCase().split(/\s+/).map(w => w[0].toUpperCase()).join('')) : null;
  return cols;
}

// A model title: a mostly-uppercase line without prices or sizes, carrying a
// recognisable model code. The code becomes the part-number stem.
const MODEL_CODE = /\b(?:MARK|MK)\s?-?\s?(\d{2,4}\w{0,4})\b|\b([A-Z]{2,6}-?\d{2,4}\w{0,4})\b|\b(J-PURE\s+\w{2,8}|JSHM|SSC|SVC|SHC)\b/;
export function parseModelTitle(line) {
  const t = line.trim();
  if (!t || t.length < 6 || /\$/.test(t) || SIZE_TEST.test(t)) return null;
  const letters = t.replace(/[^A-Za-z]/g, '');
  if (!letters || letters.replace(/[^A-Z]/g, '').length / letters.length < 0.7) return null;
  const m = t.match(MODEL_CODE);
  if (!m) return null;
  const code = (m[1] ? `MK${m[1]}` : (m[2] || m[3] || '')).replace(/\s+/g, '').toUpperCase();
  if (!code || /^(PAGE|LIST|PRICE|SERIES|NOTE)/.test(code)) return null;
  return { code, title: t.replace(/\s{2,}Page \d+\s*$/i, '').replace(/\s+/g, ' ').trim() };
}

const SKIP_SECTION = /options?\s*&?\s*adders?|adders?\b|spare parts|repair kits?|accessories|misc options|documentation|terms|sample cases?/i;
const SKIP_LABEL = /adder|spare|repair|kit|gasket|element|weight|torque|finish|polish|note:|p\/n|consult factory/i;
const MONEY = /-?\$\s?[\d,]+(?:\.\d{2})?/g;
const MONEY_TEST = /-?\$\s?[\d,]+(?:\.\d{2})?/;

// Parse a whole book's -layout text into base parts.
export function parseRichardsBook(text, { line = 'richards' } = {}) {
  const lines = String(text || '').split(/\r?\n/);
  const parts = [];
  const seen = new Set();
  const report = { models: 0, rows: 0, parts: 0, skippedSections: 0 };
  let model = null, cols = null, skipping = false, orphan = null, pendingLabel = null;

  // A line that is only a row label, the grouped-table style where the label
  // stands above its prices: short, wordy, not a material or column heading.
  const labelOnly = (t) =>
    t && t.length >= 3 && t.split(/\s+/).length <= 6 && /[A-Za-z]{3}/.test(t) &&
    /^[A-Z0-9]/.test(t) && // sidebar prose runs lowercase; row labels never do
    !SKIP_LABEL.test(t) && !/^(body|ends?|316L\*?|\*|•)/i.test(t) && !SIZE_TEST.test(t);

  for (const raw of lines) {
    const title = parseModelTitle(raw);
    if (title) {
      model = title; cols = null; skipping = false; orphan = null; pendingLabel = null;
      report.models++;
      continue;
    }
    if (SKIP_SECTION.test(raw) && !MONEY_TEST.test(raw)) { skipping = true; report.skippedSections++; orphan = null; pendingLabel = null; continue; }
    const header = parseSizeColumns(raw);
    if (header && !MONEY_TEST.test(raw)) {
      // A fresh size header inside a skipped section stays skipped; adder
      // tables carry their own headers. Only a new model title resets.
      cols = header; orphan = null; pendingLabel = null;
      continue;
    }
    if (!model || !cols || skipping) continue;

    MONEY.lastIndex = 0;
    const money = [...raw.matchAll(MONEY)];
    if (!money.length) {
      const t = raw.replace(/\s+/g, ' ').trim();
      if (labelOnly(t)) pendingLabel = t;
      continue;
    }
    // Sidebar prose can share the line with a table row; row labels start
    // with a capital or digit, so leading lowercase tokens are the sidebar's.
    let label = raw.slice(0, money[0].index).replace(/\s+/g, ' ').trim();
    while (label && /^[a-z]/.test(label)) {
      const cut = label.indexOf(' ');
      if (cut === -1) { label = ''; break; }
      label = label.slice(cut + 1);
    }
    const positioned = money.map(m => ({
      at: m.index + Math.floor(m[0].length / 2),
      value: parseFloat(m[0].replace(/[$,\s]/g, '')),
    })).filter(p => Number.isFinite(p.value) && p.value > 0);

    if (!label && pendingLabel) { label = pendingLabel; pendingLabel = null; }
    if (!label) { orphan = (orphan || []).concat(positioned); continue; }
    if (SKIP_LABEL.test(label)) { orphan = null; continue; }
    report.rows++;
    const all = [...(orphan || []), ...positioned];
    orphan = null;
    for (const p of all) {
      const col = cols.find(c => p.at >= c.span[0] && p.at < c.span[1]);
      if (!col) continue;
      const slug = label.replace(/[^A-Za-z0-9]+/g, '').slice(0, 14).toUpperCase();
      const part = `${model.code}-${SIZE_CODES[col.label]}-${slug}${cols.qualifier && cols.qualifier !== 'V' ? '-' + cols.qualifier : ''}`;
      if (seen.has(part)) continue;
      seen.add(part);
      parts.push({
        part,
        description: `${model.title}, ${label}, ${col.label}`,
        listUsd: p.value,
      });
      report.parts++;
    }
  }
  return { parts, report, line };
}
