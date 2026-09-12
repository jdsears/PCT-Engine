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
// Codes that look like accessory part numbers and are not: ingress ratings,
// serial and connector standards, approvals. "IP66 or IP67 £538" is an
// option row, John's re-read of 11 September 2026, never two parts.
const NOT_PART = /^(IP\d{2}|RS\d{3}|DB\d{1,2}[A-Z]?|RJ\d{2}|NEMA\d+|ISO\d+|EN\d+|UL\d+|ATEX\d*|M\d{2})$/i;
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
    const parts = tokens(PART_TOKEN, line).map(t => ({ part: t.m[1], at: t.at, end: t.end })).filter(p => !NOT_PART.test(p.part));
    let prev = 0;
    // In the supplier read a second figure straight after a part's first,
    // with nothing between them, is the partner price beside the list price.
    let lastRows = [];
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
      if (!inSegment.length) {
        if (supplier && !segment.trim() && lastRows.length && price.currency === 'USD') {
          for (const r of lastRows) if (r.partnerPrice == null) r.partnerPrice = price.price;
          report.partnerPrices = (report.partnerPrices || 0) + 1;
          continue;
        }
        lastRows = [];
        sample(report.priceNoPart, segment.trim() ? pair : text(line));
        continue;
      }
      lastRows = [];
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
        const row = { productLine, partNumber: part, normKey: normKey(part), description: desc, currency: price.currency, sellPrice: price.price, price: price.price, partnerPrice: null, sourceTab: 'pdf', line: pair };
        const prior = seen.get(key);
        if (prior && prior.sellPrice !== price.price) {
          const c = conflicts.get(key) || { partNumber: prior.partNumber, currency: price.currency, occurrences: [prior] };
          c.occurrences.push(row);
          conflicts.set(key, c);
          continue;
        }
        if (!prior) { seen.set(key, row); lastRows.push(row); }
      }
    }
    const after = parts.filter(p => p.at >= prev);
    if (after.length && !prices.length) sample(report.partNoPrice, text(line));
    else if (after.length) sample(report.partNoPrice, text(line.slice(prev)));
  }
  // Merged groups, the supplier list's layout: a part the line-by-line read
  // left without a price takes its group's price from the columned layout.
  // A part that had its own price keeps it; a group price that disagrees
  // with it is counted as a disagreement for the dry run to show, since it
  // means the columns were misread, not that the list prices it twice.
  report.grouped = 0;
  report.groupedDisagreements = [];
  report.unpriced = [];
  if (supplier) {
    const grouped = parseGroupedColumns(src, { currency: 'USD', productLine });
    for (const g of grouped.rows) {
      const key = `${g.normKey}|${g.currency}`;
      const prior = seen.get(key);
      if (prior) {
        if (prior.sellPrice !== g.sellPrice && report.groupedDisagreements.length < 20) {
          report.groupedDisagreements.push(`${g.partNumber}: own ${prior.sellPrice}, group ${g.sellPrice}`);
        }
        continue;
      }
      if (conflicts.has(key)) continue;
      seen.set(key, g);
      report.grouped++;
    }
    report.unpriced = grouped.unpriced.filter(p => !seen.has(`${normKey(p)}|USD`)).slice(0, 20);
    if (report.grouped) report.partNoPrice = report.partNoPrice.filter(l => !grouped.rows.some(g => l.includes(g.partNumber)));
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

// Option rows, James's note of 11 September 2026, and the shapes John's
// second read showed. The list prints an option as its label, the codes
// in brackets and a value, two options to a line ("Serial w/ analogs +
// alarm (-ALM) £41   M12 (-M12 or -M12O) £62"), so each value belongs to the
// bracket group just before it. A choice table prints the choices in one
// bracket and a value under each ("Display (D, TFT, O) [default] £124
// -£83"): the values map to the codes in order, default is no cost and a
// minus is a credit. "Included" is a no-cost option, N/A is no option, and
// codes joined by "or" with no bracket ("IP66 or IP67 £538") are options
// too. A row whose values outnumber its codes is a per-series table, still
// reported and not stored. The same code at two adders is a conflict,
// named and not stored. Pure, so every shape is provable.
const VALUE_TOKEN = /(-)?\s?([£$€])\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)|\bN\/A\b|\[default\]|\b(?:included|incl\.|no charge|n\/c|free)\b/gi;
// Names that sit in brackets on an option row without being option codes:
// serial and connector standards and protocol names.
const NOT_OPTION = /^(RS\d{3}|RJ\d{2}|USB[A-Z0-9-]*|EIP|ECAT|PROFINET|MODBUS|NEMA\d+)$/i;
const CODE_OK = /^[A-Z0-9][A-Z0-9-]{0,14}$/i;
const codesIn = s => String(s || '').split(/\s*(?:,|\bor\b|\/)\s*/i).map(c => c.trim().replace(/^-+/, '')).filter(c => CODE_OK.test(c) && !/#/.test(c) && !/^etc$/i.test(c));
const valueOf = (m, currency) => {
  if (m[3] != null) return { kind: 'price', adder: (m[1] ? -1 : 1) * (priceNumber(m[3]) ?? 0), currency: SYMBOL[m[2]] || currency };
  const t = m[0].toLowerCase();
  if (t === 'n/a') return { kind: 'na' };
  if (t === '[default]') return { kind: 'default', adder: 0, currency };
  return { kind: 'free', adder: 0, currency };
};
export function parseOptionRows(src, { currency = 'GBP' } = {}) {
  const out = { options: [], multi: [], skipped: [], conflicts: [] };
  const seen = new Map();
  const add = (code, label, value, line, markedDefault = false) => {
    if (!value || value.kind === 'na' || value.currency !== currency) return;
    const normCode = code.toUpperCase().replace(/\s+/g, '');
    const prior = seen.get(normCode);
    if (prior && (prior.conflicted || prior.adder !== value.adder)) {
      // The same code at two adders: named, and neither stored.
      const c = out.conflicts.find(x => x.code === normCode);
      if (c) { c.adders.push(value.adder); c.lines.push(line.slice(0, 120)); }
      else out.conflicts.push({ code: normCode, adders: [prior.adder, value.adder], lines: [prior.line, line.slice(0, 120)] });
      out.options = out.options.filter(o => o.normCode !== normCode);
      seen.set(normCode, { ...prior, conflicted: true });
      return;
    }
    if (prior) return;
    const row = { code, normCode, label: text(label.replace(/\[default\]/ig, '')) || null, currency, adder: value.adder, markedDefault: markedDefault || value.kind === 'default', line: line.slice(0, 120) };
    seen.set(normCode, row);
    out.options.push(row);
  };
  for (const raw of String(src || '').replace(/\f/g, '\n').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || EXCLUDE_LINE.test(line)) continue;
    const brackets = [...line.matchAll(/\(([^()]{1,80})\)/g)]
      .map(m => ({ at: m.index, end: m.index + m[0].length, codes: codesIn(m[1]).filter(c => !NOT_OPTION.test(c)) }))
      .filter(b => b.codes.length);
    const values = [...line.matchAll(VALUE_TOKEN)].map(m => ({ at: m.index, end: m.index + m[0].length, ...valueOf(m, currency) }));
    if (!values.length) continue;
    // Every value has an owner: the last bracket in the text since the
    // previous value, or codes joined by "or" standing there with no
    // bracket, or the previous value's owner when nothing but space lies
    // between (a choice table's row of values), or nobody when the text is
    // a label without codes ("None £0").
    const owners = [];
    let prev = 0, current = null;
    for (const v of values) {
      const segment = line.slice(prev, v.at);
      const inSeg = brackets.filter(b => b.at >= prev && b.end <= v.at);
      const bare = text(segment);
      if (inSeg.length) {
        const b = inSeg[inSeg.length - 1];
        current = { codes: b.codes, label: text(line.slice(prev, b.at).replace(/\[default\]/ig, '')) || text(segment.replace(/\([^()]*\)/g, '')) || b.codes.join(', '), values: [] };
        owners.push(current);
      } else if (/^[A-Z]{1,5}\d{1,4}[A-Z]?(?:\s+or\s+[A-Z]{1,5}\d{1,4}[A-Z]?)+$/i.test(bare)) {
        current = { codes: bare.split(/\s+or\s+/i), label: bare, values: [] };
        owners.push(current);
      } else if (/[A-Za-z]/.test(bare)) {
        current = null;
      }
      if (current) current.values.push(v);
      prev = v.end;
    }
    // Values with nobody to own them. Only a line that looked like an
    // option row, one with a bracket on it, is worth reporting: a product
    // row carries prices and no brackets, and listing every one of those
    // buried the real skips in John's read of 12 September 2026.
    if (!owners.length) {
      if (/\([^()]{1,80}\)/.test(line)) out.skipped.push(line.slice(0, 120));
      continue;
    }
    for (const o of owners) {
      const vals = o.values;
      if (vals.length === 1) { for (const code of o.codes) add(code, o.label, vals[0], line); continue; }
      if (vals.length === o.codes.length) { o.codes.forEach((code, i) => add(code, o.label, vals[i], line)); continue; }
      out.multi.push(line.slice(0, 120));
    }
  }
  return out;
}

