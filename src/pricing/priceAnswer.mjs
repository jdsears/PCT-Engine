import { pool } from '../db.mjs';
import { lookupPrice } from './lookup.mjs';
import { quotedLine } from './quotedLines.mjs';
import { marwinSeriesOf, renderSeriesSummary } from './marwinRanges.mjs';
import { superlativeIntent, cheapestOf, renderCheapestValve } from './cheapest.mjs';
import { lookupCost, renderCostLine } from './supplierPrices.mjs';
import { allConfigs } from '../configurator/registry.mjs';

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

// A configured code carries its options after the base part:
// PCD-100PSIG-D-M12-PCV30/5P is the PCD-100PSIG-D base with M12, PCV30 and
// 5P bolted on. The list prices the base; the options are additions. The
// candidates are the code with its last segment removed, again and again,
// down to the series and range, so the first stored one is the base.
export function baseKeys(token) {
  const out = [];
  let t = String(token || '').toUpperCase().replace(/\s+/g, '');
  for (;;) {
    const m = /^(.+?)[/-][A-Z0-9.]+$/.exec(t);
    if (!m || !m[1].includes('-')) break;
    t = m[1];
    out.push(t);
  }
  return out;
}
export const optionsAfter = (token, base) =>
  String(token || '').toUpperCase().replace(/\s+/g, '').slice(String(base || '').length).split(/[/-]/).filter(Boolean);

// An explicit ask for the other side of the price. John's rule, 11
// September 2026: the purchase price is given only when someone asks for
// it in so many words; every other price question answers with the sell
// price and never mentions cost.
export const asksCost = q => /\b(cost|costs|costing|costings|supplier|suppliers|buy|buying|purchase|purchasing|margin)\b/i.test(String(q || ''));

export function renderPriceAnswer(m, { configured = null, options = [], askedCost = false, cost = null } = {}) {
  const prices = ['GBP', 'EUR', 'USD'].filter(c => m.prices[c] != null)
    .map(c => `${SYM[c]}${Number(m.prices[c]).toLocaleString('en-GB')}`).join(', ');
  const basis = m.basis === 'guide'
    ? `Guide price at the standard margin, computed from the ${m.listName}` +
      `${m.effectiveDate ? `, effective ${String(m.effectiveDate).slice(0, 10)}` : ''}. ` +
      'The margin is the standard one the master price sheet sets, the single source for margin.'
    : `Sell price from the ${m.sourceTab === 'pdf' ? `${m.listName} list` : `${m.sourceTab} tab of the ${m.listName}`}` +
      `${m.effectiveDate ? `, effective ${String(m.effectiveDate).slice(0, 10)}` : ''}. ` +
      'Prices come from the loaded lists and are never estimated.';
  const lines = [];
  if (configured && options.length) {
    lines.push(`**${configured}** reads as the base part ${m.partNumber} with the option${options.length === 1 ? '' : 's'} ${options.join(', ')}.`, '');
  }
  lines.push(`**${m.partNumber}**${m.description ? `, ${m.description}` : ''}: ${prices}.`, '', basis);
  if (configured && options.length) {
    lines.push('', 'The list prices the base unit. The options are priced as additions and are not held in the engine yet, so the configured price is the base plus the option adders, per enquiry until the option pricing is loaded.');
  }
  // The purchase price appears only on an explicit ask, and only from the
  // supplier table; a sell answer never carries it.
  if (askedCost) lines.push('', renderCostLine(cost));
  return lines.join('\n');
}

// A whole-line question ("lowest cost of a Marwin valve") answered from what
// is actually loaded: the range, the cheapest loaded part by name, and the
// honest edge that anything beyond the loaded lists is still per enquiry.
// Pure renderer, so the wording is provable offline.
export function renderLineSummary(s) {
  const guide = s.anyGuide
    ? ' These are guide prices at the standard margin the master price sheet sets, the single source for margin.'
    : '';
  return `**${s.line}**, from the loaded lists: ${s.count} part${s.count === 1 ? '' : 's'} priced, ` +
    `from ${SYM.GBP}${Number(s.min).toLocaleString('en-GB')} (${s.minPart}${s.minDesc ? ', ' + s.minDesc : ''}) ` +
    `to ${SYM.GBP}${Number(s.max).toLocaleString('en-GB')}.${guide}\n\n` +
    'Parts and series beyond the loaded lists are priced per enquiry via Andy or your area sales manager.';
}

