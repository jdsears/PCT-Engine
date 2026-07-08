import { graphJson } from '../msgraph.mjs';
import { matchReply } from './sendDecision.mjs';

// Inbox messages received after sinceIso, oldest first, with just the fields the
// matcher needs. With no sinceIso it reads the most recent batch.
export async function fetchInboxSince(sinceIso) {
  const mb = process.env.ENGINE_MAILBOX;
  const sel = '$select=id,conversationId,subject,from,receivedDateTime,bodyPreview';
  const filter = sinceIso ? `&$filter=receivedDateTime gt ${sinceIso}` : '';
  const json = await graphJson(`/users/${mb}/mailFolders/inbox/messages?${sel}&$top=50&$orderby=receivedDateTime asc${filter}`);
  return (json?.value || []).map(m => ({
    id: m.id, conversationId: m.conversationId, subject: m.subject,
    from: m.from?.emailAddress?.address || null,
    receivedDateTime: m.receivedDateTime, snippet: m.bodyPreview || null,
  }));
}

// Poll the engine mailbox, match each inbound message to a real send, record new
// replies and advance the matched lead to replied. apply=false makes no writes.
export async function pollReplies(pool, { apply = false, includeTestSends = (process.env.REPLY_CAPTURE_TEST_SENDS || 'off') === 'on' } = {}) {
  const stored = (await pool.query(`SELECT value FROM kv WHERE key = 'outbound_replies_last_poll'`)).rows[0]?.value || null;
  const sinceIso = typeof stored === 'string' ? stored : null;
  const messages = await fetchInboxSince(sinceIso);
  // Real sends only by default. During the internal testing window the flag
  // widens matching to test sends too, so a reply from a teammate's mailbox can
  // demonstrate the replied stage without any prospect being involved.
  const sent = (await pool.query(
    `SELECT draft_id, to_email, conversation_id FROM outbound_sends WHERE sent${includeTestSends ? '' : ' AND NOT test_mode'}`)).rows;

  const report = { scanned: messages.length, matched: 0, recorded: 0 };
  let maxReceived = sinceIso;
  for (const m of messages) {
    if (m.receivedDateTime && (!maxReceived || m.receivedDateTime > maxReceived)) maxReceived = m.receivedDateTime;
    const hit = matchReply(m, sent);
    if (!hit) continue;
    report.matched++;
    if (!apply) continue;
    const ins = await pool.query(
      `INSERT INTO outbound_replies (draft_id, from_email, subject, snippet, conversation_id, graph_message_id, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (graph_message_id) DO NOTHING RETURNING id`,
      [hit.draft_id, m.from, m.subject, m.snippet, m.conversationId, m.id, m.receivedDateTime]);
    if (!ins.rowCount) continue; // already recorded
    report.recorded++;
    if (hit.draft_id) {
      await pool.query(
        `UPDATE leads SET stage = 'replied', updated_at = now()
         WHERE id = (SELECT lead_id FROM outbound_drafts WHERE id = $1)
           AND stage IN ('sourced', 'researched', 'outbound')`,
        [hit.draft_id]);
    }
  }

  if (apply && maxReceived && maxReceived !== sinceIso) {
    await pool.query(
      `INSERT INTO kv (key, value) VALUES ('outbound_replies_last_poll', to_jsonb($1::text))
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [maxReceived]);
  }
  return report;
}
