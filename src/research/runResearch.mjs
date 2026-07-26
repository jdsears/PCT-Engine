import { pool } from '../db.mjs';
import { pollCompaniesHouse } from './companiesHouse.mjs';
import { dcSignalSweep } from './newsResearch.mjs';
import { scoreCompany, CONTACTABILITY_DRAFT } from './icp.mjs';
import { getCreditsSpent } from './findymail.mjs';
import { regionForPostcode } from './region.mjs';
import { resolveDomain } from './domains.mjs';
import { syncOfficerContacts } from './officerContacts.mjs';
import { matchParty } from './match.mjs';
import { planPartyActions, proposalsPerRun, normName } from './partyActions.mjs';
import { searchCompanies } from './companiesHouse.mjs';

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

  log('2b. Matching news signal parties to accounts ...');
  const { rows: matchCompanies } = await pool.query(`SELECT id, name FROM companies`);
  // Aliases learned through the review queues, layered over the seeded map.
  const aliases = Object.fromEntries(
    (await pool.query(`SELECT alias, canonical FROM matcher_aliases`)).rows.map(r => [r.alias, r.canonical]));
  // Both parties of every kept news signal that still has an unlinked side.
  // uk_project and expansion_watch both match; only uk_project may propose.
  const { rows: unlinkedNews } = await pool.query(
    `SELECT id, operator, contractor, title, geo_scope, campaign FROM signals
     WHERE COALESCE(relevant, dc_relevant)
       AND (company_id IS NULL OR (contractor IS NOT NULL AND contractor_company_id IS NULL))`);

  // Names already reviewed, whatever the outcome: a dismissed name is a
  // decision and is never proposed again. Keyed by campaign, since the same
  // brand may be a fine account on one campaign and dismissed on another.
  const known = new Set(
    (await pool.query(`SELECT name_norm, campaign FROM party_reviews`)).rows.map(r => `${r.campaign}:${r.name_norm}`));
  const state = { proposed: 0, cap: proposalsPerRun(), known: null };

  const counts = { matched: 0, proposals: 0, ambiguous: 0, overCap: 0 };
  for (const s of unlinkedNews) {
    // The operator falls back to the title, the original behaviour that lets a
    // clear headline match without an extracted name. The contractor never
    // falls back: a title is not a contractor.
    state.known = { has: k => known.has(`${s.campaign}:${k}`), add: k => known.add(`${s.campaign}:${k}`) };
    const results = {
      operator: matchParty(s.operator || s.title, matchCompanies, { aliases }),
      contractor: s.contractor ? matchParty(s.contractor, matchCompanies, { aliases }) : null,
    };
    const actions = planPartyActions(
      { operator: s.operator || s.title, contractor: s.contractor, geo_scope: s.geo_scope },
      results, state);

    for (const a of actions) {
      if (a.act === 'link') {
        const col = a.party === 'contractor' ? 'contractor_company_id' : 'company_id';
        await pool.query(`UPDATE signals SET ${col} = $1 WHERE id = $2 AND ${col} IS NULL`, [a.companyId, s.id]);
        counts.matched++;
      } else if (a.act === 'count') {
        await pool.query(
          `INSERT INTO unmatched_parties (name_norm, printed, campaign) VALUES ($1, $2, $3)
           ON CONFLICT (name_norm, campaign) DO UPDATE SET n = unmatched_parties.n + 1, printed = $2, last_seen = now()`,
          [a.norm, a.name, s.campaign]);
      } else if (a.act === 'review_ambiguous') {
        await pool.query(
          `INSERT INTO party_reviews (kind, printed_name, name_norm, party, campaign, signal_id, account_candidates)
           VALUES ('ambiguous', $1, $2, $3, $4, $5, $6::jsonb) ON CONFLICT (name_norm, campaign) DO NOTHING`,
          [a.name, a.norm, a.party, s.campaign, s.id, JSON.stringify(a.candidates)]);
        counts.ambiguous++;
      } else if (a.act === 'propose') {
        // Read-only enrichment, so the human decides over evidence: Companies
        // House candidates and a domain. No Findymail, no LinkedIn, no spend.
        let chCandidates = null, domain = null;
        try {
          const found = await searchCompanies(a.name);
          chCandidates = (found || []).slice(0, 5).map(c => ({
            chNumber: c.company_number, name: c.title, status: c.company_status, address: c.address_snippet || null,
          }));
        } catch { /* the proposal stands without candidates */ }
        try { domain = await resolveDomain(a.name); } catch { /* optional */ }
        await pool.query(
          `INSERT INTO party_reviews (kind, printed_name, name_norm, party, campaign, signal_id, ch_candidates, domain)
           VALUES ('proposal', $1, $2, $3, $4, $5, $6::jsonb, $7) ON CONFLICT (name_norm, campaign) DO NOTHING`,
          [a.name, a.norm, a.party, s.campaign, s.id, chCandidates ? JSON.stringify(chCandidates) : null, domain]);
        counts.proposals++;
      } else if (a.act === 'over_cap') {
        counts.overCap++;
      }
    }
  }
  const newsMatched = counts.matched;
  log(`   linked ${counts.matched} party link(s) across ${unlinkedNews.length} signal(s); ` +
    `${counts.proposals} proposal(s), ${counts.ambiguous} ambiguous, ${counts.overCap} held over the cap of ${state.cap}`);

  log('3. Scoring companies and upserting leads ...');
  // A signal feeds both its linked accounts: the operator's and the
  // contractor's. Both linkages pull a company into scoring.
  const { rows: targets } = await pool.query(
    `SELECT DISTINCT c.* FROM companies c
     LEFT JOIN signals s ON (s.company_id = c.id OR s.contractor_company_id = c.id) AND NOT s.processed
     WHERE c.named_account OR s.id IS NOT NULL`);

  const report = { scored: 0, leadsCreated: 0, leadsUpdated: 0, domains: 0, officersAdded: 0, officersUpdated: 0, inOrbit: 0, skipped: [] };
  for (const co of targets) {
    const { rows: signals } = await pool.query(
      `SELECT * FROM signals WHERE company_id = $1 OR contractor_company_id = $1`, [co.id]);
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
       ON CONFLICT (company_id, campaign) WHERE campaign <> 'rehearsal' DO UPDATE SET
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
    ? await pool.query(
        `UPDATE signals SET processed = true
         WHERE (company_id = ANY($1) OR contractor_company_id = ANY($1)) AND NOT processed`, [ids])
    : { rowCount: 0 };
  const { rows: unlinked } = await pool.query(
    `SELECT count(*)::int AS n FROM signals
     WHERE company_id IS NULL AND contractor_company_id IS NULL AND NOT processed`);

  return {
    chCounts, newsCounts, newsMatched, unlinkedNewsSeen: unlinkedNews.length,
    ...report, skippedCount: report.skipped.length,
    processedCount, awaitingMatch: unlinked[0].n,
    findymailCredits: getCreditsSpent(), threshold: LEAD_THRESHOLD, campaign: CAMPAIGN,
  };
}
