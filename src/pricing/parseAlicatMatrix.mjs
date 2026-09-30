// The tables on the Alicat lists that price by range rather than by part
// number, from John's verbatim reads of 22 and 28 September 2026. The OEM
// and Coriolis sections (Basis MEMS Thermal, EPC, Standard and High
// Accuracy CODA) print a flow or pressure band down the side and the series
// codes across the top (B and BC; EP, EPS, EPC and EPCD; K, KC, KF and KG),
// a figure in each cell; the supplier's list repeats the codes under a
// Partner Price heading, the customer list prints list prices only.
// Recalibration and cleaning price the same way, by flow range or product
// family against Standard and High Accuracy, two tables side by side, and
// the list itself says no discount applies to them. Nothing here is a part
// number, so a part in one of these series resolves to its band at lookup.
// Pure over the layout text; every shape is provable.

const text = x => String(x ?? '').replace(/\s+/g, ' ').trim();

// Cells of a layout line: runs of text separated by two or more spaces,
// each with where it starts.
export function cellsOf(line) {
  const out = [];
  const re = /\S(?:\s?\S)*/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    const last = out[out.length - 1];
    // A band the layout breaks after its dash ("1000slpm -    5000slpm")
    // is one cell.
    if (last && /-$/.test(last.text) && /^\d/.test(m[0])) { last.text = `${last.text} ${m[0]}`; last.end = m.index + m[0].length; continue; }
    // A figure with words one space after it ("$350 IP65 or IP66") is a
    // figure and then the next cell.
    const split = /^(-?[£$€]\s?[\d,]+(?:\.\d{1,2})?)\s(\S.*)$/.exec(m[0]);
    if (split) {
      out.push({ text: split[1], x: m.index, end: m.index + split[1].length });
      out.push({ text: split[2], x: m.index + split[1].length + 1, end: m.index + m[0].length });
      continue;
    }
    out.push({ text: m[0], x: m.index, end: m.index + m[0].length });
  }
  return out;
}

