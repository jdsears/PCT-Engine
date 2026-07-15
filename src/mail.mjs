import { graphJson } from './msgraph.mjs';

// Two send paths, two independent gates. A real prospect send is governed by the
// production kill switch and stays off by default. An internal test send is
// governed by its own switch and a strict allowlist, never by the kill switch, so
// the send mechanism can be exercised end to end during the testing window with
// no chance of reaching a prospect.

const emailList = (v) => String(v || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// One team list for everything internal. TEAM_EMAILS is the default for the
// digest recipients, the intel senders and the outbound test recipients; each
// specific variable still overrides it when set, and every path keeps its own
// gate (the digest allowlist, the intel sender check, the test-sends switch).
export function teamEmails() {
  return emailList(process.env.TEAM_EMAILS);
}

// The internal test-recipient allowlist, lower-cased for comparison.
function testRecipients() {
  const specific = emailList(process.env.OUTBOUND_TEST_RECIPIENTS);
  return specific.length ? specific : teamEmails();
}
export function testRecipientList() {
  return testRecipients();
}
export function isTestRecipient(addr) {
  return testRecipients().includes(String(addr || '').trim().toLowerCase());
}

// The sender identity on prospect mail. A cold email from a bare system address
// converts poorly and reads automated; a named person with a plain signature is
// both politer and clearer under PECR. SENDER_SIGNATURE overrides the whole
// block when set; otherwise it is built from the parts. The opt-out line is
// always appended to prospect mail: an opt-out we invite is an opt-out we can
// honour, and the triage path suppresses the contact when one arrives.
export function signatureBlock() {
  const custom = String(process.env.SENDER_SIGNATURE || '').trim();
  if (custom) return custom;
  const name = String(process.env.SENDER_NAME || '').trim();
  const title = String(process.env.SENDER_TITLE || '').trim();
  const lines = [];
  if (name) lines.push(name);
  if (title) lines.push(title);
  lines.push('Premier Control Technologies');
  lines.push('pctflow.com');
  return lines.join('\n');
}

export function withFooter(text) {
  const optOut = 'If this is not relevant to you, reply no thanks and I will not write again.';
  return `${String(text || '').trim()}\n\n${signatureBlock()}\n\n${optOut}`;
}

// Plain text to a simple, safe HTML body: escape, keep blank-line paragraphs and
// single line breaks. The drafts are plain text, so this is all the markup needed.
export function textToHtml(text) {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return String(text || '').trim().split(/\n{2,}/)
    .map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('\n');
}

// The actual Graph send. Private: both public paths must gate before reaching it.
async function deliver({ to, subject, html }) {
  await graphJson(`/users/${process.env.ENGINE_MAILBOX}/sendMail`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message: { subject, body: { contentType: 'HTML', content: html }, toRecipients: [{ emailAddress: { address: to } }] },
      saveToSentItems: true,
    }),
  });
}

// Create the message as a draft, read its identifiers, then send it. The two
// step form is used for real sends so the conversation id is known and an inbound
// reply can be matched back to the draft it answers.
async function deliverTracked({ to, subject, html }) {
  const mb = process.env.ENGINE_MAILBOX;
  const created = await graphJson(`/users/${mb}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      subject, body: { contentType: 'HTML', content: html },
      toRecipients: [{ emailAddress: { address: to } }],
    }),
  });
  await graphJson(`/users/${mb}/messages/${created.id}/send`, { method: 'POST' });
  return { messageId: created.id, conversationId: created.conversationId, internetMessageId: created.internetMessageId };
}

// Whether the kill switch blocks a send to this address. The invariant: with
// the kill switch on, mail can only ever reach the internal allowlist, and
// only while test sends are enabled. That lets a rehearsal run the real
// tracked send path to a teammate while every prospect stays unreachable.
// Pure over the environment, so the invariant is testable.
export function blockedByKillSwitch(to) {
  if ((process.env.MAIL_KILL_SWITCH || 'on') === 'off') return false;
  const internalOk = (process.env.OUTBOUND_TEST_SENDS || 'off') === 'on' && isTestRecipient(to);
  return !internalOk;
}

// Real prospect send. Refuses unless the kill switch allows this recipient
// (explicitly off, or an internal allowlisted address during the testing
// window). This is the production gate and stays on by default. On a send it
// returns the message identifiers so the reply poller can correlate.
export async function sendMail({ to, subject, html }) {
  if (blockedByKillSwitch(to)) {
    return { sent: false, reason: 'kill switch on' };
  }
  const ids = await deliverTracked({ to, subject, html });
  return { sent: true, ...ids };
}

// Threaded reply to an inbound prospect message, for the response drafts. Graph
// places our text above the quoted thread and sends in the same conversation,
// exactly as a human reply would look. Gated by the same kill switch rule as
// any other prospect send; `to` is the recipient on record, used only for that
// gate since Graph derives the actual recipient from the thread. Returns no
// message ids (Graph's reply endpoint sends immediately); the conversation id
// on the inbound message already correlates.
export async function sendMailReply({ inboundMessageId, html, to }) {
  if (blockedByKillSwitch(to)) {
    return { sent: false, reason: 'kill switch on' };
  }
  await graphJson(`/users/${process.env.ENGINE_MAILBOX}/messages/${inboundMessageId}/reply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ comment: html }),
  });
  return { sent: true };
}

// Internal test send. Refuses unless test sends are explicitly enabled and the
// recipient is on the internal allowlist, so it can never reach a prospect even
// when the production kill switch is off.
export async function sendMailTest({ to, subject, html }) {
  if ((process.env.OUTBOUND_TEST_SENDS || 'off') !== 'on') {
    return { sent: false, reason: 'test sends disabled' };
  }
  if (!isTestRecipient(to)) {
    return { sent: false, reason: 'recipient not on the internal allowlist' };
  }
  await deliver({ to, subject, html });
  return { sent: true };
}

// The digest list: the internal people who receive the engine's weekly summary.
export function digestRecipients() {
  const specific = emailList(process.env.DIGEST_RECIPIENTS);
  return specific.length ? specific : teamEmails();
}

// Internal operational mail, the weekly digest. Its own allowlist and
// deliberately independent of the outbound kill switch: this is the engine
// reporting to its own team, never outreach, and an address off the digest
// list is refused outright.
export async function sendInternal({ to, subject, html }) {
  if (!digestRecipients().includes(String(to || '').trim().toLowerCase())) {
    return { sent: false, reason: 'recipient not on the digest list' };
  }
  await deliver({ to, subject, html });
  return { sent: true };
}

// One plain-text note to the whole internal list, the shape every immediate
// notification uses: a reply triaged, a meeting booked, a handoff pack. A
// failure to one address never stops the others.
export async function sendTeamNote(subject, text) {
  let sent = 0;
  for (const to of digestRecipients()) {
    try { const r = await sendInternal({ to, subject, html: textToHtml(text) }); if (r.sent) sent++; }
    catch { /* the app still shows the state; mail is a convenience */ }
  }
  return sent;
}
