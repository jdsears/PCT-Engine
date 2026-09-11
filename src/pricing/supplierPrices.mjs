import { pool } from '../db.mjs';
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

// The one line the purchase price is ever given in, and only because it
// was asked for: the figure, how it was arrived at, and where it came from.
export function renderCostLine(c) {
  if (!c || c.cost == null) return 'Purchase price: not held for this part.';
  const how = c.netPrice != null
    ? `a stated net buying price`
    : `the supplier's list ${money(c.currency, c.listPrice)} less ${Number(c.discountPct)}%`;
  return `Purchase price, given because you asked for it: ${money(c.currency, c.cost)}, ${how}, from the ${c.listName}` +
    `${c.effectiveDate ? `, effective ${String(c.effectiveDate).slice(0, 10)}` : ''}. Never a figure to quote; the sell price is the one for customers.`;
}

// The supplier row for a part, by exact key, any line. Null when the table
// is not there yet or holds nothing for the part.
export async function lookupCost(query) {
  const key = normKey(query);
  if (!key) return null;
  try {
    const { rows } = await pool.query(
      `SELECT product_line, part_number, description, currency, list_price, discount_pct, net_price, list_name, effective_date
       FROM supplier_prices WHERE norm_key = $1 LIMIT 1`, [key]);
    const r = rows[0];
    if (!r) return null;
    return {
      productLine: r.product_line, partNumber: r.part_number, description: r.description, currency: r.currency,
      listPrice: Number(r.list_price), discountPct: r.discount_pct == null ? null : Number(r.discount_pct),
      netPrice: r.net_price == null ? null : Number(r.net_price),
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
