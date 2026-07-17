import { pool } from '../db.mjs';
import { normKey } from './parseMega.mjs';
import { quotedLine } from './quotedLines.mjs';

// The deterministic price lookup: a plain indexed query, no model anywhere in
// the path. Exact match on the normalised key first; failing that, a prefix
// match so a partial part number surfaces candidates rather than nothing. The
// answer is only ever what the loaded lists say.

function groupRows(rows) {
  const byPart = new Map();
  for (const r of rows) {
    const k = `${r.product_line}|${r.norm_key}`;
    if (!byPart.has(k)) {
      byPart.set(k, {
        partNumber: r.part_number, productLine: r.product_line, description: r.description,
        prices: {}, listName: r.list_name, sourceTab: r.source_tab, effectiveDate: r.effective_date,
        basis: r.price_basis || 'sell',
      });
    }
    byPart.get(k).prices[r.currency] = Number(r.sell_price);
  }
  return [...byPart.values()];
}

export async function lookupPrice(query, { limit = 8 } = {}) {
  const key = normKey(query);
  if (!key) return { query, exact: false, matches: [] };
  const exact = await pool.query(
    `SELECT product_line, part_number, norm_key, description, currency, sell_price, list_name, source_tab, effective_date, price_basis
     FROM prices WHERE norm_key = $1`, [key]);
  if (exact.rows.length) return { query, exact: true, matches: groupRows(exact.rows) };
  const prefix = await pool.query(
    `SELECT product_line, part_number, norm_key, description, currency, sell_price, list_name, source_tab, effective_date, price_basis
     FROM prices WHERE norm_key LIKE $1 || '%' ORDER BY norm_key LIMIT $2`, [key, limit * 3]);
  const matches = groupRows(prefix.rows).slice(0, limit);
  // No stored price, but the query names a quoted line: answer with the
  // process that produces the price, never with a number.
  const quoted = matches.length === 0 ? quotedLine(query) : null;
  return { query, exact: false, matches, ...(quoted ? { quoted } : {}) };
}

export async function priceStatus() {
  try {
    const { rows } = await pool.query(
      `SELECT product_line, count(DISTINCT norm_key)::int AS parts, max(ingested_at) AS last
       FROM prices GROUP BY product_line`);
    const lines = rows.reduce((a, r) => { a[r.product_line] = r.parts; return a; }, {});
    const parts = rows.reduce((a, r) => a + r.parts, 0);
    const last = rows.reduce((a, r) => (a && a > r.last ? a : r.last), null);
    return { parts, lines, lastIngest: last };
  } catch (e) {
    if (/relation "prices" does not exist/i.test(String(e))) return { parts: 0, lines: {}, lastIngest: null, migrationPending: true };
    throw e;
  }
}
