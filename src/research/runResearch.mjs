import { pool } from '../db.mjs';
import { pollCompaniesHouse } from './companiesHouse.mjs';
import { dcSignalSweep } from './newsResearch.mjs';
import { scoreCompany, CONTACTABILITY_DRAFT } from './icp.mjs';
import { getCreditsSpent } from './findymail.mjs';
import { regionForPostcode } from './region.mjs';
import { resolveDomain } from './domains.mjs';
import { syncOfficerContacts } from './officerContacts.mjs';
import { matchParty } from './match.mjs';
import { primaryParty } from './parties.mjs';
import { planPartyActions, proposalsPerRun, normName } from './partyActions.mjs';
import { searchCompanies, candidateRows } from './companiesHouse.mjs';
import { getCampaign, listCampaigns } from '../campaigns/registry.mjs';

// One research run FOR ONE CAMPAIGN: poll Companies House, sweep and gate that
// campaign's news, match that campaign's signal parties to accounts, score its
// member companies, and upsert its leads. Extracted from
// scripts/research-run.mjs so the manual script and the in-service scheduler
// share a single source of truth. Idempotent and safe to repeat: signals dedupe
// on url hash, scores recompute in place, leads upsert one row per company per
// campaign without regressing stage. Nothing in here sends anything, and the
// LinkedIn lane is never touched: it keeps its own capped orchestrator.
//
// The campaign arrives as a parameter and resolves through the registry; an
// unknown id is refused with the known list rather than silently running the
// default, and the bare call's default is stated in the run's first line of
// output rather than assumed.
export async function runResearch({ campaign, log = () => {} } = {}) {
  const defaulted = campaign == null;
  const id = defaulted ? 'marwin_dc' : String(campaign);
  const def = getCampaign(id);
  if (!def) {
    throw new Error(`unknown campaign ${JSON.stringify(id)}; known campaigns: ${listCampaigns().map(c => c.id).join(', ')}`);
  }
  const LEAD_THRESHOLD = Number(process.env.RESEARCH_LEAD_THRESHOLD || 40);

  log(`Research run for campaign ${def.id} (${def.displayName})${defaulted ? ', the default because none was named' : ''}.`);
  log('1. Polling Companies House ...');
  let chCounts = { companies: 0, ch_filing: 0, ch_director_change: 0 };
  try { chCounts = await pollCompaniesHouse(); }
  catch (e) { log(`   poll failed: ${String(e.message).slice(0, 150)}`); }

  log('2. Sweeping news signals ...');
  let newsCounts = { queries: 0, inserted: 0, seen: 0 };
  try { newsCounts = await dcSignalSweep({ campaign: def }); }
  catch (e) { log(`   sweep failed: ${String(e.message).slice(0, 150)}`); }

  log('2b. Matching news signal parties to accounts ...');
  const { rows: matchCompanies } = await pool.query(`SELECT id, name FROM companies`);
  // Aliases learned through the review queues, layered over the seeded map.
  const aliases = Object.fromEntries(
    (await pool.query(`SELECT alias, canonical FROM matcher_aliases`)).rows.map(r => [r.alias, r.canonical]));
  // Both parties of every kept news signal that still has an unlinked side,
  // scoped to this run's campaign so a pharma run never files reviews under a
  // data centre signal or the other way round. uk_project and expansion_watch
  // both match; only uk_project may propose.
  const { rows: unlinkedNews } = await pool.query(
    `SELECT id, operator, contractor, title, geo_scope, campaign FROM signals
     WHERE COALESCE(relevant, dc_relevant) AND campaign = $1
       AND (company_id IS NULL OR (contractor IS NOT NULL AND contractor_company_id IS NULL))`, [def.id]);

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
    // A stored party may still be a joint-venture list on a row written before
    // this rule, or an echo of the same name on both sides; primaryParty keeps
    // the first named and the same-name guard drops a duplicate, so telemetry
    // and proposals see one clean name a side, not a phantom.
    const opName = s.operator ? primaryParty(s.operator) : s.title;
    let conName = s.contractor ? primaryParty(s.contractor) : null;
    if (opName && conName && opName.toLowerCase() === conName.toLowerCase()) conName = null;
    const results = {
      operator: matchParty(opName, matchCompanies, { aliases }),
      contractor: conName ? matchParty(conName, matchCompanies, { aliases }) : null,
    };
    const actions = planPartyActions(
      { operator: opName, contractor: conName, geo_scope: s.geo_scope,
        operatorIsTitleFallback: !s.operator },
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
        try { chCandidates = candidateRows(await searchCompanies(a.name)); }
        catch { /* the proposal stands without candidates */ }
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
  // The campaign's own register: a named account belongs to this run when the
  // membership table says so, and any company belongs when this campaign's
  // unprocessed signals link it, on either side. A signal feeds both its
  // linked accounts: the operator's and the contractor's.
  const { rows: targets } = await pool.query(
    `SELECT DISTINCT c.* FROM companies c
     LEFT JOIN company_campaigns m ON m.company_id = c.id AND m.campaign = $1
     LEFT JOIN signals s ON (s.company_id = c.id OR s.contractor_company_id = c.id)
       AND NOT s.processed AND s.campaign = $1
     WHERE (c.named_account AND m.company_id IS NOT NULL) OR s.id IS NOT NULL`, [def.id]);

  const report = { scored: 0, leadsCreated: 0, leadsUpdated: 0, domains: 0, officersAdded: 0, officersUpdated: 0, inOrbit: 0, skipped: [] };
  for (const co of targets) {
    // A company the public register says is dissolved is not a prospect at
    // any score: John's Fletchers catch, a dead M&E contractor sitting at 60
    // because named plus type clears the threshold on its own. CH health
    // zeroing keeps the audit honest; this skip keeps a known-dead company
    // from ever forming a lead, and the report says exactly why.
    const chStatus = co.ch_profile?.company_status;
    if (chStatus && chStatus !== 'active') {
      report.skipped.push(`${co.name}: Companies House status ${chStatus}, not a prospect`);
      continue;
    }
    const { rows: signals } = await pool.query(
      `SELECT * FROM signals WHERE (company_id = $1 OR contractor_company_id = $1) AND campaign = $2`,
      [co.id, def.id]);
    // Contact rows feed the contactability draft; while the draft is off the
    // scorer ignores them, so skip the query and keep the run identical.
    const contacts = CONTACTABILITY_DRAFT.enabled()
      ? (await pool.query(`SELECT in_decision_orbit, email_verified_at, suppressed FROM contacts WHERE company_id = $1`, [co.id])).rows
      : null;
    const { score, breakdown } = scoreCompany(co, signals, contacts, def);

    // The per-campaign score lands on the membership row, which is what the
    // accounts view reads first. The company-level icp_score and breakdown
    // remain the data centre campaign's, because the account detail panel and
    // older readers treat them as the single company score; a pharma run
    // writing them would silently overwrite the DC score on a shared account.
    await pool.query(
      `INSERT INTO company_campaigns (company_id, campaign, score, score_reason)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (company_id, campaign) DO UPDATE SET score = $3, score_reason = $4`,
      [co.id, def.id, score, breakdown.signals?.reason || null]);
    // The cached Companies House profile often carries the registered postcode
    // when the search snippet did not, so backfill before assigning a region.
    const postcode = co.postcode || co.ch_profile?.registered_office_address?.postal_code || null;
    const region = co.region || regionForPostcode(postcode);
    if (def.id === 'marwin_dc') {
      await pool.query(
        `UPDATE companies SET icp_score = $1, icp_breakdown = $2::jsonb,
           region = COALESCE(region, $3), postcode = COALESCE(postcode, $4), updated_at = now() WHERE id = $5`,
        [score, JSON.stringify(breakdown), region, postcode, co.id]);
    } else {
      await pool.query(
        `UPDATE companies SET region = COALESCE(region, $1), postcode = COALESCE(postcode, $2), updated_at = now() WHERE id = $3`,
        [region, postcode, co.id]);
    }
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
      [co.id, def.id, score, JSON.stringify(breakdown), region]);
    if (upserted[0]?.inserted) report.leadsCreated++; else report.leadsUpdated++;
  }

  log('4. Marking consumed signals processed ...');
  const ids = targets.map(t => t.id);
  // Only this campaign's signals: marking another campaign's consumed here
  // would hide them from that campaign's own next run.
  const { rowCount: processedCount } = ids.length
    ? await pool.query(
        `UPDATE signals SET processed = true
         WHERE (company_id = ANY($1) OR contractor_company_id = ANY($1))
           AND campaign = $2 AND NOT processed`, [ids, def.id])
    : { rowCount: 0 };
  const { rows: unlinked } = await pool.query(
    `SELECT count(*)::int AS n FROM signals
     WHERE company_id IS NULL AND contractor_company_id IS NULL AND campaign = $1 AND NOT processed`, [def.id]);

  return {
    chCounts, newsCounts, newsMatched, unlinkedNewsSeen: unlinkedNews.length,
    ...report, skippedCount: report.skipped.length,
    processedCount, awaitingMatch: unlinked[0].n,
    findymailCredits: getCreditsSpent(), threshold: LEAD_THRESHOLD, campaign: def.id,
  };
}
