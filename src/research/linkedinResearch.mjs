// The LinkedIn research lane, Sales Navigator through Unipile. Research only,
// permanently: this module reads searches and profiles and writes to our own
// contacts table. It contains no messaging, no connection requests, no posting
// and no profile edits, and the client it uses exposes no write-capable route.
//
// Both capabilities respect the shared limiter in unipile.mjs: sequential
// calls, randomised delays, and the LINKEDIN_DAILY_CAP per UTC day.
import { pool } from '../db.mjs';
import { unipile, ROUTES, unipileConfigured, CapReached, AccountUnhealthy } from './unipile.mjs';
import { ORBIT_TITLES, inOrbit } from './orbitRules.mjs';

const accountId = () => process.env.UNIPILE_ACCOUNT_ID || '';
export const laneReady = () => unipileConfigured() && Boolean(accountId());

// The decision-makers we want are on UK builds, so a UK people search should
// not surface a hyperscaler's worldwide engineers. LinkedIn location strings
// are inconsistent (some name the country, some only a region like "Greater
// London"), so the test is layered: keep anything that names the UK, drop
// anything that names another country, and keep the rest. That cuts the clear
// global noise without losing a UK metro that omits the country, and it never
// mistakes Northern Ireland for the Republic. A blank location is kept, rather
// than lose a profile that hides its city. Configurable via LINKEDIN_COUNTRY;
// only UK is implemented, anything else passes everything through.
const COUNTRY = (process.env.LINKEDIN_COUNTRY || 'uk').toLowerCase();
const UK_LOCATION = /united kingdom|great britain|england|scotland|wales|northern ireland|\b(uk|u\.k\.)\b/i;
const FOREIGN_LOCATION = /\b(united states|usa|u\.s\.a|america|canada|ireland|germany|france|netherlands|belgium|luxembourg|spain|italy|portugal|switzerland|austria|poland|czech|sweden|norway|denmark|finland|india|pakistan|australia|new zealand|singapore|malaysia|japan|china|hong kong|korea|brazil|mexico|argentina|united arab emirates|uae|saudi|qatar|israel|south africa|nigeria|kenya|egypt)\b/i;
export function inTargetCountry(location) {
  if (COUNTRY !== 'uk') return true;
  if (!location) return true;
  if (UK_LOCATION.test(location)) return true;     // names the UK or a home nation
  if (FOREIGN_LOCATION.test(location)) return false; // names another country
  return true;                                       // ambiguous, keep
}

// ---- matching helpers, deliberately conservative ----

