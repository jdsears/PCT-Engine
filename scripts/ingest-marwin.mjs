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
// tables; --md takes the full book's markdown extraction and covers every
// other valve series through parseMarwinMd; --csv (rows of
// part,description,list_usd) remains as the manual side door. All feed the
// same transform and storage path, but each source owns only its own rows:
// the PDF ingest keeps source_tab 'guide', the markdown ingest writes
// source_tab 'book', and neither delete touches the other. A code the
// markdown parse produces that the applied CV ingest already holds is
// skipped and named rather than silently repriced.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { readRichardsTransform, computeGuide } from '../src/pricing/richardsTransform.mjs';
import { parseMarwinPages } from '../src/pricing/parseMarwinPdf.mjs';
import { parseMarwinMd } from '../src/pricing/parseMarwinMd.mjs';
import { normKey } from '../src/pricing/parseMega.mjs';
import { storeGuideRows } from '../src/pricing/storeGuide.mjs';
import { materialiseSource, resolveWorkbook } from '../src/sharepoint.mjs';
import { pool } from '../src/db.mjs';

const args = process.argv.slice(2);
const flag = n => { const i = args.indexOf(n); return i === -1 ? null : (args[i + 1] || null); };
const APPLY = args.includes('--apply');
const PROBE = args.includes('--probe');
// Any source flag also takes "sharepoint:<path in the Sales Engine library>",
// fetched read-only and transiently at run time so the ingest always reads
// the current file, not a stale download.
const src = async v => {
  try { return await materialiseSource(v, { log: m => console.log(m) }); }
  catch (e) { console.error(`SharePoint fetch failed: ${String(e.message).slice(0, 200)}`); process.exit(1); }
};
const WORKBOOK = await resolveWorkbook(flag('--workbook'), { log: m => console.log(m) })
  .catch(e => { console.error(`Workbook fetch failed: ${String(e.message).slice(0, 200)}`); process.exit(1); });
const CSV = await src(flag('--csv'));
const PDF = await src(flag('--pdf'));
const MD = await src(flag('--md'));
const PAGES = flag('--pages') || '27-34';
const EFFECTIVE = flag('--effective') || new Date().toISOString().slice(0, 10);

if (!WORKBOOK) {
  console.error('Usage: node --env-file=.env scripts/ingest-marwin.mjs [--workbook "sharepoint:<path>"] [--probe | --csv <file> | --md <file> [--apply]]');
  console.error('Set PRICE_WORKBOOK to the workbook\'s sharepoint: path and --workbook becomes optional.');
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

if (!CSV && !PDF && !MD) {
  console.error('No list source. Pass --pdf "<Marwin price list>" (pages 27-34 by default), --md "<full book markdown>" or --csv <file>.');
  await pool.end();
  process.exit(1);
}

let rows = [];
if (MD) {
  const parsed = parseMarwinMd(readFileSync(MD, 'utf8'));
  rows = parsed.parts;
  const r = parsed.report;
  console.log(`Parsed the full book: ${r.pages} valve page(s), ${r.parts} part(s).`);
  if (parsed.defaultedSeries.length) {
    console.log(`  sizes expanded by the book's stated numeric rule, no complete code on their own pages, check a sample per series: ${parsed.defaultedSeries.join(', ')}.`);
  }
  if (parsed.mixedSeries.length) {
    console.log(`  refused outright, mixed size-code conventions: ${parsed.mixedSeries.join(', ')}.`);
  }
  if (r.conflicts) {
    console.log(`  ${r.conflicts} code(s) printed at two prices are two products under one printed code, per James (July 2026):`);
    console.log(`  the limit switch differs at configurator parts 9 and 10, Nema 4 (AA, AB) carries the lower list, Nema 7 (AC, AD) the higher,`);
    console.log(`  the designators confirmed on the Flanged Valves sheet's final page, per James, 24 July 2026.`);
    console.log(`  They stay unpriced until the resolver maps each onto its two designator-distinct codes; send this list back to wire it:`);
    for (const c of parsed.conflictParts) console.log(`    ${c}`);
  }
  if (r.spanRefused) console.log(`  ${r.spanRefused} row(s) with prices collapsed into one cell were refused rather than guessed.`);
  if (r.modelless) console.log(`  ${r.modelless} priced row(s) carry no part number in the extraction and priced nothing.`);
  if (r.unevidencedSize) console.log(`  ${r.unevidencedSize} size cell(s) had no evidenced code for their series and were refused.`);
  console.log(`  CV3000 and CV4700 pages stay with the applied PDF ingest; repair-kit and accessory pages are excluded so a kit can never be the cheapest valve.`);
} else if (PDF) {
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

// Codes both the 3000 section and the CV section print take the higher
// figure, per James (July 2026): the parts are identical, the higher price
// stands. The storage statement applies it per code and per currency, so
// this dry-run report only says how many held prices would rise.
const SOURCE = MD ? 'book' : 'guide';
if (MD) {
  try {
    const { rows: held } = await pool.query(
      `SELECT norm_key, sell_price FROM prices WHERE product_line = 'marwin' AND currency = 'GBP'`);
    const heldBy = new Map(held.map(h => [h.norm_key, Number(h.sell_price)]));
    const overlapping = priced.filter(r => heldBy.has(normKey(r.part)));
    const rising = overlapping.filter(r => r.guide.GBP > heldBy.get(normKey(r.part)));
    if (overlapping.length) {
      console.log(`  ${overlapping.length} code(s) are already held; per James the higher figure stands, so ${rising.length} would rise and the rest hold.`);
    }
  } catch (e) {
    console.log(`  could not compare against held prices (${String(e.message).slice(0, 60)}); the apply run applies the higher-figure rule regardless.`);
  }
}

console.log(`\nMarwin guide prices, effective ${EFFECTIVE}: ${priced.length} part(s).`);
for (const s of priced.slice(0, 5)) {
  console.log(`  sample: ${s.part}  £${s.guide.GBP}  €${s.guide.EUR}  $${s.guide.USD}${s.description ? '  ' + s.description.slice(0, 40) : ''}`);
}
if (MD && priced.length) {
  const floor = [...priced].sort((a, b) => a.guide.GBP - b.guide.GBP)[0];
  console.log(`  cheapest: ${floor.part}  £${floor.guide.GBP}  €${floor.guide.EUR}  $${floor.guide.USD}  ${floor.description ? floor.description.slice(0, 60) : ''}`);
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
  await client.query(`DELETE FROM prices WHERE product_line = 'marwin' AND source_tab = $1`, [SOURCE]);
  await storeGuideRows(client, {
    line: 'marwin', priced, normKey,
    listName: MD ? 'Marwin NA price list, full book, via Richards transform' : 'Marwin NA price list via Richards transform',
    sourceTab: SOURCE, effective: EFFECTIVE,
  });
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
