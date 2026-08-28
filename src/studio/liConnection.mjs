import { pool, hasColumn } from '../db.mjs';
import { unipile, ROUTES, accountForCampaign, CapReached, AccountUnhealthy } from '../research/unipile.mjs';
import { linkedinSlug } from './liInvite.mjs';

// Did they accept? A read on our own invitee's profile through the account
// that invited them, which is the same call the invite itself makes to
// resolve the profile, so no new permission and no new route.
//
// This exists because a direct message only reaches a first-degree
// connection. Without it the message stage would be a guess: we would either
// message into the void or hold a lead forever waiting for an acceptance
// nobody can see. The analytics page said invite acceptance was not
// observable and refused to guess; this is that gap closed properly.

// LinkedIn's degree, read defensively: providers spell it network_distance,
// distance or relationship, with values like FIRST_DEGREE, DISTANCE_1 or a
// bare 1. Anything unrecognised is unknown, never a false accept, because a
// false accept would send a message that cannot arrive.
export function networkDistance(profile) {
  const raw = profile?.network_distance ?? profile?.networkDistance
    ?? profile?.distance ?? profile?.relationship ?? profile?.degree ?? null;
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const s = String(raw).toUpperCase();
  if (/(^|[^A-Z])(FIRST|1ST)([^A-Z]|$)|DISTANCE_1|^1$|^D1$/.test(s)) return 1;
  if (/(SECOND|2ND)|DISTANCE_2|^2$/.test(s)) return 2;
  if (/(THIRD|3RD)|DISTANCE_3|^3$/.test(s)) return 3;
  if (/OUT_OF_NETWORK|DISTANCE_OUT/.test(s)) return 99;
  if (/SELF|DISTANCE_SELF/.test(s)) return 0;
  return null;
}
export const isConnected = profile => networkDistance(profile) === 1;

// How long to keep asking, and how often. An invitation sits unanswered for
// all sorts of ordinary reasons; after the window the answer is simply no and
// the sequence moves on rather than holding a lead open forever.
export const connectionCheckDays = () => Math.max(1, parseInt(process.env.LI_CONNECTION_CHECK_DAYS || '21', 10) || 21);
export const CONNECTION_RECHECK_HOURS = 20;

// Whether this contact is worth a check now: invited, not already known
// connected, inside the window, and not checked in the last day. Pure, so the
// politeness is provable without a provider.
export function checkDue({ invitedAt, connectedAt = null, checkedAt = null, now = Date.now(),
                           windowDays = connectionCheckDays() } = {}) {
  if (connectedAt) return false;
  const inv = new Date(invitedAt).getTime();
  if (Number.isNaN(inv)) return false;
  if (now - inv > windowDays * 86_400_000) return false;
  if (!checkedAt) return true;
  const last = new Date(checkedAt).getTime();
  if (Number.isNaN(last)) return true;
  return now - last >= CONNECTION_RECHECK_HOURS * 3_600_000;
}

// One sweep: a small batch of invitees per pass, oldest invitation first,
// through the campaign's own account and the shared capped queue. Every
// contact is stamped as checked whatever the answer, so nobody is knocked
// twice in a day, and an accepted invitation records when we learned it.
export async function sweepConnectionsOnce({ limit = 5, log = () => {} } = {}) {
  const out = { checked: 0, connected: 0 };
  if (!(await hasColumn('contacts', 'li_connected_at'))) {
    return { ...out, skipped: 'the connection columns are missing; run npm run migrate first' };
  }
  const { rows } = await pool.query(
    `SELECT ct.id, ct.full_name, ct.linkedin_url, ct.li_invited_at, ct.li_connection_checked_at,
            (CASE WHEN array_length(m.memberships, 1) = 1 THEN m.memberships[1] ELSE 'marwin_dc' END) AS campaign
     FROM contacts ct JOIN companies c ON c.id = ct.company_id
     CROSS JOIN LATERAL (
       SELECT (SELECT array_agg(cc.campaign ORDER BY cc.campaign) FROM company_campaigns cc
               WHERE cc.company_id = c.id) AS memberships
     ) m
     WHERE ct.li_invited_at IS NOT NULL AND ct.li_connected_at IS NULL
       AND NOT ct.suppressed AND NOT ct.rehearsal AND ct.linkedin_url IS NOT NULL
     ORDER BY ct.li_invited_at ASC LIMIT 40`);
  for (const r of rows) {
    if (out.checked >= limit) break;
    if (!checkDue({ invitedAt: r.li_invited_at, checkedAt: r.li_connection_checked_at })) continue;
    const slug = linkedinSlug(r.linkedin_url);
    if (!slug) continue;
    const accountId = accountForCampaign(r.campaign);
    if (!accountId) continue;
    try {
      const profile = await unipile(ROUTES.profile, {
        pathSuffix: slug, query: { account_id: accountId }, target: `connection check ${slug}`,
      });
      out.checked++;
      const connected = isConnected(profile);
      await pool.query(
        `UPDATE contacts SET li_connection_checked_at = now()${connected ? ', li_connected_at = now()' : ''} WHERE id = $1`,
        [r.id]);
      if (connected) {
        out.connected++;
        log(`${r.full_name} accepted the invitation (${r.campaign})`);
      }
    } catch (e) {
      if (e instanceof CapReached) break;
      if (e instanceof AccountUnhealthy) { out.unhealthy = String(e.message).slice(0, 300); break; }
      // A profile that cannot be read is not a verdict: stamp the check so
      // the sweep moves on, and try again after the recheck interval.
      await pool.query(`UPDATE contacts SET li_connection_checked_at = now() WHERE id = $1`, [r.id]);
      log(`connection check failed for ${r.full_name}: ${String(e.message).slice(0, 120)}`);
    }
  }
  return out;
}
