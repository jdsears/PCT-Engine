import { normKey, priceNumber } from './parseMega.mjs';

// The Alicat customer list arrived as a PDF, 9 September 2026, not the
// workbook the first ingest expected: Pricing/Customer Pricing/Alicat Q1
// 2026.pdf. This parser reads the text pdftotext lays out, line by line, on
// the same doctrine as the workbook parser: a row is a part number beside
// one selling price, everything it is unsure of is named rather than
// guessed, and nothing that reads as cost, discount, margin or the
// supplier's USD list is ever stored.
//
// The layout, learned from John's dry runs of the real document: up to four
// part-and-price pairs sit side by side on one line (M-Series, MS-Series,
// MQ-Series, MW-Series columns), so each price belongs to the part
// immediately before it, never to the first part on the line. Adders are
// priced as an addition to a base unit ("MCD £579 + MC") and are not prices
// of a part. A series heading (MCE-SFF-Series) is not a part, and one that
// shares a line with the first pair is ignored rather than making that pair
// a mention. A specification before a code ("10/32 5μ Brass/Buna ILFE20
// £8") is its description; a phrase before a code that reads as prose
// ("Carrying case for FP-25 £430") names something for the code and is a
// mention, not the code's price. Part numbers carry a digit or at least
// three segments (PC-EXTSEN-D-ISC), which keeps connector names in table
// headings (USB-C) out. Ranges with a decimal (M-0.5SCCM-D) are one code.

const text = x => String(x ?? '').replace(/\s+/g, ' ').trim();

// Alicat's part grammar: a series of letters with optional digits, then
// hyphen-joined segments that may carry a decimal, then optional slash
// options; or a short accessory code with digits and no hyphen (BB3, MD8).
// A code must carry a digit or at least three segments, and must not run on
// into a word with lower-case letters, which is how "MCE-SFF-Series" is a
// heading.
export const PART_TOKEN = /\b(?=[A-Z0-9.\/-]*\d|[A-Z0-9.\/]+-[A-Z0-9.\/]+-)([A-Z]{1,5}\d{0,3}(?:-[A-Z0-9]+(?:\.[A-Z0-9]+)*)+(?:\/[A-Z0-9]+)*|[A-Z]{2,5}\d{1,4}[A-Z]{0,2})\b(?!-[A-Za-z]*[a-z])/g;
// A price carries a currency symbol, a thousands separator or two decimals.
// A bare integer is never a price, because 500 in 500SCCM is a flow rate.
const PRICE_TOKEN = /([£$€])\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)|(?<![\w.-])(\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+\.\d{2})(?![\w.-])/g;
// A line that says any of these is never a selling row, whatever else it
// carries: the cost, the discount, the supplier's own list.
const EXCLUDE_LINE = /\b(cost|costs|discount|disc\.?|margin|markup|mark-up|net buy|buying|purchase|supplier|rev\.? ?\d+|list price usd|usd list)\b/i;
// A column heading for a series, which can share a line with the first pair.
const HEADING = /\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-Series\b/g;
// Words that make the text before a code a phrase about the code rather
// than a specification of it.
const PROSE = /\b(for|with|of|the|and|per|to|in|on|by|only|case|kit|cable|set|spare|option|options|extra|additional|replacement)\b/i;
// A table cell between a code and a figure: the code is the row's label in
// an options table ("FP-25 N/A £430" is an option for the FP-25 with the
// first column not applicable), and the figure is the option's, never the
// part's. John's third dry run, 9 September 2026.
const OPTION_CELL = /\bN\/A\b|\bn\/c\b|\bby quote\b|\bincluded\b|\bstandard\b|\bstd\b/i;
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
// resolve is { partNumber: figure } for conflicts a human has settled on the
// command line; the figure must be one the document shows for that part.
// mode is 'sell' for the customer list, where a USD figure is the
// supplier's and is set aside, or 'supplier' for the supplier's own list,
// 11 September 2026, where USD is the price and a GBP figure is the one
// set aside; the two never mix in one read.
export function parseAlicatPdfText(src, { currency = null, productLine = 'alicat', resolve = {}, mode = 'sell' } = {}) {
  const lines = String(src || '').replace(/\f/g, '\n').split(/\r?\n/);
  const supplier = mode === 'supplier';
  const defaultCurrency = currency ? String(currency).toUpperCase() : supplier ? 'USD' : detectCurrency(src);
  const report = {
    mode, lines: 0, rows: 0, parts: 0, currency: { default: defaultCurrency, seen: { GBP: 0, EUR: 0, USD: 0 } },
    excluded: [], usd: [], otherCurrency: [], adders: [], mentions: [], options: [], priceNoPart: [], partNoPrice: [], bareUnknown: [], conflicts: [], resolved: [], head: [],
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
      const figure = line.slice(price.at, price.end);
      const pair = text(segment + ' ' + figure);
      prev = price.end;
      if (/^\+/.test(tail)) {
        // "+ MC", "+ Meter", "+ 3 Meters": the addition phrase is a plus, an
        // optional count and a word. The code is the last word before the
        // figure once the previous pair's phrase is stripped.
        const phrase = /^\+\s*(?:\d+\s+)?[A-Za-z]+/;
        const code = segment.replace(new RegExp(`^\\s*${phrase.source.slice(1)}\\s*`), '').trim().split(/\s+/).pop() || '';
        sample(report.adders, text(`${code} ${figure} ${(tail.match(phrase) || ['+'])[0]}`));
        continue;
      }
      if (!inSegment.length) { sample(report.priceNoPart, segment.trim() ? pair : text(line)); continue; }
      const first = inSegment[0];
      const lead = line.slice(segStart, first.at).replace(HEADING, ' ').trim();
      if (lead && PROSE.test(lead)) { sample(report.mentions, pair); continue; }
      if (OPTION_CELL.test(line.slice(first.end, price.at))) { sample(report.options, pair); continue; }
      if (!supplier && price.currency === 'USD') { sample(report.usd, pair); continue; }
      if (supplier && price.currency && price.currency !== 'USD') { sample(report.otherCurrency, pair); continue; }
      if (!price.currency) { sample(report.bareUnknown, pair); continue; }
      // Alternates, from John's lookup of 11 September 2026: the list prints
      // "PCD-100PSIA-D or PCD-100PSIG-D or PCD-100PSID-D £1,410", one price
      // for the absolute, gauge and differential references. Codes joined by
      // "or" (or a slash or a comma) before the figure each take the price
      // as their own row, and none of them is the first one's description.
      const alternates = [];
      let prevEnd = first.end;
      for (const p of inSegment.slice(inSegment.indexOf(first) + 1)) {
        if (!/^\s*(?:or|\/|,|;|&|and)\s*$/i.test(line.slice(prevEnd, p.at))) break;
        alternates.push(p);
        prevEnd = p.end;
      }
      const description = text([lead, line.slice(prevEnd, price.at)].join(' ')) || null;
      if (alternates.length) report.alternates = (report.alternates || 0) + alternates.length;
      // sellPrice is the row's figure in either mode; the supplier ingest
      // stores it as the list price, never as a sell.
      const rowsHere = [
        { part: first.part, description },
        ...alternates.map(a => ({ part: a.part, description: `listed with ${first.part}` })),
      ];
      for (const { part, description: desc } of rowsHere) {
        const key = `${normKey(part)}|${price.currency}`;
        const row = { productLine, partNumber: part, normKey: normKey(part), description: desc, currency: price.currency, sellPrice: price.price, price: price.price, sourceTab: 'pdf', line: pair };
        const prior = seen.get(key);
        if (prior && prior.sellPrice !== price.price) {
          const c = conflicts.get(key) || { partNumber: prior.partNumber, currency: price.currency, occurrences: [prior] };
          c.occurrences.push(row);
          conflicts.set(key, c);
          continue;
        }
        if (!prior) seen.set(key, row);
      }
    }
    const after = parts.filter(p => p.at >= prev);
    if (after.length && !prices.length) sample(report.partNoPrice, text(line));
    else if (after.length) sample(report.partNoPrice, text(line.slice(prev)));
  }
  // A conflict a human settled on the command line keeps the stated figure,
  // provided the document shows it; every other conflict is withdrawn and
  // named with its lines, so the next decision is made on evidence.
  const stated = Object.fromEntries(Object.entries(resolve || {}).map(([k, v]) => [normKey(k), priceNumber(v)]));
  for (const [key, c] of conflicts) {
    const want = stated[key.split('|')[0]];
    const hit = want != null ? c.occurrences.find(o => o.sellPrice === want) : null;
    const prices = c.occurrences.map(o => o.sellPrice);
    if (hit) {
      seen.set(key, hit);
      report.resolved.push(`${c.partNumber} ${c.currency} ${want}, stated on the command line; the document also shows ${prices.filter(p => p !== want).join(', ')}`);
      continue;
    }
    seen.delete(key);
    report.conflicts.push({ partNumber: c.partNumber, currency: c.currency, prices, lines: c.occurrences.map(o => o.line),
      ...(want != null ? { statedNotSeen: want } : {}) });
  }
  const rows = [...seen.values()].map(({ line, ...r }) => r);
  report.rows = rows.length;
  report.parts = new Set(rows.map(r => r.normKey)).size;
  return { rows, report };
}

