import { graphJson } from '../msgraph.mjs';
import { matchReply } from './sendDecision.mjs';
import { replyMailboxes } from './senders.mjs';

// Inbox messages received after sinceIso, oldest first, with just the fields the
// matcher needs. The mailbox is explicit because regional senders each have
// their own inbox to sweep.
export async function fetchInboxSince(sinceIso, mailbox = process.env.ENGINE_MAILBOX) {
  const sel = '$select=id,conversationId,subject,from,receivedDateTime,bodyPreview';
  const filter = sinceIso ? `&$filter=receivedDateTime gt ${sinceIso}` : '';
  const json = await graphJson(`/users/${mailbox}/mailFolders/inbox/messages?${sel}&$top=50&$orderby=receivedDateTime asc${filter}`);
  return (json?.value || []).map(m => ({
    id: m.id, conversationId: m.conversationId, subject: m.subject,
    from: m.from?.emailAddress?.address || null,
    receivedDateTime: m.receivedDateTime, snippet: m.bodyPreview || null,
  }));
}

// Each mailbox keeps its own poll cursor; the engine mailbox keeps the
// original key so nothing re-crawls on upgrade.
export function pollCursorKey(mailbox) {
  const engine = String(process.env.ENGINE_MAILBOX || '').trim().toLowerCase();
  const mb = String(mailbox || '').trim().toLowerCase();
  return !mb || mb === engine ? 'outbound_replies_last_poll' : `outbound_replies_last_poll:${mb}`;
}

// The poller never looks further back than this floor. Replies only matter for
// sends this engine made, and on a mailbox with history (a personal mailbox
// during the testing window) an unbounded first poll would start at the oldest
// mail and crawl the whole archive fifty messages a tick, taking hours to
// reach today. Pure, so the window is provable.
export function pollFloor(now = Date.now()) {
  return new Date(now - 7 * 86_400_000).toISOString();
}
export function effectiveSince(stored, floor) {
  return typeof stored === 'string' && stored > floor ? stored : floor;
}

// Poll every sending mailbox, match each inbound message to a real send,
// record new replies and advance the matched lead to replied. apply=false
// makes no writes. Each mailbox has its own cursor, and a mailbox that fails
// (a licence not yet created, a typo in the config) is reported and never
// stops the others.
export async function pollReplies(pool, { apply = false, includeTestSends = (process.env.REPLY_CAPTURE_TEST_SENDS || 'off') === 'on' } = {}) {
  // Real sends only by default. During the internal testing window the flag
  // widens matching to test sends too, so a reply from a teammate's mailbox can
  // demonstrate the replied stage without any prospect being involved.
  // Real sends first, newest first, so the address fallback in matchReply
  // lands on a live thread before a stale test send.
  const sent = (await pool.query(
    `SELECT draft_id, to_email, conversation_id, test_mode FROM outbound_sends
     WHERE sent${includeTestSends ? '' : ' AND NOT test_mode'}
     ORDER BY test_mode ASC, id DESC`)).rows;

  const report = { scanned: 0, matched: 0, recorded: 0, mailboxes: 0 };
  for (const mailbox of replyMailboxes()) {
    const key = pollCursorKey(mailbox);
    const stored = (await pool.query(`SELECT value FROM kv WHERE key = $1`, [key])).rows[0]?.value || null;
    let since = effectiveSince(stored, pollFloor());
    let maxReceived = since;
    try {
      // Sweep up to five pages per poll, advancing the cursor, so a busy
      // stretch can never outrun the tick.
      for (let page = 0; page < 5; page++) {
        const messages = await fetchInboxSince(since, mailbox);
        report.scanned += messages.length;
        for (const m of messages) {
          if (m.receivedDateTime && m.receivedDateTime > maxReceived) maxReceived = m.receivedDateTime;
          const hit = matchReply(m, sent);
          if (!hit) continue;
          report.matched++;
          if (!apply) continue;
          const ins = await pool.query(
            `INSERT INTO outbound_replies (draft_id, from_email, subject, snippet, conversation_id, graph_message_id, received_at, mailbox)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (graph_message_id) DO NOTHING RETURNING id`,
            [hit.draft_id, m.from, m.subject, m.snippet, m.conversationId, m.id, m.receivedDateTime, mailbox]);
          if (!ins.rowCount) continue; // already recorded
          report.recorded++;
          // A reply matched to a TEST send is recorded for visibility and nothing
          // more: it must never advance a real lead or reach triage, which would
          // suppress real contacts off the back of a teammate's message. The
          // rehearsal lane is the full-journey test path; this flag is only the
          // legacy demonstration.
          if (hit.test_mode) {
            await pool.query(
              `UPDATE outbound_replies SET triaged_at = now(),
                      triage = '{"note":"matched an internal test send; not triaged. Use a rehearsal for the full journey."}'::jsonb
               WHERE id = $1`, [ins.rows[0].id]);
            continue;
          }
          if (hit.draft_id) {
            await pool.query(
              `UPDATE leads SET stage = 'replied', updated_at = now()
               WHERE id = (SELECT lead_id FROM outbound_drafts WHERE id = $1)
                 AND stage IN ('sourced', 'researched', 'outbound')`,
              [hit.draft_id]);
          }
        }
        if (messages.length < 50 || !(maxReceived > since)) break;
        since = maxReceived;
      }
      report.mailboxes++;
    } catch (e) {
      report.mailboxErrors = report.mailboxErrors || [];
      report.mailboxErrors.push(`${mailbox}: ${String(e.message).slice(0, 120)}`);
      continue;
    }
    if (apply && maxReceived && maxReceived !== stored) {
      await pool.query(
        `INSERT INTO kv (key, value) VALUES ($1, to_jsonb($2::text))
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, maxReceived]);
    }
  }
  return report;
}
