#!/usr/bin/env node
// Run the SharePoint document sync by hand, from a machine with .env. The
// same code the engine cycle runs; --dry lists what would change without
// writing anything. Needs SHAREPOINT_SYNC_FOLDERS set, the same variable the
// service uses.
//
//   SHAREPOINT_SYNC_FOLDERS="Richards/7. Marwin" node --env-file=.env scripts/sync-sharepoint.mjs --dry
//   node --env-file=.env scripts/sync-sharepoint.mjs
import { syncSharepointDocs } from '../src/sharepointSync.mjs';
import { pool } from '../src/db.mjs';

const DRY = process.argv.includes('--dry');
const r = await syncSharepointDocs({ apply: !DRY, log: m => console.log(' ', m) });

if (r.skipped) {
  console.log(`Skipped: ${r.skipped}`);
} else {
  console.log(`${DRY ? 'Dry run. ' : ''}${r.roots} root(s): ${r.files} document(s) considered, ` +
    `${r.unchanged} unchanged, ${r.updated} ${DRY ? 'would refresh' : 'refreshed'} (${r.chunks} chunk(s)), ` +
    `${r.removed} ${DRY ? 'would be withdrawn' : 'withdrawn'}.`);
  if (r.skippedType) console.log(`  ${r.skippedType} file(s) skipped by type (only pdf, docx, pptx, txt and md sync).`);
  if (r.skippedPriceRule.length) {
    console.log(`  ${r.skippedPriceRule.length} file(s) refused by the price rule, price material never enters the corpus:`);
    for (const p of r.skippedPriceRule) console.log(`    ${p}`);
  }
  for (const e of r.errors) console.log(`  error: ${e}`);
}
await pool.end();