// One Marwin series, found by its description prefix from the book ingest.
async function seriesSummary(series) {
  const prefix = `Marwin ${series} series%`;
  const { rows } = await pool.query(
    `SELECT count(DISTINCT norm_key)::int AS count, min(sell_price) AS min, max(sell_price) AS max
     FROM prices WHERE product_line = 'marwin' AND currency = 'GBP' AND description LIKE $1`, [prefix]);
  if (!rows[0] || !rows[0].count) return null;
  const cheapest = (await pool.query(
    `SELECT part_number, description FROM prices
     WHERE product_line = 'marwin' AND currency = 'GBP' AND description LIKE $1
     ORDER BY sell_price ASC, norm_key LIMIT 1`, [prefix])).rows[0];
  return {
    series, count: rows[0].count, min: Number(rows[0].min), max: Number(rows[0].max),
    minPart: cheapest?.part_number || '', minDesc: cheapest?.description || null,
  };
}

// The cheapest complete build for what the question named: a Marwin series,
// the Marwin line, or another loaded line. One row, price ascending, then the
// registry reads the code back into its spec where a matrix exists. Marwin
// rows are valves by construction (the ingest skips kits and accessories);
// other lines say "part", which claims no more than the store knows.
async function cheapestValve(question) {
  const series = marwinSeriesOf(question);
  let scope, where, params;
  if (series) {
    scope = `Marwin ${series} series valve`;
    where = `product_line = 'marwin' AND description LIKE $1`;
    params = [`Marwin ${series} series%`];
  } else if (/\bmarwin\b/i.test(String(question || ''))) {
    scope = 'Marwin valve';
    where = `product_line = 'marwin'`;
    params = [];
  } else {
    const q = quotedLine(question);
    if (!q) return null;
    scope = `${q.line} part`;
    where = 'product_line = $1';
    params = [q.line.toLowerCase()];
  }
  const { rows } = await pool.query(
    `SELECT part_number, description, sell_price, price_basis, list_name FROM prices
     WHERE ${where} AND currency = 'GBP'
     ORDER BY sell_price ASC, norm_key LIMIT 1`, params);
  const c = cheapestOf(allConfigs(), rows);
  return c ? renderCheapestValve({ scope, ...c }) : null;
}

async function lineSummary(lineLabel) {
  const key = String(lineLabel || '').toLowerCase();
  const { rows } = await pool.query(
    `SELECT count(DISTINCT norm_key)::int AS count, min(sell_price) AS min, max(sell_price) AS max,
            bool_or(price_basis = 'guide') AS any_guide
     FROM prices WHERE product_line = $1 AND currency = 'GBP'`, [key]);
  if (!rows[0] || !rows[0].count) return null;
  const cheapest = (await pool.query(
    `SELECT part_number, description FROM prices
     WHERE product_line = $1 AND currency = 'GBP' ORDER BY sell_price ASC, norm_key LIMIT 1`, [key])).rows[0];
  return {
    line: lineLabel, count: rows[0].count, min: Number(rows[0].min), max: Number(rows[0].max),
    anyGuide: rows[0].any_guide, minPart: cheapest?.part_number || '', minDesc: cheapest?.description || null,
  };
}

// The deterministic price turn, or null to let the ordinary answer path run.
// Only active while the price lookup switch on the Health page is on. Order:
// a named part wins, then a superlative question answers with the cheapest
// build read back through its matrix, then a named series or line answers
// with its range, and the enquiry note remains only for lines with nothing
// loaded.
export async function priceTurn(question) {
  if (!priceIntent(question)) return null;
  if (!(await priceEnabled())) return null;
  const askedCost = asksCost(question);
  // The supplier table is read only on an explicit ask, never otherwise.
  const costFor = async key => (askedCost ? lookupCost(key).catch(() => null) : null);
  for (const tok of partTokens(question)) {
    const r = await lookupPrice(tok);
    if (r.exact && r.matches.length) {
      return { answer: renderPriceAnswer(r.matches[0], { askedCost, cost: await costFor(tok) }), kind: 'price' };
    }
    // A configured code: the base part with options after it. The first
    // stored base answers, and the options are named as additions.
    for (const base of baseKeys(tok)) {
      const b = await lookupPrice(base);
      if (b.exact && b.matches.length) {
        return { answer: renderPriceAnswer(b.matches[0], { configured: tok, options: optionsAfter(tok, base), askedCost, cost: await costFor(base) }), kind: 'price' };
      }
    }
  }
  if (superlativeIntent(question)) {
    const c = await cheapestValve(question).catch(() => null);
    if (c) return { answer: c, kind: 'cheapest' };
  }
  const series = marwinSeriesOf(question);
  if (series) {
    const s = await seriesSummary(series).catch(() => null);
    if (s) return { answer: renderSeriesSummary(s), kind: 'series' };
  }
  const q = quotedLine(question);
  if (q) {
    const s = await lineSummary(q.line).catch(() => null);
    if (s) return { answer: renderLineSummary(s), kind: 'line' };
    return { answer: `**${q.line}** is priced per enquiry, so no list price is held in the engine.\n\n${q.note}`, kind: 'quoted' };
  }
  return null;
}
