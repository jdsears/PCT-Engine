import { pool, hasColumn } from '../db.mjs';
import { unipile, ROUTES, accountForCampaign, unipileConfigured, CapReached, AccountUnhealthy } from '../research/unipile.mjs';
import { linkedinSlug } from './liInvite.mjs';
import { sendTeamNote } from '../mail.mjs';
import { dmSender } from './liDm.mjs';

// Replies on LinkedIn, 10 September 2026. Laurence Davis at Jones
// Engineering answered James's message on LinkedIn ("no live UK projects
// with requirements; in the event we do I will reach out"), and the engine
// had no way to see it: reply capture reads mailboxes, and the break-up
// email from the rep would have followed his answer a few days later as if
// nobody had spoken. This sweep reads each sent message's conversation back
// through the account that sent it, records the first reply, stops the
// sequence on that thread the way an email reply does, and tells the lane's
// owner what was said.
//
// Reads only, small batches, one check a day per message inside a watch
// window, and every field read defensively, because the provider's message
// shape is learned on the first live sweep: scripts/unipile-check.mjs
// --chats prints it raw.

export const REPLY_RECHECK_HOURS = 20;
export const replyWatchDays = () => Math.max(1, parseInt(process.env.LI_REPLY_WATCH_DAYS || '30', 10) || 30);

// Worth a look now: sent, unanswered as far as we know, inside the watch
// window, and not checked in the last day. Pure, so the politeness is
// provable without a provider.
export function replyCheckDue({ sentAt, repliedAt = null, checkedAt = null, now = Date.now(), watchDays = replyWatchDays() } = {}) {
  if (repliedAt) return false;
  const sent = new Date(sentAt).getTime();
  if (Number.isNaN(sent)) return false;
  if (now - sent > watchDays * 86_400_000) return false;
  if (!checkedAt) return true;
  const last = new Date(checkedAt).getTime();
  if (Number.isNaN(last)) return true;
  return now - last >= REPLY_RECHECK_HOURS * 3_600_000;
}

// The items in a listing, whatever the envelope: items, messages, a bare
// array, or nothing.
export function chatItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.messages)) return payload.messages;
  return [];
}

const when = m => new Date(m?.timestamp ?? m?.created_at ?? m?.date ?? m?.sent_at ?? 0).getTime();
const ours = (m, ownId) => m?.is_sender === 1 || m?.is_sender === true || m?.is_sender === '1'
  || m?.direction === 'outbound' || (ownId && m?.sender_id === ownId);

// The first thing they said after our message: not ours, after we sent,
// from them when the message names a sender at all. Null when nothing has
// come back, which is the ordinary answer.
export function replyFrom(messages, { sentAt, attendeeId = null, ownId = null } = {}) {
  const since = new Date(sentAt).getTime();
  if (Number.isNaN(since)) return null;
  const inbound = chatItems(messages)
    .filter(m => !ours(m, ownId))
    .filter(m => when(m) >= since - 60_000)
    .filter(m => !attendeeId || !m?.sender_id || m.sender_id === attendeeId)
    .filter(m => String(m?.text ?? m?.body ?? '').trim())
    .sort((a, b) => when(a) - when(b));
  const first = inbound[0];
  if (!first) return null;
  return { text: String(first.text ?? first.body).trim().slice(0, 4000), at: new Date(when(first)).toISOString(), id: first.id ?? null };
}

// The chat with this person, found by their provider id on the chat or on
// its attendees. Null when the account holds no such chat yet.
export function chatFor(chats, attendeeId) {
  if (!attendeeId) return null;
  for (const c of chatItems(chats)) {
    if (c?.attendee_provider_id === attendeeId) return c;
    const attendees = Array.isArray(c?.attendees) ? c.attendees : [];
    if (attendees.some(a => a?.provider_id === attendeeId || a?.id === attendeeId)) return c;
  }
  return null;
}

