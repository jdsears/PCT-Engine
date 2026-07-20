// The two Richards books whose tables the generic parser rightly refused,
// each with its own narrow spec. BestoBell pairs every price row with a Part
// Number row carrying real manufacturer part numbers, position-aligned to
// the same size columns, so parts here get their true numbers rather than
// derived slugs. Hex is flat: one row per orderable part, model number
// first, list price last. Food and Beverage stays refused: its tables merge
// one price across several size columns, and a parser that guesses which
// size a merged price belongs to would misprice.

const SIZE_CODES = {
  '3/8"': '038', '1/2"': '050', '3/4"': '075', '1"': '100',
  '1 1/4"': '125', '1 1/2"': '150', '2"': '200', '2 1/2"': '250', '3"': '300', '4"': '400',
};
const SIZE_RE = /\d+[ -]\d\/\d"|\d\/\d"|\d+"/g;
const canonSize = s => s.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
const MONEY = /\$\s?([\d,]+)(?:\.\d{2})?/g;

function sizeColumns(line) {
  SIZE_RE.lastIndex = 0;
  const cols = [];
  for (const m of line.matchAll(SIZE_RE)) {
    const label = canonSize(m[0]);
    if (!SIZE_CODES[label]) continue;
    cols.push({ label, at: m.index + Math.floor(m[0].length / 2) });
  }
  return cols.length >= 2 ? cols : null;
}
// A price claims a column only when it clearly sits under one: near enough,
// and decisively nearer than the runner-up. BestoBell prints some prices
// spanning a pair of sizes, and claiming either side would be a guess, so an
// ambiguous position is skipped and counted, never resolved by proximity.
const nearestCol = (cols, at) => {
  let best = null, second = null;
  for (const c of cols) {
    const d = Math.abs(c.at - at);
    if (!best || d < best.d) { second = best; best = { c, d }; }
    else if (!second || d < second.d) second = { c, d };
  }
  if (!best || best.d > 12) return null;
  if (second && second.d - best.d < 8) return { ambiguous: true };
  return best.c;
};

// BestoBell: "Model GM3  1/2" 3/4" ..." headers, then pairs of a priced
// connection row and its Part Number row. Only a column holding both a price
// and a part number becomes a part; CONSULT FACTORY rows price nothing.
export function parseBestobell(text) {
  const lines = String(text || '').split(/\r?\n/);
  const parts = [];
  const seen = new Set();
  const report = { models: 0, rows: 0, parts: 0, ambiguous: 0 };
  let model = null, cols = null, pending = null;
  for (const raw of lines) {
    const mh = raw.match(/^\s*Model\s+([A-Z]{1,3}\d+[A-Z]?)\b/);
    if (mh) {
      const c = sizeColumns(raw);
      if (c) { model = mh[1]; cols = c; pending = null; report.models++; }
      continue; // a sidebar "Model GM3" without sizes never resets context
    }
    if (!model || !cols) continue;
    if (/^\s*Part Number\b/i.test(raw)) {
      if (!pending) continue;
      const pns = [...raw.matchAll(/\b([A-Z]{1,3}\d{3,}[A-Z]?\d*)\b/g)]
        .filter(m => m[1] !== 'Part')
        .map(m => ({ pn: m[1], at: m.index + Math.floor(m[1].length / 2) }));
      for (const { pn, at } of pns) {
        const col = nearestCol(cols, at);
        if (!col || col.ambiguous) { if (col?.ambiguous) report.ambiguous++; continue; }
        const price = pending.byCol.get(col.label);
        if (price == null) continue;
        if (seen.has(pn)) continue;
        seen.add(pn);
        parts.push({ part: pn, description: `BestoBell ${model} ${pending.label}, ${col.label}`, listUsd: price });
        report.parts++;
      }
      pending = null;
      continue;
    }
    MONEY.lastIndex = 0;
    const money = [...raw.matchAll(MONEY)];
    if (!money.length) { if (!/consult factory/i.test(raw)) pending = null; continue; }
    const label = raw.slice(0, money[0].index).replace(/\s+/g, ' ').trim();
    if (!label || /adder|blow ?down|page/i.test(label)) { pending = null; continue; }
    const byCol = new Map();
    for (const m of money) {
      const col = nearestCol(cols, m.index + Math.floor(m[0].length / 2));
      if (col && !col.ambiguous) byCol.set(col.label, parseFloat(m[1].replace(/,/g, '')));
      else if (col?.ambiguous) report.ambiguous++;
    }
    pending = { label, byCol };
    report.rows++;
  }
  return { parts, report };
}

// Hex: one orderable part per row, model number first, list price last. The
// middle columns become the description; a leading short group code (HN41)
// sharing the line is dropped.
export function parseHex(text) {
  const lines = String(text || '').split(/\r?\n/);
  const parts = [];
  const seen = new Set();
  const report = { rows: 0, parts: 0 };
  for (const raw of lines) {
    const m = raw.match(/^\s*(?:[A-Z]{2}\d{2}\s+)?([A-Z]{2,4}\d{2,}[A-Z0-9]{4,})\s+(.+?)\s+\$\s?([\d,]+)(?:\.\d{2})?\s*$/);
    if (!m) continue;
    const [, pn, middle, price] = m;
    if (/model number|list price/i.test(raw)) continue;
    report.rows++;
    if (seen.has(pn)) continue;
    seen.add(pn);
    const desc = middle.replace(/\s{2,}/g, ', ').replace(/\s+/g, ' ').trim();
    parts.push({ part: pn, description: `Hex ${desc}`.slice(0, 160), listUsd: parseFloat(price.replace(/,/g, '')) });
    report.parts++;
  }
  return { parts, report };
}
