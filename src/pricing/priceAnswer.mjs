import { pool } from '../db.mjs';
import { lookupPrice } from './lookup.mjs';
import { quotedLine } from './quotedLines.mjs';

// Price questions in the co-pilot answer deterministically, never through the
// model: a stored part answers with its sell prices exactly as loaded, a
// quoted line answers with the enquiry process from the mega sheet's own
// notes, and when neither matches the ordinary answer path carries on under a
// standing rule that pricing routes internally, never to a manufacturer's
// phone number fished out of a datasheet footer.

// Deliberately precise: money words only. "How much flow can it pass" is a
// specification question and must never be hijacked into a pricing turn, so
// bare "how much" does not qualify.
const PRICE_INTENT = /\b(price[sd]?|pricing|cost(s|ed)?|quote|quotation|quoted|cheapest|rrp)\b/i;
export const priceIntent = q => PRICE_INTENT.test(String(q || ''));

// Candidate part tokens: words carrying a digit (SEM203/P, 7100, CV3861-10),
// most specific first.
export function partTokens(question) {
  const m = String(question || '').toUpperCase().match(/\b[A-Z0-9][A-Z0-9/.-]*\d[A-Z0-9/.-]*\b/g) || [];
  return [...new Set(m)].sort((a, b) => b.length - a.length).slice(0, 5);
}

async function priceEnabled() {
  try {
    const { rows } = await pool.query(`SELECT value FROM kv WHERE key = 'pricelookup_enabled'`);
    return rows[0]?.value === 'on';
  } catch { return false; }
}

const SYM = { GBP: '£', EUR: '€', USD: '$' };
export function renderPriceAnswer(m) {
  const prices = ['GBP', 'EUR', 'USD'].filter(c => m.prices[c] != null)
    .map(c => `${SYM[c]}${Number(m.prices[c]).toLocaleString('en-GB')}`).join(', ');
  const basis = m.basis === 'guide'
    ? `Guide price at the standard margin, computed from the ${m.listName}` +
      `${m.effectiveDate ? `, effective ${String(m.effectiveDate).slice(0, 10)}` : ''}. ` +
      'The final margin is set per customer at quote, so confirm with Andy or your area sales manager before quoting.'
    : `Sell price from the ${m.sourceTab} tab of the ${m.listName}` +
      `${m.effectiveDate ? `, effective ${String(m.effectiveDate).slice(0, 10)}` : ''}. ` +
      'Prices come from the loaded lists and are never estimated.';
  return `**${m.partNumber}**${m.description ? `, ${m.description}` : ''}: ${prices}.\n\n${basis}`;
}

// The deterministic price turn, or null to let the ordinary answer path run.
// Only active while the price lookup switch on the Health page is on.
export async function priceTurn(question) {
  if (!priceIntent(question)) return null;
  if (!(await priceEnabled())) return null;
  for (const tok of partTokens(question)) {
    const r = await lookupPrice(tok);
    if (r.exact && r.matches.length) return { answer: renderPriceAnswer(r.matches[0]), kind: 'price' };
  }
  const q = quotedLine(question);
  if (q) return { answer: `**${q.line}** is priced per enquiry, so no list price is held in the engine.\n\n${q.note}`, kind: 'quoted' };
  return null;
}
