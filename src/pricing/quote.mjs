import { lookupPrice } from './lookup.mjs';
import { pool } from '../db.mjs';
import { normKey } from './parseMega.mjs';

// The itemised quote basket. A rep opens a quote in the co-pilot, adds lines
// by part number and quantity, and reads back an itemised table with totals.
// The honesty rules of the price lookup carry over whole: a line prices only
// from the loaded lists, sell prices exactly as loaded and guide prices as
// computed at ingest through the master sheet's own Richards transform, so
// the margin is the sheet's and nothing here invents or adjusts a number. A
// part with no loaded price joins the quote as a per-enquiry line with no
// figure at all, listed beneath the total rather than pretending.
//
// The basket itself follows the configurator's state pattern: a plain object
// threaded through ask() and back to the caller, held in the web client or
// the Teams conversation store, persisted nowhere.

const SYM = { GBP: '£', EUR: '€', USD: '$' };
const CURRENCY_WORDS = [
  [/\b(gbp|pound(s)?|sterling)\b/i, 'GBP'],
  [/\b(eur|euro(s)?)\b/i, 'EUR'],
  [/\b(usd|dollar(s)?)\b/i, 'USD'],
];

export function emptyQuote(reference = null) {
  return { reference: reference || null, currency: 'GBP', lines: [] };
}

// A part token is a word carrying a digit, the price lookup's own shape.
const PART = '[A-Z0-9][A-Z0-9/.-]*\\d[A-Z0-9/.-]*';

// What does this message ask of the basket? Deliberately narrow: the basket
// engages on its own verbs alone, so an ordinary pricing question, a build,
// or a spec question mid-quote falls through to the normal paths untouched.
export function quoteIntent(question, open) {
  const q = String(question || '').trim();
  if (!q) return null;
  if (/\b(?:start|begin|open)\s+(?:a|the|another|a\s+new|my)\s+quote\b/i.test(q) || /\bnew\s+quote\b/i.test(q)) {
    const ref = q.match(/\bquote\b\s+for\s+(.{1,80}?)[.!?]?\s*$/i);
    return { kind: 'start', reference: ref ? ref[1].trim() : null };
  }
  if (!open) return null;
  if (/\b(discard|scrap|cancel|clear)\b[^.]*\bquote\b/i.test(q)) return { kind: 'discard' };
  if (/\b(show|see|view|read)\b[^.]*\bquote\b/i.test(q) || /\bquote so far\b/i.test(q) || /^totals?\??$/i.test(q)) {
    return { kind: 'show' };
  }
  const rm = q.match(/\b(?:remove|drop|delete)\b[^.]*?\bline\s*(\d+)/i);
  if (rm) return { kind: 'remove', line: Number(rm[1]) };
  const rmPart = q.match(new RegExp(`\\b(?:remove|drop|delete)\\b[^.]*?(${PART})`, 'i'));
  if (rmPart) return { kind: 'remove', part: rmPart[1].toUpperCase() };
  const add = q.match(new RegExp(`\\b(?:add\\s+)?(\\d{1,4})\\s*(?:x|of|off)\\s*(${PART})\\b`, 'i'))
    || q.match(new RegExp(`\\badd\\s+(?:an?\\s+)?(${PART})\\b`, 'i'));
  if (add) {
    const qty = add.length === 3 ? Number(add[1]) : 1;
    const part = (add.length === 3 ? add[2] : add[1]).toUpperCase();
    if (qty >= 1) return { kind: 'add', part, qty };
  }
  for (const [re, cur] of CURRENCY_WORDS) {
    if (re.test(q) && /\b(in|to|switch|currency)\b/i.test(q)) return { kind: 'currency', currency: cur };
  }
  return null;
}

// Pure: fold a lookup result into the basket. Same part merges by quantity.
export function addLine(quote, { part, qty, match }) {
  const key = normKey(part);
  const lines = quote.lines.map(l => ({ ...l }));
  const existing = lines.find(l => normKey(l.part) === key);
  if (existing) {
    existing.qty += qty;
  } else if (match) {
    lines.push({
      part: match.partNumber, description: match.description || null, qty,
      unit: { ...match.prices }, basis: match.basis || 'sell',
      listName: match.listName || null, effectiveDate: match.effectiveDate || null,
    });
  } else {
    lines.push({ part, description: null, qty, unit: null, basis: null, listName: null, effectiveDate: null });
  }
  return { ...quote, lines };
}

export function removeLine(quote, { line, part }) {
  const lines = quote.lines.filter((l, i) => {
    if (line != null) return i + 1 !== line;
    return normKey(l.part) !== normKey(part);
  });
  return { ...quote, lines };
}

