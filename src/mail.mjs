import { graphJson } from './msgraph.mjs';

// Two send paths, two independent gates. A real prospect send is governed by the
// production kill switch and stays off by default. An internal test send is
// governed by its own switch and a strict allowlist, never by the kill switch, so
// the send mechanism can be exercised end to end during the testing window with
// no chance of reaching a prospect.

// The internal test-recipient allowlist, lower-cased for comparison.
function testRecipients() {
  return (process.env.OUTBOUND_TEST_RECIPIENTS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}
export function testRecipientList() {
  return testRecipients();
}
export function isTestRecipient(addr) {
  return testRecipients().includes(String(addr || '').trim().toLowerCase());
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

// Real prospect send. Refuses unless the kill switch is explicitly off. This is
// the production gate and stays on by default.
export async function sendMail({ to, subject, html }) {
  if ((process.env.MAIL_KILL_SWITCH || 'on') !== 'off') {
    return { sent: false, reason: 'kill switch on' };
  }
  await deliver({ to, subject, html });
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
