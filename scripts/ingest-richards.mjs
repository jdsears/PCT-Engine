#!/usr/bin/env node
// Guide prices for the Richards price books beyond Marwin: Steriflow,
// LowFlow and Jordan through the generic book parser, the same workbook
// transform, the same storage, the same labels. Dry run by default.
//
//   node --env-file=.env scripts/ingest-richards.mjs --workbook "<Mega Price List.xlsx>" --line steriflow --pdf "<STERIFLOW...pdf>"
//   ... --apply
//
// BestoBell and Hex go through their own page specs in parseBooksSpecial.
// Food and Beverage stays refused: its tables merge one price across several
// size columns, beyond the two-size pair James ruled on, so it keeps the
// per-enquiry answer until there is guidance for it.
import { execFileSync } from 'node:child_process';
import { readRichardsTransform, computeGuide } from '../src/pricing/richardsTransform.mjs';
import { parseRichardsBook } from '../src/pricing/parseRichardsPdf.mjs';
import { parseBestobell, parseHex } from '../src/pricing/parseBooksSpecial.mjs';
import { normKey } from '../src/pricing/parseMega.mjs';
import { materialiseSource } from '../src/sharepoint.mjs';
import { pool } from '../src/db.mjs';

const SUPPORTED = ['steriflow', 'lowflow', 'jordan', 'bestobell', 'hex'];
const REFUSED = {
  fb: 'prices merge across size columns, so single-size attribution would be a guess',
  food_beverage: 'prices merge across size columns, so single-size attribution would be a guess',
};

const args = process.argv.slice(2);
const flag = n => { const i = args.indexOf(n); return i === -1 ? null : (args[i + 1] || null); };
const APPLY = args.includes('--apply');
// Source flags also take "sharepoint:<path in the Sales Engine library>",
// fetched read-only and transiently at run time.
const src = async v => {
  try { return await materialiseSource(v, { log: m => console.log(m) }); }
  catch (e) { console.error(`SharePoint fetch failed: ${String(e.message).slice(0, 200)}`); process.exit(1); }
};
const WORKBOOK = await src(flag('--workbook'));
const PDF = await src(flag('--pdf'));
const LINE = (flag('--line') || '').toLowerCase();
const EFFECTIVE = flag('--effective') || new Date().toISOString().slice(0, 10);

if (!WORKBOOK || !PDF || !LINE) {
  console.error('Usage: node --env-file=.env scripts/ingest-richards.mjs --workbook "<xlsx>" --line <steriflow|lowflow|jordan> --pdf "<price list pdf>" [--apply]');
  process.exit(1);
}
if (REFUSED[LINE]) {
  console.error(`${LINE} is not parseable by the generic reader yet (${REFUSED[LINE]}); it keeps the per-enquiry answer until its own page spec is built.`);
  process.exit(1);
}
if (!SUPPORTED.includes(LINE)) {
  console.error(`Unknown line "${LINE}". Supported: ${SUPPORTED.join(', ')}.`);
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

let text;
try {
  text = execFileSync('pdftotext', ['-layout', PDF, '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
} catch (e) {
  console.error(`pdftotext failed: ${e.message}`);
  process.exit(1);
}
const { parts, report } = LINE === 'bestobell' ? parseBestobell(text)
  : LINE === 'hex' ? parseHex(text)
  : parseRichardsBook(text, { line: LINE });
console.log(`Parsed ${LINE}: ${parts.length} base part(s) (${Object.entries(report).map(([k, v]) => `${k}=${v}`).join(', ')}).`);
if (report.spanned) console.log(`  ${report.spanned} price(s) printed between two sizes were applied to both, as James confirmed in July 2026.`);
if (report.ambiguous) console.log(`  ${report.ambiguous} part-number position(s) sat between size columns and were skipped rather than guessed.`);
if (!parts.length) { console.error('Nothing parsed; not writing.'); await pool.end(); process.exit(2); }

const priced = parts.map(r => ({ ...r, guide: computeGuide(r.listUsd, transform) }));
console.log(`\n${LINE} guide prices, effective ${EFFECTIVE}:`);
for (const s of priced.slice(0, 5)) {
  console.log(`  sample: ${s.part}  £${s.guide.GBP}  €${s.guide.EUR}  $${s.guide.USD}  ${s.description.slice(0, 56)}`);
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
  await client.query(`DELETE FROM prices WHERE product_line = $1`, [LINE]);
  for (const r of priced) {
    for (const [currency, sell] of Object.entries(r.guide)) {
      await client.query(
        `INSERT INTO prices (product_line, part_number, norm_key, description, currency, sell_price, price_basis, list_name, source_tab, effective_date)
         VALUES ($1, $2, $3, $4, $5, $6, 'guide', $7, 'guide', $8)
         ON CONFLICT (product_line, norm_key, currency) DO UPDATE SET sell_price = EXCLUDED.sell_price,
           part_number = EXCLUDED.part_number, description = EXCLUDED.description, effective_date = EXCLUDED.effective_date, ingested_at = now()`,
        [LINE, r.part, normKey(r.part), r.description, currency, sell, `${LINE} price list via Richards transform`, EFFECTIVE]);
    }
  }
  await client.query('COMMIT');
  console.log(`\nStored. ${priced.length} ${LINE} part(s) carry guide prices, labelled guide everywhere they surface.`);
} catch (e) {
  await client.query('ROLLBACK');
  console.error(`\nFailed, nothing changed: ${e.message}`);
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
