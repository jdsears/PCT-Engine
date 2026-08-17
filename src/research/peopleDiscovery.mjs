import { pool } from '../db.mjs';
import { findContacts, laneReady } from './linkedinResearch.mjs';
import { CapReached, AccountUnhealthy, accountForCampaign } from './unipile.mjs';
import { roleWindow } from './orbitRules.mjs';
import { getCampaign } from '../campaigns/registry.mjs';

// The in-cycle people search: a small batch of named accounts per engine
// cycle, so a new account gets its specifiers found within a day of arriving
// instead of waiting for someone to run the enrich script. Authorised by John
// in July 2026, with the same discipline as the manual lane it reuses: the
// same findContacts, the same single Unipile queue, pacing, ledger and daily
// cap, the same thirty-day per-account cooldown. The batch is deliberately
// tiny (ENGINE_PEOPLE_SEARCH_LIMIT, default 2 accounts a cycle, roughly eight
// calls a day at the six-hour cadence) because it runs on James's account.
//
// An account-health error is the one thing that must never be retried on a
// schedule: the caller is told to switch the feature off and say so.
//
// Raised on John's instruction, August 2026, when contacts became the
// bottleneck on the live pipeline: the default doubles to four accounts a
// cycle, roughly sixteen calls a day at the six-hour cadence, and the ceiling
// moves to ten. Two things keep this honest at the higher rate: each search
// runs through the campaign's own connected account, so James's profile
// carries the data centre load and Andy's the pharma load, and the daily
// call cap counts per account once the ledger can say. The AccountUnhealthy
// latch stays the circuit breaker it always was.

export const peopleSearchLimit = () => Math.max(1, Math.min(10, parseInt(process.env.ENGINE_PEOPLE_SEARCH_LIMIT || '4', 10) || 4));

export async function discoverPeople({ limit = peopleSearchLimit(), log = () => {} } = {}) {
  if (!laneReady()) return { skipped: 'the LinkedIn lane is not configured on this service' };

  // Selection order serves the drafting queue: companies whose researched
  // leads are waiting on a contact come first, then the rest by score, all
  // still under the thirty-day per-account cooldown. Drafting only happens
  // once a company has an emailable specifier, so the search works the
  // backlog that is actually blocking outreach before it explores.
  const { rows: companies } = await pool.query(
    `SELECT id, name,
            (SELECT array_agg(cc.campaign ORDER BY cc.campaign) FROM company_campaigns cc WHERE cc.company_id = companies.id) AS memberships,
            (SELECT count(*)::int FROM unipile_calls u WHERE u.target = 'findContacts: ' || companies.name) AS prior_searches
     FROM companies
     WHERE named_account
       AND NOT EXISTS (
         SELECT 1 FROM unipile_calls u
         WHERE u.target = 'findContacts: ' || companies.name
           AND u.called_at > now() - interval '30 days')
     ORDER BY EXISTS (
         SELECT 1 FROM leads l WHERE l.company_id = companies.id AND l.stage = 'researched'
           AND NOT EXISTS (
             SELECT 1 FROM contacts ct WHERE ct.company_id = companies.id
               AND ct.in_decision_orbit AND NOT ct.suppressed AND NOT ct.rehearsal
               AND ct.email IS NOT NULL AND ct.email_bounced_at IS NULL)
       ) DESC,
       icp_score DESC NULLS LAST, name LIMIT $1`, [limit]);
  if (!companies.length) return { companies: 0, note: 'every named account has been searched in the last thirty days' };

  const report = { companies: 0, created: 0, updated: 0, orbit: 0 };
  for (const co of companies) {
    try {
      // The search runs through the campaign's own connected account, with a
      // stray membership value never deciding anything, and speaks the
      // campaign's own vocabulary: the definition's orbitTitles key the
      // search and widen the classification, so a pharma company is asked
      // for its process and CQV people, not MEP and HVAC ones.
      const known = (co.memberships || []).filter(id => getCampaign(id));
      const campaign = known.length === 1 ? known[0] : 'marwin_dc';
      const titles = getCampaign(campaign)?.orbitTitles || [];
      const f = await findContacts(co, { limit: 5, accountId: accountForCampaign(campaign),
        searchRoles: roleWindow(titles, co.prior_searches), orbitExtra: titles });
      report.companies++;
      report.created += f.created || 0;
      report.updated += f.updated || 0;
      report.orbit += (f.contacts || []).filter(c => c.orbit === true).length;
      log(`${co.name}: ${f.created || 0} new contact(s), ${(f.contacts || []).filter(c => c.orbit === true).length} in orbit`);
    } catch (e) {
      if (e instanceof AccountUnhealthy) {
        // The account is the asset. Stop, and tell the caller to stand the
        // feature down rather than let the schedule knock again in six hours.
        report.unhealthy = String(e.message).slice(0, 300);
        return report;
      }
      if (e instanceof CapReached) {
        report.capStopped = true;
        log('daily Unipile cap reached, stopping cleanly');
        return report;
      }
      report.failed = (report.failed || 0) + 1;
      log(`${co.name} FAILED: ${String(e.message).slice(0, 140)}`);
    }
  }
  return report;
}
