#!/usr/bin/env node
// Ingest the Mega Price List's explicit sell tabs into the prices table.
// Dry run by default: it parses, prints what it would store per tab, shows a
// small sample, and states exactly which cost, purchase and list columns were
// skipped. --apply writes, replacing each tab's rows wholesale so vanished
// parts vanish here too and re-running is always safe.
//
//   node --env-file=.env scripts/ingest-prices.mjs --file "/path/to/Mega_Price_List.xlsx"
//   node --env-file=.env scripts/ingest-prices.mjs --file "..." --effective 2026-07-14 --apply
//
// The file comes from the Sales Engine SharePoint; point --file at a local
// copy or the synced OneDrive path. Runs on a machine with .env, needs only
// DATABASE_URL. Nothing here touches the embedding pipeline.
import ExcelJS from 'exceljs';
import { parseMegaWorkbook } from '../src/pricing/parseMega.mjs';
import { pool } from '../src/db.mjs';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? null : (args[i + 1] || null); };
const APPLY = args.includes('--apply');
const FILE = flag('--file');
const EFFECTIVE = flag('--effective') || new Date().toISOString().slice(0, 10);

if (!FILE) {
  console.error('Usage: node --env-file=.env scripts/ingest-prices.mjs --file "<Mega_Price_List.xlsx>" [--effective YYYY-MM-DD] [--apply]');
  process.exit(1);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(EFFECTIVE)) {
  console.error(`--effective must be YYYY-MM-DD, got ${EFFECTIVE}`);
  process.exit(1);
}

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(FILE);
const { rows, report } = parseMegaWorkbook(wb);

console.log(`Mega Price List: ${rows.length} price rows across ${Object.keys(report.tabs).length} tab(s), effective ${EFFECTIVE}.\n`);
for (const [line, t] of Object.entries(report.tabs)) {
  console.log(`  ${line}: ${t.parts} part(s), ${t.rows} price row(s), ${t.skippedNoPrice} row(s) without a sell price skipped`);
  console.log(`    columns excluded, never ingested: ${report.skippedColumns[line].join(', ')}`);
  for (const s of rows.filter(r => r.productLine === line).slice(0, 3)) {
    console.log(`    sample: ${s.partNumber}  ${s.currency} ${s.sellPrice}${s.description ? '  ' + s.description.slice(0, 40) : ''}`);
  }
}
if (report.missingTabs.length) console.log(`\n  Tabs not found in this file: ${report.missingTabs.join(', ')}`);

if (!rows.length) {
  console.log('\nNothing to store. Not writing.');
  process.exit(2);
}
if (!APPLY) {
  console.log('\nDry run, nothing written. Re-run with --apply to store.');
  process.exit(0);
}

const client = await pool.connect();
try {
  await client.query('BEGIN');
  for (const line of Object.keys(report.tabs)) {
    await client.query(`DELETE FROM prices WHERE product_line = $1`, [line]);
  }
  for (const r of rows) {
    await client.query(
      `INSERT INTO prices (product_line, part_number, norm_key, description, currency, sell_price, list_name, source_tab, effective_date)
       VALUES ($1, $2, $3, $4, $5, $6, 'Mega Price List', $7, $8)
       ON CONFLICT (product_line, norm_key, currency) DO UPDATE
         SET part_number = EXCLUDED.part_number, description = EXCLUDED.description,
             sell_price = EXCLUDED.sell_price, source_tab = EXCLUDED.source_tab,
             effective_date = EXCLUDED.effective_date, ingested_at = now()`,
      [r.productLine, r.partNumber, r.normKey, r.description, r.currency, r.sellPrice, r.sourceTab, EFFECTIVE]);
  }
  await client.query('COMMIT');
  console.log(`\nStored. ${rows.length} price rows are live. Flip the price lookup switch on the Health page when James has verified a sample.`);
} catch (e) {
  await client.query('ROLLBACK');
  console.error(`\nFailed, nothing changed: ${e.message}`);
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
