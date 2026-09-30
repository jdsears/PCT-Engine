import { pool, hasColumn } from '../db.mjs';
import { parseRangeLabel, partFigure } from './parseAlicatMatrix.mjs';
import { costFrom, isoDay } from './supplierPrices.mjs';

// The questions the tables priced by band answer (migration 044), 30
// September 2026: recalibration and cleaning, priced by flow range or
// product family against Standard and High Accuracy, and the OEM and
// Coriolis series (Basis MEMS Thermal, EPC, CODA), priced by a flow or
// pressure band against the series. None of these cells is a part number,
// so a question is read for the service, the family, the series and the
// figure, and answered from the cells that hold them, sell price by
// default. The purchase price is added only on an explicit ask, from the
// supplier's side of the same table, under the same rule as parts. No model
// anywhere in the path.

const RECAL = /\bre-?cal(?:ibrat\w*|s)?\b/i;
const CLEANING = /\b(?:cleaning|ultra-?sonic\s+clean\w*|oxygen\s+clean\w*)\b/i;
export const serviceIntent = q => RECAL.test(String(q || '')) || CLEANING.test(String(q || ''));
// "How much is a recal" asks for money, where "how much flow" never does,
// so a service question counts as a price question on these words too.
export const serviceMoneyIntent = q => serviceIntent(q)
  && /\b(?:how much|charges?|fees?|price[sd]?|pricing|cost(?:s|ed)?|quote|quotation)\b/i.test(String(q || ''));

// Part codes in the question: a series, then hyphen-joined segments.
const codesIn = q => [...new Set(String(q || '').toUpperCase().match(/\b[A-Z]{1,5}\d{0,3}(?:-[A-Z0-9.\/]+)+/g) || [])];

// Which row of the recalibration table, or which OEM table, a part belongs
// to, from its series. Mainline gas flow is priced by flow range; pressure,
// liquid and the OEM and Coriolis series each have a row of their own.
const SERIES_FAMILY = [
  [/^FP$/, 'FP-25'],
  [/^(?:K|KC|KF|KG)$/, 'CODA'],
  [/^(?:B|BC)$/, 'Basis'],
  [/^(?:EP|EPS|EPC|EPCD)$/, 'EPC'],
  [/^P[A-Z]*$/, 'Pressure'],
  [/^L[A-Z]*$/, 'Liquid'],
  [/^M[A-Z]*$/, 'Mainline'],
];
const FAMILY_WORDS = [
  [/\bfp-?25\b/i, 'FP-25'],
  [/\bcoda\b|\bcoriolis\b/i, 'CODA'],
  [/\bbasis\b/i, 'Basis'],
  [/\b(?:epcd|epc|eps)\b/i, 'EPC'],
  [/\bliquid\b/i, 'Liquid'],
  [/\bpressure\b/i, 'Pressure'],
  [/\bmainline\b|\b(?:gas|mass)\s+flow\b/i, 'Mainline'],
];
function familyOf(q, codes) {
  for (const c of codes) {
    const hit = SERIES_FAMILY.find(([re]) => re.test(c.split('-')[0]));
    if (hit) return { family: hit[1], code: c };
  }
  const w = FAMILY_WORDS.find(([re]) => re.test(q));
  return { family: w ? w[1] : null, code: null };
}

// The figure a band is chosen by: from a part code's range segment
// (MC-100SLPM-D is 100 slpm), else a number and unit in the words.
function figureIn(q, codes) {
  for (const c of codes) { const f = partFigure(c); if (f) return { ...f, text: c }; }
  const m = /(\d+(?:\.\d+)?)\s*(sccm|slpm|ccm|lpm|kg\s*\/\s*h|g\s*\/\s*h|kgh|psi[agd]?|torr|bar)\b/i.exec(String(q || ''));
  if (!m) return null;
  const unit = m[2].toLowerCase().replace(/\s+/g, '').replace(/^kgh$/, 'kg/h');
  const r = parseRangeLabel(`${m[1]}${unit}`);
  return r ? { quantity: r.quantity, unit: r.unit, value: r.min, text: `${m[1]} ${m[2]}` } : null;
}

const OEM = [
  { family: 'Basis', sections: ['Basis MEMS Thermal'], cols: ['B', 'BC'] },
  { family: 'EPC', sections: ['EPC'], cols: ['EP', 'EPS', 'EPC', 'EPCD'] },
  { family: 'CODA', sections: ['Standard Accuracy CODA', 'High Accuracy CODA'], cols: ['K', 'KC', 'KF', 'KG'] },
];
// The series column: a code's own series, or the series named in capitals
// ("BC", "KF", "EPCD"). A unit is never a series ("5 KG/H" is a figure), and
// "EPC" names the whole line, so it filters no column.
function seriesCol(q, codes, oem) {
  for (const c of codes) { const s = c.split('-')[0]; if (oem.cols.includes(s)) return s; }
  const words = String(q || '').match(/(?<!\d\s?)\b[A-Z]{2,4}\b(?!\s*\/)/g) || [];
  return words.find(w => oem.cols.includes(w) && !(oem.family === 'EPC' && w === 'EPC')) || null;
}