// Pure: totals in the basket's currency over the lines that carry it.
export function computeTotals(quote) {
  const cur = quote.currency;
  let total = 0, priced = 0;
  const enquiry = [], missing = [];
  for (const l of quote.lines) {
    const unit = l.unit ? l.unit[cur] : null;
    if (unit == null) {
      (l.unit ? missing : enquiry).push(l);
    } else {
      priced += 1;
      total += unit * l.qty;
    }
  }
  return { currency: cur, total, priced, enquiry, missing };
}

const money = (cur, n) => `${SYM[cur]}${Number(n).toLocaleString('en-GB')}`;

export function renderQuote(quote) {
  const head = `**Quote${quote.reference ? `, ${quote.reference}` : ''}**`;
  if (!quote.lines.length) {
    return `${head}\n\nThe quote is empty. Add a line with, for example, "add 2 x 7100", and read it back any time with "show the quote".`;
  }
  const t = computeTotals(quote);
  const cur = t.currency;
  const rows = quote.lines.map((l, i) => {
    const unit = l.unit ? l.unit[cur] : null;
    const guide = l.basis === 'guide' ? '*' : '';
    return `| ${i + 1} | ${l.part} | ${l.description || ''} | ${l.qty} | ` +
      (unit == null ? 'per enquiry | per enquiry |' : `${money(cur, unit)}${guide} | ${money(cur, unit * l.qty)}${guide} |`);
  });
  const table = [
    `| Line | Part | Description | Qty | Unit | Total |`,
    `| --- | --- | --- | --- | --- | --- |`,
    ...rows,
  ].join('\n');
  const parts = [`${head}\n\n${table}`];
  parts.push(`**Total ${money(cur, t.total)}** across ${t.priced} priced line${t.priced === 1 ? '' : 's'}.`);
  if (t.enquiry.length) {
    parts.push(`Per enquiry, no loaded price, excluded from the total: ${t.enquiry.map(l => `${l.qty} x ${l.part}`).join('; ')}. These go through PCT's enquiry process.`);
  }
  if (t.missing.length) {
    parts.push(`Priced, but not in ${cur === 'GBP' ? 'sterling' : cur}: ${t.missing.map(l => `${l.qty} x ${l.part}`).join('; ')}. Switch currency to include them, for example "switch the quote to euros".`);
  }
  const dates = [...new Set(quote.lines.map(l => l.effectiveDate && String(l.effectiveDate).slice(0, 10)).filter(Boolean))];
  const anyGuide = quote.lines.some(l => l.basis === 'guide');
  parts.push(
    'Prices are the loaded lists exactly as ingested' +
    (anyGuide ? '; lines marked * are guide prices computed through the master sheet’s own Richards transform, the margin as the sheet sets it' : '') +
    (dates.length ? `, effective ${dates.join(', ')}` : '') +
    '. Nothing here is estimated.');
  return parts.join('\n\n');
}

async function priceEnabled() {
  try {
    const { rows } = await pool.query(`SELECT value FROM kv WHERE key = 'pricelookup_enabled'`);
    return rows[0]?.value === 'on';
  } catch { return false; }
}

// The turn handler. Returns null when the message is not basket business, so
// the ordinary paths run and the open basket rides through unchanged.
export async function quoteTurn(question, quoteState) {
  const open = !!(quoteState && Array.isArray(quoteState.lines));
  const intent = quoteIntent(question, open);
  if (!intent) return null;
  if (intent.kind === 'start') {
    if (!(await priceEnabled())) {
      return { answer: 'The price lookup is switched off at the moment, so a quote cannot price its lines. Ask John to switch it on, then start the quote again.', quoteState: null };
    }
    const fresh = emptyQuote(intent.reference);
    return { answer: renderQuote(fresh), quoteState: fresh };
  }
  if (intent.kind === 'discard') {
    return { answer: 'The quote is discarded. Start a fresh one any time with "start a quote".', quoteState: null };
  }
  if (intent.kind === 'show') {
    return { answer: renderQuote(quoteState), quoteState };
  }
  if (intent.kind === 'remove') {
    const next = removeLine(quoteState, intent);
    if (next.lines.length === quoteState.lines.length) {
      return { answer: 'Nothing matched that line, so the quote is unchanged.\n\n' + renderQuote(quoteState), quoteState };
    }
    return { answer: renderQuote(next), quoteState: next };
  }
  if (intent.kind === 'currency') {
    const next = { ...quoteState, currency: intent.currency };
    return { answer: renderQuote(next), quoteState: next };
  }
  if (intent.kind === 'add') {
    let match = null;
    try {
      const r = await lookupPrice(intent.part);
      if (r.exact && r.matches.length) match = r.matches[0];
    } catch { match = null; }
    const next = addLine(quoteState, { part: intent.part, qty: intent.qty, match });
    return { answer: renderQuote(next), quoteState: next };
  }
  return null;
}
