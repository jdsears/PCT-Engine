import { cellValue, priceNumber, normKey } from './parseMega.mjs';

// The Alicat price list parser, 9 September 2026, for the GBP customer price
// list James placed in the customer pricing folder ("Alicat Q1 2026"). The
// Mega parser knows its tabs by fixed column numbers because those sheets
// have not moved in years; this list is new and its layout was not in front
// of anyone when the parser was written, so it detects the header row and
// classifies every column by name, then REPORTS the classification for a
// human to confirm before anything is stored.
//
// The rule that matters is inherited unchanged: only a selling price ever
// enters the price table. Alicat's supplier list is in USD and PCT's cost is
// that list less a discount, so a USD column without an explicit sell marker
// is set aside by default, and any column whose name says cost, purchase,
// discount, margin, supplier or a revision number is excluded whatever its
// currency and cannot be named back in. Exclusion is by construction and the
// gate proves it with poison values.

const text = x => String(x ?? '').replace(/\s+/g, ' ').trim();
const lower = x => text(x).toLowerCase();

// Anything on this list is never a selling price, whatever else the header
// says: it is cost, the supplier's own list, or the arithmetic between them.
// A hard exclusion: no override can name one of these columns.
const EXCLUDED = /\b(cost|costs|purchase|buy|buying|supplier|discount|disc|margin|markup|mark-up|rev ?\d+)\b/;
// The part column: a header that says part, model or stock code outright is
// preferred over the generic words, so an "Item" running number beside a
// "Part Number" column never wins by sitting further left.
const PART_STRONG = /^(part|model|sku|p\/?n|part ?no|part ?number|model ?number|stock ?code|product ?code)\b/;
const PART = /^(part|model|item|sku|p\/?n|part ?no|part ?number|model ?number|catalog(ue)?|product ?code|stock ?code|code)\b/;
const DESCRIPTION = /\b(desc|description|name|title|product)\b/;
// A column that says it is the price PCT sells at. "GBP sales list price" is
// how James described the customer list, and "sales" is the marker.
const SELL_MARK = /\b(sell|selling|sales|customer|pct|resale|trade|net selling)\b/;

export const HARD_WHY = "names cost, discount, margin or the supplier's list; never ingested";
export const USD_WHY = 'USD with no sell marker reads as the supplier list; set aside unless named with --usd-column';
export const LIST_WHY = "'list' with no sell marker could be the supplier's list; name the column to confirm it";

