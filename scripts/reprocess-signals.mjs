import { pool } from '../src/db.mjs';
import { classifySignal } from '../src/research/relevance.mjs';
import { extractParties } from '../src/research/parties.mjs';

// Re-judge the news signals already in the table through the relevance gate and
// router, as a one-off. Reversible: it only sets dc_relevant, geo_scope and
// operator, never deletes, so the gate can be tuned and this re-run. Dry run by
// default; --apply writes. Run the research run afterwards to match the survivors.
//
// --parties runs the second-party pass instead: the stored KEPT signals go
// through the party extraction, which names the contractor the gate's single
// operator field had no room for, and fills an operator only where none is
// stored. The gate verdict and the geo scope are never written in this mode;
// the calibrated judgement stands, only the naming improves. Reversible: the
// only columns touched are contractor and a null operator.

const APPLY = process.argv.includes('--apply');
const PARTIES = process.argv.includes('--parties');

if (PARTIES) {
  const { rows } = await pool.query(
    `SELECT id, title, operator, contractor, campaign, payload FROM signals
     WHERE COALESCE(relevant, dc_relevant) AND signal_type NOT LIKE 'ch_%' ORDER BY id`);
  const report = { total: rows.length, contractorFound: 0, operatorFilled: 0, unchanged: 0, failed: 0 };
  for (const s of rows) {
    let p;
    try { p = await extractParties({ title: s.title, content: s.payload?.content }, { campaign: s.campaign || 'marwin_dc' }); }
    catch (e) { report.failed++; console.log(`  extract failed for ${s.id}: ${String(e.message).slice(0, 100)}`); continue; }
    const gains = [];
    if (p.contractor && !s.contractor) { gains.push(`contractor: ${p.contractor}`); report.contractorFound++; }
    if (p.operator && !s.operator) { gains.push(`operator: ${p.operator}`); report.operatorFilled++; }
    if (!gains.length) report.unchanged++;
    console.log(`  [${gains.length ? gains.join('; ') : 'no change'}] ${(s.title || '').slice(0, 80)}`);
    if (APPLY && gains.length) {
      await pool.query(
        `UPDATE signals SET contractor = COALESCE(contractor, $1), operator = COALESCE(operator, $2) WHERE id = $3`,
        [p.contractor, p.operator, s.id]);
    }
  }
  console.log('\n=== Reprocess signals, second-party pass ===');
  console.log(`Kept news signals read: ${report.total}`);
  console.log(`Contractors found: ${report.contractorFound}   Null operators filled: ${report.operatorFilled}   Unchanged: ${report.unchanged}   Failures: ${report.failed}`);
  console.log('Gate verdicts and geo scopes untouched by design in this mode.');
  if (!APPLY) console.log('Dry run, no writes. Re-run with --parties --apply to persist (reversible: only contractor, and operator where null, change).');
  else console.log('Applied. Run scripts/research-run.mjs next to match the new parties to accounts.');
  await pool.end();
  process.exit(0);
}
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
