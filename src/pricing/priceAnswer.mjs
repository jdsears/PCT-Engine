import { pool } from '../db.mjs';
import { lookupPrice, lookupOptions } from './lookup.mjs';
import { quotedLine } from './quotedLines.mjs';
import { marwinSeriesOf, renderSeriesSummary } from './marwinRanges.mjs';
import { superlativeIntent, cheapestOf, renderCheapestValve } from './cheapest.mjs';
import { lookupCost, renderCostLine, isoDay } from './supplierPrices.mjs';
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

// The family a code belongs to: its series and range, the first two
// segments (PCD-100PSIG). When neither the code nor any shortening of it is
// stored, the family's stored parts are the honest answer: what the list
// holds nearest to what was asked, never a guess at which one was meant.
export function familyKey(token) {
  const m = /^([A-Z]{1,5}\d{0,3}-[A-Z0-9.]+)(?=[/-]|$)/.exec(String(token || '').toUpperCase().replace(/\s+/g, ''));
  return m ? m[1] : null;
}

export function renderFamilyAnswer(token, family, matches, { askedCost = false, costs = {} } = {}) {
  const lines = [`**${token}** is not in the loaded list as written. The list holds these ${family} parts:`, ''];
  for (const m of matches.slice(0, 8)) {
    const prices = ['GBP', 'EUR', 'USD'].filter(c => m.prices[c] != null).map(c => `${SYM[c]}${Number(m.prices[c]).toLocaleString('en-GB')}`).join(', ');
    const cost = askedCost && costs[m.partNumber]?.cost != null ? `; purchase ${SYM[costs[m.partNumber].currency] || ''}${Number(costs[m.partNumber].cost).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '';
    lines.push(`- ${m.partNumber}${m.description ? `, ${m.description}` : ''}: ${prices}${cost}`);
  }
  if (matches.length > 8) lines.push(`- and ${matches.length - 8} more`);
  const opts = optionsAfter(token, family);
  lines.push('', `Sell prices from the ${matches[0].listName}, never estimated.` +
    (opts.length ? ` The part after ${family} in what was asked, ${opts.join(', ')}, reads as options or a variant; options are priced as additions and are not held in the engine yet.` : ''));
  if (askedCost && !matches.some(m => costs[m.partNumber]?.cost != null)) lines.push('', 'Purchase price: not held for these parts.');
  return lines.join('\n');
}

// An explicit ask for the other side of the price. John's rule, 11
// September 2026: the purchase price is given only when someone asks for
// it in so many words; every other price question answers with the sell
// price and never mentions cost.
export const asksCost = q => /\b(cost|costs|costing|costings|supplier|suppliers|buy|buying|purchase|purchasing|margin)\b/i.test(String(q || ''));

// The configured price: the base plus the adders the list prices for the
// options named, each traceable, and any option the list does not price
// named as not held rather than priced at nothing. Pure, so the arithmetic
// and the honesty are provable.
export function renderConfiguredTotal(base, options, adders, currency = 'GBP') {
  const sym = SYM[currency] || '';
  const fmt = n => `${sym}${Number(n).toLocaleString('en-GB')}`;
  const known = [], unknown = [];
  for (const o of options) {
    const key = String(o).toUpperCase().replace(/^-+/, '');
    const a = adders?.[key];
    if (a && a.currency === currency) known.push({ code: o, ...a }); else unknown.push(o);
  }
  if (!known.length && unknown.length) {
    return `The options ${unknown.join(', ')} are not priced on the loaded list, so the configured price is the base plus those adders, per enquiry.`;
  }
  const lines = ['Options from the list\'s own option table:'];
  for (const k of known) {
    lines.push(`- ${k.code}: ${k.adder === 0 ? 'no cost' : fmt(k.adder)}${k.label ? `, ${k.label}` : ''}${k.byFamily ? ` (priced as ${k.byFamily})` : ''}${k.markedDefault ? ', marked default on the list' : ''}`);
  }
  const sum = known.reduce((n, k) => n + k.adder, 0);
  if (unknown.length) {
    lines.push('', `Base plus the priced options: ${fmt(Number(base) + sum)}. ${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not priced on the loaded list, so the full configured price is that plus ${unknown.length === 1 ? 'that adder' : 'those adders'}, per enquiry.`);
  } else {
    lines.push('', `Configured price: ${fmt(Number(base) + sum)}, the base ${fmt(base)} plus ${sum ? `${fmt(sum)} of options` : 'no-cost options'}.`);
  }
  return lines.join('\n');
}

export function renderPriceAnswer(m, { configured = null, options = [], adders = null, askedCost = false, cost = null } = {}) {
  const prices = ['GBP', 'EUR', 'USD'].filter(c => m.prices[c] != null)
    .map(c => `${SYM[c]}${Number(m.prices[c]).toLocaleString('en-GB')}`).join(', ');
  const basis = m.basis === 'guide'
    ? `Guide price at the standard margin, computed from the ${m.listName}` +
      `${m.effectiveDate ? `, effective ${isoDay(m.effectiveDate)}` : ''}. ` +
      'The margin is the standard one the master price sheet sets, the single source for margin.'
    : `Sell price from the ${m.sourceTab === 'pdf' ? `${m.listName} list` : `${m.sourceTab} tab of the ${m.listName}`}` +
      `${m.effectiveDate ? `, effective ${isoDay(m.effectiveDate)}` : ''}. ` +
      'Prices come from the loaded lists and are never estimated.';
  const lines = [];
  if (configured && options.length) {
    lines.push(`**${configured}** reads as the base part ${m.partNumber} with the option${options.length === 1 ? '' : 's'} ${options.join(', ')}.`, '');
  }
  lines.push(`**${m.partNumber}**${m.description ? `, ${m.description}` : ''}: ${prices}.`, '', basis);
  if (configured && options.length) {
    const cur = m.prices.GBP != null ? 'GBP' : Object.keys(m.prices)[0];
    lines.push('', adders && Object.keys(adders).length
      ? renderConfiguredTotal(m.prices[cur], options, adders, cur)
      : 'The list prices the base unit. The options are priced as additions and are not held in the engine yet, so the configured price is the base plus the option adders, per enquiry until the option pricing is loaded.');
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
        const options = optionsAfter(tok, base);
        const adders = await lookupOptions(b.matches[0].productLine, options).catch(() => ({}));
        return { answer: renderPriceAnswer(b.matches[0], { configured: tok, options, adders, askedCost, cost: await costFor(base) }), kind: 'price' };
      }
    }
    // Nothing stored as written or shortened: the family's stored parts,
    // James's PCD-100PSIG-D-M12-PCV30/5P of 11 September 2026, where the
    // list spells the pressure controllers another way.
    const family = familyKey(tok);
    if (family && family !== tok.toUpperCase()) {
      const f = await lookupPrice(family, { limit: 8 });
      if (f.matches.length) {
        const costs = {};
        if (askedCost) for (const m of f.matches.slice(0, 8)) { const c = await costFor(m.partNumber); if (c) costs[m.partNumber] = c; }
        return { answer: renderFamilyAnswer(tok, family, f.matches, { askedCost, costs }), kind: 'family' };
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
