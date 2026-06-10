import { pool } from '../src/db.mjs';
import { pollCompaniesHouse } from '../src/research/companiesHouse.mjs';
import { dcSignalSweep } from '../src/research/newsResearch.mjs';
import { scoreCompany } from '../src/research/icp.mjs';
import { findContacts } from '../src/research/linkedinResearch.mjs';
import { getCreditsSpent } from '../src/research/findymail.mjs';
import { regionForPostcode } from '../src/research/region.mjs';
import { resolveDomain } from '../src/research/domains.mjs';
import { syncOfficerContacts } from '../src/research/officerContacts.mjs';

// Advances the front of the funnel. Idempotent and safe to run repeatedly:
// signals dedupe on url hash, scores are recomputed in place, and leads upsert
// one row per company per campaign without regressing stage.

const LEAD_THRESHOLD = Number(process.env.RESEARCH_LEAD_THRESHOLD || 40);
const CAMPAIGN = 'marwin_dc';

console.log('1. Polling Companies House ...');
let chCounts = { companies: 0, ch_filing: 0, ch_director_change: 0 };
try { chCounts = await pollCompaniesHouse(); }
catch (e) { console.log(`   poll failed: ${String(e.message).slice(0, 150)}`); }

console.log('2. Sweeping news signals ...');
let newsCounts = { queries: 0, inserted: 0, seen: 0 };
try { newsCounts = await dcSignalSweep(); }
catch (e) { console.log(`   sweep failed: ${String(e.message).slice(0, 150)}`); }

console.log('3. Scoring companies and upserting leads ...');
const { rows: targets } = await pool.query(
  `SELECT DISTINCT c.* FROM companies c
   LEFT JOIN signals s ON s.company_id = c.id AND NOT s.processed
   WHERE c.named_account OR s.id IS NOT NULL`);

const report = { scored: 0, leadsCreated: 0, leadsUpdated: 0, domains: 0, officersAdded: 0, officersUpdated: 0, inOrbit: 0, skipped: [] };
for (const co of targets) {
  const { rows: signals } = await pool.query(`SELECT * FROM signals WHERE company_id = $1`, [co.id]);
  const { score, breakdown } = scoreCompany(co, signals);

  // The cached Companies House profile often carries the registered postcode
  // when the search snippet did not, so backfill before assigning a region.
  const postcode = co.postcode || co.ch_profile?.registered_office_address?.postal_code || null;
  const region = co.region || regionForPostcode(postcode);
  await pool.query(
    `UPDATE companies SET icp_score = $1, icp_breakdown = $2::jsonb,
       region = COALESCE(region, $3), postcode = COALESCE(postcode, $4), updated_at = now() WHERE id = $5`,
    [score, JSON.stringify(breakdown), region, postcode, co.id]);
  report.scored++;

  if (co.named_account) {
    // Official domain, so name-and-domain email lookups can work later.
    if (!co.domain) {
      try {
        const domain = await resolveDomain(co.name);
        if (domain) {
          await pool.query(`UPDATE companies SET domain = $1, updated_at = now() WHERE id = $2`, [domain, co.id]);
          report.domains++;
        }
      } catch (e) { console.log(`  domain lookup failed for ${co.name}: ${String(e.message).slice(0, 100)}`); }
    }
    // Directors from the public register become contacts, no LinkedIn needed.
    if (co.ch_number) {
      try {
        const oc = await syncOfficerContacts(co);
        report.officersAdded += oc.added; report.officersUpdated += oc.updated; report.inOrbit += oc.inOrbit;
      } catch (e) { console.log(`  officer sync failed for ${co.name}: ${String(e.message).slice(0, 100)}`); }
    }
  }

  // LinkedIn lane socket: a no-op until the Unipile accounts are live.
  await findContacts(co, ['specifier', 'M&E lead', 'procurement']);

  if (score < LEAD_THRESHOLD) { report.skipped.push(`${co.name}: score ${score} below ${LEAD_THRESHOLD}`); continue; }

  const { rows: upserted } = await pool.query(
    `INSERT INTO leads (company_id, stage, campaign, score, score_breakdown, region)
     VALUES ($1, 'researched', $2, $3, $4::jsonb, $5)
     ON CONFLICT (company_id, campaign) DO UPDATE SET
       score = EXCLUDED.score, score_breakdown = EXCLUDED.score_breakdown,
       region = COALESCE(leads.region, EXCLUDED.region),
       stage = CASE WHEN leads.stage = 'sourced' THEN 'researched' ELSE leads.stage END,
       updated_at = now()
     RETURNING (xmax = 0) AS inserted`,
    [co.id, CAMPAIGN, score, JSON.stringify(breakdown), region]);
  if (upserted[0]?.inserted) report.leadsCreated++; else report.leadsUpdated++;
}

console.log('4. Marking consumed signals processed ...');
const ids = targets.map(t => t.id);
const { rowCount: processedCount } = ids.length
  ? await pool.query(`UPDATE signals SET processed = true WHERE company_id = ANY($1) AND NOT processed`, [ids])
  : { rowCount: 0 };
const { rows: unlinked } = await pool.query(
  `SELECT count(*)::int AS n FROM signals WHERE company_id IS NULL AND NOT processed`);

console.log('\n=== Research run report ===');
console.log(`Companies House: ${chCounts.companies} tracked, ${chCounts.ch_filing} filings, ${chCounts.ch_director_change} director changes inserted`);
console.log(`News sweep: ${newsCounts.queries} queries, ${newsCounts.seen} results seen, ${newsCounts.inserted} new signals`);
console.log(`Companies scored: ${report.scored}`);
console.log(`Domains resolved: ${report.domains}`);
console.log(`Officer contacts: ${report.officersAdded} added, ${report.officersUpdated} refreshed, ${report.inOrbit} in the decision orbit`);
console.log(`Leads created: ${report.leadsCreated}   Leads updated: ${report.leadsUpdated}   (threshold ${LEAD_THRESHOLD}, campaign ${CAMPAIGN})`);
console.log(`Signals marked processed: ${processedCount}   Awaiting company match: ${unlinked[0].n}`);
console.log(`Findymail credits spent this run: ${getCreditsSpent()}`);
console.log(`Skipped below threshold: ${report.skipped.length}`);
for (const s of report.skipped.slice(0, 15)) console.log(`  - ${s}`);
if (report.skipped.length > 15) console.log(`  ... and ${report.skipped.length - 15} more`);
console.log('\nDone.');
await pool.end();
