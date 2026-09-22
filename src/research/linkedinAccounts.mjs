import { pool, hasColumn } from '../db.mjs';
import { allCampaigns } from '../campaigns/registry.mjs';
import { accountForCampaign } from './unipile.mjs';

// Which LinkedIn account is whose, and how each one is doing. James's ask
// of 15 September 2026, after reconnecting his Unipile: the report should
// say which account is disconnected, not only that one is. The accounts are
// the ones the campaigns route through, each owned by the person the
// campaign definition names as its studio sender, and their health is read
// from the call ledger, where an account-health refusal is now recorded as
// unhealthy against the acting account. No new LinkedIn call anywhere here.

// The accounts the service knows, from the campaign map and the default,
// each with its owner and the lanes it carries.
export function knownAccounts() {
  const byId = new Map();
  for (const c of allCampaigns()) {
    if (c.status !== 'active') continue;
    const id = accountForCampaign(c.id);
    if (!id) continue;
    const entry = byId.get(id) || { accountId: id, owner: null, campaigns: [] };
    entry.campaigns.push({ id: c.id, name: c.displayName || c.id });
    if (!entry.owner && c.studio?.sender?.name) entry.owner = { name: c.studio.sender.name, title: c.studio.sender.title || null };
    byId.set(id, entry);
  }
  return [...byId.values()];
}

export function accountOwner(accountId) {
  return knownAccounts().find(a => a.accountId === String(accountId || ''))?.owner?.name || null;
}

// The account in words: whose it is and what it carries, so a note about it
// needs no id to make sense. Falls back to the id when nobody is named.
export function describeAccount(accountId) {
  const a = knownAccounts().find(x => x.accountId === String(accountId || ''));
  if (!a) return accountId ? `the LinkedIn account ${accountId}` : 'a LinkedIn account';
  const lanes = a.campaigns.map(c => c.name).join(' and ');
  return a.owner ? `${a.owner.name}'s LinkedIn account (${lanes})` : `the LinkedIn account carrying ${lanes}`;
}

// The team note for an account-health stop, one shape for every feature
// that stands itself down: which account, during what, the provider's
// words, and what to do.
export function unhealthyNote(during, message, accountId) {
  const who = describeAccount(accountId);
  const others = knownAccounts().filter(a => a.accountId !== String(accountId || ''));
  return `${who} reported an account health problem during ${during}, so that feature has switched itself off and nothing will retry.\n\n` +
    `${message}\n\nReconnect that account in Unipile (a login prompt or checkpoint usually explains it), then turn the switch back on from the Health page.` +
    (others.length ? ` The other account is unaffected and its lanes carry on.` : '');
}

// Each known account's last call and last outcome, from the ledger. An
// account whose last recorded call was refused as unhealthy is disconnected
// until a later call succeeds; one that has never been called is unknown.
export async function accountHealth() {
  const accounts = knownAccounts();
  if (!accounts.length) return [];
  const perAcct = await hasColumn('unipile_calls', 'account_id');
  if (!perAcct) return accounts.map(a => ({ ...a, state: 'unknown', lastOkAt: null, lastUnhealthyAt: null }));
  const { rows } = await pool.query(
    `SELECT account_id,
            max(called_at) FILTER (WHERE outcome = 'ok') AS last_ok,
            max(called_at) FILTER (WHERE outcome = 'unhealthy') AS last_unhealthy
     FROM unipile_calls WHERE account_id = ANY($1) GROUP BY account_id`, [accounts.map(a => a.accountId)]);
  return accounts.map(a => {
    const r = rows.find(x => x.account_id === a.accountId);
    const ok = r?.last_ok ? new Date(r.last_ok).getTime() : null;
    const bad = r?.last_unhealthy ? new Date(r.last_unhealthy).getTime() : null;
    const state = bad && (!ok || bad > ok) ? 'disconnected' : ok ? 'connected' : 'unknown';
    return { ...a, state, lastOkAt: r?.last_ok || null, lastUnhealthyAt: r?.last_unhealthy || null };
  });
}
