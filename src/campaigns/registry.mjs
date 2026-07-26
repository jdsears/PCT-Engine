import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The single reader of the campaigns directory, the configurator registry's
// pattern applied to campaigns. Pure filesystem, no model calls, no database
// and no imports from the answer or outbound layers, so every offline suite
// can load a campaign definition and prove behaviour without a connection.
//
// A campaign is data: what it sells, who it targets, which signals matter and
// how it opens. The machinery is shared. Adding a campaign is a file plus a
// positioning pack, never a second pipeline.

const CAMPAIGNS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'definitions');

let all = null;
function loadAll() {
  if (all) return all;
  all = readdirSync(CAMPAIGNS_DIR).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(join(CAMPAIGNS_DIR, f), 'utf8')))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return all;
}

// Every campaign, definition order irrelevant, sorted by id so listings and
// reports are stable.
export function allCampaigns() { return loadAll(); }

// One campaign by id, or null. Null is the honest answer for an unknown id;
// callers that must have one use requireCampaign.
export function getCampaign(id) {
  const key = String(id || '').trim().toLowerCase();
  if (!key) return null;
  return loadAll().find(c => String(c.id).toLowerCase() === key) || null;
}

// The strict form: an unknown campaign id is a programming error or a bad
// request, never something to paper over with a default, because defaulting
// would silently draft one campaign's positioning at another's leads.
export function requireCampaign(id) {
  const c = getCampaign(id);
  if (!c) throw new Error(`unknown campaign: ${JSON.stringify(String(id || ''))}`);
  return c;
}

// Ids of the campaigns that may run. A paused campaign stays loadable, so its
// existing leads and drafts still render, but the research and drafting loops
// skip it.
export function activeCampaignIds() {
  return loadAll().filter(c => c.status === 'active').map(c => c.id);
}

// For the UI switcher and any listing: id, name and status only.
export function listCampaigns() {
  return loadAll().map(c => ({ id: c.id, displayName: c.displayName, status: c.status }));
}
