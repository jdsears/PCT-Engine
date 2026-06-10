import { graphJson } from './msgraph.mjs';

// Sends as the engine mailbox. Refuses unless the kill switch is explicitly off.
export async function sendMail({ to, subject, html }) {
  if ((process.env.MAIL_KILL_SWITCH || 'on') !== 'off') {
    return { sent: false, reason: 'kill switch on' };
  }
  await graphJson(`/users/${process.env.ENGINE_MAILBOX}/sendMail`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message: { subject, body: { contentType: 'HTML', content: html }, toRecipients: [{ emailAddress: { address: to } }] },
      saveToSentItems: true,
    }),
  });
  return { sent: true };
}
