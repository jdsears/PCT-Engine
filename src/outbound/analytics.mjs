import { pool } from '../db.mjs';
import { listCampaigns } from '../campaigns/registry.mjs';

// What happens after Send, measured from what we already hold, John's ask of
// 24 August 2026. No pixels, no click rewriting, no tracking of prospects:
// opens are unknowable and the pursuit of them costs deliverability and
// trust, so the funnel runs on the outcomes the database records, sends,
// bounces, replies, meetings. Rehearsal rows are excluded everywhere, and
// out-of-office and bounces never count as a person replying.

// A reply from a person, as opposed to a mail server or an autoresponder.
export const HUMAN_REPLIES = ['interested', 'question', 'not_interested', 'wrong_person', 'unclear'];

// What opened a conversation, judged from its first draft. Precedence
// matters: a contact who exists because they engaged with a post, or because
// a colleague referred them, is that source even when a news signal seasoned
// the draft, because without the person there is no conversation. Then the
// signal decides, and no signal at all is honest profile fit.
export function openerSource({ signalType = null, contactSource = null } = {}) {
  if (contactSource === 'post_engagement') return 'Post engagement';
  if (contactSource === 'referral') return 'Referral';
  const t = String(signalType || '');
  if (/^news/.test(t)) return 'Project news';
  if (/^ch_/.test(t)) return 'Register filing';
  return 'Profile fit';
}

// Conversion between adjacent funnel steps: each step's share of the one
// before it. The first step has no denominator and a zero step cannot be one,
// so both render as no percentage rather than an invented number.
export function funnelSteps(steps) {
  let prev = null;
  return (steps || []).map(s => {
    const pct = prev == null || prev === 0 ? null : Math.round((s.n / prev) * 100);
    prev = s.n;
    return { ...s, pct };
  });
}

// How long replies take, in whole-feeling buckets plus a median, so the
// follow-up cadence can be set from evidence. Negative deltas (clock skew,
// a reply matched to a later send) clamp to zero rather than distorting.
export function replyBuckets(days) {
  const clean = (days || []).map(Number).filter(d => Number.isFinite(d)).map(d => Math.max(0, d));
  const sorted = [...clean].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
  const b = { sameDay: 0, oneToTwo: 0, threeToSeven: 0, overSeven: 0 };
  for (const d of clean) {
    if (d < 1) b.sameDay++;
    else if (d <= 2) b.oneToTwo++;
    else if (d <= 7) b.threeToSeven++;
    else b.overSeven++;
  }
  return { count: clean.length, medianDays: median == null ? null : Math.round(median * 10) / 10, ...b };
}

// The weekly bounce picture: sends and bounces merged on week, rate computed
// once here so the page never does arithmetic. A week with no sends has no
// rate rather than a zero that reads as good news.
export function bounceWeeks(sendRows, bounceRows) {
  const weeks = new Map();
  for (const r of sendRows || []) weeks.set(String(r.wk), { week: String(r.wk), sent: r.sent, bounced: 0 });
  for (const r of bounceRows || []) {
    const w = weeks.get(String(r.wk)) || { week: String(r.wk), sent: 0, bounced: 0 };
    w.bounced = r.bounced;
    weeks.set(String(r.wk), w);
  }
  return [...weeks.values()]
    .sort((a, b) => a.week.localeCompare(b.week))
    .map(w => ({ ...w, rate: w.sent > 0 ? Math.round((w.bounced / w.sent) * 100) : null }));
}

const HUMAN_SQL = `('interested','question','not_interested','wrong_person','unclear')`;