const ADD_ONS = [
  [/iso\s*-?\s*17025/i, q => (/expedit/i.test(q) ? /expedited\s*iso/i : /standard\s*iso/i)],
  [/\bexpedit\w*\s+service\b/i, () => /expedited\s*service/i],
  [/\b(?:additional|extra)\s+(?:calibration\s+)?cert/i, () => /additional\s*calibration\s*cert/i],
  [/\b(?:additional|extra)\s+(?:calibration\s+)?point/i, () => /additional\s*calibration\s*point/i],
];

// What the question asks of the tables, or null when it asks nothing they
// hold, so an ordinary part price question is never taken from the parts.
export function matrixQuestion(question) {
  const q = String(question || '');
  const codes = codesIn(q);
  const { family, code } = familyOf(q, codes);
  const figure = figureIn(q, codes);
  const highAccuracy = /\bhigh[- ]accuracy\b/i.test(q) || codes.some(c => c.split('-').includes('HC'));
  if (RECAL.test(q)) return { kind: 'recal', family, code, figure, highAccuracy, addOns: ADD_ONS.filter(([re]) => re.test(q)).map(([, pick]) => pick(q)) };
  if (CLEANING.test(q)) {
    const rows = [/ultra-?sonic/i.test(q) && /ultra-?sonic/i, /oxygen/i.test(q) && /oxygen/i].filter(Boolean);
    return { kind: 'cleaning', rows, code, figure };
  }
  const oem = OEM.find(o => o.family === family);
  if (!oem) return null;
  // "Basis" is also an ordinary word ("on what basis is it priced"), so
  // named alone it takes the table only with a figure, a series or a word
  // that makes it the product.
  const col = seriesCol(q, codes, oem);
  if (family === 'Basis' && !code && !figure && !col && !/\b(?:mems|thermal|meter|controller)s?\b/i.test(q)) return null;
  const options = [/ip\s*6[56]/i.test(q) && /ip\s*6/i, /io-?link/i.test(q) && /iolink/i, /rs-?485/i.test(q) && /rs485/i].filter(Boolean);
  return { kind: 'oem', family, code, figure, highAccuracy, statedAccuracy: /\b(?:high|standard)[- ]accuracy\b/i.test(q), col, options };
}

const band = s => String(s || '').replace(/\s+-\s+/g, ' to ').replace(/\*+/g, '').replace(/\s+/g, ' ').trim();
// A figure in the words a reader uses, whichever unit it was read in.
export function figureWords(f) {
  if (!f) return '';
  const v = Number(f.value);
  const big = (div, small, large) => (v >= div ? `${+(v / div).toFixed(3)} ${large}` : `${v} ${small}`);
  if (f.unit === 'sccm') return big(1000, 'sccm', 'slpm');
  if (f.unit === 'ccm') return big(1000, 'ccm', 'lpm');
  if (f.unit === 'g/h') return big(1000, 'g/h', 'kg/h');
  return `${v} ${f.unit}`;
}
const within = (e, f) => f && e.quantity === f.quantity && e.min != null && f.value >= e.min && f.value <= e.max;
// Cells grouped into the rows they were printed in, in the list's order.
function rowsOf(cells, label = c => band(c.rowLabel)) {
  const out = [];
  for (const c of cells) {
    const key = `${c.section}|${c.rowLabel}`;
    let row = out.find(r => r.key === key);
    if (!row) { row = { key, label: label(c), cells: [] }; out.push(row); }
    row.cells.push(c);
  }
  return out;
}

