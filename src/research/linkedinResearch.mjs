// The LinkedIn research lane, Sales Navigator through Unipile. Research only,
// permanently: this module reads searches and profiles and writes to our own
// contacts table. It contains no messaging, no connection requests, no posting
// and no profile edits, and the client it uses exposes no write-capable route.
//
// Both capabilities respect the shared limiter in unipile.mjs: sequential
// calls, randomised delays, and the LINKEDIN_DAILY_CAP per UTC day.
import { pool } from '../db.mjs';
import { unipile, ROUTES, unipileConfigured } from './unipile.mjs';
import { ORBIT_TITLES, inOrbit } from './orbitRules.mjs';

const accountId = () => process.env.UNIPILE_ACCOUNT_ID || '';
export const laneReady = () => unipileConfigured() && Boolean(accountId());

// ---- matching helpers, deliberately conservative ----

const COMPANY_SUFFIXES = new Set([
  'limited', 'ltd', 'plc', 'llp', 'uk', 'group', 'holdings', 'services',
  'international', 'operations', 'sarl', 's.a.r.l', 'emea', 'company',
]);
const coreTokens = name => String(name || '')
  .toLowerCase()
  .replace(/[^a-z0-9& ]+/g, ' ')
  .split(/\s+/)
  .filter(t => t && !COMPANY_SUFFIXES.has(t));

// True when the text carries real evidence of the company: the first core
// token plus at least one more (or all of a very short name).
function companyEvidence(companyName, text) {
  const core = coreTokens(companyName);
  if (!core.length) return false;
  const hay = String(text || '').toLowerCase();
  const hits = core.filter(t => hay.includes(t)).length;
  return hay.includes(core[0]) && hits >= Math.min(2, core.length);
}

const nameTokens = n => String(n || '')
  .toLowerCase()
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z' -]+/g, ' ')
  .split(/\s+/)
  .filter(Boolean);

// Surname must match exactly; first names may differ by initial or a shared
// prefix of three or more letters, which covers Chris versus Christopher.
function namesMatch(registerName, linkedinName) {
  const a = nameTokens(registerName), b = nameTokens(linkedinName);
  if (a.length < 2 || b.length < 2) return false;
  if (a[a.length - 1] !== b[b.length - 1]) return false;
  const af = a[0], bf = b[0];
  if (af === bf) return true;
  if (af[0] === bf[0] && (af.length === 1 || bf.length === 1)) return true;
  return Math.min(af.length, bf.length) >= 3 && (af.startsWith(bf) || bf.startsWith(af));
}

// ---- Unipile search, tolerant of small response-shape differences ----

function mapResult(item) {
  const name = item.name || [item.first_name, item.last_name].filter(Boolean).join(' ');
  const title = item.headline || item.title
    || item.current_positions?.[0]?.role || item.current_positions?.[0]?.title || null;
  const positionCompany = item.current_positions?.[0]?.company
    || item.current_positions?.[0]?.company_name || item.current_company || null;
  const url = item.public_profile_url || item.profile_url
    || (item.public_identifier ? `https://www.linkedin.com/in/${item.public_identifier}` : null);
  return {
    name, title, url,
    location: item.location || null,
    providerId: item.id || item.provider_id || null,
    positionCompany,
  };
}

async function searchPeople(keywords, limit, target) {
  const res = await unipile(ROUTES.search, {
    query: { account_id: accountId(), limit: String(limit) },
    body: { api: 'sales_navigator', category: 'people', keywords },
    target: target || keywords.slice(0, 120),
  });
  const items = Array.isArray(res?.items) ? res.items : [];
  return items.map(mapResult).filter(r => r.name);
}

// ---- contact writes, guarded by the freshness rule ----

// Only rows never enriched, or enriched more than thirty days ago, may be
// written. That protects human edits and recently filled rows alike.
const FRESH_DAYS = 30;
const isFresh = ts => ts && (Date.now() - new Date(ts).getTime()) < FRESH_DAYS * 86400000;