// One sweep: a small batch of sent messages, oldest first, each read back
// through its own account. A reply is recorded once and the thread's lead
// moves to replied; the lane's owner gets the words themselves.
export async function sweepDmRepliesOnce({ limit = 8, log = () => {} } = {}) {
  const out = { checked: 0, replied: 0 };
  if (!unipileConfigured()) return { ...out, skipped: 'Unipile is not configured' };
  if (!(await hasColumn('li_messages', 'replied_at'))) return { ...out, skipped: 'run npm run migrate first' };
  const { rows } = await pool.query(
    `SELECT m.id, m.campaign, m.sent_at, m.chat_id, m.attendee_id, m.reply_checked_at, m.lead_id,
            ct.id AS contact_id, ct.full_name, ct.linkedin_url, c.name AS company
     FROM li_messages m JOIN contacts ct ON ct.id = m.contact_id
     LEFT JOIN companies c ON c.id = m.company_id
     WHERE m.status = 'sent' AND m.replied_at IS NULL
       AND m.sent_at > now() - ($1 || ' days')::interval
     ORDER BY m.sent_at ASC LIMIT 40`, [String(replyWatchDays())]);
  for (const r of rows) {
    if (out.checked >= limit) break;
    if (!replyCheckDue({ sentAt: r.sent_at, checkedAt: r.reply_checked_at })) continue;
    const accountId = accountForCampaign(r.campaign);
    const slug = linkedinSlug(r.linkedin_url);
    if (!accountId || !slug) continue;
    try {
      let attendeeId = r.attendee_id;
      if (!attendeeId) {
        const profile = await unipile(ROUTES.profile, { pathSuffix: slug, query: { account_id: accountId }, target: `reply check ${slug}` });
        attendeeId = profile?.provider_id || profile?.member_id || profile?.id || null;
        if (attendeeId) await pool.query(`UPDATE li_messages SET attendee_id = $2 WHERE id = $1`, [r.id, attendeeId]);
      }
      let chatId = r.chat_id;
      if (!chatId && attendeeId) {
        const chats = await unipile(ROUTES.listChats, { query: { account_id: accountId, limit: 50 }, target: `reply check chats ${slug}` });
        chatId = chatFor(chats, attendeeId)?.id || null;
        if (chatId) await pool.query(`UPDATE li_messages SET chat_id = $2 WHERE id = $1`, [r.id, chatId]);
      }
      out.checked++;
      await pool.query(`UPDATE li_messages SET reply_checked_at = now() WHERE id = $1`, [r.id]);
      if (!chatId) { log(`no conversation found yet for ${r.full_name} (${r.campaign})`); continue; }
      const payload = await unipile(ROUTES.chatMessages, {
        pathSuffix: `${encodeURIComponent(chatId)}/messages`, rawSuffix: true, query: { limit: 20 }, target: `reply check ${slug}`,
      });
      const reply = replyFrom(payload, { sentAt: r.sent_at, attendeeId });
      if (!reply) continue;
      await pool.query(`UPDATE li_messages SET replied_at = $2, reply_text = $3, updated_at = now() WHERE id = $1`, [r.id, reply.at, reply.text]);
      // A reply ends the machine's initiative on the thread, exactly as an
      // email reply does: the lead moves to replied and no follow-up or
      // break-up is drafted for it again.
      if (r.lead_id) {
        await pool.query(`UPDATE leads SET stage = 'replied' WHERE id = $1 AND stage NOT IN ('replied', 'handed_off', 'closed')`, [r.lead_id]);
      }
      const sender = dmSender(r.campaign);
      await sendTeamNote(`LinkedIn reply from ${r.full_name}${r.company ? ` (${r.company})` : ''}`,
        `${r.full_name}${r.company ? ` at ${r.company}` : ''} replied on LinkedIn to the message sent from ${sender ? `${sender.name}'s` : 'the campaign'} profile on ${new Date(r.sent_at).toDateString()}:\n\n"${reply.text}"\n\n` +
        `The sequence has stopped for this thread; no break-up email will follow. Reply from LinkedIn as usual.${r.linkedin_url ? `\n\n${r.linkedin_url}` : ''}`,
        { campaign: r.campaign }).catch(() => {});
      out.replied++;
      log(`${r.full_name} replied on LinkedIn (${r.campaign}): ${reply.text.slice(0, 80)}`);
    } catch (e) {
      if (e instanceof CapReached) break;
      if (e instanceof AccountUnhealthy) { out.unhealthy = String(e.message).slice(0, 300); break; }
      // A conversation that cannot be read is not a verdict: stamp the check
      // so the sweep moves on, and try again after the recheck interval.
      await pool.query(`UPDATE li_messages SET reply_checked_at = now() WHERE id = $1`, [r.id]).catch(() => {});
      log(`reply check failed for ${r.full_name}: ${String(e.message).slice(0, 120)}`);
    }
  }
  return out;
}
