import { pool } from '../db.mjs';
import { publishPost, generateLiPosts } from './liPosts.mjs';
import { activeCampaignIds } from '../campaigns/registry.mjs';
import { AccountUnhealthy, CapReached, accountForCampaign } from '../research/unipile.mjs';

// The studio autopilot's posting half, John's decision of 24 August 2026:
// James and Andy post on Tuesday, Wednesday and Thursday mornings without a
// morning click. The sanction did not move to the machine, it moved earlier
// in time: a person approves each draft into the queue, and the slot releases
// the oldest approved post. Nothing unapproved ever publishes, the blocking
// flags still refuse, the caps still count, and one account-health error
// stands the whole autopilot down.

// London wall clock from a real instant, DST-proof via Intl, so an 08:40 slot
// means 08:40 on the wall in the UK in January and July alike. Pure given now.
export function londonClock(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', weekday: 'short', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(now).map(p => [p.type, p.value]));
  return {
    day: parts.weekday,
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10),
  };
}

// Tuesday, Wednesday, Thursday: John's chosen rhythm, stated 24 August 2026.
export const POST_DAYS = ['Tue', 'Wed', 'Thu'];

// Each lane's morning slot, staggered so the two accounts never fire in the
// same minute. STUDIO_POST_SLOTS overrides as JSON, {"campaign":"HH:MM"}; a
// campaign with no slot anywhere simply never auto-posts, the safe default
// for any future lane.
// Two lanes on one account share one slot and take turns, never two posts
// in a morning: pharma and food and beverage both publish through Andy's
// profile, 9 September 2026, and John's instruction was that the content
// rotates between them.
const SLOT_DEFAULTS = { marwin_dc: '08:40', pharma_steriflow: '09:10', food_beverage: '09:10' };
// A slot stays open for three hours, so a service restart cannot silently eat
// a morning; after that the day's post is a human decision, not a late surprise.
export const SLOT_WINDOW_MINUTES = 180;

