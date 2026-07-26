import { requireCampaign } from '../campaigns/registry.mjs';

// Lead staleness. A lead whose newest signal is six months old looks much like
// a fresh one once the recency tiers bottom out, and a cold open on stale
// research reads as exactly that. So a lead with no new signal and no human
// action for the campaign's window is marked stale: badged in the pipeline,
// excluded from new outbound drafting by default, counted on Insights.
//
// A flag over the existing scoring, not a new formula: nothing is deleted, no
// score is rewritten, and the mark clears itself the moment anything real
// happens, because it is computed from activity rather than stored. Activity
// means the newest signal linked to the lead's company on either side (operator
// or contractor) for the lead's campaign, or the lead's own updated_at, which
// every human action already touches: a stage move, a rescore, a triaged reply.

export function staleDays(campaign) {
  const def = typeof campaign === 'string' ? requireCampaign(campaign) : campaign;
  const n = parseInt(def?.staleness?.days, 10);
  return Number.isFinite(n) && n > 0 ? n : 120;
}

// Pure rule, for tests and for anywhere already holding the dates.
export function isStale({ updatedAt, newestSignalAt, now = Date.now(), days }) {
  const times = [updatedAt, newestSignalAt]
    .map(t => (t ? new Date(t).getTime() : NaN))
    .filter(t => !Number.isNaN(t));
  if (!times.length) return false; // nothing known is not the same as known old
  return (now - Math.max(...times)) / 86_400_000 > days;
}

// The SQL expression of the same rule, kept beside it so the two cannot drift.
// leadAlias must expose company_id, campaign and updated_at; daysParam is the
// placeholder carrying the window.
export function staleSql(leadAlias, daysParam) {
  return `(GREATEST(${leadAlias}.updated_at, COALESCE((
    SELECT max(s.observed_at) FROM signals s
    WHERE (s.company_id = ${leadAlias}.company_id OR s.contractor_company_id = ${leadAlias}.company_id)
      AND s.campaign = ${leadAlias}.campaign), ${leadAlias}.updated_at))
    < now() - (${daysParam} || ' days')::interval)`;
}