// One gather for the whole after-send picture, campaign to date for the
// funnel and step tables, thirty days for the daily lines, eight weeks for
// bounce health. Everything derives its campaign the way the rest of the
// engine does: drafts and leads carry their own, contacts through the
// membership rule, posts through their grounding.
export async function gatherOutboundAnalytics() {
  const byCampaign = (rows, key = 'campaign') => {
    const m = new Map();
    for (const r of rows) m.set(r[key], r);
    return m;
  };

  const accounts = byCampaign((await pool.query(
    `SELECT campaign, count(*)::int AS n FROM company_campaigns GROUP BY campaign`)).rows);

  const orbit = byCampaign((await pool.query(
    `SELECT cc.campaign,
            count(*)::int AS orbit,
            count(*) FILTER (WHERE ct.email IS NOT NULL)::int AS addressed
     FROM contacts ct JOIN company_campaigns cc ON cc.company_id = ct.company_id
     WHERE ct.in_decision_orbit AND NOT ct.suppressed AND NOT ct.rehearsal
     GROUP BY cc.campaign`)).rows);

  // The conversation grain is the lead: one company on one campaign. A
  // conversation is delivered when at least one real send drew no bounce,
  // replied when a person answered on any step, live when they showed
  // interest or asked.
  const conv = byCampaign((await pool.query(
    `WITH conv AS (
       SELECT d.lead_id, d.campaign,
              bool_or(s.id IS NOT NULL) AS has_send,
              bool_or(s.id IS NOT NULL AND NOT COALESCE(b.bounced, false)) AS delivered,
              bool_or(r.category IN ${HUMAN_SQL}) AS replied,
              bool_or(r.category IN ('interested','question')) AS live
       FROM outbound_drafts d
       LEFT JOIN outbound_sends s ON s.draft_id = d.id AND s.sent AND NOT s.test_mode
       LEFT JOIN LATERAL (
         SELECT bool_or(r2.category = 'bounce') AS bounced FROM outbound_replies r2 WHERE r2.draft_id = d.id
       ) b ON true
       LEFT JOIN outbound_replies r ON r.draft_id = d.id
       WHERE d.campaign <> 'rehearsal'
       GROUP BY d.lead_id, d.campaign
     )
     SELECT campaign, count(*)::int AS drafted,
            count(*) FILTER (WHERE has_send)::int AS sent,
            count(*) FILTER (WHERE delivered)::int AS delivered,
            count(*) FILTER (WHERE replied)::int AS replied,
            count(*) FILTER (WHERE live)::int AS live
     FROM conv GROUP BY campaign`)).rows);

  const goals = byCampaign((await pool.query(
    `SELECT campaign,
            count(*) FILTER (WHERE meeting_booked_at IS NOT NULL)::int AS meetings,
            count(*) FILTER (WHERE handed_off_at IS NOT NULL)::int AS handoffs
     FROM leads WHERE campaign <> 'rehearsal' GROUP BY campaign`)).rows);

  // Reply rate per sequence step: does email two earn its place, does the
  // break-up. Sends and replies are counted distinctly because the joins
  // multiply rows.
  const stepRows = (await pool.query(
    `SELECT d.campaign, d.sequence_step AS step,
            count(DISTINCT s.id)::int AS sends,
            count(DISTINCT r.id) FILTER (WHERE r.category IN ${HUMAN_SQL})::int AS replies
     FROM outbound_drafts d
     JOIN outbound_sends s ON s.draft_id = d.id AND s.sent AND NOT s.test_mode
     LEFT JOIN outbound_replies r ON r.draft_id = d.id
     WHERE d.campaign <> 'rehearsal'
     GROUP BY d.campaign, d.sequence_step`)).rows;

  // What opened each conversation that went out, and whether it replied. The
  // opener is the earliest sent draft's grounding and contact.
  const sourceRows = (await pool.query(
    `SELECT d.campaign,
            (array_agg(d.grounding->'signal'->>'type' ORDER BY d.sequence_step, d.id))[1] AS signal_type,
            (array_agg(ct.source ORDER BY d.sequence_step, d.id))[1] AS contact_source,
            bool_or(r.category IN ${HUMAN_SQL}) AS replied
     FROM outbound_drafts d
     JOIN outbound_sends s ON s.draft_id = d.id AND s.sent AND NOT s.test_mode
     LEFT JOIN contacts ct ON ct.id = d.contact_id
     LEFT JOIN outbound_replies r ON r.draft_id = d.id
     WHERE d.campaign <> 'rehearsal'
     GROUP BY d.campaign, d.lead_id`)).rows;

  // Days from the first real send of a draft to each human reply on it.
  const timingRows = (await pool.query(
    `SELECT d.campaign,
            EXTRACT(epoch FROM (COALESCE(r.received_at, r.created_at) - fs.first_sent)) / 86400.0 AS days
     FROM outbound_replies r
     JOIN outbound_drafts d ON d.id = r.draft_id
     JOIN LATERAL (
       SELECT min(s.created_at) AS first_sent FROM outbound_sends s
       WHERE s.draft_id = d.id AND s.sent AND NOT s.test_mode
     ) fs ON true
     WHERE r.category IN ${HUMAN_SQL} AND d.campaign <> 'rehearsal' AND fs.first_sent IS NOT NULL`)).rows;

  const weekSends = (await pool.query(
    `SELECT d.campaign, date_trunc('week', s.created_at)::date AS wk, count(*)::int AS sent
     FROM outbound_sends s JOIN outbound_drafts d ON d.id = s.draft_id
     WHERE s.sent AND NOT s.test_mode AND d.campaign <> 'rehearsal'
       AND s.created_at >= now() - interval '8 weeks'
     GROUP BY 1, 2`)).rows;
  const weekBounces = (await pool.query(
    `SELECT d.campaign, date_trunc('week', r.created_at)::date AS wk, count(*)::int AS bounced
     FROM outbound_replies r JOIN outbound_drafts d ON d.id = r.draft_id
     WHERE r.category = 'bounce' AND d.campaign <> 'rehearsal'
       AND r.created_at >= now() - interval '8 weeks'
     GROUP BY 1, 2`)).rows;

  const dailySends = (await pool.query(
    `SELECT d.campaign, (s.created_at AT TIME ZONE 'UTC')::date::text AS day, count(*)::int AS n
     FROM outbound_sends s JOIN outbound_drafts d ON d.id = s.draft_id
     WHERE s.sent AND NOT s.test_mode AND d.campaign <> 'rehearsal'
       AND s.created_at >= now() - interval '30 days'
     GROUP BY 1, 2`)).rows;
  const dailyReplies = (await pool.query(
    `SELECT d.campaign, (r.created_at AT TIME ZONE 'UTC')::date::text AS day, count(*)::int AS n
     FROM outbound_replies r JOIN outbound_drafts d ON d.id = r.draft_id
     WHERE r.category IN ${HUMAN_SQL} AND d.campaign <> 'rehearsal'
       AND r.created_at >= now() - interval '30 days'
     GROUP BY 1, 2`)).rows;

  // The LinkedIn lane. Contacts derive their campaign through the membership
  // rule (exactly one registered membership, else the data centre default).
  // Invite acceptance is not observable yet and is not invented.
  const invites = byCampaign((await pool.query(
    `SELECT (CASE WHEN array_length(m.memberships, 1) = 1 THEN m.memberships[1] ELSE 'marwin_dc' END) AS campaign,
            count(*)::int AS invited
     FROM contacts ct JOIN companies c ON c.id = ct.company_id
     CROSS JOIN LATERAL (
       SELECT (SELECT array_agg(cc.campaign ORDER BY cc.campaign) FROM company_campaigns cc
               WHERE cc.company_id = c.id) AS memberships
     ) m
     WHERE ct.li_invited_at IS NOT NULL AND NOT ct.rehearsal
     GROUP BY 1`)).rows);
  const engagementContacts = byCampaign((await pool.query(
    `SELECT (CASE WHEN array_length(m.memberships, 1) = 1 THEN m.memberships[1] ELSE 'marwin_dc' END) AS campaign,
            count(*)::int AS contacts,
            count(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM outbound_drafts d JOIN outbound_sends s ON s.draft_id = d.id AND s.sent AND NOT s.test_mode
              WHERE d.contact_id = ct.id))::int AS conversations
     FROM contacts ct JOIN companies c ON c.id = ct.company_id
     CROSS JOIN LATERAL (
       SELECT (SELECT array_agg(cc.campaign ORDER BY cc.campaign) FROM company_campaigns cc
               WHERE cc.company_id = c.id) AS memberships
     ) m
     WHERE ct.source = 'post_engagement' AND NOT ct.rehearsal
     GROUP BY 1`)).rows);
  let postsByCampaign = new Map(), engagersByCampaign = new Map();
  try {
    const reg = (await pool.query(`SELECT to_regclass('li_posts') AS t`)).rows[0]?.t;
    if (reg) postsByCampaign = byCampaign((await pool.query(
      `SELECT COALESCE(lp.grounding->>'campaign', s2.campaign, 'marwin_dc') AS campaign, count(*)::int AS posted
       FROM li_posts lp LEFT JOIN signals s2 ON s2.id = lp.signal_id
       WHERE lp.status = 'posted' AND lp.posted_at >= now() - interval '30 days'
       GROUP BY 1`)).rows);
  } catch { /* the block simply shows nothing */ }
  try {
    const reg = (await pool.query(`SELECT to_regclass('post_engagers') AS t`)).rows[0]?.t;
    if (reg) engagersByCampaign = byCampaign((await pool.query(
      `SELECT campaign,
              count(*) FILTER (WHERE first_seen_at >= now() - interval '30 days')::int AS gathered,
              count(*) FILTER (WHERE status = 'new')::int AS waiting
       FROM post_engagers GROUP BY campaign`)).rows);
  } catch { /* absent before migration 032 */ }

  const laneOf = (rows, id) => rows.filter(r => r.campaign === id);
  return {
    campaigns: listCampaigns().filter(c => c.id !== 'rehearsal').map(c => {
      const a = accounts.get(c.id), o = orbit.get(c.id), v = conv.get(c.id), g = goals.get(c.id);
      const funnel = funnelSteps([
        { label: 'Accounts on the register', n: a?.n || 0 },
        { label: 'Decision-orbit contacts', n: o?.orbit || 0 },
        { label: 'With an email address', n: o?.addressed || 0 },
        { label: 'Conversations drafted', n: v?.drafted || 0 },
        { label: 'Sent', n: v?.sent || 0 },
        { label: 'Delivered', n: v?.delivered || 0 },
        { label: 'Replied', n: v?.replied || 0 },
        { label: 'Live interest', n: v?.live || 0 },
        { label: 'Meetings booked', n: g?.meetings || 0 },
        { label: 'Handed off', n: g?.handoffs || 0 },
      ]);
      const steps = laneOf(stepRows, c.id)
        .sort((x, y) => x.step - y.step)
        .map(r => ({ step: r.step, sends: r.sends, replies: r.replies,
          rate: r.sends > 0 ? Math.round((r.replies / r.sends) * 100) : null }));
      const sources = {};
      for (const r of laneOf(sourceRows, c.id)) {
        const key = openerSource({ signalType: r.signal_type, contactSource: r.contact_source });
        sources[key] = sources[key] || { source: key, conversations: 0, replied: 0 };
        sources[key].conversations++;
        if (r.replied) sources[key].replied++;
      }
      return {
        id: c.id, displayName: c.displayName, status: c.status,
        funnel,
        steps,
        sources: Object.values(sources).sort((x, y) => y.conversations - x.conversations),
        timing: replyBuckets(laneOf(timingRows, c.id).map(r => r.days)),
        bounceWeeks: bounceWeeks(laneOf(weekSends, c.id), laneOf(weekBounces, c.id)),
        daily: {
          sends: laneOf(dailySends, c.id).map(r => ({ day: r.day, n: r.n })),
          replies: laneOf(dailyReplies, c.id).map(r => ({ day: r.day, n: r.n })),
        },
        linkedin: {
          invited: invites.get(c.id)?.invited || 0,
          postsThirtyDays: postsByCampaign.get(c.id)?.posted || 0,
          engagersThirtyDays: engagersByCampaign.get(c.id)?.gathered || 0,
          interestWaiting: engagersByCampaign.get(c.id)?.waiting || 0,
          engagementContacts: engagementContacts.get(c.id)?.contacts || 0,
          engagementConversations: engagementContacts.get(c.id)?.conversations || 0,
        },
      };
    }),
  };
}
