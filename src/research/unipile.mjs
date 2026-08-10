// Unipile client. The research lane remains read-only: discovery and
// enrichment never message, post, or edit anything on LinkedIn. One write
// route now exists, invite, added in July 2026 on John's direction with
// James's consent for the studio's connect queue: a connection request sends
// only when a person clicks Send invite on one named contact, never in a
// batch, capped per day, and any account-health error stops everything with no
// retry. Auth is an X-API-KEY header against the account's DSN base URL.
//
// Route provenance: the build environment cannot reach developer.unipile.com
// (egress allowlist), so these routes follow the Unipile API as documented in
// early 2026. They are centralised here so a correction is a one-line edit,
// and scripts/unipile-check.mjs verifies the read routes against the live API;
// the invite route is verified by its first supervised live use.
import { pool, hasColumn } from '../db.mjs';

const DSN = (process.env.UNIPILE_DSN || '').replace(/\/+$/, '');
const KEY = process.env.UNIPILE_API_KEY || '';
const CAP = Math.max(1, parseInt(process.env.LINKEDIN_DAILY_CAP || '40', 10));

// Which connected LinkedIn account carries a campaign's writes and reads.
// UNIPILE_CAMPAIGN_ACCOUNTS is a JSON map of campaign id to Unipile account
// id, set when Andy's account joined James's in August 2026 so pharma posts
// and invites go through Andy's profile while the data centre lane stays on
// James's. A campaign not in the map, an empty map, or a malformed value all
// fall back to UNIPILE_ACCOUNT_ID, so one-account services behave exactly as
// before.
let warnedBadMap = false;
export function accountForCampaign(campaign) {
  const raw = process.env.UNIPILE_CAMPAIGN_ACCOUNTS || '';
  if (raw) {
    try {
      const id = JSON.parse(raw)[String(campaign || '')];
      if (id) return String(id);
    } catch {
      if (!warnedBadMap) { console.warn('UNIPILE_CAMPAIGN_ACCOUNTS is not valid JSON; using UNIPILE_ACCOUNT_ID for every campaign.'); warnedBadMap = true; }
    }
  }
  return process.env.UNIPILE_ACCOUNT_ID || '';
}

// The research lane uses only the read routes. The single write route, invite,
// belongs to the studio's human-approved connect queue and nothing else; the
// enrichment and research code never calls it.
export const ROUTES = {
  listAccounts: { method: 'GET', path: '/api/v1/accounts' },
  search: { method: 'POST', path: '/api/v1/linkedin/search' }, // ?account_id=&limit=
  profile: { method: 'GET', path: '/api/v1/users' },           // /{identifier}?account_id=
  invite: { method: 'POST', path: '/api/v1/users/invite' },    // { account_id, provider_id, message }
  createPost: { method: 'POST', path: '/api/v1/posts' },       // multipart form fields account_id and text; the endpoint's own 400 echoed a file-upload schema at JSON, which is how the shape was pinned down without posting
  // Who reacted to a post: GET /api/v1/posts/{post_id}/reactions, a read on
  // our own published posts through the connected account, the same thing a
  // person sees under their post. rawSuffix carries the nested path.
  listPostReactions: { method: 'GET', path: '/api/v1/posts' },
};

export const unipileConfigured = () => Boolean(DSN && KEY);
export const dailyCap = () => CAP;

export class CapReached extends Error {}
export class AccountUnhealthy extends Error {}

