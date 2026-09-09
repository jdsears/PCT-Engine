#!/usr/bin/env node
// Read a website into the corpus from the terminal, the same trawl the
// Health page runs. Dry by default: it crawls, prints what it would store
// and everything it refused, and writes nothing. --apply registers the
// site (or updates its settings) and stores its pages, replacing changed
// ones and withdrawing pages gone from the site. Needs .env for the
// database and the embedding key.
//
//   node --env-file=.env scripts/trawl-site.mjs --url https://www.alicat.com --line alicat
//   node --env-file=.env scripts/trawl-site.mjs --url https://www.alicat.com --line alicat --max-pages 300 --pdfs --apply
import { pool } from '../src/db.mjs';
import { validateSite, addSite, trawlSite, tablesReady } from '../src/web/siteCorpus.mjs';

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i === -1 ? null : (args[i + 1] || null); };
const APPLY = args.includes('--apply');
const input = { url: flag('--url'), line: flag('--line') || 'general', maxPages: flag('--max-pages') || 150, includePdfs: args.includes('--pdfs') };

if (!input.url) {
  console.error('Usage: node --env-file=.env scripts/trawl-site.mjs --url <https://site> [--line <key>] [--max-pages N] [--pdfs] [--apply]');
  process.exit(1);
}
const v = validateSite(input);
if (!v.ok) { console.error(v.error); process.exit(1); }

let site = { ...v.site, max_pages: v.site.maxPages, include_pdfs: v.site.includePdfs };
if (APPLY) {
  if (!(await tablesReady())) { console.error('The website tables are not created yet; run npm run migrate first.'); process.exit(1); }
  if (!process.env.VOYAGE_API_KEY) { console.error('VOYAGE_API_KEY is not set; nothing can be embedded from here.'); process.exit(1); }
  const r = await addSite(v.site, { addedBy: 'terminal' });
  if (r.error) { console.error(r.error); process.exit(1); }
  site = r.site;
  console.log(`Registered ${site.host} as line ${site.line}, up to ${site.max_pages} pages${site.include_pdfs ? ', PDFs included' : ''}.`);
}

console.log(`${APPLY ? 'Reading' : 'Dry run over'} ${site.host} ...`);
const report = await trawlSite(site, { apply: APPLY, log: m => console.log('  ' + m) });
if (report.skipped) { console.log(report.skipped); await pool.end(); process.exit(2); }

console.log(`\n${report.pages} page(s) read from ${report.fetched} request(s)${report.truncated ? ', capped, so the site holds more' : ''}.`);
console.log(`  ${report.updated} ${APPLY ? 'stored' : 'would be stored'}, ${report.unchanged} unchanged, ${report.removed} ${APPLY ? 'withdrawn' : 'would be withdrawn'}${APPLY ? `, ${report.chunks} chunk(s) written` : ''}.`);
console.log(`  skipped: ${report.skips}`);
if (report.priceRule?.length) {
  console.log('  refused by the price rule, never read into the corpus:');
  for (const u of report.priceRule) console.log(`    ${u}`);
}
for (const s of report.sample || []) console.log(`    sample: ${s.title}  ${s.url}  (${s.words} words${s.kind === 'pdf' ? ', PDF' : ''})`);
if (report.errors?.length) {
  console.log(`  ${report.errors.length} error(s):`);
  for (const e of report.errors) console.log(`    ${e}`);
}
if (!APPLY) console.log('\nDry run, nothing written. Re-run with --apply to register the site and store its pages, or add it from the Health page.');
await pool.end();
