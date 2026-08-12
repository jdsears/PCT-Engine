import { pool } from '../src/db.mjs';
import { requireCampaign } from '../src/campaigns/registry.mjs';

// Types a campaign's untyped members, in one deliberate wave. John's
// instruction of 11 August 2026, for the pharma members first: the customer
// import loaded James's chosen population without company types, and an
// untyped member scores 35 against a lead threshold of 40, so his prospects
// could never become leads however good they are. Typing them on the
// authority of his own tab is what unlocks the pipeline, and from there
// decision-maker discovery works them leads-first at its own pace.
//
//   node --env-file=.env scripts/type-members.mjs --campaign pharma_steriflow --type pharma_manufacturer
//   node --env-file=.env scripts/type-members.mjs --campaign pharma_steriflow --type pharma_manufacturer --apply
//
// The type must be one the campaign's own ICP declares, resolved through the
// registry, never free text. Only members whose type is empty change, a
// type any human or earlier run has set is never overwritten, and the dry
// run lists every company so the wave is read before it is applied.

const APPLY = process.argv.includes('--apply');
const argAfter = f => { const i = process.argv.indexOf(f); return i !== -1 ? process.argv[i + 1] : null; };
const campArg = argAfter('--campaign');
const type = argAfter('--type');
if (!campArg || !type) {
  console.error('usage: node --env-file=.env scripts/type-members.mjs --campaign <id> --type <company type> [--apply]');
  process.exit(1);
}
const def = requireCampaign(campArg);
console.log(`Campaign: ${def.id}`);
if (!def.icp.companyTypes.includes(type)) {
  console.error(`The type must be one ${def.id} declares: ${def.icp.companyTypes.join(', ')}.`);
  process.exit(1);
}

const { rows } = await pool.query(
  `SELECT c.id, c.name, c.customer_status FROM companies c
   JOIN company_campaigns m ON m.company_id = c.id AND m.campaign = $1
   WHERE c.company_type IS NULL ORDER BY c.name`, [def.id]);

console.log(`${rows.length} untyped member(s) would become ${type}.`);
for (const r of rows) console.log(`  ${r.name}${r.customer_status ? `  [${r.customer_status === 'prospect' ? 'prospect' : 'customer ' + r.customer_status.toUpperCase()}]` : ''}`);

if (!rows.length) { await pool.end(); process.exit(0); }
if (!APPLY) {
  console.log('\nDry run. Nothing written. Re-run with --apply to type the wave.');
  await pool.end();
  process.exit(0);
}

const { rowCount } = await pool.query(
  `UPDATE companies SET company_type = $2, updated_at = now()
   WHERE company_type IS NULL AND id IN (
     SELECT company_id FROM company_campaigns WHERE campaign = $1)`, [def.id, type]);
console.log(`\nTyped ${rowCount}. The next research run scores them with the type fit; leads form where the threshold clears, and discovery works those leads first.`);
await pool.end();
