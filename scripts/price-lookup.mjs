#!/usr/bin/env node
// What the price tables hold for a part or a prefix, from the terminal, so a
// co-pilot answer can be checked against the store rather than argued about.
//
//   node --env-file=.env scripts/price-lookup.mjs --q PCD-100
//   node --env-file=.env scripts/price-lookup.mjs --q "PCD-100PSIG-D-M12-PCV30/5P"
//
// Prints every stored sell row whose key starts with the query, then the
// exact, shortened and family lookups the co-pilot would make for it, and
// any supplier row held for the same keys. Read-only.
import { pool } from '../src/db.mjs';
import { normKey } from '../src/pricing/parseMega.mjs';
import { baseKeys, familyKey } from '../src/pricing/priceAnswer.mjs';

const args = process.argv.slice(2);
const i = args.indexOf('--q');
const Q = i === -1 ? null : args[i + 1];
if (!Q) { console.error('Usage: node --env-file=.env scripts/price-lookup.mjs --q <part or prefix>'); process.exit(1); }

const key = normKey(Q);
const { rows } = await pool.query(
  `SELECT product_line, part_number, currency, sell_price, description, list_name FROM prices
   WHERE norm_key LIKE $1 || '%' ORDER BY norm_key, currency LIMIT 60`, [key]);
console.log(`${rows.length} stored sell row(s) whose key starts with ${key}${rows.length === 60 ? ' (first 60)' : ''}:`);
for (const r of rows) console.log(`  ${r.part_number}  ${r.currency} ${r.sell_price}  ${r.description || ''}  [${r.product_line}, ${r.list_name}]`);

const tries = [key, ...baseKeys(key)];
const fam = familyKey(key);
console.log(`\nThe co-pilot tries, in order: ${tries.join(', ')}${fam && fam !== key ? `, then the ${fam} family` : ''}.`);
for (const t of tries) {
  const hit = (await pool.query(`SELECT part_number, currency, sell_price FROM prices WHERE norm_key = $1`, [t])).rows;
  console.log(`  ${t}: ${hit.length ? hit.map(h => `${h.part_number} ${h.currency} ${h.sell_price}`).join('; ') : 'nothing'}`);
}
if (fam && fam !== key) {
  const f = (await pool.query(`SELECT part_number, currency, sell_price FROM prices WHERE norm_key LIKE $1 || '%' ORDER BY norm_key LIMIT 8`, [fam])).rows;
  console.log(`  ${fam} family: ${f.length ? f.map(h => `${h.part_number} ${h.currency} ${h.sell_price}`).join('; ') : 'nothing'}`);
}
try {
  const s = (await pool.query(`SELECT part_number, currency, list_price, discount_pct, net_price, list_name FROM supplier_prices WHERE norm_key = ANY($1)`, [tries])).rows;
  console.log(`\nSupplier rows for those keys: ${s.length ? s.map(r => `${r.part_number} list ${r.currency} ${r.list_price}${r.net_price != null ? ` net ${r.net_price}` : ` less ${r.discount_pct}%`} [${r.list_name}]`).join('; ') : 'none'}`);
} catch { console.log('\nSupplier table not created yet (migration 040).'); }
await pool.end();
