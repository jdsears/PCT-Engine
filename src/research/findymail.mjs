import { pool } from '../db.mjs';

// Findymail client. Credits cost money, so every call is logged, a counter is
// kept for run reports, a contact with a verified email is never looked up
// again, and a miss is recorded on the contact row so the next run stands the
// contact down instead of re-buying the same miss.
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
      Authorization: `Bearer ${(process.env.FINDYMAIL_API_KEY || '').trim()}`,
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
  if (!found) {
    // A miss costs credits too. John's first live spend showed the leak:
    // fifteen not-founds at the highest scores, and nothing recorded, so
    // every later run would have re-bought the same misses first, forever.
    // The stamp lets the selection stand a missed contact down for a
    // quarter; people move and mailboxes appear, so a retry eventually
    // makes sense, just not four times a day.
    await pool.query(
      `UPDATE contacts SET payload = COALESCE(payload, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
      [contact.id, JSON.stringify({ email_lookup: { at: new Date().toISOString(), outcome: 'not_found' } })]);
    return { skipped: 'not found' };
  }
  await pool.query(
    `UPDATE contacts SET email = $1, email_confidence = $2, email_verified_at = now() WHERE id = $3`,
    [found.email, found.confidence, contact.id]);
  return { email: found.email };
}