export function slotFor(campaign) {
  let slots = SLOT_DEFAULTS;
  const raw = process.env.STUDIO_POST_SLOTS || '';
  if (raw) {
    try { slots = JSON.parse(raw); }
    catch { slots = SLOT_DEFAULTS; }
  }
  const hhmm = slots[String(campaign || '')];
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

// The one decision the posting slot makes, pure so the gate can prove it:
// due only on a posting day, at or after the lane's slot, within the window,
// and only when nothing has posted for the lane today. A hand-published post
// that morning stands the slot down, so autopilot and a keen human never
// double-post a lane.
export function slotDue({ campaign, now = new Date(), postedToday = false }) {
  const slot = slotFor(campaign);
  if (slot == null) return { due: false, reason: 'no slot configured for this campaign' };
  const clock = londonClock(now);
  if (!POST_DAYS.includes(clock.day)) return { due: false, reason: 'not a posting day' };
  if (postedToday) return { due: false, reason: 'the lane has already posted today' };
  if (clock.minutes < slot) return { due: false, reason: 'before the slot' };
  if (clock.minutes > slot + SLOT_WINDOW_MINUTES) return { due: false, reason: 'the slot lapsed' };
  return { due: true, reason: 'slot open' };
}

// Has anything published for this lane today, London's today? The campaign is
// derived exactly as everywhere else: the draft's grounding, its signal, the
// data centre default.
// When a lane last published, any status, so lanes sharing an account can
// take turns: the one that posted least recently goes next.
async function lastPostedAt(campaign) {
  const { rows } = await pool.query(
    `SELECT max(lp.posted_at) AS last FROM li_posts lp LEFT JOIN signals s ON s.id = lp.signal_id
     WHERE lp.status = 'posted'
       AND COALESCE(lp.grounding->>'campaign', s.campaign, 'marwin_dc') = $1`, [campaign]);
  return rows[0]?.last || null;
}

// The turn order for lanes that share one LinkedIn account: never posted
// first, then least recently posted, so two lanes alternate day by day and
// a lane with nothing approved simply yields the morning to the other. Pure,
// so the rotation is provable without a database.
export function rotationOrder(lanes) {
  const t = v => { const n = v ? new Date(v).getTime() : NaN; return Number.isNaN(n) ? -Infinity : n; };
  return [...(lanes || [])].sort((a, b) => t(a.lastPostedAt) - t(b.lastPostedAt) || String(a.campaign).localeCompare(String(b.campaign)));
}

async function postedTodayLondon(campaign) {
  const { rows } = await pool.query(
    `SELECT 1 FROM li_posts lp LEFT JOIN signals s ON s.id = lp.signal_id
     WHERE lp.status = 'posted'
       AND COALESCE(lp.grounding->>'campaign', s.campaign, 'marwin_dc') = $1
       AND (lp.posted_at AT TIME ZONE 'Europe/London')::date = (now() AT TIME ZONE 'Europe/London')::date
     LIMIT 1`, [campaign]);
  return rows.length > 0;
}

// The oldest approved, unflagged post for a lane. updated_at is the approval
// time, since edits are restricted to drafts, so oldest-approved-first is the
// queue order a person expects.
async function nextApproved(campaign) {
  const { rows } = await pool.query(
    `SELECT lp.id FROM li_posts lp LEFT JOIN signals s ON s.id = lp.signal_id
     WHERE lp.status = 'approved'
       AND COALESCE(lp.grounding->>'campaign', s.campaign, 'marwin_dc') = $1
       AND COALESCE(jsonb_array_length(lp.grounding->'flags'), 0) = 0
     ORDER BY lp.updated_at ASC LIMIT 1`, [campaign]);
  return rows[0]?.id ?? null;
}

// One pass over the lanes: for each campaign whose slot is open, publish the
// oldest approved post through publishPost, which is the same code the button
// runs, caps, flags, account routing and the story-link first comment
// included. An account-health error is returned, never swallowed, so the
// caller can stand the autopilot down; a cap refusal skips the lane cleanly.
export async function autopostOnce({ log = () => {} } = {}) {
  const out = { posted: [], skipped: [] };
  // Lanes whose slot is open, grouped by the LinkedIn account that carries
  // them. One account posts once a morning whatever the lane count: a person
  // who publishes twice before ten reads as a feed, not a practitioner.
  const byAccount = new Map();
  for (const campaign of activeCampaignIds()) {
    if (slotFor(campaign) == null) continue;
    const accountId = accountForCampaign(campaign);
    if (!accountId) continue;
    const postedToday = await postedTodayLondon(campaign);
    const slot = slotDue({ campaign, postedToday });
    const group = byAccount.get(accountId) || { accountId, lanes: [], postedToday: false };
    group.postedToday = group.postedToday || postedToday;
    if (slot.due) group.lanes.push({ campaign, lastPostedAt: await lastPostedAt(campaign) });
    byAccount.set(accountId, group);
  }
  for (const group of byAccount.values()) {
    if (group.postedToday || !group.lanes.length) continue;
    let published = false;
    for (const lane of rotationOrder(group.lanes)) {
      const { campaign } = lane;
      const id = await nextApproved(campaign);
      if (!id) {
        out.skipped.push({ campaign, reason: 'the slot is open but no approved post is waiting' });
        continue;
      }
      try {
        const r = await publishPost(id, { auto: true });
        if (r.posted) {
          log(`published post ${id} for ${campaign}${r.commented ? ', story link as first comment' : ''}`);
          out.posted.push({ campaign, id, commented: r.commented });
          published = true;
          break;
        }
        out.skipped.push({ campaign, reason: r.reason });
      } catch (e) {
        if (e instanceof AccountUnhealthy) { out.unhealthy = String(e.message).slice(0, 300); return out; }
        if (e instanceof CapReached) { out.skipped.push({ campaign, reason: 'daily call cap reached' }); break; }
        out.skipped.push({ campaign, reason: String(e.message).slice(0, 200) });
      }
    }
    if (!published && group.lanes.length > 1) {
      log(`no lane on this account had an approved post this morning (${group.lanes.map(l => l.campaign).join(', ')})`);
    }
  }
  return out;
}

// The drafting half feeds the queue: when a posting lane holds fewer open
// posts (drafts plus approved) than the floor, the engine drafts more from
// its own fresh gated signals, exactly what the studio's button does. Costs a
// model call, writes nothing to LinkedIn, and a lane with enough in hand is
// left alone.
export const queueFloor = () => Math.max(1, parseInt(process.env.STUDIO_QUEUE_FLOOR || '3', 10) || 3);

export async function topUpStudioPosts({ log = () => {} } = {}) {
  if (!process.env.ANTHROPIC_API_KEY) return { skipped: 'ANTHROPIC_API_KEY is not set' };
  const lanes = [];
  for (const campaign of activeCampaignIds()) {
    if (slotFor(campaign) == null) continue;
    const { rows } = await pool.query(
      `SELECT count(*)::int AS open FROM li_posts lp LEFT JOIN signals s ON s.id = lp.signal_id
       WHERE lp.status IN ('draft', 'approved')
         AND COALESCE(lp.grounding->>'campaign', s.campaign, 'marwin_dc') = $1`, [campaign]);
    const open = rows[0].open;
    if (open >= queueFloor()) continue;
    const r = await generateLiPosts({ limit: queueFloor() - open, campaign });
    log(`topped up ${campaign}: ${r.drafted} drafted${r.flagged ? `, ${r.flagged} flagged` : ''}`);
    lanes.push({ campaign, open, ...r });
  }
  return { lanes };
}
