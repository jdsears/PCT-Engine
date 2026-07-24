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
import { pool } from '../db.mjs';

const DSN = (process.env.UNIPILE_DSN || '').replace(/\/+$/, '');
const KEY = process.env.UNIPILE_API_KEY || '';
const CAP = Math.max(1, parseInt(process.env.LINKEDIN_DAILY_CAP || '40', 10));

// The research lane uses only the read routes. The single write route, invite,
// belongs to the studio's human-approved connect queue and nothing else; the
// enrichment and research code never calls it.
export const ROUTES = {
  listAccounts: { method: 'GET', path: '/api/v1/accounts' },
  search: { method: 'POST', path: '/api/v1/linkedin/search' }, // ?account_id=&limit=
  profile: { method: 'GET', path: '/api/v1/users' },           // /{identifier}?account_id=
  invite: { method: 'POST', path: '/api/v1/users/invite' },    // { account_id, provider_id, message }
  createPost: { method: 'POST', path: '/api/v1/posts' },       // { account_id, text }; per Unipile docs, unverifiable without posting, so the first human-approved post is its live test
};

export const unipileConfigured = () => Boolean(DSN && KEY);
export const dailyCap = () => CAP;

export class CapReached extends Error {}
export class AccountUnhealthy extends Error {}

export async function callsUsedToday() {
  try {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM unipile_calls
       WHERE (called_at AT TIME ZONE 'UTC')::date = (now() AT TIME ZONE 'UTC')::date`);
    return rows[0].n;
  } catch (e) {
    if (/relation "unipile_calls" does not exist/i.test(String(e))) {
      throw new Error('unipile_calls table missing. Run npm run migrate first.');
    }
    throw e;
  }
}

async function log(endpoint, target, outcome) {
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

async function doCall(route, { pathSuffix = '', query = {}, body, target } = {}) {
  if (!unipileConfigured()) throw new Error('UNIPILE_DSN and UNIPILE_API_KEY are not set');
  const endpoint = `${route.method} ${route.path}${pathSuffix ? '/{id}' : ''}`;

  const used = await callsUsedToday();
  if (used >= CAP) {
    await log(endpoint, target, 'refused_cap');
    throw new CapReached(`daily cap reached: ${used} of ${CAP} Unipile calls used today (UTC). Stopping cleanly.`);
  }
  if (calledBefore) await sleep(4000 + Math.floor(Math.random() * 5001));
  calledBefore = true;

  const qs = new URLSearchParams(query).toString();
  const url = `${DSN}${route.path}${pathSuffix ? '/' + encodeURIComponent(pathSuffix) : ''}${qs ? '?' + qs : ''}`;

  let res;
  try {
    res = await fetch(url, {
      method: route.method,
      headers: {
        'X-API-KEY': KEY,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    await log(endpoint, target, 'network_error');
    throw new Error(`Unipile unreachable at ${DSN}: ${e.message}. Check UNIPILE_DSN.`);
  }

  const text = await res.text();
  await log(endpoint, target, res.ok ? 'ok' : `http_${res.status}`);

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
