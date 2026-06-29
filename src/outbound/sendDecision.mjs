// Pure decision logic for the outbound send and reply-matching paths, kept
// separate from the network so it can be tested offline. The production kill
// switch is not checked here: that stays the single responsibility of sendMail.

// Whether an approved draft may be sent to its real prospect. The kill switch is
// enforced afterwards by sendMail, so this covers only the business rules.
export function canSendReal({ status, contactEmail, suppressed }) {
  if (status !== 'approved') return { ok: false, reason: 'only an approved draft can be sent to a prospect' };
  if (!contactEmail) return { ok: false, reason: 'no recipient email on file for this lead' };
  if (suppressed) return { ok: false, reason: 'the recipient is on the suppression list' };
  return { ok: true };
}

// Match an inbound message to the send it answers: by conversation first, then
// by the prospect's address, so a reply lands on the right draft. Returns the
// matching sent row or null. message: { from, conversationId }. sent rows carry
// { draft_id, to_email, conversation_id }.
export function matchReply(message, sent) {
  const conv = message.conversationId || null;
  if (conv) {
    const byConv = sent.find(s => s.conversation_id && s.conversation_id === conv);
    if (byConv) return byConv;
  }
  const from = String(message.from || '').trim().toLowerCase();
  if (!from) return null;
  return sent.find(s => s.to_email && s.to_email.trim().toLowerCase() === from) || null;
}
