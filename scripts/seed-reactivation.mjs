import { pool } from '../src/db.mjs';
import { requireCampaign } from '../src/campaigns/registry.mjs';

// Seeds a reactivation wave: existing customers from the imported base become
// named accounts on the richards_reactivation campaign, in deliberate waves
// rather than all eleven hundred at once, because discovery, drafting and the
// reps' attention are all paced and a flood serves nobody.
//
//   node --env-file=.env scripts/seed-reactivation.mjs --grade c --limit 50
//   node --env-file=.env scripts/seed-reactivation.mjs --grade b,c --segment "Oil & Gas" --apply
//   node --env-file=.env scripts/seed-reactivation.mjs --grade c --region RA-2 --limit 25 --apply
//
// Dry by default: prints the wave, changes nothing. --apply makes each
// company a named account and a member of the reactivation campaign; the
// next research run for that campaign scores them, the relationship itself
// carries a seeded wave over the lead threshold, and discovery then finds
// their people at its own pace. Filters: --grade a|b|c (comma list, default
// c, the arms-length web shop buyers James described), --segment <text>
// matched against the CRM's own segment label, --region RA-1..RA-6,
// --limit N (default 50). Republic of Ireland companies are excluded
// always: customers there are served, never prospected, and a reactivation
// email is prospecting.
//
// What this never does: touch leads, contacts or scores, or send anything.

const APPLY = process.argv.includes('--apply');
const argAfter = f => { const i = process.argv.indexOf(f); return i !== -1 ? process.argv[i + 1] : null; };
const grades = String(argAfter('--grade') || 'c').toLowerCase().split(',').map(s => s.trim()).filter(g => ['a', 'b', 'c'].includes(g));
const segment = argAfter('--segment');
const region = argAfter('--region');
const limit = Math.max(1, Math.min(200, parseInt(argAfter('--limit') || '50', 10) || 50));
if (!grades.length) {
  console.error('usage: node --env-file=.env scripts/seed-reactivation.mjs [--grade a,b,c] [--segment <text>] [--region RA-x] [--limit N] [--apply]');
  process.exit(1);
}
const def = requireCampaign('richards_reactivation');
console.log(`Campaign: ${def.id}`);
console.log(`Wave: grade ${grades.join(', ')}${segment ? `, segment ~ "${segment}"` : ''}${region ? `, region ${region}` : ''}, limit ${limit}.`);

const params = [grades];
let where = `customer_status = ANY($1)
  AND COALESCE(crm->>'country', 'United Kingdom') <> 'Ireland'
  AND NOT EXISTS (SELECT 1 FROM company_campaigns m WHERE m.company_id = companies.id AND m.campaign = 'richards_reactivation')`;
if (segment) { params.push(`%${segment}%`); where += ` AND crm->>'segment' ILIKE $${params.length}`; }
if (region) { params.push(region); where += ` AND region = $${params.length}`; }
params.push(limit);

const { rows } = await pool.query(
  `SELECT id, name, customer_status, region, domain, crm->>'segment' AS segment
   FROM companies WHERE ${where}
   ORDER BY customer_status, name LIMIT $${params.length}`, params);

if (!rows.length) {
  console.log('No customers match this wave; every match may already be seeded.');
  await pool.end();
  process.exit(0);
}
for (const r of rows) {
  console.log(`  ${r.name}  [grade ${r.customer_status}${r.region ? ', ' + r.region : ''}${r.segment ? ', ' + r.segment : ''}${r.domain ? '' : ', no domain'}]`);
}
const noDomain = rows.filter(r => !r.domain).length;
if (noDomain) console.log(`\n${noDomain} of ${rows.length} have no domain; email discovery cannot reach them until one is set, so they will sit as leads waiting on a contact.`);

if (!APPLY) {
  console.log(`\nDry run. Nothing written. Re-run with --apply to seed these ${rows.length} into the wave.`);
  await pool.end();
  process.exit(0);
}

for (const r of rows) {
  await pool.query(`UPDATE companies SET named_account = true, updated_at = now() WHERE id = $1`, [r.id]);
  await pool.query(
    `INSERT INTO company_campaigns (company_id, campaign) VALUES ($1, 'richards_reactivation')
     ON CONFLICT (company_id, campaign) DO NOTHING`, [r.id]);
}
console.log(`\nSeeded ${rows.length}. Next: node --env-file=.env scripts/research-run.mjs --campaign richards_reactivation`);
console.log('That scores the wave, the relationship carries it over the threshold, and drafting then waits on contacts as usual.');
await pool.end();