// Merged groups in a columned list, John's supplier read of 11 September
// 2026: the USD list prints the parts of a series in rows and a price once
// per group of ranges, at the group's vertical middle. On an odd-sized
// group the price sits on the middle row; on an even-sized one it sits on
// its own line between the two middle rows. Groups tile the column from
// the top, so each group runs from the row after the previous group to the
// same distance past its price as the price is from its start. Columns are
// the series headings ("M-Series MS-Series ..."), and a figure belongs to
// the column whose heading is nearest above it. Pure over the layout text.
export function parseGroupedColumns(src, { currency = 'USD', productLine = 'alicat' } = {}) {
  const lines = String(src || '').replace(/\f/g, '\n').split(/\r?\n/);
  const out = { rows: [], blocks: 0, unpriced: [] };
  let block = null;
  const nearest = (cols, x) => {
    let best = null;
    for (const [i, c] of cols.entries()) { const d = Math.abs(c.x - x); if (best == null || d < best.d) best = { i, d }; }
    return best && best.d <= 22 ? best.i : null;
  };
  const flush = () => {
    if (!block) return;
    out.blocks++;
    for (const [i, col] of block.columns.entries()) {
      const parts = col.parts.sort((a, b) => a.row - b.row);
      const anchors = col.anchors.sort((a, b) => a.row - b.row);
      let start = null, ai = 0;
      for (let pi = 0; pi < parts.length;) {
        start = parts[pi].row;
        while (ai < anchors.length && anchors[ai].row < start) ai++;
        if (ai >= anchors.length) { for (const p of parts.slice(pi)) out.unpriced.push(p.part); break; }
        const anchor = anchors[ai++];
        const end = start + 2 * (anchor.row - start);
        let taken = 0;
        while (pi < parts.length && parts[pi].row <= end) {
          const p = parts[pi++];
          out.rows.push({ productLine, partNumber: p.part, normKey: normKey(p.part), description: null, currency: anchor.currency, sellPrice: anchor.price, price: anchor.price, partnerPrice: null, sourceTab: 'pdf', column: block.cols[i].name, line: `${p.part} ${SYMBOL[anchor.currency] || ''}${anchor.price} (group price)` });
          taken++;
        }
        if (!taken) break;
      }
    }
    block = null;
  };
  let row = 0;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const heads = [...line.matchAll(/\b([A-Z]{1,5}\d{0,3})-Series\b/g)];
    if (heads.length >= 2) {
      flush();
      block = { cols: heads.map(h => ({ name: h[1], x: h.index + h[0].length / 2 })), columns: heads.map(() => ({ parts: [], anchors: [] })) };
      row = 0;
      continue;
    }
    if (!block) continue;
    if (!line.trim() || EXCLUDE_LINE.test(line)) continue;
    const parts = tokens(PART_TOKEN, line).map(t => ({ part: t.m[1], x: t.at + t.m[1].length / 2 })).filter(p => !NOT_PART.test(p.part));
    const prices = pricesOn(line, currency).filter(p => p.currency === currency).map(p => ({ ...p, x: p.at + (p.end - p.at) / 2 }));
    // A line of prose inside a block ends it: the next table has its own
    // heading. A price-only line is a group's price only when it is nothing
    // but figures; "$700 + controller" is an adder, never an anchor.
    if (!parts.length && !prices.length) {
      if ((line.match(/[a-z]{3,}/g) || []).length >= 5) flush();
      continue;
    }
    if (!parts.length && !/^[\s$£€\d,.]+$/.test(line)) continue;
    if (parts.length) {
      row++;
      for (const p of parts) { const c = nearest(block.cols, p.x); if (c != null) block.columns[c].parts.push({ part: p.part, row }); }
    }
    for (const p of prices) {
      const c = nearest(block.cols, p.x);
      if (c != null) block.columns[c].anchors.push({ row: parts.length ? row : row + 0.5, price: p.price, currency: p.currency });
    }
  }
  flush();
  return out;
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
