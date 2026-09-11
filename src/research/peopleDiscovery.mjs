import { pool } from '../db.mjs';
import { findContacts, laneReady } from './linkedinResearch.mjs';
import { CapReached, AccountUnhealthy, accountForCampaign } from './unipile.mjs';
import { roleWindow, ORBIT_TITLES } from './orbitRules.mjs';
import { getCampaign } from '../campaigns/registry.mjs';

// The in-cycle people search: a small batch of named accounts per engine
// cycle, so a new account gets its specifiers found within a day of arriving
// instead of waiting for someone to run the enrich script. Authorised by John
// in July 2026, with the same discipline as the manual lane it reuses: the
// same findContacts, the same single Unipile queue, pacing, ledger and daily
// cap. The batch is deliberately small because it runs on the connected
// accounts.
//
// An account-health error is the one thing that must never be retried on a
// schedule: the caller is told to switch the feature off and say so.
//
// Raised on John's instruction, August 2026, when contacts became the
// bottleneck on the live pipeline: the default doubled and the ceiling moved.
// Each search runs through the campaign's own connected account, so James's
// profile carries the data centre load and Andy's the pharma load, and the
// daily call cap counts per account once the ledger can say.
//
// Raised again on 11 September 2026, when the data centre lane starved at
// this step: a pass that found nobody had stood the account down for thirty
// days, so an account with no decision makers waited a month between
// questions. The cooldown now depends on the outcome. An account that has a
// decision maker in orbit rests the full thirty days; one with nobody comes
// back after a few days (ENGINE_PEOPLE_RETRY_DAYS, default 5) and is asked
// the next window of roles, until every window has been asked, when it rests
// the thirty days like the rest. The default batch is six accounts a cycle.

export const peopleSearchLimit = () => Math.max(1, Math.min(12, parseInt(process.env.ENGINE_PEOPLE_SEARCH_LIMIT || '6', 10) || 6));
export const peopleRetryDays = () => Math.max(1, parseInt(process.env.ENGINE_PEOPLE_RETRY_DAYS || '5', 10) || 5);
export const PEOPLE_SERVED_DAYS = 30;

// How many distinct windows of roles a campaign can ask: its own vocabulary
// when it has one, else the shared orbit titles, eight at a time.
export function orbitWindows(titles) {
  const t = (titles || []).filter(Boolean);
  return Math.max(1, Math.ceil((t.length ? t.length : ORBIT_TITLES.length) / 8));
}

// Whether an account is due another LinkedIn pass. Pure, so the cadence is
// provable: never searched is due; served (someone in orbit) rests thirty
// days; nobody found rests the retry days until every window has been
// asked, then thirty.
export function peopleSearchDue({ lastAt = null, priorSearches = 0, orbitFound = false, windows = 1,
                                  now = Date.now(), retryDays = peopleRetryDays() } = {}) {
  if (!lastAt) return true;
  const last = new Date(lastAt).getTime();
  if (Number.isNaN(last)) return true;
  const days = orbitFound || priorSearches >= windows ? PEOPLE_SERVED_DAYS : retryDays;
  return now - last >= days * 86_400_000;
}
export function peopleCoolingUntil(args) {
  const { lastAt = null, priorSearches = 0, orbitFound = false, windows = 1, retryDays = peopleRetryDays() } = args || {};
  if (!lastAt) return null;
  const last = new Date(lastAt).getTime();
  if (Number.isNaN(last)) return null;
  const days = orbitFound || priorSearches >= windows ? PEOPLE_SERVED_DAYS : retryDays;
  const until = last + days * 86_400_000;
  return until > Date.now() ? new Date(until).toISOString() : null;
}

export async function discoverPeople({ limit = peopleSearchLimit(), log = () => {} } = {}) {
  if (!laneReady()) return { skipped: 'the LinkedIn lane is not configured on this service' };

  // Selection order serves the drafting queue: companies whose researched
  // leads are waiting on a contact come first, then the rest by score. The
  // cooldown is judged per account in code, from the ledger's count and
  // date and whether anyone is in orbit, so the rule lives in one place.
  const { rows: candidates } = await pool.query(
    `SELECT id, name, icp_score,
            (SELECT array_agg(cc.campaign ORDER BY cc.campaign) FROM company_campaigns cc WHERE cc.company_id = companies.id) AS memberships,
            (SELECT count(*)::int FROM unipile_calls u WHERE u.target = 'findContacts: ' || companies.name) AS prior_searches,
            (SELECT max(u.called_at) FROM unipile_calls u WHERE u.target = 'findContacts: ' || companies.name) AS last_at,
            EXISTS (SELECT 1 FROM contacts ct WHERE ct.company_id = companies.id
                      AND ct.in_decision_orbit AND NOT ct.suppressed AND NOT ct.rehearsal) AS orbit_found,
            EXISTS (SELECT 1 FROM leads l WHERE l.company_id = companies.id AND l.stage = 'researched'
                      AND NOT EXISTS (
                        SELECT 1 FROM contacts ct WHERE ct.company_id = companies.id
                          AND ct.in_decision_orbit AND NOT ct.suppressed AND NOT ct.rehearsal
                          AND ct.email IS NOT NULL AND ct.email_bounced_at IS NULL)) AS blocked
     FROM companies
     WHERE named_account
     ORDER BY blocked DESC, icp_score DESC NULLS LAST, name LIMIT 400`);
  const companies = [];
  for (const co of candidates) {
    const known = (co.memberships || []).filter(id => getCampaign(id));
    const campaign = known.length === 1 ? known[0] : 'marwin_dc';
    const titles = getCampaign(campaign)?.orbitTitles || [];
    if (!peopleSearchDue({ lastAt: co.last_at, priorSearches: co.prior_searches, orbitFound: co.orbit_found, windows: orbitWindows(titles) })) continue;
    companies.push({ ...co, campaign, titles });
    if (companies.length >= limit) break;
  }
  if (!companies.length) return { companies: 0, note: 'every named account is resting between passes' };

  const report = { companies: 0, created: 0, updated: 0, orbit: 0 };
  for (const co of companies) {
    try {
      // The search runs through the campaign's own connected account, with a
      // stray membership value never deciding anything, and speaks the
      // campaign's own vocabulary: the definition's orbitTitles key the
      // search and widen the classification, so a pharma company is asked
      // for its process and CQV people, not MEP and HVAC ones. Each pass
      // asks the next window of roles.
      const { campaign, titles } = co;
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
