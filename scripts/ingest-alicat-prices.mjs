#!/usr/bin/env node
// Ingest the Alicat GBP customer price list into the prices table, from the
// workbook or the PDF, whichever James placed in the customer pricing folder.
// Dry run by default: it reads the list, classifies what it found, and
// prints that for a human to confirm, with samples. --apply writes,
// replacing the Alicat line wholesale so vanished parts vanish here too and
// re-running is always safe.
//
//   node --env-file=.env scripts/ingest-alicat-prices.mjs --file "sharepoint:Pricing/Customer Pricing/Alicat Q1 2026.pdf"
//   node --env-file=.env scripts/ingest-alicat-prices.mjs --file "sharepoint:<path>.xlsx" --sheet "Price list" --gbp-column K --apply
//
// Only selling prices are stored, ever. Alicat's own list is in USD and PCT's
// cost is that list less a discount, so USD figures are set aside and any
// column or line that says cost, discount, margin or supplier is excluded
// outright. A workbook is read by its header row (name a column with
// --gbp-column, --eur-column, --usd-column when the header leaves a currency
// ambiguous); a PDF is read line by line through pdftotext, each price
// belonging to the part number just before it, up to four pairs to a line
// (--currency GBP when the document names no currency for bare figures).
// --apply refuses while anything is unsettled.
//
// --file is required and there is no fallback to PRICE_WORKBOOK, because that
// is the Mega Price List, a different document with different rules.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { parseAlicatWorkbook, applyBlockers, colLetter } from '../src/pricing/parseAlicat.mjs';
import { parseAlicatPdfText, pdfApplyBlockers } from '../src/pricing/parseAlicatPdf.mjs';
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
  console.error('Usage: node --env-file=.env scripts/ingest-alicat-prices.mjs --file "sharepoint:<path>" [--sheet <name>] [--list <name>] [--effective YYYY-MM-DD] [--gbp-column N] [--eur-column N] [--usd-column N] [--currency GBP] [--price "PART=figure"] [--apply]');
  process.exit(1);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(EFFECTIVE)) {
  console.error(`--effective must be YYYY-MM-DD, got ${EFFECTIVE}`);
  process.exit(1);
}
const CURRENCY = flag('--currency');
if (CURRENCY && !['GBP', 'EUR'].includes(CURRENCY.toUpperCase())) { console.error('--currency wants GBP or EUR; USD is the supplier list and is never stored'); process.exit(1); }
// --price "PART=figure", repeatable: a conflict a human has settled, kept
// only when the document shows that figure for the part.
const resolve = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--price') continue;
  const m = /^(.+?)=\s*£?([\d,]+(?:\.\d+)?)$/.exec(args[i + 1] || '');
  if (!m) { console.error(`--price wants "PART=figure", got ${args[i + 1] || 'nothing'}`); process.exit(1); }
  resolve[m[1].trim()] = m[2];
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

const at = c => `column ${c.col} (${colLetter(c.col)}) "${c.header}"`;
const stop = async (code) => { await pool.end(); process.exit(code); };
console.log(`\nAlicat price list, effective ${EFFECTIVE}, stored as "${LIST_NAME}" on the ${LINE} line.`);

let rows, blockers, sourceNote;
if (/\.pdf$/i.test(SOURCE)) {
  // The PDF path: pdftotext keeps the columns; the plain extractor is the
  // fallback and keeps the words in order but not the layout.
  let pdfText = null;
  try { pdfText = execFileSync('pdftotext', ['-layout', FILE, '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
  catch (e) {
    console.log(`  pdftotext is not available (${String(e.message).slice(0, 80)}); reading the words without the layout. brew install poppler gives the better read.`);
    const { parseOfficeAsync } = await import('officeparser');
    pdfText = String(await parseOfficeAsync(await readFile(FILE)) || '');
  }
  const parsed = parseAlicatPdfText(pdfText, { currency: CURRENCY, resolve });
  rows = parsed.rows;
  const r = parsed.report;
  console.log(`  read as a PDF: ${r.lines} line(s) of text, currency for bare figures ${r.currency.default || 'unknown'}` +
    ` (symbols seen: £ ${r.currency.seen.GBP}, € ${r.currency.seen.EUR}, $ ${r.currency.seen.USD})`);
  console.log(`\n  ${r.parts} part(s), ${r.rows} price row(s).`);
  for (const s of rows.slice(0, 8)) console.log(`    sample: ${s.partNumber}  ${s.currency} ${s.sellPrice}${s.description ? '  ' + s.description.slice(0, 50) : ''}`);
  const show = (label, list, why) => { if (list.length) { console.log(`  ${label}${why ? `, ${why}` : ''}:`); for (const l of list) console.log(`    ${l}`); } };
  show('conflicts settled on the command line', r.resolved);
  show('excluded lines, never ingested', r.excluded, 'cost, discount, margin or the supplier list by name');
  show('USD figures set aside', r.usd, 'the USD list is the supplier\'s');
  show('adders, not stored', r.adders, 'priced as an addition to a base unit, not a price of a part');
  show('parts mentioned inside a description, not stored as that part\'s price', r.mentions);
  show('option table rows, not stored', r.options, 'the figure is an option\'s, with a cell between the code and it');
  show('figures with no currency, held', r.bareUnknown, 'say which with --currency GBP');
  show('prices with no part number beside them', r.priceNoPart, 'named products without a code are not stored');
  show('part numbers with no price beside them', r.partNoPrice);
  if (!rows.length || !APPLY) {
    console.log('\n  The top of the document reads:');
    for (const l of r.head) console.log(`    | ${l}`);
  }
  blockers = pdfApplyBlockers(r);
  sourceNote = 'pdf';
} else {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(FILE);
  const parsed = parseAlicatWorkbook(wb, { sheet: SHEET, overrides });
  rows = parsed.rows;
  const report = parsed.report;
  console.log(`  sheet read: ${report.sheet || 'none'}${report.sheets.length > 1 ? `  (sheets in the file: ${report.sheets.join(', ')}; pick another with --sheet)` : ''}`);
  if (report.header == null) {
    console.log('\n  No header row found in the top rows: nothing names a part number beside a price. The top of the sheet reads:');
    for (const [i, vals] of report.firstRows.entries()) console.log(`    row ${i + 1}: ${vals.filter(Boolean).join(' | ') || '(empty)'}`);
    console.log('\nNothing stored. If the list is on another sheet, pass --sheet; if the headers are unusual, say so and the parser learns them.');
    await stop(2);
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
  for (const s of rows.slice(0, 5)) console.log(`    sample: ${s.partNumber}  ${s.currency} ${s.sellPrice}${s.description ? '  ' + s.description.slice(0, 50) : ''}`);
  blockers = applyBlockers(report);
  sourceNote = report.sheet;
}

if (blockers.length) {
  console.log('\nNot storing until these are settled:');
  for (const b of blockers) console.log(`  - ${b}`);
  await stop(2);
}
if (!APPLY) {
  console.log('\nDry run, nothing written. Check the read above against the list, then re-run with --apply to store.');
  await stop(0);
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
      [r.productLine, r.partNumber, r.normKey, r.description, r.currency, r.sellPrice, LIST_NAME, r.sourceTab || sourceNote, EFFECTIVE]);
  }
  await client.query('COMMIT');
  console.log(`\nStored. ${rows.length} Alicat price rows are live. The co-pilot answers Alicat part numbers from them once the price lookup switch on the Health page is on.`);
} catch (e) {
  await client.query('ROLLBACK');
  console.error(`\nFailed, nothing changed: ${e.message}`);
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
