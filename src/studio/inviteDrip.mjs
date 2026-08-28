import { pool, hasColumn } from '../db.mjs';
import { londonClock } from './autopost.mjs';
import { activeCampaignIds } from '../campaigns/registry.mjs';
import { accountForCampaign, AccountUnhealthy, CapReached, unipileConfigured } from '../research/unipile.mjs';
import { canInvite, sendConnectionInvite, inviteRefusal } from './liInvite.mjs';
import { connectNote } from './liPosts.mjs';
import { recipientMismatch } from '../outbound/draft.mjs';
import { sendDm } from './liDm.mjs';

// The invite drip, John's decision of 24 August 2026: connection requests
// join the autopilot, timed with the outreach engine. Two modes, both human
// sanctions. In approvals mode a person approves one named contact and the
// drip releases only what carries the stamp. In automatic mode, sanctioned
// the same evening by John with James's and Andy's word for their own
// accounts ("they want automatic invites"), the standing approval covers the
// whole eligible queue: the drip picks the best accounts first, approved
// people still jump the queue, every unapproved pick is screened with the
// recipient-truth nets so a wrong-company note can never send, and a Skip on
// any card vetoes a person out of LinkedIn contact entirely. Invitations are
// the touchiest LinkedIn action of all, so the drip stays deliberately
// boring either way: weekdays only, working hours only, one release per
// lane per tick, a minimum gap per account, a daily cap tighter than the
// hand cap, and the whole thing stands itself down on any account-health
// error. Timing with the email sequence: a contact who has been emailed is
// only invited a few days after the last send, and never once a person has
// replied, because a reply makes it a conversation and conversations are
// handled by humans.
//
// Since the sequencing change of the same evening the drip carries the
// message stage too: a person who accepted an invitation and still has not
// replied gets one direct message, drafted and gated in liDm.mjs, released
// here so invitations and messages share one pace, one gap and one daily cap
// per account. A waiting message goes before a new invitation, because that
// person is further down the sequence.

export const dripDailyCap = () => Math.max(1, parseInt(process.env.STUDIO_INVITE_DRIP_CAP || '5', 10) || 5);

