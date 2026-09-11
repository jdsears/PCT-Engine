import { pool, hasColumn } from '../db.mjs';
import { normKey } from './parseMega.mjs';

// The supplier side of a price, 11 September 2026, under John's rule agreed
// with James: the co-pilot may give the purchase price, but only when
// someone explicitly asks for it, and every other price question answers
// with the sell price. The supplier's list is held in its own table, never
// in the sell table; the cost is arithmetic over the list price and the
// standing discount, or a stated net buying price where one applies; and
// nothing here is read except on an explicit ask. Alicat first: the USD
// list less the standard discount, with exceptions stated per part.

const SYM = { GBP: '£', EUR: '€', USD: '$' };
const money = (cur, n) => `${SYM[cur] || ''}${Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const round2 = n => Math.round(Number(n) * 100) / 100;

// A date as YYYY-MM-DD whatever shape it arrives in: a Date from the
// database, an ISO string, or a plain day. James's answer of 11 September
// 2026 read "effective Fri Sep 11" because a Date was sliced as text.
export function isoDay(d) {
  if (!d) return null;
  const t = d instanceof Date ? d : new Date(d);
  return Number.isNaN(t.getTime()) ? String(d).slice(0, 10) : t.toISOString().slice(0, 10);
}

// The cost: the net buying price when one is stated, else the list price
// less the discount. Null when neither can be worked out; a cost is never
// guessed.
export function costFrom({ listPrice = null, discountPct = null, netPrice = null } = {}) {
  if (netPrice != null && Number.isFinite(Number(netPrice)) && Number(netPrice) > 0) return round2(netPrice);
  // No discount stated is no cost, never a discount of nothing: the list
  // price is the supplier's asking figure, not what PCT pays.
  if (discountPct == null || discountPct === '') return null;
  const list = Number(listPrice), pct = Number(discountPct);
  if (!Number.isFinite(list) || list <= 0 || !Number.isFinite(pct) || pct < 0 || pct >= 100) return null;
  return round2(list * (1 - pct / 100));
}

// The Alicat folder holds Niels Kraus's rev 101 announcement email printed
// to PDF (08-Price-List-101-and-adjustment-OEM-units.pdf). James's ruling
// of 11 September 2026: ignore it. It is not a price list, the corpus sync
// refuses it by name, and nothing here is read from it; the surcharge rule
// briefly taken from it was removed on that ruling.

// James's rules for Alicat, 11 September 2026, as cost rules a part
// matches by its code: an exact key, or a prefix with a star. The value is
// a discount off list, "partner" (cost is the partner price the list
// prints), or "list" (cost is the stated price, no discount). The first
// matching rule wins, so the specific goes before the general.
export function parseCostRule(s) {
  const m = /^(.+?)=\s*(partner|list|\d+(?:\.\d+)?)\s*$/i.exec(String(s || '').trim());
  if (!m) return null;
  const pattern = m[1].trim().toUpperCase().replace(/\s+/g, '');
  const v = m[2].toLowerCase();
  return { pattern, value: v === 'partner' ? 'partner' : v === 'list' ? 'list' : parseFloat(v) };
}
export function costRuleFor(key, rules = []) {
  const k = String(key || '').toUpperCase();
  for (const r of rules) {
    if (!r) continue;
    const hit = r.pattern.endsWith('*') ? k.startsWith(r.pattern.slice(0, -1)) : k === r.pattern;
    if (hit) return r;
  }
  return null;
}
// What a supplier row stores under a rule: the discount, the net price, and
// the rule's name for the answer. A partner rule with no partner price on
// the row stores no cost, which the dry run names rather than hides.
export function applyCostRule(row, rule, standingDiscount = 35) {
  if (!rule) return { discountPct: standingDiscount, netPrice: null, costRule: `list less ${standingDiscount}%` };
  if (rule.value === 'partner') {
    return row.partnerPrice != null
      ? { discountPct: null, netPrice: row.partnerPrice, costRule: 'partner price' }
      : { discountPct: null, netPrice: null, costRule: 'partner price, none printed for this part' };
  }
  if (rule.value === 'list') return { discountPct: 0, netPrice: null, costRule: 'list price, no discount' };
  return { discountPct: rule.value, netPrice: null, costRule: `list less ${rule.value}%` };
}

// The one line the purchase price is ever given in, and only because it
// was asked for: the figure, how it was arrived at, and where it came from.
export function renderCostLine(c) {
  if (!c || c.cost == null) return 'Purchase price: not held for this part.';
  const how = c.netPrice != null
    ? (c.costRule === 'partner price' ? "the supplier's partner price as printed" : 'a stated net buying price')
    : Number(c.discountPct) === 0
      ? `the supplier's stated price ${money(c.currency, c.listPrice)} with no discount`
      : `the supplier's list ${money(c.currency, c.listPrice)} less ${Number(c.discountPct)}%`;
  return `Purchase price, given because you asked for it: ${money(c.currency, c.cost)}, ${how}, from the ${c.listName}` +
    `${c.effectiveDate ? `, effective ${isoDay(c.effectiveDate)}` : ''}. Never a figure to quote; the sell price is the one for customers.`;
}

// The supplier row for a part, by exact key, any line. Null when the table
// is not there yet or holds nothing for the part.
export async function lookupCost(query) {
  const key = normKey(query);
  if (!key) return null;
  try {
    const withRule = await hasColumn('supplier_prices', 'cost_rule');
    const { rows } = await pool.query(
      `SELECT product_line, part_number, description, currency, list_price, discount_pct, net_price, list_name, effective_date
              ${withRule ? ', partner_price, cost_rule' : ', NULL::numeric AS partner_price, NULL::text AS cost_rule'}
       FROM supplier_prices WHERE norm_key = $1 LIMIT 1`, [key]);
    const r = rows[0];
    if (!r) return null;
    return {
      productLine: r.product_line, partNumber: r.part_number, description: r.description, currency: r.currency,
      listPrice: Number(r.list_price), discountPct: r.discount_pct == null ? null : Number(r.discount_pct),
      netPrice: r.net_price == null ? null : Number(r.net_price),
      partnerPrice: r.partner_price == null ? null : Number(r.partner_price), costRule: r.cost_rule || null,
      cost: costFrom({ listPrice: r.list_price, discountPct: r.discount_pct, netPrice: r.net_price }),
      listName: r.list_name, effectiveDate: r.effective_date,
    };
  } catch (e) {
    if (/relation "supplier_prices" does not exist/i.test(String(e))) return null;
    throw e;
  }
}

// How much supplier pricing is held, for the Health card.
export async function supplierStatus() {
  try {
    const { rows } = await pool.query(
      `SELECT product_line, count(DISTINCT norm_key)::int AS parts, max(ingested_at) AS last FROM supplier_prices GROUP BY product_line`);
    return {
      parts: rows.reduce((a, r) => a + r.parts, 0),
      lines: rows.reduce((a, r) => { a[r.product_line] = r.parts; return a; }, {}),
      lastIngest: rows.reduce((a, r) => (a && a > r.last ? a : r.last), null),
    };
  } catch (e) {
    if (/relation "supplier_prices" does not exist/i.test(String(e))) return { parts: 0, lines: {}, lastIngest: null, migrationPending: true };
    throw e;
  }
}
