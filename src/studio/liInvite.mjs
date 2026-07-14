import { pool } from '../db.mjs';
import { unipile, ROUTES, unipileConfigured } from '../research/unipile.mjs';

// The one sanctioned LinkedIn write: a connection invite, sent only when a
// person clicks Send invite on one named contact in the studio, authorised by
// John with James's consent. Every send goes through the shared Unipile queue,
// so it is sequential, paced, ledgered against the daily call cap, and an
// account-health error stops everything with no retry. On top of that sits a
// stricter invites-per-day cap, because invitations are the touchiest LinkedIn
// action of all.

export const inviteDailyCap = () => Math.max(1, parseInt(process.env.LINKEDIN_INVITE_DAILY_CAP || '10', 10));

export function inviteReady() {
  return unipileConfigured() && Boolean(process.env.UNIPILE_ACCOUNT_ID);
}

// The public identifier from a profile URL: linkedin.com/in/<slug>.
export function linkedinSlug(url) {
  const m = String(url || '').match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]).trim() : null;
}

// Pure eligibility, provable offline: orbit hygiene the send route enforces
// before any network call.
export function canInvite(contact) {
  if (!contact) return { ok: false, reason: 'no such contact' };
  if (contact.suppressed) return { ok: false, reason: 'the contact is suppressed' };
  if (contact.li_invited_at) return { ok: false, reason: 'already invited' };
  if (!linkedinSlug(contact.linkedin_url)) return { ok: false, reason: 'no usable LinkedIn profile URL on file' };
  return { ok: true };
}

// Successful invites sent today (UTC), from the shared call ledger.
export async function invitesUsedToday() {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM unipile_calls
     WHERE endpoint = 'POST /api/v1/users/invite' AND outcome = 'ok'
       AND (called_at AT TIME ZONE 'UTC')::date = (now() AT TIME ZONE 'UTC')::date`);
  return rows[0].n;
}

// Resolve the profile to its provider id, then send the invite with the note.
// Two Unipile calls, both through the queue and both ledgered.
export async function sendConnectionInvite(contact, note) {
  const slug = linkedinSlug(contact.linkedin_url);
  const accountId = process.env.UNIPILE_ACCOUNT_ID;
  const profile = await unipile(ROUTES.profile, { pathSuffix: slug, query: { account_id: accountId }, target: slug });
  const providerId = profile?.provider_id || profile?.member_id || profile?.id || null;
  if (!providerId) return { sent: false, reason: 'could not resolve the LinkedIn profile to an id' };
  const message = String(note || '').slice(0, 300);
  await unipile(ROUTES.invite, {
    body: { account_id: accountId, provider_id: providerId, ...(message ? { message } : {}) },
    target: slug,
  });
  return { sent: true };
}