// What stops --apply on a PDF read, pure over the report: nothing parsed,
// figures with no currency anyone named, a part priced two ways, or a
// document that reads as the USD list rather than the GBP one.
export function pdfApplyBlockers(report) {
  const out = [];
  if (!report.lines) out.push('no text came out of the PDF; if it is a scan, the list needs to come as a workbook or a text PDF');
  if (report.bareUnknown?.length) out.push(`${report.bareUnknown.length} row(s) carry a figure with no currency and the document names none; say which with --currency GBP`);
  for (const c of report.conflicts || []) {
    out.push(`${c.partNumber} is priced ${c.prices.length} ways in ${c.currency} (${c.prices.join(', ')}); the lines: ${(c.lines || []).map(l => `"${l}"`).join(' | ')}.` +
      (c.statedNotSeen != null ? ` --price stated ${c.statedNotSeen}, which the document does not show for it.` : '') +
      ` Settle it with --price "${c.partNumber}=<one of those figures>" or fix the list; nothing is stored for it until then`);
  }
  if (report.lines && !report.rows && !out.length) {
    const seen = report.currency.seen;
    if (report.mode === 'supplier') {
      out.push(!seen.USD && (seen.GBP || seen.EUR)
        ? 'every price is in sterling or euros, which reads as the customer list, not the supplier\'s; the supplier list is in USD'
        : 'no part number sits beside a price on any line; the top of the document is printed above so the parser can learn the layout');
    } else {
      out.push(seen.USD && !seen.GBP && !seen.EUR
        ? 'every price is in USD, which reads as the supplier list, never a sell'
        : 'no part number sits beside a price on any line; the top of the document is printed above so the parser can learn the layout');
    }
  }
  return out;
}
