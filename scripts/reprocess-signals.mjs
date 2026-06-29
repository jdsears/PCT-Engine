import { pool } from '../src/db.mjs';
import { classifySignal } from '../src/research/relevance.mjs';

// Re-judge the news signals already in the table through the relevance gate and
// router, as a one-off. Reversible: it only sets dc_relevant, geo_scope and
// operator, never deletes, so the gate can be tuned and this re-run. Dry run by
// default; --apply writes. Run the research run afterwards to match the survivors.

const APPLY = process.argv.includes('--apply');
const { rows } = await pool.query(
  `SELECT id, title, payload FROM signals
   WHERE signal_type IN ('news_dc_build','news_contract') ORDER BY id`);

const report = { total: rows.length, kept: 0, rejected: 0, uk_project: 0, expansion_watch: 0, foreign_only: 0, failed: 0 };
for (const s of rows) {
  let cls;
  try { cls = await classifySignal({ title: s.title, content: s.payload?.content, query: s.payload?.query }); }
  catch (e) { report.failed++; console.log(`  classify failed for ${s.id}: ${String(e.message).slice(0, 100)}`); continue; }
  if (!cls.dcRelevant) report.rejected++;
  else { report.kept++; report[cls.geoScope] = (report[cls.geoScope] || 0) + 1; }
  console.log(`  [${cls.dcRelevant ? cls.geoScope : 'REJECT'}] ${(s.title || '').slice(0, 80)}`);
  if (APPLY) {
    await pool.query(
      `UPDATE signals SET dc_relevant = $1, geo_scope = $2, operator = COALESCE(operator, $3) WHERE id = $4`,
      [cls.dcRelevant, cls.dcRelevant ? cls.geoScope : null, cls.operator, s.id]);
  }
}

console.log('\n=== Reprocess signals ===');
console.log(`Total news signals: ${report.total}`);
console.log(`Kept (DC-relevant): ${report.kept}  [uk_project ${report.uk_project}, expansion_watch ${report.expansion_watch}, foreign_only ${report.foreign_only}]`);
console.log(`Rejected (not a data centre): ${report.rejected}   Classify failures: ${report.failed}`);
if (!APPLY) console.log('Dry run, no writes. Re-run with --apply to persist (reversible: only dc_relevant/geo_scope/operator change).');
else console.log('Applied. Run scripts/research-run.mjs next to match the surviving UK-project signals to accounts.');
await pool.end();