// The cells that answer the question, with the sentence that frames them,
// or null when the loaded tables hold nothing for it. Pure over the stored
// cells, so every choice is provable.
export function pickMatrix(entries, want) {
  if (!want || !entries?.length) return null;
  const of = name => entries.filter(e => e.section === name);
  const fig = want.figure;
  if (want.kind === 'recal') {
    const lines = [];
    let lead;
    const addOns = of('Recalibration Add-Ons').filter(e => want.addOns.some(re => re.test(e.rowLabel)));
    if (want.family === 'Mainline' || (!want.family && fig?.quantity === 'gas flow')) {
      const bands = of('Mainline Recalibrations');
      const hit = bands.filter(e => within(e, fig));
      if (hit.length) {
        lead = `**Recalibration**${want.code ? ` for ${want.code}` : ''}, mainline gas flow at ${figureWords(fig)}, in the list's ${band(hit[0].rowLabel)} band:`;
        lines.push(...rowsOf(hit, c => `Mainline, ${band(c.rowLabel)}`));
      } else {
        lead = fig?.quantity === 'gas flow'
          ? `**Recalibration**, mainline gas flow: the list prints no band that holds ${figureWords(fig)}. Its bands are:`
          : `**Recalibration**, mainline gas flow, by flow range:`;
        lines.push(...rowsOf(bands, c => `Mainline, ${band(c.rowLabel)}`));
      }
    } else if (want.family) {
      const row = of('All Other Recalibrations').filter(e => e.rowLabel.toUpperCase() === want.family.toUpperCase());
      if (row.length) {
        lead = `**Recalibration**${want.code ? ` for ${want.code}` : ''}, from the list's ${want.family} row:`;
        lines.push(...rowsOf(row));
      }
    } else if (!addOns.length) {
      lead = '**Recalibration** prices, by flow range for mainline gas flow and by family for the rest:';
      lines.push(...rowsOf(of('Mainline Recalibrations'), c => `Mainline, ${band(c.rowLabel)}`), ...rowsOf(of('All Other Recalibrations')));
    }
    if (addOns.length) {
      if (!lead) lead = '**Recalibration add-ons**:';
      lines.push(...rowsOf(addOns));
    }
    if (!lines.length) return null;
    const notes = [];
    if (want.highAccuracy && lines.some(l => l.key.includes('Recalibrations') && !l.cells.some(c => c.colLabel === 'High Accuracy'))) {
      notes.push('The list prints no high accuracy recalibration for that row.');
    }
    return { kind: 'recal', lead, lines, notes, where: 'the Recalibrations and Cleaning table', noDiscount: true };
  }
  if (want.kind === 'cleaning') {
    const cells = of('Cleaning').filter(e => !want.rows.length || want.rows.some(re => re.test(e.rowLabel)));
    if (!cells.length) return null;
    return {
      kind: 'cleaning', lines: rowsOf(cells), notes: [], where: 'the Recalibrations and Cleaning table', noDiscount: true,
      lead: '**Cleaning**, priced by flow class. The list does not say where low, mid and high flow begin and end:',
    };
  }
  // The OEM and Coriolis series: the table, the series column, the band.
  const oem = OEM.find(o => o.family === want.family);
  const sections = want.family === 'CODA' && want.statedAccuracy
    ? [want.highAccuracy ? 'High Accuracy CODA' : 'Standard Accuracy CODA']
    : oem.sections;
  const lines = [];
  let matched = false;
  for (const name of sections) {
    const cells = of(name).filter(e => !want.col || e.colLabel === want.col);
    const hit = cells.filter(e => within(e, fig));
    if (hit.length) matched = true;
    const multi = sections.length > 1;
    lines.push(...rowsOf(hit.length ? hit : cells, c => `${multi ? `${name.replace(' CODA', '')}, ` : ''}${band(c.rowLabel)}`));
  }
  if (!lines.length) return null;
  const title = sections.length > 1 ? 'CODA Coriolis' : sections[0];
  let lead = `**${title}**${want.code ? `, ${want.code}` : want.col ? `, ${want.col}` : ''}`;
  if (fig && matched) lead += ` at ${figureWords(fig)}:`;
  else if (fig) lead += `: the list prints no band that holds ${figureWords(fig)}. Its bands are:`;
  else lead += ', by band:';
  if (want.options?.length) {
    const opts = of(`${oem.sections[0]} options`).filter(e => want.options.some(re => re.test(e.rowLabel.replace(/\s+/g, ''))));
    lines.push(...rowsOf(opts, c => `Option ${c.rowLabel}`));
  }
  return { kind: 'oem', lead, lines, notes: [], where: `the ${title} table`, noDiscount: false };
}

const SYM = { GBP: '£', EUR: '€', USD: '$' };
const money = (cur, n) => `${Number(n) < 0 ? '-' : ''}${SYM[cur] || ''}${Math.abs(Number(n)).toLocaleString('en-GB', { maximumFractionDigits: 2 })}`;
const colText = c => (c.colLabel === 'Price' || c.colLabel === 'Add. Price' ? '' : `${c.colLabel} `);

// The supplier's cell for a sell cell: same table, same column, same row,
// matched by label or, where the lists spell a band differently, by band.
function supplierCell(supplier, c) {
  return supplier.find(s => s.section === c.section && s.colLabel === c.colLabel
    && (s.rowLabel === c.rowLabel || (c.min != null && s.min === c.min && s.max === c.max))) || null;
}
function howCost(s) {
  if (s.netPrice != null) return /partner/i.test(s.costRule || '') ? "the supplier's partner price as printed" : 'a stated net buying price';
  if (Number(s.discountPct) === 0) return "the supplier's stated price with no discount";
  return `the supplier's list ${money(s.currency, s.price)} less ${Number(s.discountPct)}%`;
}

