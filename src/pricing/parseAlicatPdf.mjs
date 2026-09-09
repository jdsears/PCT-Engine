import { normKey, priceNumber } from './parseMega.mjs';
import { colLetter } from './parseAlicat.mjs';

// The Alicat customer list arrived as a PDF, 9 September 2026, not the
// workbook the first ingest expected: Pricing/Customer Pricing/Alicat Q1
// 2026.pdf. This parser reads the text pdftotext lays out, line by line, on
// the same doctrine as the workbook parser: a row is a part number beside
// one selling price, everything it is unsure of is named rather than
// guessed, and nothing that reads as cost, discount, margin or the
// supplier's USD list is ever stored. The layout was not in front of anyone
// when this was written, so the report carries the top of the document
// verbatim, and the next attempt, if one is needed, is made on evidence.

const text = x => String(x ?? '').replace(/\s+/g, ' ').trim();

// Alicat's part grammar: a series of letters with optional digits, then
// hyphen-joined segments, then optional slash options. MC-500SCCM-D,
// PC-15PSIG-D/5P, MCR-5SLPM-D, BB9-232, CODA-KC-...
export const PART_TOKEN = /\b([A-Z]{1,5}\d{0,3}(?:-[A-Z0-9]+)+(?:\/[A-Z0-9]+)*)\b/;
// A price carries a currency symbol, a thousands separator or two decimals.
// A bare integer is never a price, because 500 in 500SCCM is a flow rate.
const PRICE_TOKEN = /([£$€])\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)|(?<![\w.-])(\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+\.\d{2})(?![\w.-])/g;
// A line that says any of these is never a selling row, whatever else it
// carries: the cost, the discount, the supplier's own list.
const EXCLUDE_LINE = /\b(cost|costs|discount|disc\.?|margin|markup|mark-up|net buy|buying|purchase|supplier|rev\.? ?\d+|list price usd|usd list)\b/i;
const SYMBOL = { '£': 'GBP', '$': 'USD', '€': 'EUR' };

function pricesOn(line, defaultCurrency) {
  const out = [];
  PRICE_TOKEN.lastIndex = 0;
  let m;
  while ((m = PRICE_TOKEN.exec(line)) !== null) {
    const raw = m[2] ?? m[3];
    const price = priceNumber(raw);
    if (price == null) continue;
    out.push({ price, currency: m[1] ? SYMBOL[m[1]] : defaultCurrency, symbol: !!m[1], at: m.index, text: m[0] });
  }
  return out;
}

// The document's default currency for bare figures: the one it names in a
// heading ("Prices in GBP", "£"), else unknown, which is a question and not
// a guess. USD symbols are never a default, because the USD list is the
// supplier's.
export function detectCurrency(src) {
  const s = String(src || '');
  const gbp = /\bGBP\b|£|sterling/i.test(s), eur = /\bEUR\b|€|euro/i.test(s);
  if (gbp && !eur) return 'GBP';
  if (eur && !gbp) return 'EUR';
  if (gbp && eur) return 'GBP';
  return null;
}

// Text to rows. take picks a price when a line carries several ('first' or
// 'last'); without it such lines are held and named. currency overrides
// the detected default for bare figures.
export function parseAlicatPdfText(src, { take = null, currency = null, productLine = 'alicat' } = {}) {
  const lines = String(src || '').replace(/\f/g, '\n').split(/\r?\n/);
  const defaultCurrency = currency ? String(currency).toUpperCase() : detectCurrency(src);
  const report = {
    lines: 0, rows: 0, parts: 0, currency: { default: defaultCurrency, seen: { GBP: 0, EUR: 0, USD: 0 } },
    excluded: [], usd: [], multi: [], priceNoPart: [], partNoPrice: [], bareUnknown: [], conflicts: [], head: [],
  };
  const seen = new Map();
  const conflicts = new Map();
  const sample = (list, v, cap = 8) => { if (list.length < cap) list.push(v); };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    report.lines++;
    if (report.head.length < 30) report.head.push(line.trimEnd().slice(0, 140));
    if (EXCLUDE_LINE.test(line)) { sample(report.excluded, text(line)); continue; }
    const pm = PART_TOKEN.exec(line);
    const prices = pricesOn(line, defaultCurrency);
    for (const p of prices) if (p.currency) report.currency.seen[p.currency]++;
    if (!pm) { if (prices.length) sample(report.priceNoPart, text(line)); continue; }
    const part = pm[1];
    // Only figures after the part are its prices; a leading item number is
    // not a price and is not a part either.
    const after = prices.filter(p => p.at > pm.index + part.length - 1);
    const sells = after.filter(p => p.currency !== 'USD');
    if (after.some(p => p.currency === 'USD')) sample(report.usd, text(line));
    if (!sells.length) { if (!after.length) sample(report.partNoPrice, text(line)); continue; }
    let pick = null;
    if (sells.length === 1) pick = sells[0];
    else if (take === 'first') pick = sells[0];
    else if (take === 'last') pick = sells[sells.length - 1];
    else { sample(report.multi, text(line)); continue; }
    if (!pick.currency) { sample(report.bareUnknown, text(line)); continue; }
    const description = text(line.slice(pm.index + part.length, pick.at).replace(/[£$€]\s?[\d,.]+/g, ' ')) || null;
    const key = `${normKey(part)}|${pick.currency}`;
    const prior = seen.get(key);
    if (prior && prior.sellPrice !== pick.price) {
      const c = conflicts.get(key) || { partNumber: prior.partNumber, currency: pick.currency, prices: [prior.sellPrice] };
      c.prices.push(pick.price);
      conflicts.set(key, c);
      continue;
    }
    if (!prior) seen.set(key, { productLine, partNumber: part, normKey: normKey(part), description, currency: pick.currency, sellPrice: pick.price, sourceTab: 'pdf' });
  }
  for (const key of conflicts.keys()) seen.delete(key);
  const rows = [...seen.values()];
  report.rows = rows.length;
  report.parts = new Set(rows.map(r => r.normKey)).size;
  report.conflicts = [...conflicts.values()];
  return { rows, report };
}

// What stops --apply on a PDF read, pure over the report: nothing parsed,
// figures with no currency anyone named, a part priced two ways, or a
// document that reads as the USD list rather than the GBP one.
export function pdfApplyBlockers(report) {
  const out = [];
  if (!report.lines) out.push('no text came out of the PDF; if it is a scan, the list needs to come as a workbook or a text PDF');
  if (report.bareUnknown.length) out.push(`${report.bareUnknown.length} row(s) carry a figure with no currency and the document names none; say which with --currency GBP`);
  for (const c of report.conflicts) out.push(`${c.partNumber} is priced ${c.prices.length} ways in ${c.currency} (${c.prices.join(', ')}); fix the list, nothing is stored for it`);
  if (report.lines && !report.rows && !out.length) {
    out.push(report.currency.seen.USD && !report.currency.seen.GBP && !report.currency.seen.EUR
      ? 'every price is in USD, which reads as the supplier list, never ingested'
      : report.multi.length
        ? `${report.multi.length}+ row(s) carry more than one price and none stored; say which to take with --take first or --take last`
        : 'no part number sits beside a price on any line; the top of the document is printed above so the parser can learn the layout');
  }
  return out;
}

export { colLetter };
