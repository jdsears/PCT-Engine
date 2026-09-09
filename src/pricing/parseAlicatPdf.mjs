import { normKey, priceNumber } from './parseMega.mjs';

// The Alicat customer list arrived as a PDF, 9 September 2026, not the
// workbook the first ingest expected: Pricing/Customer Pricing/Alicat Q1
// 2026.pdf. This parser reads the text pdftotext lays out, line by line, on
// the same doctrine as the workbook parser: a row is a part number beside
// one selling price, everything it is unsure of is named rather than
// guessed, and nothing that reads as cost, discount, margin or the
// supplier's USD list is ever stored.
//
// The layout, learned from John's first dry run of the real document: up to
// four part-and-price pairs sit side by side on one line (M-Series,
// MS-Series, MQ-Series, MW-Series columns), so each price belongs to the
// part immediately before it, never to the first part on the line. Adders
// are priced as an addition to a base unit ("MCD £579 + MC") and are not
// prices of a part. A series heading (MCE-SFF-Series) is not a part, a part
// named inside a description ("Carrying case for FP-25 £430") is a mention
// and not a row, and part numbers carry a digit, which keeps connector names
// in table headings (USB-C) out. Ranges with a decimal (M-0.5SCCM-D) are
// one code.

const text = x => String(x ?? '').replace(/\s+/g, ' ').trim();

// Alicat's part grammar: a series of letters with optional digits, then
// hyphen-joined segments that may carry a decimal, then optional slash
// options; or a short accessory code with digits and no hyphen (BB3, MD8).
// A code must carry a digit somewhere, and must not run on into a word
// with lower-case letters, which is how "MCE-SFF-Series" is a heading.
export const PART_TOKEN = /\b(?=[A-Z0-9.\/-]*\d)([A-Z]{1,5}\d{0,3}(?:-[A-Z0-9]+(?:\.[A-Z0-9]+)*)+(?:\/[A-Z0-9]+)*|[A-Z]{2,5}\d{1,4}[A-Z]{0,2})\b(?!-[A-Za-z]*[a-z])/g;
// A price carries a currency symbol, a thousands separator or two decimals.
// A bare integer is never a price, because 500 in 500SCCM is a flow rate.
const PRICE_TOKEN = /([£$€])\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)|(?<![\w.-])(\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+\.\d{2})(?![\w.-])/g;
// A line that says any of these is never a selling row, whatever else it
// carries: the cost, the discount, the supplier's own list.
const EXCLUDE_LINE = /\b(cost|costs|discount|disc\.?|margin|markup|mark-up|net buy|buying|purchase|supplier|rev\.? ?\d+|list price usd|usd list)\b/i;
const SYMBOL = { '£': 'GBP', '$': 'USD', '€': 'EUR' };

const tokens = (re, line) => {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(line)) !== null) out.push({ m, at: m.index, end: m.index + m[0].length });
  return out;
};

function pricesOn(line, defaultCurrency) {
  return tokens(PRICE_TOKEN, line).map(({ m, at, end }) => {
    const price = priceNumber(m[2] ?? m[3]);
    return price == null ? null : { price, currency: m[1] ? SYMBOL[m[1]] : defaultCurrency, symbol: !!m[1], at, end };
  }).filter(Boolean);
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

// Text to rows. currency overrides the detected default for bare figures.
export function parseAlicatPdfText(src, { currency = null, productLine = 'alicat' } = {}) {
  const lines = String(src || '').replace(/\f/g, '\n').split(/\r?\n/);
  const defaultCurrency = currency ? String(currency).toUpperCase() : detectCurrency(src);
  const report = {
    lines: 0, rows: 0, parts: 0, currency: { default: defaultCurrency, seen: { GBP: 0, EUR: 0, USD: 0 } },
    excluded: [], usd: [], adders: [], mentions: [], priceNoPart: [], partNoPrice: [], bareUnknown: [], conflicts: [], head: [],
  };
  const seen = new Map();
  const conflicts = new Map();
  const sample = (list, v, cap = 8) => { if (list.length < cap && !list.includes(v)) list.push(v); };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    report.lines++;
    if (report.head.length < 30) report.head.push(line.slice(0, 140));
    if (EXCLUDE_LINE.test(line)) { sample(report.excluded, text(line)); continue; }
    const prices = pricesOn(line, defaultCurrency);
    for (const p of prices) if (p.currency) report.currency.seen[p.currency]++;
    const parts = tokens(PART_TOKEN, line).map(t => ({ part: t.m[1], at: t.at, end: t.end }));
    let prev = 0;
    for (const price of prices) {
      // Each price belongs to the part that starts its own stretch of the
      // line, the text since the previous price.
      const segStart = prev;
      const segment = line.slice(segStart, price.at);
      const inSegment = parts.filter(p => p.at >= segStart && p.end <= price.at);
      const tail = line.slice(price.end, price.end + 24).trim();
      const pair = text(segment + ' ' + line.slice(price.at, price.end));
      prev = price.end;
      if (/^\+/.test(tail)) { sample(report.adders, text(pair + ' ' + (tail.match(/^\+\s*\S+(\s+\S+)?/) || ['+'])[0])); continue; }
      if (!inSegment.length) { sample(report.priceNoPart, segment.trim() ? pair : text(line)); continue; }
      const first = inSegment[0];
      if (line.slice(segStart, first.at).trim()) { sample(report.mentions, pair); continue; }
      if (price.currency === 'USD') { sample(report.usd, pair); continue; }
      if (!price.currency) { sample(report.bareUnknown, pair); continue; }
      const description = text(line.slice(first.end, price.at)) || null;
      const key = `${normKey(first.part)}|${price.currency}`;
      const prior = seen.get(key);
      if (prior && prior.sellPrice !== price.price) {
        const c = conflicts.get(key) || { partNumber: prior.partNumber, currency: price.currency, prices: [prior.sellPrice] };
        c.prices.push(price.price);
        conflicts.set(key, c);
        continue;
      }
      if (!prior) seen.set(key, { productLine, partNumber: first.part, normKey: normKey(first.part), description, currency: price.currency, sellPrice: price.price, sourceTab: 'pdf' });
    }
    const after = parts.filter(p => p.at >= prev);
    if (after.length && !prices.length) sample(report.partNoPrice, text(line));
    else if (after.length) sample(report.partNoPrice, text(line.slice(prev)));
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
  if (report.bareUnknown?.length) out.push(`${report.bareUnknown.length} row(s) carry a figure with no currency and the document names none; say which with --currency GBP`);
  for (const c of report.conflicts || []) out.push(`${c.partNumber} is priced ${c.prices.length} ways in ${c.currency} (${c.prices.join(', ')}); fix the list, nothing is stored for it`);
  if (report.lines && !report.rows && !out.length) {
    out.push(report.currency.seen.USD && !report.currency.seen.GBP && !report.currency.seen.EUR
      ? 'every price is in USD, which reads as the supplier list, never ingested'
      : 'no part number sits beside a price on any line; the top of the document is printed above so the parser can learn the layout');
  }
  return out;
}
