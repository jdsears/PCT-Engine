#!/usr/bin/env node
// Ingest the Alicat GBP customer price list into the prices table.
// Dry run by default: it finds the header row, classifies every column by
// name, and prints that classification for a human to confirm, with samples.
// --apply writes, replacing the Alicat line wholesale so vanished parts vanish
// here too and re-running is always safe.
//
//   node --env-file=.env scripts/ingest-alicat-prices.mjs --file "sharepoint:<path>/Alicat Q1 2026.xlsx"
//   node --env-file=.env scripts/ingest-alicat-prices.mjs --file "..." --sheet "Price list" --gbp-column K --apply
//
// Only selling prices are stored, ever. Alicat's own list is in USD and PCT's
// cost is that list less a discount, so a USD column with no sell marker is
// set aside and a column whose name says cost, discount, margin or supplier is
// excluded outright; naming one of those with a column flag is refused. When
// the header leaves a currency ambiguous the dry run says so and --apply
// refuses until the column is named: --gbp-column, --eur-column, --usd-column,
// as a number or an Excel letter.
//
// --file is required and there is no fallback to PRICE_WORKBOOK, because that
// is the Mega Price List, a different document with different rules.
import ExcelJS from 'exceljs';
import { parseAlicatWorkbook, applyBlockers, colLetter } from '../src/pricing/parseAlicat.mjs';
import { pool } from '../src/db.mjs';
import { materialiseSource, isSharepointRef } from '../src/sharepoint.mjs';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? null : (args[i + 1] || null); };
const APPLY = args.includes('--apply');
const SOURCE = flag('--file');
const SHEET = flag('--sheet');
const LIST_NAME = flag('--list') || 'Alicat Q1 2026';
const EFFECTIVE = flag('--effective') || new Date().toISOString().slice(0, 10);
const LINE = 'alicat';

if (!SOURCE) {
  console.error('Usage: node --env-file=.env scripts/ingest-alicat-prices.mjs --file "sharepoint:<path>" [--sheet <name>] [--list <name>] [--effective YYYY-MM-DD] [--gbp-column N] [--eur-column N] [--usd-column N] [--apply]');
  process.exit(1);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(EFFECTIVE)) {
  console.error(`--effective must be YYYY-MM-DD, got ${EFFECTIVE}`);
  process.exit(1);
}
const overrides = {};
for (const cur of ['gbp', 'eur', 'usd']) {
  const v = flag(`--${cur}-column`);
  if (v) overrides[cur.toUpperCase()] = v;
}

if (!isSharepointRef(SOURCE)) {
  console.log(`WARNING: reading the price list from a local file, which may be a stale download: ${SOURCE}`);
  console.log('         The live copy is on SharePoint; pass --file "sharepoint:<path>" to read it there.');
}
let FILE;
try { FILE = await materialiseSource(SOURCE, { log: m => console.log(m) }); }
catch (e) { console.error(`Workbook fetch failed: ${String(e.message).slice(0, 200)}`); process.exit(1); }

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(FILE);
const { rows, report } = parseAlicatWorkbook(wb, { sheet: SHEET, overrides });

const at = c => `column ${c.col} (${colLetter(c.col)}) "${c.header}"`;
console.log(`\nAlicat price list, effective ${EFFECTIVE}, stored as "${LIST_NAME}" on the ${LINE} line.`);
console.log(`  sheet read: ${report.sheet || 'none'}${report.sheets.length > 1 ? `  (sheets in the file: ${report.sheets.join(', ')}; pick another with --sheet)` : ''}`);

if (report.header == null) {
  console.log('\n  No header row found in the top rows: nothing names a part number beside a price. The top of the sheet reads:');
  for (const [i, vals] of report.firstRows.entries()) console.log(`    row ${i + 1}: ${vals.filter(Boolean).join(' | ') || '(empty)'}`);
  console.log('\nNothing stored. If the list is on another sheet, pass --sheet; if the headers are unusual, say so and the parser learns them.');
  await pool.end();
  process.exit(2);
}

console.log(`  header on row ${report.header}`);
console.log(`  part number: ${at(report.columns.part)}`);
console.log(`  description: ${report.columns.description ? at(report.columns.description) : 'none found'}`);
console.log('  stored as sell prices:');
for (const [cur, c] of Object.entries(report.columns.sells)) {
  const assumed = report.assumed.find(a => a.col === c.col);
  console.log(`    ${cur}: ${at(c)}${c.named ? '  (named on the command line)' : ''}${assumed ? '  (no currency in the header, read as GBP)' : ''}`);
}
if (!Object.keys(report.columns.sells).length) console.log('    none');
if (report.excluded.length) {
  console.log('  excluded, never ingested:');
  for (const e of report.excluded) console.log(`    ${at(e)}: ${e.why}`);
}
if (report.ignored.length) console.log(`  ignored, not a price: ${report.ignored.map(at).join(', ')}`);
console.log(`\n  ${report.parts} part(s), ${report.rows} price row(s), ${report.skippedNoPrice} row(s) without a sell price skipped (section headings and unpriced parts).`);
for (const s of rows.slice(0, 5)) {
  console.log(`    sample: ${s.partNumber}  ${s.currency} ${s.sellPrice}${s.description ? '  ' + s.description.slice(0, 50) : ''}`);
}

const blockers = applyBlockers(report);
if (blockers.length) {
  console.log('\nNot storing until these are settled:');
  for (const b of blockers) console.log(`  - ${b}`);
  await pool.end();
  process.exit(2);
}
if (!APPLY) {
  console.log('\nDry run, nothing written. Check the columns above against the sheet, then re-run with --apply to store.');
  await pool.end();
  process.exit(0);
}

const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query(`DELETE FROM prices WHERE product_line = $1`, [LINE]);
  for (const r of rows) {
    await client.query(
      `INSERT INTO prices (product_line, part_number, norm_key, description, currency, sell_price, price_basis, list_name, source_tab, effective_date)
       VALUES ($1, $2, $3, $4, $5, $6, 'sell', $7, $8, $9)
       ON CONFLICT (product_line, norm_key, currency) DO UPDATE
         SET part_number = EXCLUDED.part_number, description = EXCLUDED.description,
             sell_price = EXCLUDED.sell_price, price_basis = 'sell', list_name = EXCLUDED.list_name,
             source_tab = EXCLUDED.source_tab, effective_date = EXCLUDED.effective_date, ingested_at = now()`,
      [r.productLine, r.partNumber, r.normKey, r.description, r.currency, r.sellPrice, LIST_NAME, r.sourceTab, EFFECTIVE]);
  }
  await client.query('COMMIT');
  console.log(`\nStored. ${rows.length} Alicat price rows are live across ${report.parts} part(s). The co-pilot answers Alicat part numbers from them once the price lookup switch on the Health page is on.`);
} catch (e) {
  await client.query('ROLLBACK');
  console.error(`\nFailed, nothing changed: ${e.message}`);
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