// Excel column letters, because that is how people describe a sheet ("column
// K sales GBP"). Both directions, pure.
export function colLetter(n) {
  let s = '';
  for (let x = Math.floor(Number(n) || 0); x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}
export function columnIndex(v) {
  const s = text(v).toUpperCase();
  if (/^\d+$/.test(s)) return parseInt(s, 10) > 0 ? parseInt(s, 10) : null;
  if (!/^[A-Z]{1,3}$/.test(s)) return null;
  let n = 0;
  for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

// Classify one header row. The part column is the first that names a part;
// the description the first that names one and is not the part column; each
// currency's sell is the column that carries that currency and is not
// excluded. A USD column needs a sell marker to count, because Alicat's USD
// is the supplier's list. Two unmarked GBP columns are ambiguous, and so is a
// lone "list" column with no sell marker; ambiguity is reported rather than
// resolved by a guess.
export function classifyHeader(headers) {
  const cols = (headers || []).map((h, i) => ({ col: i + 1, header: text(h), l: lower(h) })).filter(c => c.header);
  const out = { part: null, description: null, sells: {}, assumed: {}, excluded: [], ignored: [], ambiguous: [] };
  const part = cols.find(c => PART_STRONG.test(c.l)) || cols.find(c => PART.test(c.l));
  if (part) out.part = part.col;
  const desc = cols.find(c => c.col !== out.part && DESCRIPTION.test(c.l) && !EXCLUDED.test(c.l));
  if (desc) out.description = desc.col;
  const candidates = { GBP: [], EUR: [], USD: [] };
  for (const c of cols) {
    if (c.col === out.part || c.col === out.description) continue;
    if (EXCLUDED.test(c.l)) { out.excluded.push({ col: c.col, header: c.header, why: HARD_WHY, hard: true }); continue; }
    const gbp = /gbp|£|sterling/.test(c.l);
    const eur = /\beur\b|€|euro/.test(c.l);
    const usd = /\busd\b|\$|dollar/.test(c.l);
    if (usd && !gbp && !eur) {
      if (SELL_MARK.test(c.l)) candidates.USD.push(c);
      else out.excluded.push({ col: c.col, header: c.header, why: USD_WHY, hard: false });
      continue;
    }
    if (gbp) candidates.GBP.push(c);
    else if (eur) candidates.EUR.push(c);
    else if (/\b(price|sell|selling)\b/.test(c.l)) { candidates.GBP.push(c); out.assumed[c.col] = 'GBP'; }
    else out.ignored.push({ col: c.col, header: c.header });
  }
  for (const [cur, list] of Object.entries(candidates)) {
    if (!list.length) continue;
    const marked = list.filter(c => SELL_MARK.test(c.l));
    const named = l => l.map(c => ({ col: c.col, header: c.header }));
    if (marked.length === 1) { out.sells[cur] = marked[0].col; continue; }
    if (marked.length > 1) { out.ambiguous.push({ currency: cur, candidates: named(marked), why: 'more than one column carries a sell marker' }); continue; }
    if (list.length === 1 && !/\blist\b/.test(list[0].l)) { out.sells[cur] = list[0].col; continue; }
    out.ambiguous.push({
      currency: cur, candidates: named(list),
      why: list.length === 1 ? LIST_WHY : 'more than one column carries this currency and none says sell',
    });
  }
  return out;
}

// The header row is the first of the top rows that names a part and at
// least one price. Title rows above it are normal on a customer list.
export function findHeader(ws, { scan = 15 } = {}) {
  for (let r = 1; r <= Math.min(scan, ws.rowCount); r++) {
    const row = ws.getRow(r);
    const headers = [];
    for (let c = 1; c <= (row.cellCount || 0); c++) headers[c - 1] = cellValue(row.getCell(c));
    const cls = classifyHeader(headers);
    if (cls.part && (Object.keys(cls.sells).length || cls.ambiguous.length)) return { row: r, headers: headers.map(text), cls };
  }
  return null;
}

// Pick the worksheet: a named one, else the first whose name reads like a
// price list, else the first. Reported, so a wrong pick is visible.
export function pickSheet(wb, name = null) {
  const sheets = wb.worksheets || [];
  if (name) return sheets.find(s => lower(s.name) === lower(name)) || null;
  return sheets.find(s => /price|gbp|q[1-4]|20\d\d|list/.test(lower(s.name))) || sheets[0] || null;
}

// A human can name a currency's column when the header left it ambiguous, or
// bring back a USD column that was set aside for want of a sell marker. What
// nobody can do is name a hard-excluded column, the part column or the
// description column: those refusals are reported and the override dropped.
export function checkOverrides(header, overrides = {}) {
  const accepted = {}, refused = [];
  const width = header.headers.length;
  const hard = new Set(header.cls.excluded.filter(e => e.hard).map(e => e.col));
  for (const [cur, raw] of Object.entries(overrides || {})) {
    const currency = String(cur).toUpperCase();
    const col = columnIndex(raw);
    const name = col ? header.headers[col - 1] || '' : '';
    if (!['GBP', 'EUR', 'USD'].includes(currency)) { refused.push({ currency, col, header: name, why: 'not a currency the price table holds' }); continue; }
    if (!col || col > width) { refused.push({ currency, col, header: name, why: 'no such column in the header row' }); continue; }
    if (col === header.cls.part || col === header.cls.description) { refused.push({ currency, col, header: name, why: 'that is the part or description column' }); continue; }
    if (hard.has(col)) { refused.push({ currency, col, header: name, why: HARD_WHY }); continue; }
    accepted[currency] = col;
  }
  return { accepted, refused };
}

// Rows below the header, one per part and currency. A part printed twice at
// the same price is one row; printed twice at different prices it is a
// conflict, withdrawn entirely and named, never silently repriced.
export function extractAlicat(ws, header, { productLine = 'alicat', overrides = {} } = {}) {
  const sells = { ...header.cls.sells, ...overrides };
  const seen = new Map();
  const conflicts = new Map();
  let skippedNoPrice = 0;
  for (let r = header.row + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const part = text(cellValue(row.getCell(header.cls.part)));
    if (!part) continue;
    const description = header.cls.description ? text(cellValue(row.getCell(header.cls.description))) || null : null;
    let any = false;
    for (const [currency, col] of Object.entries(sells)) {
      const price = priceNumber(cellValue(row.getCell(col)));
      if (price == null) continue;
      any = true;
      const key = `${normKey(part)}|${currency}`;
      const prior = seen.get(key);
      if (prior && prior.sellPrice !== price) {
        const c = conflicts.get(key) || { partNumber: prior.partNumber, currency, prices: [prior.sellPrice] };
        c.prices.push(price);
        conflicts.set(key, c);
        continue;
      }
      if (!prior) seen.set(key, { productLine, partNumber: part, normKey: normKey(part), description, currency, sellPrice: price, sourceTab: ws.name });
    }
    if (!any) skippedNoPrice++;
  }
  for (const key of conflicts.keys()) seen.delete(key);
  const rows = [...seen.values()];
  const parts = new Set(rows.map(r => r.normKey)).size;
  return { rows, parts, skippedNoPrice, conflicts: [...conflicts.values()] };
}

// Everything that stops --apply, pure over the report so the gate can prove
// each one: a header nobody found, a currency nobody named, an override that
// was refused, a part priced two ways, and nothing to store at all.
export function applyBlockers(report) {
  const out = [];
  if (!report.sheet) out.push('no worksheet to read');
  else if (report.header == null) out.push('no header row found in the top rows of the sheet');
  for (const a of report.ambiguous || []) {
    out.push(`${a.currency} is ambiguous: ${a.candidates.map(c => `column ${c.col} (${colLetter(c.col)}) "${c.header}"`).join(' or ')}; ${a.why}. Name it with --${a.currency.toLowerCase()}-column`);
  }
  for (const r of report.overrides?.refused || []) {
    out.push(`--${String(r.currency).toLowerCase()}-column ${r.col ? `${r.col} (${colLetter(r.col)})` : ''}${r.header ? ` "${r.header}"` : ''} refused: ${r.why}`);
  }
  for (const c of report.conflicts || []) {
    out.push(`${c.partNumber} is priced ${c.prices.length} ways in ${c.currency} (${c.prices.join(', ')}); fix the sheet, nothing is stored for it`);
  }
  // Only when nothing above explains the empty result: an ambiguous currency
  // or a refused override already says why no rows came out.
  if (report.header != null && !report.rows && !out.length) out.push('no sell prices found under the header');
  return out;
}

// The whole workbook to rows plus a report a human can read before --apply.
// No header found is not an error to guess past: the report carries the top
// rows verbatim so the next attempt can name the columns by hand.
export function parseAlicatWorkbook(wb, { sheet = null, overrides = {} } = {}) {
  const ws = pickSheet(wb, sheet);
  const report = { sheet: ws?.name || null, sheets: (wb.worksheets || []).map(s => s.name), header: null, columns: null,
                   excluded: [], ignored: [], ambiguous: [], assumed: [], overrides: { accepted: {}, refused: [] },
                   conflicts: [], firstRows: [], parts: 0, rows: 0, skippedNoPrice: 0 };
  if (!ws) return { rows: [], report };
  const header = findHeader(ws);
  if (!header) {
    for (let r = 1; r <= Math.min(8, ws.rowCount); r++) {
      const row = ws.getRow(r);
      const vals = [];
      for (let c = 1; c <= Math.min(12, row.cellCount || 0); c++) vals.push(text(cellValue(row.getCell(c))));
      report.firstRows.push(vals);
    }
    return { rows: [], report };
  }
  const ov = checkOverrides(header, overrides);
  report.header = header.row;
  report.excluded = header.cls.excluded.filter(e => !Object.values(ov.accepted).includes(e.col));
  report.ignored = header.cls.ignored.filter(e => !Object.values(ov.accepted).includes(e.col));
  report.ambiguous = header.cls.ambiguous.filter(a => !(a.currency in ov.accepted));
  report.overrides = ov;
  const { rows, parts, skippedNoPrice, conflicts } = extractAlicat(ws, header, { overrides: ov.accepted });
  const sells = { ...header.cls.sells, ...ov.accepted };
  report.columns = {
    part: { col: header.cls.part, header: header.headers[header.cls.part - 1] },
    description: header.cls.description ? { col: header.cls.description, header: header.headers[header.cls.description - 1] } : null,
    sells: Object.fromEntries(Object.entries(sells).map(([cur, col]) => [cur, { col, header: header.headers[col - 1], named: cur in ov.accepted }])),
  };
  report.assumed = Object.entries(header.cls.assumed).filter(([col]) => Object.values(sells).includes(Number(col)))
    .map(([col, cur]) => ({ col: Number(col), header: header.headers[col - 1], currency: cur }));
  report.conflicts = conflicts;
  report.parts = parts; report.rows = rows.length; report.skippedNoPrice = skippedNoPrice;
  return { rows, report };
}
