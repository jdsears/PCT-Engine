import { pool, hasColumn } from '../db.mjs';
import { unipile, ROUTES, unipileConfigured, accountForCampaign } from '../research/unipile.mjs';

// The connection invite, the lane's touchiest write. Sent on one named
// contact only, authorised by John with James's consent, and always resting
// on a human decision: the Send invite click, or, since 24 August 2026 and
// John's drip decision, an approval recorded ahead of time that the drip
// releases within its own tighter caps (inviteDrip.mjs). Nothing unapproved
// ever invites. Every send goes through the shared Unipile queue, so it is
// sequential, paced, ledgered against the daily call cap, and an
// account-health error stops everything with no retry. On top of that sits a
// stricter invites-per-day cap, because invitations are the touchiest
// LinkedIn action of all.

export const inviteDailyCap = () => Math.max(1, parseInt(process.env.LINKEDIN_INVITE_DAILY_CAP || '10', 10));

export function inviteReady() {
  return unipileConfigured() && Boolean(process.env.UNIPILE_ACCOUNT_ID);
}

// LinkedIn's own refusals, translated where translation earns its place. The
// one that matters says an invitation is already pending with this person,
// usually sent by hand outside the engine's books; the honest response is to
// record that truth and let the queue move on, not to error at the same name
// on every click. Learned live when Darryn Power sat in the queue refusing
// with a raw 422 each time James pressed Send invite.
export function inviteRefusal(e) {
  if (e?.status === 422 && /already_invited_recently/i.test(String(e.message))) {
    return {
      alreadyInvited: true,
      reason: 'LinkedIn reports an invitation is already pending with this person, sent at some point outside the engine. Recorded, so the queue will not offer them again; the connection completes whenever they accept.',
    };
  }
  return null;
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

// Successful invites sent today (UTC), from the shared call ledger. Per
// connected account when the ledger can say (migration 028), because the
// invite tolerance is per LinkedIn profile; before the column exists, or
// with no account given, the shared count stands, the conservative
// direction.
export async function invitesUsedToday(accountId = null) {
  const perAccount = accountId && await hasColumn('unipile_calls', 'account_id');
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM unipile_calls
     WHERE endpoint = 'POST /api/v1/users/invite' AND outcome = 'ok'
       AND (called_at AT TIME ZONE 'UTC')::date = (now() AT TIME ZONE 'UTC')::date
       ${perAccount ? 'AND account_id = $1' : ''}`, perAccount ? [accountId] : []);
  return rows[0].n;
}

// Resolve the profile to its provider id, then send the invite with the note.
// Two Unipile calls, both through the queue and both ledgered. The account is
// the campaign's own, so a pharma invite goes from Andy's profile and a data
// centre one from James's.
export async function sendConnectionInvite(contact, note, { accountId = process.env.UNIPILE_ACCOUNT_ID } = {}) {
  const slug = linkedinSlug(contact.linkedin_url);
  if (!accountId) return { sent: false, reason: 'no LinkedIn account is configured for this campaign' };
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
