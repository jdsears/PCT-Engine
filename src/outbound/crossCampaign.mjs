// Cross-campaign contact protection.
//
// The engine's existing guardrails are per campaign: one lead per company per
// campaign, one open draft per lead per campaign, one thread at a time within a
// lead. None of them stop the same person receiving a data centre cold open on
// Monday and a pharmaceutical one on Thursday, because those are two leads on
// two campaigns. From the recipient's side that is one company mailing them
// twice about different things in a week, which reads as a campaign rather than
// a colleague, and it costs the relationship the first email was trying to open.
//
// So the window is enforced at contact level and across campaigns: once a
// contact has been cold-opened for any campaign, no other campaign may
// cold-open them until the window has passed. A draft held for this reason is
// surfaced in the review queue with its reason, never silently dropped, because
// a queue that goes quiet without explanation is worse than one that says why.
//
// Same-campaign follow-ups are untouched. This guards the first approach from a
// second campaign, not the sequence a contact is already in.

export const crossCampaignDays = () => {
  const n = parseInt(process.env.CROSS_CAMPAIGN_DAYS || '90', 10);
  return Math.max(1, Math.min(365, Number.isNaN(n) ? 90 : n));
};

// Pure: may this campaign cold-open this contact now? The contact carries when
// it was last cold-opened and by which campaign. Returns a decision with a
// reason fit to show a reviewer.
export function canColdOpen({ lastColdOpenAt, lastColdOpenCampaign, campaign, now = Date.now(), windowDays = crossCampaignDays() }) {
  if (!lastColdOpenAt) return { ok: true };
  const last = new Date(lastColdOpenAt).getTime();
  if (Number.isNaN(last)) return { ok: true };
  // The same campaign approaching again is the sequence's own business, governed
  // by the follow-up cadence and contact rotation, not by this window.
  if (lastColdOpenCampaign && String(lastColdOpenCampaign) === String(campaign)) return { ok: true };
  const days = (now - last) / 86_400_000;
  if (days >= windowDays) return { ok: true };
  const waitDays = Math.ceil(windowDays - days);
  return {
    ok: false,
    reason: `contacted ${Math.floor(days)} day${Math.floor(days) === 1 ? '' : 's'} ago by another campaign` +
      `${lastColdOpenCampaign ? ` (${lastColdOpenCampaign})` : ''}, ${waitDays} day${waitDays === 1 ? '' : 's'} of the ${windowDays} day cross-campaign window remaining`,
    waitDays,
  };
}

// The SQL fragment the drafting query uses to exclude contacts inside another
// campaign's window. Kept beside the pure rule so the two cannot drift: the
// query filters, and canColdOpen explains.
export const CROSS_CAMPAIGN_SQL = `(
  ct.last_cold_open_at IS NULL
  OR ct.last_cold_open_campaign = $CAMPAIGN$
  OR ct.last_cold_open_at < now() - ($WINDOW$ || ' days')::interval)`;

export function crossCampaignClause({ campaignParam, windowParam }) {
  return CROSS_CAMPAIGN_SQL.replace('$CAMPAIGN$', campaignParam).replace('$WINDOW$', windowParam);
}