const COMPANY_SUFFIXES = new Set([
  'limited', 'ltd', 'plc', 'llp', 'uk', 'group', 'holdings',
  'international', 'operations', 'sarl', 'emea', 'company',
]);
// Core company tokens: strip legal and regional suffixes from the end only,
// so "Amazon Web Services EMEA SARL" becomes "amazon web services" rather
// than a gutted token soup. Dotted abbreviations collapse first, so
// "S.À.R.L." reads as one strippable token. People's profiles say
// "Ada Infrastructure", never the legal entity string.
export const coreTokens = name => {
  const toks = String(name || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[.'’]/g, '')
    .replace(/[^a-z0-9& ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  while (toks.length > 1 && COMPANY_SUFFIXES.has(toks[toks.length - 1])) toks.pop();
  return toks;
};
export const corePhrase = name => coreTokens(name).join(' ');

// First and last name only for searching: the register stores middle names
// and titles ("Heidi Alexa Durrant", "Jonathan, Lord Evans") that LinkedIn
// profiles rarely carry, and a quoted full register string finds nobody.
export function searchName(fullName) {
  const parts = String(fullName || '').split(/[\s,]+/).filter(Boolean);
  return parts.length >= 2 ? `${parts[0]} ${parts[parts.length - 1]}` : String(fullName || '');
}

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
    || item.current_positions?.[0]?.company_name || item.current_company
    || item.company || item.company_name || null;
  const url = item.public_profile_url || item.profile_url
    || (item.public_identifier ? `https://www.linkedin.com/in/${item.public_identifier}` : null);
  return {
    name, title, url,
    location: item.location || null,
    providerId: item.id || item.provider_id || null,
    publicIdentifier: item.public_identifier || null,
    positionCompany,
  };
}

// Profile retrieval, used only when a search result matches on name but shows
// no employer evidence. Headlines often omit the company ("Legal Director");
// the profile's work experience carries it, at the cost of one more call.
function profilePositions(p) {
  const arrays = [p?.work_experience, p?.experience, p?.positions, p?.current_positions]
    .filter(Array.isArray);
  return arrays.flat().map(x => ({
    company: x?.company || x?.company_name || x?.companyName || null,
    title: x?.position || x?.role || x?.title || null,
    current: x?.current ?? (x?.end == null && x?.end_date == null),
  }));
}

async function getProfile(identifier) {
  return unipile(ROUTES.profile, {
    pathSuffix: identifier,
    query: { account_id: accountId() },
    target: `profile: ${identifier}`,
  });
}

// A written title must read like a job title, not the company name. Heidi
// Durrant's headline is just "Ada Infrastructure"; writing that as her role
// is the wrong-title-on-a-real-name failure, worse than leaving the blank.
function looksLikeTitle(title, companyName) {
  const t = String(title || '').trim();
  if (t.length < 3) return false;
  const titleCore = coreTokens(t);
  if (!titleCore.length) return false;
  const compCore = new Set(coreTokens(companyName));
  return !titleCore.every(tok => compCore.has(tok)); // all-company-words is not a title
}

// Returns { evidence, title } for a candidate. Evidence requires the employer
// to be proven and a real job title to exist, from the search row or, failing
// that, one profile fetch of the person's positions. A headline that only
// names the company is not a title and yields no write. A failed fetch is no
// evidence: the row stays as register data rather than a guess.
async function verifyEmployer(companyName, candidate) {
  const rowText = [candidate.title, candidate.positionCompany].filter(Boolean).join(' | ');
  if (companyEvidence(companyName, rowText) && looksLikeTitle(candidate.title, companyName)) {
    return { evidence: true, title: candidate.title };
  }
  const identifier = candidate.providerId || candidate.publicIdentifier;
  if (!identifier) return { evidence: false, title: null };
  let profile = null;
  try { profile = await getProfile(identifier); }
  catch (e) {
    if (e instanceof CapReached || e instanceof AccountUnhealthy) throw e;
    return { evidence: false, title: null };
  }
  // A position at this company that also carries a real title, current first.
  const atCompany = profilePositions(profile).filter(po => companyEvidence(companyName, po.company || ''));
  const match = atCompany.find(po => po.current && looksLikeTitle(po.title, companyName))
    || atCompany.find(po => looksLikeTitle(po.title, companyName));
  return match ? { evidence: true, title: match.title } : { evidence: false, title: null };
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
  const keywords = `"${corePhrase(company.name)}" (${terms})`;
  // Over-fetch, then keep the UK ones, so the daily-capped single call still
  // returns a full batch after the global noise is dropped.
  const candidatePool = Math.min(Math.max(limit * 4, limit), 25);
  const found = await searchPeople(keywords, candidatePool, `findContacts: ${company.name}`);
  const uk = found.filter(c => inTargetCountry(c.location));

  const out = { available: true, contacts: [], created: 0, updated: 0, kept: 0, skipped: 0, filteredOutOfArea: found.length - uk.length };
  for (const c of uk.slice(0, limit)) {
    if (!c.url) { out.skipped++; continue; }
    // Drop a headline that is only the company name, so we never store it as a
    // role; the row keeps whatever real title it already had.
    const cleaned = { ...c, title: looksLikeTitle(c.title, company.name) ? c.title : null };
    const outcome = await upsertLinkedinContact(company.id, cleaned);
    out[outcome]++;
    out.contacts.push({ ...cleaned, outcome, orbit: inOrbit(cleaned.title) });
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
    const results = await searchPeople(`"${searchName(d.full_name)}" ${core}`, 3, `enrich: ${d.full_name} at ${company.name}`);
    out.searched++;

    // Name agreement first; then employer verification, going to the profile
    // when the search row alone cannot prove it. Exactly one verified person
    // may be written; two is ambiguity and none is an honest blank.
    const named = results.filter(r => namesMatch(d.full_name, r.name));
    const confident = [];
    for (const r of named) {
      const v = await verifyEmployer(company.name, r);
      if (v.evidence && v.title) confident.push({ ...r, title: v.title });
      if (confident.length > 1) break;
    }
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