// Calls made today, per connected account when both the ledger column
// (migration 028) and the acting account are known, because LinkedIn's
// tolerance is per profile: with James's and Andy's accounts each carrying
// their own campaign, one cap shared between them would halve both for no
// safety gain. Absent either, the shared count stands, the conservative
// direction.
export async function callsUsedToday(accountId = null) {
  try {
    const perAccount = accountId && await hasColumn('unipile_calls', 'account_id');
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM unipile_calls
       WHERE (called_at AT TIME ZONE 'UTC')::date = (now() AT TIME ZONE 'UTC')::date
       ${perAccount ? 'AND account_id = $1' : ''}`, perAccount ? [accountId] : []);
    return rows[0].n;
  } catch (e) {
    if (/relation "unipile_calls" does not exist/i.test(String(e))) {
      throw new Error('unipile_calls table missing. Run npm run migrate first.');
    }
    throw e;
  }
}

async function log(endpoint, target, outcome, accountId = null) {
  // The account column arrived with the second connected account (migration
  // 028); until the schema has it the ledger keeps its old shape.
  if (accountId && await hasColumn('unipile_calls', 'account_id')) {
    await pool.query(
      `INSERT INTO unipile_calls (endpoint, target, outcome, account_id) VALUES ($1, $2, $3, $4)`,
      [endpoint, target ?? null, outcome, accountId]);
    return;
  }
  await pool.query(
    `INSERT INTO unipile_calls (endpoint, target, outcome) VALUES ($1, $2, $3)`,
    [endpoint, target ?? null, outcome]);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
let queue = Promise.resolve();
let calledBefore = false;

// Every call joins one queue, so calls are sequential by construction, with a
// randomised 4 to 9 second pause between them and the UTC-day cap checked
// before each one. On a cap refusal the refusal itself is logged.
export function unipile(route, opts = {}) {
  const task = queue.then(() => doCall(route, opts));
  queue = task.then(() => {}, () => {});
  return task;
}

async function doCall(route, { pathSuffix = '', rawSuffix = false, query = {}, body, form, target } = {}) {
  if (!unipileConfigured()) throw new Error('UNIPILE_DSN and UNIPILE_API_KEY are not set');
  const endpoint = `${route.method} ${route.path}${pathSuffix ? '/{id}' : ''}`;
  // The acting account, read from wherever the call carries it, so the ledger
  // learns it without every call site changing.
  const acct = query?.account_id || form?.account_id || body?.account_id || null;

  const used = await callsUsedToday(acct);
  if (used >= CAP) {
    await log(endpoint, target, 'refused_cap', acct);
    throw new CapReached(`daily cap reached${acct ? ' for this account' : ''}: ${used} of ${CAP} Unipile calls used today (UTC). Stopping cleanly.`);
  }
  if (calledBefore) await sleep(4000 + Math.floor(Math.random() * 5001));
  calledBefore = true;

  const qs = new URLSearchParams(query).toString();
  // rawSuffix is for nested paths like {id}/reactions: the caller encodes the
  // id itself and the path structure passes through intact.
  const url = `${DSN}${route.path}${pathSuffix ? '/' + (rawSuffix ? pathSuffix : encodeURIComponent(pathSuffix)) : ''}${qs ? '?' + qs : ''}`;

  // A form option sends multipart/form-data (fetch sets the boundary
  // itself, so no content-type header here); body stays JSON as before.
  let fetchBody;
  const headers = { 'X-API-KEY': KEY, accept: 'application/json' };
  if (form) {
    fetchBody = new FormData();
    for (const [k, v] of Object.entries(form)) fetchBody.append(k, String(v));
  } else if (body) {
    headers['content-type'] = 'application/json';
    fetchBody = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, { method: route.method, headers, body: fetchBody });
  } catch (e) {
    await log(endpoint, target, 'network_error', acct);
    throw new Error(`Unipile unreachable at ${DSN}: ${e.message}. Check UNIPILE_DSN.`);
  }

  const text = await res.text();
  await log(endpoint, target, res.ok ? 'ok' : `http_${res.status}`, acct);

  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }

  if (!res.ok) {
    // Account-health failures stop the run, no retry: the account is the asset.
    const probe = (JSON.stringify(json) || text || '').toLowerCase();
    if (/checkpoint|disconnected|relogin|credentials.*(expired|invalid)|account.*restricted/.test(probe)) {
      throw new AccountUnhealthy(`Unipile reports an account health problem (${res.status}): ${text.slice(0, 300)}`);
    }
    const err = new Error(`Unipile ${res.status} on ${route.method} ${route.path}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// Helpers over the accounts list shape: tolerate items at the top level or
// under items, and status either on the account or its first source.
export function accountsList(json) {
  return Array.isArray(json?.items) ? json.items : Array.isArray(json) ? json : [];
}
export function linkedinAccounts(json) {
  return accountsList(json).filter(a => String(a.type || a.provider || '').toUpperCase() === 'LINKEDIN');
}
export function accountStatus(account) {
  return account?.sources?.[0]?.status || account?.status || 'UNKNOWN';
}
