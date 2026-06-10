import { pool } from '../db.mjs';

// Findymail client. Credits cost money, so every call is logged, a counter is
// kept for run reports, and a contact with a verified email is never looked up
// again.
const BASE = 'https://app.findymail.com/api';
let creditsSpent = 0;
export const getCreditsSpent = () => creditsSpent;
export const resetCreditsSpent = () => { creditsSpent = 0; };

async function fm(path, body) {
  creditsSpent++;
  console.log(`  Findymail call: ${path}`);
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.FINDYMAIL_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Findymail ${res.status} on ${path}: ${await res.text()}`);
  return res.json();
}

export async function findFromLinkedin(linkedinUrl) {
  const json = await fm('/search/linkedin', { linkedin_url: linkedinUrl });
  const email = json?.contact?.email || json?.email || null;
  if (!email) return null;
  return { email, confidence: json?.contact?.confidence ?? json?.confidence ?? null };
}

export async function findFromNameDomain(fullName, domain) {
  const json = await fm('/search/name', { name: fullName, domain });
  const email = json?.contact?.email || json?.email || null;
  if (!email) return null;
  return { email, confidence: json?.contact?.confidence ?? json?.confidence ?? null };
}

export async function verifyEmail(email) {
  const json = await fm('/verify', { email });
  return { verified: json?.verified ?? json?.is_valid ?? false, raw: json };
}

// Resolves an email for a contact row and writes it back. Skips, without
// spending a credit, when the contact already has a verified email.
export async function ensureContactEmail(contact, companyDomain) {
  if (contact.email && contact.email_verified_at) return { skipped: 'already verified' };
  let found = null;
  if (contact.linkedin_url) found = await findFromLinkedin(contact.linkedin_url);
  if (!found && contact.full_name && companyDomain) found = await findFromNameDomain(contact.full_name, companyDomain);
  if (!found) return { skipped: 'not found' };
  await pool.query(
    `UPDATE contacts SET email = $1, email_confidence = $2, email_verified_at = now() WHERE id = $3`,
    [found.email, found.confidence, contact.id]);
  return { email: found.email };
}
