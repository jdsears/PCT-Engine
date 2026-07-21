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
// both politer and clearer under PECR. A regional sender carries its rep's
// name and title; otherwise SENDER_SIGNATURE overrides the whole block when
// set, and the block is built from the SENDER_* parts. The opt-out line is
// always appended to prospect mail: an opt-out we invite is an opt-out we can
// honour, and the triage path suppresses the contact when one arrives.
export function signatureBlock(sender = null) {
  if (!sender) {
    const custom = String(process.env.SENDER_SIGNATURE || '').trim();
    if (custom) return custom;
  }
  const name = String(sender?.name || process.env.SENDER_NAME || '').trim();
  const title = String(sender?.title || (sender ? '' : process.env.SENDER_TITLE) || '').trim();
  const lines = [];
  if (name) lines.push(name);
  if (title) lines.push(title);
  lines.push('Premier Control Technologies');
  const address = String(process.env.SENDER_ADDRESS || '').trim();
  if (address) lines.push(address);
  lines.push('pctflow.com');
  return lines.join('\n');
}

const OPT_OUT = 'If this is not relevant to you, reply no thanks and I will not write again.';

export function withFooter(text, sender = null) {
  return `${String(text || '').trim()}\n\n${signatureBlock(sender)}\n\n${OPT_OUT}`;
}

// Plain text to a simple, safe HTML body: escape, keep blank-line paragraphs
// and single line breaks, and turn bare URLs into real links so a booking
// link arrives clickable everywhere rather than relying on the client.
const URL_RE = /https?:\/\/[^\s<>"')]+/g;
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function inlineHtml(s) {
  let out = '';
  let last = 0;
  for (const m of String(s).matchAll(URL_RE)) {
    out += escapeHtml(s.slice(last, m.index));
    const url = m[0];
    out += `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`;
    last = m.index + url.length;
  }
  out += escapeHtml(s.slice(last));
  return out;
}
export function textToHtml(text) {
  return String(text || '').trim().split(/\n{2,}/)
    .map(p => `<p>${inlineHtml(p).replace(/\n/g, '<br>')}</p>`).join('\n');
}

// The full prospect email body: the draft as written, then the signature and
// opt-out rendered quietly, smaller and greyer under a light rule, so the
// email reads as a person's note with a tidy footer rather than three stacked
// paragraphs of the same weight.
export function prospectHtml(bodyText, sender = null) {
  const footer = `${signatureBlock(sender)}\n\n${OPT_OUT}`;
  return `${textToHtml(bodyText)}\n<div style="margin-top:16px;padding-top:10px;border-top:1px solid #d9dee4;color:#5a6b7a;font-size:13px;">${textToHtml(footer)}</div>`;
}

// The mailbox a send goes from: the regional sender's when one is given, the
// engine mailbox otherwise.
const fromMailbox = from => String(from || process.env.ENGINE_MAILBOX || '').trim();

// The actual Graph send. Private: both public paths must gate before reaching it.
async function deliver({ to, subject, html, from = null }) {
  await graphJson(`/users/${fromMailbox(from)}/sendMail`, {
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
async function deliverTracked({ to, subject, html, from = null }) {
  const mb = fromMailbox(from);
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
export async function sendMail({ to, subject, html, from = null }) {
  if (blockedByKillSwitch(to)) {
    return { sent: false, reason: 'kill switch on' };
  }
  const ids = await deliverTracked({ to, subject, html, from });
  return { sent: true, ...ids };
}

// Threaded reply to an inbound prospect message, for the response drafts. Graph
// places our text above the quoted thread and sends in the same conversation,
// exactly as a human reply would look. Gated by the same kill switch rule as
// any other prospect send; `to` is the recipient on record, used only for that
// gate since Graph derives the actual recipient from the thread. Returns no
// message ids (Graph's reply endpoint sends immediately); the conversation id
// on the inbound message already correlates.
export async function sendMailReply({ inboundMessageId, html, to, from = null }) {
  if (blockedByKillSwitch(to)) {
    return { sent: false, reason: 'kill switch on' };
  }
  // The reply must go through the mailbox the inbound message lives in; a
  // Graph message id means nothing in any other mailbox.
  await graphJson(`/users/${fromMailbox(from)}/messages/${inboundMessageId}/reply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ comment: html }),
  });
  return { sent: true };
}

// Internal test send. Refuses unless test sends are explicitly enabled and the
// recipient is on the internal allowlist, so it can never reach a prospect even
// when the production kill switch is off.
export async function sendMailTest({ to, subject, html, from = null }) {
  if ((process.env.OUTBOUND_TEST_SENDS || 'off') !== 'on') {
    return { sent: false, reason: 'test sends disabled' };
  }
  if (!isTestRecipient(to)) {
    return { sent: false, reason: 'recipient not on the internal allowlist' };
  }
  await deliver({ to, subject, html, from });
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