// The purchase price, only because it was asked for, from the supplier's
// side of the same table. A cell with no rule says so and gives no figure.
export function renderMatrixCost(pick, supplier = []) {
  let src = null;
  const rows = pick.lines.map(l => {
    const parts = l.cells.map(c => {
      const s = supplierCell(supplier, c);
      if (!s) return `${colText(c)}not held`;
      src = src || s;
      const cost = costFrom({ listPrice: s.price, discountPct: s.discountPct, netPrice: s.netPrice });
      return cost == null ? `${colText(c)}not held, no cost rule is set for this table` : `${colText(c)}${money(s.currency, cost)}, ${howCost(s)}`;
    });
    return `- ${l.label}: ${parts.join('; ')}`;
  });
  const from = src ? `, from the ${src.listName}${src.effectiveDate ? `, effective ${isoDay(src.effectiveDate)}` : ''}` : '';
  return [`Purchase price, given because you asked for it${from}:`, ...rows, 'Never a figure to quote; the sell price is the one for customers.'];
}

export function renderMatrixAnswer(pick, { askedCost = false, supplier = [] } = {}) {
  const out = [pick.lead, ''];
  for (const l of pick.lines) out.push(`- ${l.label}: ${l.cells.map(c => `${colText(c)}${money(c.currency, c.price)}`).join(', ')}`);
  const first = pick.lines[0].cells[0];
  out.push('', `Sell prices from the ${first.listName} list${first.effectiveDate ? `, effective ${isoDay(first.effectiveDate)}` : ''}, ${pick.where}. ` +
    'Prices come from the loaded lists and are never estimated.' +
    (pick.noDiscount ? ' The list marks recalibrations and cleaning as not discounted.' : ''));
  if (pick.notes.length) out.push('', pick.notes.join(' '));
  // A table's own notes, named by table when the answer spans more than one
  // (an option row belongs to its table and does not count as another).
  const cells = pick.lines.flatMap(l => l.cells);
  const tables = new Set(cells.map(c => c.section.replace(/ options$/, '')));
  const tableNotes = [...new Map(cells.filter(c => c.note).map(c => [c.section, c.note])).entries()]
    .map(([section, note]) => (tables.size > 1 ? `${section}: ${note}` : note));
  if (tableNotes.length) out.push('', `The list also says: ${tableNotes.join(' ')}`);
  if (askedCost) out.push('', ...renderMatrixCost(pick, supplier));
  return out.join('\n');
}

// The stored cells for one side, in the list's order. Empty until migration
// 044 has run and a list has been applied.
export async function matrixEntries(side, productLine = 'alicat') {
  try {
    const ready = (await pool.query(`SELECT to_regclass('price_matrix') AS t`)).rows[0]?.t;
    if (!ready) return [];
    const withNote = await hasColumn('price_matrix', 'note');
    const { rows } = await pool.query(
      `SELECT section, row_label, col_label, quantity, unit, range_min, range_max, currency, price, partner_price,
              discount_pct, net_price, cost_rule, list_name, effective_date${withNote ? ', note' : ''}
       FROM price_matrix WHERE product_line = $1 AND side = $2 ORDER BY id`, [productLine, side]);
    const num = v => (v == null ? null : Number(v));
    return rows.map(r => ({
      section: r.section, rowLabel: r.row_label, colLabel: r.col_label, quantity: r.quantity, unit: r.unit,
      min: num(r.range_min), max: num(r.range_max), currency: r.currency, price: num(r.price), partnerPrice: num(r.partner_price),
      discountPct: num(r.discount_pct), netPrice: num(r.net_price), costRule: r.cost_rule || null,
      listName: r.list_name, effectiveDate: r.effective_date, note: r.note || null,
    }));
  } catch { return []; }
}

// The table turn, or null to let the part lookup run. A recalibration or
// cleaning question is answered here even when the tables are not loaded,
// because the part lookup would otherwise answer it with the price of the
// part it names, which is not what was asked.
export async function matrixTurn(question, { askedCost = false, entries = matrixEntries } = {}) {
  const want = matrixQuestion(question);
  if (!want) return null;
  const pick = pickMatrix(await entries('sell'), want);
  if (!pick) {
    if (want.kind === 'oem') return null;
    return { answer: `${want.kind === 'cleaning' ? 'Cleaning' : 'Recalibration'} prices for that are not held in the engine, so this one is per enquiry via Andy or your area sales manager.`, kind: 'matrix' };
  }
  return { answer: renderMatrixAnswer(pick, { askedCost, supplier: askedCost ? await entries('supplier') : [] }), kind: 'matrix' };
}