// Every LinkedIn action the drip took today on one account, invitations and
// messages together. They are different endpoints but the same profile, and
// the profile is what LinkedIn watches, so one cap covers both rather than
// two caps quietly doubling the day's activity.
export async function dripActionsToday(accountId = null) {
  const perAccount = accountId && await hasColumn('unipile_calls', 'account_id');
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM unipile_calls
     WHERE endpoint IN ('POST /api/v1/users/invite', 'POST /api/v1/chats') AND outcome = 'ok'
       AND (called_at AT TIME ZONE 'UTC')::date = (now() AT TIME ZONE 'UTC')::date
       ${perAccount ? 'AND account_id = $1' : ''}`, perAccount ? [accountId] : []);
  return rows[0].n;
}
export const inviteAfterEmailDays = () => Math.max(0, parseInt(process.env.INVITE_AFTER_EMAIL_DAYS || '3', 10) || 3);
export const DRIP_MIN_GAP_MINUTES = 45;

// Weekday working hours on the London wall clock, 09:30 to 16:30: invites
// land when a person would plausibly be at a desk, never at 03:00, never at
// the weekend.
export function dripWindowOpen(now = new Date()) {
  const c = londonClock(now);
  if (!['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(c.day)) return false;
  return c.minutes >= 9 * 60 + 30 && c.minutes <= 16 * 60 + 30;
}

// Spacing per account: no two dripped invites inside the gap, so the pattern
// reads as a person, not a queue. An unknown last time never blocks.
export function gapClear({ now = Date.now(), lastInviteAt = null, minGapMinutes = DRIP_MIN_GAP_MINUTES } = {}) {
  if (!lastInviteAt) return true;
  const t = new Date(lastInviteAt).getTime();
  if (Number.isNaN(t)) return true;
  return now - t >= minGapMinutes * 60_000;
}

// The email-sequence timing: a reply parks the invite for a human, and an
// emailed contact waits the configured days after the last send, so the
// LinkedIn touch lands between the emails rather than on top of them. A
// contact never emailed is clear immediately.
export function emailTimingClear({ lastEmailAt = null, replied = false, now = Date.now(), afterDays = inviteAfterEmailDays() } = {}) {
  if (replied) return false;
  if (!lastEmailAt) return true;
  const t = new Date(lastEmailAt).getTime();
  if (Number.isNaN(t)) return true;
  return now - t >= afterDays * 86_400_000;
}

// Release one approved message for a lane, or nothing. Approvals mode sends
// only what a person stamped; automatic mode may send an unflagged message
// under the standing sanction, and a flagged one never sends in either mode,
// because a flag is the engine saying it is not sure who this is.
async function releaseMessage({ campaign, accountId, auto, log }) {
  if (!(await hasColumn('contacts', 'li_connected_at'))) return 'none';
  const { rows } = await pool.query(
    `SELECT m.id, m.body, m.status, m.flags, ct.id AS contact_id, ct.full_name, ct.linkedin_url
     FROM li_messages m JOIN contacts ct ON ct.id = m.contact_id
     WHERE m.campaign = $1 AND m.status = ${auto ? "ANY(ARRAY['approved','draft'])" : "'approved'"}

       AND COALESCE(jsonb_array_length(m.flags), 0) = 0
       AND ct.li_connected_at IS NOT NULL AND NOT ct.suppressed
       AND NOT EXISTS (SELECT 1 FROM outbound_replies r JOIN outbound_drafts d ON d.id = r.draft_id
                       WHERE d.contact_id = ct.id
                         AND (r.category IS NULL OR r.category NOT IN ('bounce', 'out_of_office')))
     ORDER BY (m.status = 'approved') DESC, m.created_at ASC LIMIT 1`, [campaign]);
  const m = rows[0];
  if (!m) return 'none';
  try {
    const r = await sendDm(m, { linkedin_url: m.linkedin_url }, { accountId });
    if (!r.sent) return 'none';
    await pool.query(
      `UPDATE li_messages SET status = 'sent', sent_at = now(), sent_by = $2, updated_at = now() WHERE id = $1`,
      [m.id, m.status === 'approved' ? 'invite drip' : 'invite drip (auto)']);
    log(`messaged ${m.full_name} (${campaign})`);
    return 'sent';
  } catch (e) {
    if (e instanceof AccountUnhealthy) return 'unhealthy';
    if (e instanceof CapReached) return 'none';
    log(`message failed for ${m.full_name}: ${String(e.message).slice(0, 140)}`);
    return 'none';
  }
}

// One pass: for each lane, release at most one invite whose timing is
// clear, approvals first, through the same send path the button uses, with
// the same bookkeeping. Quiet outside the window and under the gap; an
// account-health error is returned for the caller to stand the drip down.
export async function dripInvitesOnce({ log = () => {}, auto = false } = {}) {
  const out = { sent: [], skipped: [] };
  if (!unipileConfigured()) return out;
  if (!(await hasColumn('contacts', 'li_invite_approved_at'))) {
    return { ...out, skipped: [{ reason: 'the approval columns are missing; run npm run migrate first' }] };
  }
  if (!dripWindowOpen()) return out;
  const perAcct = await hasColumn('unipile_calls', 'account_id');
  const byCol = await hasColumn('contacts', 'li_invited_by');
  const skipCol = await hasColumn('contacts', 'li_invite_skipped_at');
  // The candidates, each with its lane and its email-sequence facts; the
  // lane derives through the membership rule the connect queue uses. In
  // approvals mode only stamped contacts qualify; in automatic mode the
  // whole eligible queue does, best accounts first, with approved people
  // still jumping it. A skipped contact never appears in either mode.
  const { rows: approved } = await pool.query(
    `SELECT ct.*, c.name AS company, c.domain AS company_domain,
            (CASE WHEN array_length(m.memberships, 1) = 1 THEN m.memberships[1] ELSE 'marwin_dc' END) AS lane,
            (SELECT max(s.created_at) FROM outbound_sends s JOIN outbound_drafts d ON d.id = s.draft_id
             WHERE d.contact_id = ct.id AND s.sent AND NOT s.test_mode) AS last_email_at,
            EXISTS (SELECT 1 FROM outbound_replies r JOIN outbound_drafts d ON d.id = r.draft_id
                    WHERE d.contact_id = ct.id
                      AND (r.category IS NULL OR r.category NOT IN ('bounce', 'out_of_office'))) AS replied
     FROM contacts ct JOIN companies c ON c.id = ct.company_id
     CROSS JOIN LATERAL (
       SELECT (SELECT array_agg(cc.campaign ORDER BY cc.campaign) FROM company_campaigns cc
               WHERE cc.company_id = c.id) AS memberships
     ) m
     WHERE (${auto ? 'ct.in_decision_orbit AND ct.linkedin_url IS NOT NULL' : 'ct.li_invite_approved_at IS NOT NULL'})
       AND ct.li_invited_at IS NULL
       AND NOT ct.suppressed AND NOT ct.rehearsal
       ${skipCol ? 'AND ct.li_invite_skipped_at IS NULL' : ''}
     ORDER BY (ct.li_invite_approved_at IS NULL) ASC, ct.li_invite_approved_at ASC NULLS LAST,
              c.icp_score DESC NULLS LAST`);
  for (const campaign of activeCampaignIds()) {
    const accountId = accountForCampaign(campaign);
    if (!accountId) continue;
    const used = await dripActionsToday(accountId);
    if (used >= dripDailyCap()) continue;
    const { rows: g } = await pool.query(
      `SELECT max(called_at) AS last FROM unipile_calls
       WHERE endpoint IN ('POST /api/v1/users/invite', 'POST /api/v1/chats') AND outcome = 'ok'${perAcct ? ' AND account_id = $1' : ''}`,
      perAcct ? [accountId] : []);
    if (!gapClear({ lastInviteAt: g[0]?.last })) continue;
    // A message to someone who already accepted comes before a new
    // invitation: they are further down the sequence and waiting on us.
    const msg = await releaseMessage({ campaign, accountId, auto, log });
    if (msg === 'sent') { out.sent.push({ campaign, kind: 'message' }); continue; }
    if (msg === 'unhealthy') { out.unhealthy = 'LinkedIn reported an account health problem while sending a message'; break; }
    const pick = approved.filter(x => x.lane === campaign)
      .find(x => canInvite(x).ok && emailTimingClear({ lastEmailAt: x.last_email_at, replied: x.replied })
        // An unapproved automatic pick is screened with the recipient-truth
        // nets: the note names their role and company, and a wrong-company
        // note must never send. Anyone the nets dispute stays in the queue
        // for a human; an approved pick was seen by one already.
        && (x.li_invite_approved_at || recipientMismatch(
              { name: x.full_name, role: x.role_title, email: x.email,
                confirmed: !!(x.payload && x.payload.recipient_confirmed) },
              { name: x.company, domain: x.company_domain }).length === 0));
    if (!pick) continue;
    try {
      const note = String(pick.li_invite_note || '').slice(0, 300)
        || connectNote({ full_name: pick.full_name, role_title: pick.role_title }, pick.company, campaign);
      const r = await sendConnectionInvite(pick, note, { accountId });
      if (r.sent) {
        // Provenance says how the release happened: an automatic pick reads
        // differently in the books than one a person stamped.
        const by = auto && !pick.li_invite_approved_at ? 'invite drip (auto)' : 'invite drip';
        await pool.query(
          `UPDATE contacts SET li_invited_at = now(), li_invite_note = $2${byCol ? ', li_invited_by = COALESCE(li_invited_by, $3)' : ''}
           WHERE id = $1`, byCol ? [pick.id, note, by] : [pick.id, note]);
        out.sent.push({ campaign, kind: 'invite', contact: pick.full_name });
        log(`dripped an invite to ${pick.full_name} (${campaign})`);
      } else {
        out.skipped.push({ campaign, reason: r.reason });
      }
    } catch (e) {
      if (e instanceof AccountUnhealthy) { out.unhealthy = String(e.message).slice(0, 300); break; }
      if (e instanceof CapReached) { out.skipped.push({ campaign, reason: 'the daily Unipile call cap is reached' }); continue; }
      const refusal = inviteRefusal(e);
      if (refusal?.alreadyInvited) {
        // Truth from LinkedIn's side, recorded exactly as the button records
        // it, so the queue moves on rather than re-raising every tick.
        await pool.query(
          `UPDATE contacts SET li_invited_at = now(), li_invite_note = $2 WHERE id = $1 AND li_invited_at IS NULL`,
          [pick.id, 'recorded from LinkedIn: an invitation was already pending']);
        out.skipped.push({ campaign, reason: 'already pending on LinkedIn, recorded' });
        continue;
      }
      out.skipped.push({ campaign, reason: String(e.message).slice(0, 160) });
    }
  }
  return out;
}