async function upsertLinkedinContact(companyId, c) {
  const { rows } = await pool.query(
    `SELECT id, enriched_at FROM contacts
     WHERE linkedin_url = $1 OR (company_id = $2 AND lower(full_name) = lower($3))
     ORDER BY (linkedin_url = $1) DESC LIMIT 1`,
    [c.url, companyId, c.name]);
  const payload = JSON.stringify({ linkedin: { location: c.location, provider_id: c.providerId } });

  if (rows.length) {
    if (isFresh(rows[0].enriched_at)) return 'kept';
    try {
      await pool.query(
        `UPDATE contacts SET
           role_title = COALESCE($1, role_title),
           linkedin_url = COALESCE(contacts.linkedin_url, $2),
           in_decision_orbit = COALESCE($3, in_decision_orbit),
           enriched_at = now(),
           payload = COALESCE(payload, '{}'::jsonb) || $4::jsonb
         WHERE id = $5`,
        [c.title, c.url, inOrbit(c.title), payload, rows[0].id]);
      return 'updated';
    } catch { return 'skipped'; }
  }
  try {
    await pool.query(
      `INSERT INTO contacts (company_id, full_name, role_title, linkedin_url, in_decision_orbit, source, payload, enriched_at)
       VALUES ($1, $2, $3, $4, $5, 'linkedin', $6::jsonb, now())`,
      [companyId, c.name, c.title, c.url, inOrbit(c.title), payload]);
    return 'created';
  } catch { return 'skipped'; } // unique collision with another row, leave it
}

// ---- the two capabilities ----

// Sales Navigator people search scoped to the company, keywords drawn from the
// orbit titles. Accepts the old (company, rolesArray) call shape as well as
// (company, { roles, limit }).
export async function findContacts(company, optsOrRoles = {}) {
  const opts = Array.isArray(optsOrRoles) ? { roles: optsOrRoles } : (optsOrRoles || {});
  const { roles = [], limit = 5 } = opts;
  if (!laneReady()) {
    console.log(`  LinkedIn lane not configured, skipping contact discovery for ${company.name}`);
    return { available: false, contacts: [] };
  }
  const terms = [...new Set([...roles, ...ORBIT_TITLES.slice(0, 8)])].map(t => `"${t}"`).join(' OR ');
  const keywords = `"${company.name}" (${terms})`;
  const found = await searchPeople(keywords, limit, `findContacts: ${company.name}`);

  const out = { available: true, contacts: [], created: 0, updated: 0, kept: 0, skipped: 0 };
  for (const c of found.slice(0, limit)) {
    if (!c.url) { out.skipped++; continue; }
    const outcome = await upsertLinkedinContact(company.id, c);
    out[outcome]++;
    out.contacts.push({ ...c, outcome, orbit: inOrbit(c.title) });
  }
  return out;
}

// Enrich the existing Companies House directors of one company with real job
// titles. A wrong title attached to a real register name is worse than a
// blank, so a write needs exactly one confident match: surname plus first
// name agreement, and company evidence in the title or current position.
export async function enrichDirectors(company) {
  if (!laneReady()) return { available: false, searched: 0, enriched: 0, left: 0, ambiguous: 0, examples: [] };
  const { rows: directors } = await pool.query(
    `SELECT id, full_name, role_title, in_decision_orbit, enriched_at FROM contacts
     WHERE company_id = $1 AND source = 'ch_officers' AND NOT suppressed
       AND (enriched_at IS NULL OR enriched_at < now() - interval '30 days')
     ORDER BY in_decision_orbit DESC NULLS LAST, full_name`, [company.id]);

  const out = { available: true, searched: 0, enriched: 0, left: 0, ambiguous: 0, examples: [] };
  const core = coreTokens(company.name).slice(0, 3).join(' ');

  for (const d of directors) {
    const results = await searchPeople(`"${d.full_name}" ${core}`, 3, `enrich: ${d.full_name} at ${company.name}`);
    out.searched++;
    const confident = results.filter(r =>
      namesMatch(d.full_name, r.name) &&
      companyEvidence(company.name, [r.title, r.positionCompany].filter(Boolean).join(' | ')) &&
      r.title);
    if (confident.length !== 1) {
      if (confident.length > 1) out.ambiguous++;
      out.left++;
      console.log(`  ${d.full_name}: ${confident.length === 0 ? 'no' : confident.length} confident match${confident.length > 1 ? 'es' : ''}, left untouched`);
      continue;
    }
    const m = confident[0];
    const orbit = inOrbit(m.title);
    try {
      await pool.query(
        `UPDATE contacts SET
           role_title = $1,
           linkedin_url = COALESCE($2, linkedin_url),
           in_decision_orbit = COALESCE($3, in_decision_orbit),
           enriched_at = now(),
           payload = COALESCE(payload, '{}'::jsonb) || $4::jsonb
         WHERE id = $5 AND (enriched_at IS NULL OR enriched_at < now() - interval '30 days')`,
        [m.title, m.url, orbit,
         JSON.stringify({ linkedin: { location: m.location, provider_id: m.providerId } }), d.id]);
      out.enriched++;
      out.examples.push({ name: d.full_name, oldRole: d.role_title, newTitle: m.title, orbit });
    } catch (e) {
      out.left++;
      console.log(`  update failed for ${d.full_name}: ${String(e.message).slice(0, 100)}`);
    }
  }
  return out;
}
