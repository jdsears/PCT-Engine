import { pool } from '../db.mjs';
import { findContacts, laneReady } from './linkedinResearch.mjs';
import { CapReached, AccountUnhealthy } from './unipile.mjs';

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

export const peopleSearchLimit = () => Math.max(1, Math.min(5, parseInt(process.env.ENGINE_PEOPLE_SEARCH_LIMIT || '2', 10) || 2));

export async function discoverPeople({ limit = peopleSearchLimit(), log = () => {} } = {}) {
  if (!laneReady()) return { skipped: 'the LinkedIn lane is not configured on this service' };

  // The same selection as the enrich script's --new: highest-scoring named
  // accounts with no people search in the last thirty days.
  const { rows: companies } = await pool.query(
    `SELECT id, name FROM companies
     WHERE named_account
       AND NOT EXISTS (
         SELECT 1 FROM unipile_calls u
         WHERE u.target = 'findContacts: ' || companies.name
           AND u.called_at > now() - interval '30 days')
     ORDER BY icp_score DESC NULLS LAST, name LIMIT $1`, [limit]);
  if (!companies.length) return { companies: 0, note: 'every named account has been searched in the last thirty days' };

  const report = { companies: 0, created: 0, updated: 0, orbit: 0 };
  for (const co of companies) {
    try {
      const f = await findContacts(co, { limit: 5 });
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