const VALUE = /^(-)?\s?([£$€])\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)$/;
const NA = /^N\/A$/i;
const SYMBOL = { '£': 'GBP', '$': 'USD', '€': 'EUR' };
// A figure in a cell, N/A, or nothing. Zero is a figure here ("RS485 $0"
// is a no-cost option), where a part price of zero would be a misread.
export function valueOf(cellText) {
  const t = text(cellText);
  if (NA.test(t)) return { kind: 'na' };
  const m = VALUE.exec(t);
  if (!m) return null;
  const n = parseFloat(m[3].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return { kind: 'price', price: (m[1] ? -1 : 1) * Math.round(n * 100) / 100, currency: SYMBOL[m[2]] };
}
const isValue = c => valueOf(c.text) != null;

// A band as the list prints it: "100sccm - 20slpm", "1PSI - 100PSI",
// "500PSI", "40 g/h - 300 g/h", "1 kg/h - 10 kg/h", "0.5sccm - 10sccm".
// Normalised to one unit per quantity so a part's own figure can be placed.
const UNITS = {
  sccm: ['gas flow', 'sccm', 1], slpm: ['gas flow', 'sccm', 1000],
  ccm: ['liquid flow', 'ccm', 1], lpm: ['liquid flow', 'ccm', 1000],
  'g/h': ['mass flow', 'g/h', 1], 'kg/h': ['mass flow', 'g/h', 1000],
  psi: ['pressure', 'psi', 1], psia: ['pressure', 'psi', 1], psig: ['pressure', 'psi', 1], psid: ['pressure', 'psi', 1],
  torr: ['pressure', 'torr', 1], torra: ['pressure', 'torr', 1], bar: ['pressure', 'bar', 1], mbar: ['pressure', 'bar', 0.001],
};
export function parseRangeLabel(s) {
  const t = text(s).toLowerCase();
  const m = /^(\d+(?:\.\d+)?)\s*([a-z\/]*)(?:\s*-\s*(\d+(?:\.\d+)?)\s*([a-z\/]+))?$/.exec(t);
  if (!m) return null;
  const unitB = m[4] || m[2], unitA = m[2] || unitB;
  const ua = UNITS[unitA], ub = UNITS[unitB];
  if (!ua || !ub || ua[0] !== ub[0]) return null;
  const min = parseFloat(m[1]) * ua[2];
  const max = m[3] != null ? parseFloat(m[3]) * ub[2] : min;
  return { quantity: ua[0], unit: ua[1], min, max };
}

// A part's own figure in the same terms: the segment after the series,
// "10SLPM" in BC-10SLPM-D, "100PSIG" in EPC-100PSIG-D, "300GH" or "10KGH"
// in a CODA code. Null when the segment names no unit the tables use.
export function partFigure(partNumber) {
  const seg = String(partNumber || '').toUpperCase().split(/[-\/]/)[1] || '';
  const m = /^(\d+(?:\.\d+)?)([A-Z\/]+)$/.exec(seg);
  if (!m) return null;
  const unit = m[2].toLowerCase().replace(/^gh$/, 'g/h').replace(/^kgh$/, 'kg/h');
  const u = UNITS[unit];
  if (!u) return null;
  return { quantity: u[0], unit: u[1], value: parseFloat(m[1]) * u[2] };
}

// The sections the reader knows, by the heading the list prints. A heading
// at the left margin (the line's first cell) starts a new table and closes
// every open one; a heading further along ("All Other Recalibrations",
// "Cleaning") opens beside whatever is open to its left, side by side. A
// heading opens only when nothing to its right on the line is a figure, so
// "EPC" as a row label in the recalibration table ("EPC $300 N/A") is a
// row and "EPC (min. qty 50)" is a heading; and the series code EPC on a
// codes line is never a heading because it is not the line's first cell.
const SECTIONS = [
  { re: /^Basis MEMS Thermal/i, name: 'Basis MEMS Thermal', first: true },
  { re: /^EPC\b/i, name: 'EPC', first: true },
  { re: /^Standard Accuracy CODA/i, name: 'Standard Accuracy CODA', first: true },
  { re: /^High Accuracy CODA/i, name: 'High Accuracy CODA', first: true },
  { re: /^Mainline Recalibrations/i, name: 'Mainline Recalibrations', first: true },
  { re: /^All Other Recalibrations/i, name: 'All Other Recalibrations', first: false },
  { re: /^Recalibration Add-Ons/i, name: 'Recalibration Add-Ons', first: true },
  { re: /^Cleaning$/i, name: 'Cleaning', first: false },
];
const UMBRELLA = /Recalibrations and Cleaning/i;
const STOP = /\bPage \d+ of \d+\b|^\s*Effective\s|CODA Options|Accessories|Product Options|OEM Products/i;
const ROW_LABEL_HEADER = /^(Flow Range|Pressure Range|Flow Channel|Communication|Display)$/i;
const OPTION_NAME_COLUMN = /^(Options|Add\. Options|Options Add\. Price)$/i;
const CODE = /^[A-Z]{1,5}$/;

// The whole read: sections with their columns and rows, and the flat
// entries a store takes, one per priced cell. currency is the list's own;
// a figure in another currency is set aside and named. In sell mode a
// partner column is never an entry.
export function parseMatrixTables(src, { currency = 'GBP', mode = 'sell' } = {}) {
  const lines = String(src || '').replace(/\f/g, '\n').split(/\r?\n/);
  const out = { sections: [], entries: [], skipped: [], otherCurrency: [] };
  let active = [];
  let noDiscount = false;
  const owner = (x) => { let hit = null; for (const s of active) if (s.x <= x + 1) hit = s; return hit || active[0] || null; };
  const open = (def, cell, headerCells) => {
    if (def.first) active = [];
    else active = active.filter(s => Math.abs(s.x - cell.x) > 10);
    // A minimum order in the heading ("EPC (min. qty 50)") is a note the
    // table's prices carry; a minimum of one says nothing.
    const qty = /\(min\.?\s*qty\.?\s*(\d+)\)/i.exec(cell.text);
    const notes = qty && Number(qty[1]) > 1 ? [`Minimum order quantity ${qty[1]}.`] : [];
    const sec = { name: def.name, x: cell.x, noDiscount, columns: null, partner: false, groups: null, rows: [], notes };
    if (headerCells?.length) sec.columns = headerCells.map(c => ({ label: text(c.text), x: c.x }));
    active.push(sec);
    active.sort((a, b) => a.x - b.x);
    out.sections.push(sec);
    return sec;
  };
  // Each cell to the section that owns its x, and each section reads its
  // own cells as one row.
  const readCells = (cs, line) => {
    const by = new Map();
    for (const c of cs) { const s = owner(c.x); if (!s) continue; if (!by.has(s)) by.set(s, []); by.get(s).push(c); }
    for (const [sec, own] of by) readRow(sec, own, line);
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    if (UMBRELLA.test(line)) { noDiscount = /no discount/i.test(line); active = []; continue; }
    if (STOP.test(line)) { active = []; continue; }
    const cells = cellsOf(line);
    // Headings on the line, each opening a section at its own x, with the
    // label cells to its right as its columns ("Cleaning  low flow  mid
    // flow  high flow"). Cells to the left of the first heading are a row
    // of whatever section was already open there.
    const heads = [];
    for (const [i, c] of cells.entries()) {
      const def = SECTIONS.find(d => d.re.test(c.text));
      if (!def || (def.first && i !== 0)) continue;
      const right = cells.slice(i + 1);
      if (right.some(isValue)) continue;
      heads.push({ def, cell: c, right: right.filter(r => !SECTIONS.some(d => d.re.test(r.text))) });
    }
    if (heads.length) {
      const dataCells = cells.slice(0, cells.indexOf(heads[0].cell));
      if (dataCells.length && active.length) readCells(dataCells, line);
      for (const h of heads) open(h.def, h.cell, h.right.length ? h.right : null);
      continue;
    }
    if (!active.length) continue;
    readCells(cells, line);
  }
  function readRow(sec, cells, line) {
    if (!sec.columns) {
      if (cells.some(c => /List Price|Partner Price/i.test(c.text))) { sec.partner = sec.partner || cells.some(c => /Partner Price/i.test(c.text)); return; }
      if (cells.every(c => !isValue(c))) {
        const codes = cells.filter(c => CODE.test(c.text));
        if (codes.length >= 2) {
          // The codes line. A leading row-label header and a bare star are
          // not columns; trailing option headings ("Options", "Add. Price")
          // are, so the EPC adders beside the bands are read as their own.
          const cols = cells.filter(c => !ROW_LABEL_HEADER.test(c.text) && c.text !== '*').map(c => ({ label: text(c.text), x: c.x }));
          const codeCols = cols.filter(c => CODE.test(c.label));
          const half = codeCols.length / 2;
          const repeats = Number.isInteger(half) && half >= 1 && codeCols.slice(0, half).every((c, i) => c.label === codeCols[half + i].label);
          sec.columns = cols;
          sec.groups = repeats ? { list: codeCols.slice(0, half).map(c => c.label), partner: codeCols.slice(half).map(c => c.label), partnerStartsAt: cols.indexOf(codeCols[half]) } : null;
          sec.partner = sec.partner || repeats;
          return;
        }
        const labels = cells.length > 1 && cells[0].x <= sec.x + 2 ? cells.slice(1) : cells;
        if (cells.length >= 2 && labels.every(c => /[A-Za-z]/.test(c.text))) { sec.columns = labels.map(c => ({ label: text(c.text), x: c.x })); return; }
        return; // a lone row-label header, or a note
      }
      sec.columns = [{ label: 'Price', x: null, implicit: true }];
    }
    const [labelCell, ...rest] = cells;
    if (!labelCell || isValue(labelCell)) { out.skipped.push(line.slice(0, 240)); return; }
    if (!rest.some(isValue)) return; // a title or a note between tables, not a row
    const label = text(labelCell.text);
    const range = parseRangeLabel(label);
    // The cells after the label map to the columns in order; text in a
    // column position is a note ("Only quote non-display variant until
    // CODA display is released.").
    const cols = sec.columns;
    const vals = rest.map(c => ({ text: text(c.text), value: valueOf(c.text) }));
    const row = { label, range, values: vals };
    sec.rows.push(row);
    // Words printed past the last column are the table's note, whichever row
    // the layout put them beside, and apply to every price in it.
    for (const v of vals.slice(cols.length)) {
      if (!v.value && /[a-z]{3,}.*[a-z]{3,}/i.test(v.text) && v.text.length >= 12 && !sec.notes.includes(v.text)) sec.notes.push(v.text);
    }
    if (!range && sec.groups) { out.skipped.push(line.slice(0, 240)); return; }
    const entry = (colLabel, v, partner) => {
      if (v.currency !== currency) { out.otherCurrency.push(`${sec.name} ${label} ${colLabel} ${v.price}`); return; }
      out.entries.push({
        section: sec.name, rowLabel: label, colLabel, quantity: range?.quantity || null, unit: range?.unit || null, min: range?.min ?? null, max: range?.max ?? null,
        currency, price: v.price, partnerPrice: mode === 'supplier' && partner?.kind === 'price' && partner.currency === currency ? partner.price : null,
        noDiscount: sec.noDiscount, line: line.slice(0, 240),
      });
    };
    // The option pair beyond the priced columns ("Options  Add. Price", or
    // the two as one heading on the customer list): a name, then its adder,
    // the section's own options and never a band price.
    const optionPair = (i) => {
      const name = vals[i], adder = vals[i + 1];
      if (!name || name.value || adder?.value?.kind !== 'price' || adder.value.currency !== currency) return;
      out.entries.push({ section: `${sec.name} options`, rowLabel: name.text, colLabel: 'Add. Price', quantity: null, unit: null, min: null, max: null, currency, price: adder.value.price, partnerPrice: null, noDiscount: sec.noDiscount, line: line.slice(0, 240) });
    };
    // A code table gives one entry per list column with its partner figure
    // beside it; a label table one per column.
    if (sec.groups) {
      const half = sec.groups.list.length;
      for (let k = 0; k < half; k++) {
        const lv = vals[k]?.value;
        if (lv?.kind === 'price') entry(cols[k].label, lv, vals[half + k]?.value);
      }
      const firstOption = cols.findIndex(c => OPTION_NAME_COLUMN.test(c.label));
      if (firstOption !== -1) optionPair(firstOption);
      return;
    }
    for (let i = 0; i < cols.length; i++) {
      if (OPTION_NAME_COLUMN.test(cols[i].label)) { optionPair(i); break; }
      const v = vals[i]?.value;
      if (v?.kind === 'price') entry(cols[i].label, v, null);
    }
  }
  // Each priced cell carries its table's notes, gathered once the whole
  // table is read. An option adder is not the unit, so it carries none.
  const notes = new Map();
  for (const s of out.sections) if (s.notes.length) notes.set(s.name, [...(notes.get(s.name) || []), ...s.notes]);
  for (const e of out.entries) e.note = notes.has(e.section) ? [...new Set(notes.get(e.section))].join(' ') : null;
  return out;
}

// Which entry a part or a service question lands on: the column is the
// series (B, BC, EP, K, ...) or a table label (Standard, High Accuracy), the
// row is the band the figure falls in. Pure over stored entries.
export function matchBand(entries, { colLabel, quantity, value }) {
  const col = String(colLabel || '').toUpperCase();
  return entries.find(e => String(e.colLabel).toUpperCase() === col && e.quantity === quantity && e.min != null && value >= e.min && value <= e.max) || null;
}
