import { pool } from '../db.mjs';
import { pollCompaniesHouse } from './companiesHouse.mjs';
import { dcSignalSweep } from './newsResearch.mjs';
import { scoreCompany, CONTACTABILITY_DRAFT } from './icp.mjs';
import { getCreditsSpent } from './findymail.mjs';
import { regionForPostcode } from './region.mjs';
import { resolveDomain } from './domains.mjs';
import { syncOfficerContacts } from './officerContacts.mjs';
import { matchOperator } from './match.mjs';

// One research run: poll Companies House, sweep and gate the news, match
// UK-project signals to accounts, score, and upsert leads. Extracted from
// scripts/research-run.mjs so the manual script and the in-service scheduler
// share a single source of truth. Idempotent and safe to repeat: signals dedupe
// on url hash, scores recompute in place, leads upsert one row per company per
// campaign without regressing stage. Nothing in here sends anything, and the
// LinkedIn lane is never touched: it keeps its own capped orchestrator.
export async function runResearch({ log = () => {} } = {}) {
  const LEAD_THRESHOLD = Number(process.env.RESEARCH_LEAD_THRESHOLD || 40);
  const CAMPAIGN = 'marwin_dc';

  log('1. Polling Companies House ...');
  let chCounts = { companies: 0, ch_filing: 0, ch_director_change: 0 };
  try { chCounts = await pollCompaniesHouse(); }
  catch (e) { log(`   poll failed: ${String(e.message).slice(0, 150)}`); }

  log('2. Sweeping news signals ...');
  let newsCounts = { queries: 0, inserted: 0, seen: 0 };
  try { newsCounts = await dcSignalSweep(); }
  catch (e) { log(`   sweep failed: ${String(e.message).slice(0, 150)}`); }

  log('2b. Matching UK-project news signals to accounts ...');
  const { rows: matchCompanies } = await pool.query(`SELECT id, name FROM companies`);
  const { rows: unlinkedNews } = await pool.query(
    `SELECT id, operator, title FROM signals
     WHERE company_id IS NULL AND dc_relevant AND geo_scope = 'uk_project'`);
  let newsMatched = 0;
  for (const s of unlinkedNews) {
    // Conservative: matchOperator returns null unless one account confidently fits,
    // so an unsure signal stays unmatched rather than linking the wrong company.
    const hit = matchOperator(s.operator || s.title, matchCompanies);
    if (hit) { await pool.query(`UPDATE signals SET company_id = $1 WHERE id = $2`, [hit.id, s.id]); newsMatched++; }
  }
  log(`   matched ${newsMatched} of ${unlinkedNews.length} unlinked UK-project signal(s)`);

  log('3. Scoring companies and upserting leads ...');
  const { rows: targets } = await pool.query(
    `SELECT DISTINCT c.* FROM companies c
     LEFT JOIN signals s ON s.company_id = c.id AND NOT s.processed
     WHERE c.named_account OR s.id IS NOT NULL`);

  const report = { scored: 0, leadsCreated: 0, leadsUpdated: 0, domains: 0, officersAdded: 0, officersUpdated: 0, inOrbit: 0, skipped: [] };
  for (const co of targets) {
    const { rows: signals } = await pool.query(`SELECT * FROM signals WHERE company_id = $1`, [co.id]);
    // Contact rows feed the contactability draft; while the draft is off the
    // scorer ignores them, so skip the query and keep the run identical.
    const contacts = CONTACTABILITY_DRAFT.enabled()
      ? (await pool.query(`SELECT in_decision_orbit, email_verified_at, suppressed FROM contacts WHERE company_id = $1`, [co.id])).rows
      : null;
    const { score, breakdown } = scoreCompany(co, signals, contacts);

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
        } catch (e) { log(`  domain lookup failed for ${co.name}: ${String(e.message).slice(0, 100)}`); }
      }
      // Directors from the public register become contacts, no LinkedIn needed.
      if (co.ch_number) {
        try {
          const oc = await syncOfficerContacts(co);
          report.officersAdded += oc.added; report.officersUpdated += oc.updated; report.inOrbit += oc.inOrbit;
        } catch (e) { log(`  officer sync failed for ${co.name}: ${String(e.message).slice(0, 100)}`); }
      }
    }

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

  log('4. Marking consumed signals processed ...');
  const ids = targets.map(t => t.id);
  const { rowCount: processedCount } = ids.length
    ? await pool.query(`UPDATE signals SET processed = true WHERE company_id = ANY($1) AND NOT processed`, [ids])
    : { rowCount: 0 };
  const { rows: unlinked } = await pool.query(
    `SELECT count(*)::int AS n FROM signals WHERE company_id IS NULL AND NOT processed`);

  return {
    chCounts, newsCounts, newsMatched, unlinkedNewsSeen: unlinkedNews.length,
    ...report, skippedCount: report.skipped.length,
    processedCount, awaitingMatch: unlinked[0].n,
    findymailCredits: getCreditsSpent(), threshold: LEAD_THRESHOLD, campaign: CAMPAIGN,
  };
}
