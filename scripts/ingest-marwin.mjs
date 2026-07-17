#!/usr/bin/env node
// Marwin guide prices: list prices in, the Richards transform from the mega
// sheet applied, only the finished guide sells stored, labelled guide
// everywhere they surface. Dry run by default; --apply writes.
//
//   node --env-file=.env scripts/ingest-marwin.mjs --workbook "<Mega Price List.xlsx>" --probe
//   node --env-file=.env scripts/ingest-marwin.mjs --workbook "<xlsx>" --pdf "<Marwin_NA_REV1.pdf>"
//   node --env-file=.env scripts/ingest-marwin.mjs --workbook "<xlsx>" --pdf "<pdf>" --apply
//
// --probe only reads and validates the transform against the sheet's own
// example row, printing a pass or the exact mismatch, never the raw
// percentages. --pdf extracts the CV3000 and CV4700 pages (default 27-34,
// override with --pages "a-b") through pdftotext and parses the base model
// tables; --csv (rows of part,description,list_usd) remains as the manual
// side door. Both feed the same transform and storage path.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { readRichardsTransform, computeGuide } from '../src/pricing/richardsTransform.mjs';
import { parseMarwinPages } from '../src/pricing/parseMarwinPdf.mjs';
import { normKey } from '../src/pricing/parseMega.mjs';
import { pool } from '../src/db.mjs';

const args = process.argv.slice(2);
const flag = n => { const i = args.indexOf(n); return i === -1 ? null : (args[i + 1] || null); };
const APPLY = args.includes('--apply');
const PROBE = args.includes('--probe');
const WORKBOOK = flag('--workbook');
const CSV = flag('--csv');
const PDF = flag('--pdf');
const PAGES = flag('--pages') || '27-34';
const EFFECTIVE = flag('--effective') || new Date().toISOString().slice(0, 10);

if (!WORKBOOK) {
  console.error('Usage: node --env-file=.env scripts/ingest-marwin.mjs --workbook "<Mega Price List.xlsx>" [--probe | --csv <file> [--apply]]');
  process.exit(1);
}

let transform;
try {
  transform = await readRichardsTransform(WORKBOOK);
  console.log('Richards transform read from the workbook and verified against its own example row.');
} catch (e) {
  console.error(`Transform read failed, nothing computed: ${e.message}`);
  process.exit(1);
}
if (PROBE) { await pool.end(); process.exit(0); }

if (!CSV && !PDF) {
  console.error('No list source. Pass --pdf "<Marwin price list>" (pages 27-34 by default) or --csv <file>.');
  await pool.end();
  process.exit(1);
}

let rows = [];
if (PDF) {
  const [f, l] = PAGES.split('-').map(n => parseInt(n, 10));
  let text;
  try {
    text = execFileSync('pdftotext', ['-layout', '-f', String(f), '-l', String(l || f), PDF, '-'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch (e) {
    console.error(`pdftotext failed: ${e.message}. Install poppler (brew install poppler) or check the path.`);
    await pool.end();
    process.exit(1);
  }
  const parsed = parseMarwinPages(text);
  rows = parsed.parts;
  console.log(`Parsed pages ${PAGES}: ${parsed.report.rows} model rows, ${parsed.report.parts} part(s), characterised-plate adder ${parsed.report.adder ? 'found and applied to the CV variants' : 'NOT found, CV variants skipped'}.`);
} else {
  for (const line of readFileSync(CSV, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || /^part\b/i.test(t)) continue;
    const cols = t.split(',').map(s => s.trim());
    const listUsd = parseFloat(cols[cols.length - 1]);
    const part = cols[0];
    const description = cols.slice(1, -1).join(', ') || null;
    if (!part || !Number.isFinite(listUsd) || listUsd <= 0) { console.log(`  skipped line: ${t.slice(0, 60)}`); continue; }
    rows.push({ part, description, listUsd });
  }
}
if (!rows.length) { console.error('No usable rows found.'); await pool.end(); process.exit(2); }

const priced = rows.map(r => ({ ...r, guide: computeGuide(r.listUsd, transform) }));
console.log(`\nMarwin guide prices, effective ${EFFECTIVE}: ${priced.length} part(s).`);
for (const s of priced.slice(0, 5)) {
  console.log(`  sample: ${s.part}  £${s.guide.GBP}  €${s.guide.EUR}  $${s.guide.USD}${s.description ? '  ' + s.description.slice(0, 40) : ''}`);
}
console.log('  (list prices and the transform parameters are not stored or printed)');

if (!APPLY) {
  console.log('\nDry run, nothing written. Check the samples against the calculator, then re-run with --apply.');
  await pool.end();
  process.exit(0);
}

const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query(`DELETE FROM prices WHERE product_line = 'marwin'`);
  for (const r of priced) {
    for (const [currency, sell] of Object.entries(r.guide)) {
      await client.query(
        `INSERT INTO prices (product_line, part_number, norm_key, description, currency, sell_price, price_basis, list_name, source_tab, effective_date)
         VALUES ('marwin', $1, $2, $3, $4, $5, 'guide', 'Marwin NA price list via Richards transform', 'guide', $6)`,
        [r.part, normKey(r.part), r.description, currency, sell, EFFECTIVE]);
    }
  }
  await client.query('COMMIT');
  console.log(`\nStored. ${priced.length} Marwin part(s) carry guide prices, labelled guide everywhere they surface.`);
  console.log('Have James check a few against the calculator before the team leans on them.');
} catch (e) {
  await client.query('ROLLBACK');
  console.error(`\nFailed, nothing changed: ${e.message}`);
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
