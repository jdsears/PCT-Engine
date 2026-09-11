import { pool, hasColumn } from '../db.mjs';
import { politeFetch, getRobots, robotsAllows, HostPacer } from '../web/fetch.mjs';
import { extractPage, canonicalUrl, sameHost, hostOf, isAssetUrl, isDocUrl, decodeEntities } from '../web/extract.mjs';
import { inOrbit, ORBIT_TITLES } from './orbitRules.mjs';
import { getCampaign } from '../campaigns/registry.mjs';

// People from a company's own website, 11 September 2026. John's
// instruction when the data centre lane starved at the people step: the
// LinkedIn search stands down after a pass and is capped per account, and
// the accounts that score highest carried no decision makers at all. A
// company's own team, leadership and contact pages name its people with
// their roles, in the company's own words, which is stronger evidence of
// employer than a LinkedIn headline. This route reads those pages, keeps
// the people whose role sits in the campaign's decision orbit, and hands
// them to email discovery, which already resolves an address from a name
// and a domain with no LinkedIn profile at all.
//
// The same manners as every other read of a site: robots obeyed, paced,
// five pages at most, and nothing stored that a page did not say.

export const sitePeopleLimit = () => Math.max(1, Math.min(30, parseInt(process.env.ENGINE_SITE_PEOPLE_LIMIT || '10', 10) || 10));
export const sitePeopleRetryDays = () => Math.max(1, parseInt(process.env.SITE_PEOPLE_RETRY_DAYS || '14', 10) || 14);

// Links worth reading for people: the anchor text or the path says team,
// people, leadership, management, board or contacts. Shallow only.
export const PEOPLE_WORDS = /\b(team|people|leadership|management|senior team|board|directors|who we are|our experts|staff|key contacts|contact us|contacts)\b/i;
const PEOPLE_PATH = /\b(team|people|leadership|management|board|directors|staff|who-we-are|our-experts|key-contacts|contact)\b/i;
export function peoplePageLinks(links, home, { max = 4 } = {}) {
  const out = [];
  const score = l => (/\b(team|people|leadership|management|board|directors)\b/i.test(`${l.text} ${l.path}`) ? 0 : 1);
  const cands = [];
  for (const l of links || []) {
    if (!l?.url || !sameHost(l.url, home) || l.url === home || isAssetUrl(l.url) || isDocUrl(l.url)) continue;
    let path;
    try { path = new URL(l.url).pathname; } catch { continue; }
    if (path.split('/').filter(Boolean).length > 3) continue;
    if (!(PEOPLE_WORDS.test(l.text || '') || PEOPLE_PATH.test(path))) continue;
    if (!cands.some(c => c.url === l.url)) cands.push({ url: l.url, text: l.text || '', path });
  }
  for (const c of cands.sort((a, b) => score(a) - score(b))) {
    out.push(c.url);
    if (out.length >= max) break;
  }
  return out;
}

// Structured data first: many corporate sites mark their people up as
// schema.org Person with a jobTitle, which is the page saying it outright.
export function jsonLdPeople(html) {
  const out = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const type = [].concat(node['@type'] || []).map(t => String(t).toLowerCase());
    if (type.includes('person') && node.name) {
      out.push({ name: String(node.name).replace(/\s+/g, ' ').trim(), role: node.jobTitle ? String(node.jobTitle).replace(/\s+/g, ' ').trim() : null });
    }
    for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v);
  };
  while ((m = re.exec(String(html || ''))) !== null) {
    try { walk(JSON.parse(decodeEntities(m[1]).trim())); } catch { /* a broken block is no evidence */ }
  }
  return out;
}

// A line that reads as a person's name: two to four words, each capitalised
// (a lower-case particle allowed in the middle), no digits, and none of the
// words a team page prints in headings. Deliberately strict, because a
// wrong name becomes a wrong contact.
const PARTICLE = /^(van|de|der|den|von|da|di|le|la|du|del|della|bin|al|el|mac|mc|st\.?|of|and|y)$/i;
const NOT_NAME = /^(our|the|meet|team|teams|about|contact|contacts|us|leadership|management|board|people|senior|key|staff|read|more|view|profile|email|phone|linkedin|join|career|careers|news|home|services|projects|sectors|group|limited|ltd|plc|uk|company|companies|office|offices|head|executive|director|directors|manager|managers|engineer|engineers|department|departments|division|team|get|in|touch|find|out|learn|discover|explore|welcome|back|next|previous|all|show|hide|menu|search|privacy|policy|cookies|cookie|terms|conditions|copyright|rights|reserved|registered|england|wales|scotland|ireland|london|united|kingdom|europe|global|international|data|centre|centres|center|centers|energy|construction|engineering|building|services|solutions|partners|associates|consulting|consultants|holdings|europe)$/i;
// The words a role is made of. A run of capitalised words that carries one
// of these is a title, not a person, which is how "Talent Acquisition
// Partner" stays a role and "Jane Smith" stays a name.
const ROLE_WORDS = /\b(director|manager|head of|head|engineer|lead|chief|officer|partner|associate|consultant|estimator|surveyor|co-?ordinator|controller|specialist|analyst|founder|owner|president|vp|vice president|executive|principal|supervisor|technician|designer|architect|planner|buyer|procurement|commissioning|ceo|cfo|coo|cto|md|managing director|chairman|chair|secretary|advisor|adviser)\b/i;
export function looksLikeName(line) {
  const s = String(line || '').trim();
  if (!s || s.length > 40 || /[\d@:|/,()]/.test(s) || ROLE_WORDS.test(s)) return false;
  const words = s.split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;
  if (words.some(w => NOT_NAME.test(w.replace(/[.,]$/, '')))) return false;
  return words.every((w, i) => /^(?:[A-Z]\.|[A-Z][A-Za-z'’-]+\.?)$/.test(w) || (i > 0 && i < words.length - 1 && PARTICLE.test(w)));
}

// A line that reads as a role: short, and it names a function or a title in
// the campaign's orbit.
export function looksLikeRole(line, titles = []) {
  const s = String(line || '').trim();
  if (!s || s.length > 90) return false;
  return ROLE_WORDS.test(s) || inOrbit(s, titles) === true;
}

// Name and role pairs from a page's text: a name on one line and its role
// on the next, or "Name, Role" and "Name - Role" on one line. Nothing else
// is a person here.
export function extractPeople(text, { titles = [] } = {}) {
  const lines = String(text || '').split('\n').map(l => l.replace(/^- /, '').trim()).filter(Boolean);
  const out = [];
  const seen = new Set();
  const add = (name, role) => {
    const n = name.replace(/\s+/g, ' ').trim();
    const key = n.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name: n, role: role ? role.replace(/\s+/g, ' ').trim() : null });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const oneLine = /^(.{4,40}?)\s*(?:,|\s-\s|\s\|\s|\s–\s|\s—\s)\s*(.{3,90})$/.exec(line);
    if (oneLine && looksLikeName(oneLine[1]) && looksLikeRole(oneLine[2], titles)) { add(oneLine[1], oneLine[2]); continue; }
    if (!looksLikeName(line)) continue;
    const next = lines[i + 1], after = lines[i + 2];
    if (next && looksLikeRole(next, titles)) { add(line, next); i++; continue; }
    if (next && !looksLikeName(next) && next.length <= 40 && after && looksLikeRole(after, titles)) { add(line, after); i += 2; }
  }
  return out;
}

// The people the campaign wants: those whose role sits in its orbit.
export const qualify = (people, titles = []) => (people || []).filter(p => p.role && inOrbit(p.role, titles) === true);

// The read: the front page and up to four people pages, robots obeyed,
// paced, bounded. Every person carries the page that named them.
export async function findPeopleOnSite(domain, { titles = [], fetchImpl = politeFetch, delayMs = 1000, timeoutMs = 10_000, maxPages = 5 } = {}) {
  const d = String(domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!d) return null;
  const hosts = d.startsWith('www.') ? [d] : [d, `www.${d}`];
  const pacer = new HostPacer({ delayMs });
  let home = null, homeHtml = null;
  for (const h of hosts) {
    await pacer.wait(hostOf(`https://${h}/`));
    const r = await fetchImpl(`https://${h}/`, { timeoutMs });
    if (r.ok && r.body && /html/.test(r.contentType)) {
      homeHtml = r.body.toString('utf8');
      home = extractPage(homeHtml, canonicalUrl(r.url) || `https://${h}/`);
      break;
    }
  }
  if (!home) return { domain: d, unreachable: true, pages: [], people: [], found: 0 };
  await pacer.wait(hostOf(home.url));
  const robots = await getRobots(new URL(home.url).origin, { fetchImpl });
  const pages = [{ url: home.url, title: home.title, text: home.text, html: homeHtml }];
  for (const u of peoplePageLinks(home.links, home.url, { max: Math.max(0, maxPages - 1) })) {
    if (!robotsAllows(robots, new URL(u).pathname).allowed) continue;
    await pacer.wait(hostOf(u));
    const r = await fetchImpl(u, { timeoutMs });
    if (!r.ok || !r.body || !/html/.test(r.contentType)) continue;
    const html = r.body.toString('utf8');
    const p = extractPage(html, u);
    if (p.noindex) continue;
    pages.push({ url: u, title: p.title, text: p.text, html });
  }
  const all = [];
  const seen = new Set();
  for (const p of pages) {
    for (const person of [...jsonLdPeople(p.html), ...extractPeople(p.text, { titles })]) {
      const key = person.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      all.push({ ...person, url: p.url, page: p.title });
    }
  }
  const people = qualify(all, titles);
  return {
    domain: d, url: home.url, pages: pages.map(p => ({ url: p.url, title: p.title })),
    found: all.length, people,
    unqualified: all.filter(p => !people.includes(p)).slice(0, 8).map(p => ({ name: p.name, role: p.role })),
  };
}

// One pass over the register: named accounts with a domain and no emailable
// decision maker, most valuable first, not read in the last fortnight. Each
// qualified person becomes a contact with source website and the page that
// named them, and email discovery does the rest in the same cycle. Nothing
// here touches LinkedIn.
export async function discoverSitePeople({ limit = sitePeopleLimit(), log = () => {}, finder = findPeopleOnSite } = {}) {
  if (!(await hasColumn('companies', 'site_people_checked_at'))) return { skipped: 'run npm run migrate first' };
  const { rows: companies } = await pool.query(
    `SELECT id, name, domain,
            (SELECT array_agg(cc.campaign ORDER BY cc.campaign) FROM company_campaigns cc WHERE cc.company_id = companies.id) AS memberships
     FROM companies
     WHERE named_account AND domain IS NOT NULL
       AND (site_people_checked_at IS NULL OR site_people_checked_at < now() - ($2 || ' days')::interval)
       AND NOT EXISTS (
         SELECT 1 FROM contacts ct WHERE ct.company_id = companies.id
           AND ct.in_decision_orbit AND NOT ct.suppressed AND NOT ct.rehearsal
           AND ct.email IS NOT NULL AND ct.email_bounced_at IS NULL)
     ORDER BY EXISTS (SELECT 1 FROM leads l WHERE l.company_id = companies.id AND l.stage = 'researched') DESC,
              icp_score DESC NULLS LAST, name LIMIT $1`, [limit, String(sitePeopleRetryDays())]);
  const report = { companies: 0, found: 0, created: 0, orbit: 0, unreachable: 0 };
  for (const co of companies) {
    const known = (co.memberships || []).filter(id => getCampaign(id));
    const campaign = known.length === 1 ? known[0] : 'marwin_dc';
    const titles = getCampaign(campaign)?.orbitTitles || [];
    let r = null;
    try { r = await finder(co.domain, { titles }); }
    catch (e) { log(`${co.name}: site read failed: ${String(e.message).slice(0, 120)}`); }
    report.companies++;
    await pool.query(`UPDATE companies SET site_people_checked_at = now(), site_people_found = $2 WHERE id = $1`, [co.id, r?.people?.length ?? 0]);
    if (!r || r.unreachable) { report.unreachable++; log(`${co.name}: site unreachable`); continue; }
    report.found += r.found;
    for (const p of r.people) {
      const { rows: ex } = await pool.query(
        `SELECT id, role_title, in_decision_orbit FROM contacts WHERE company_id = $1 AND lower(full_name) = lower($2) LIMIT 1`, [co.id, p.name]);
      if (ex.length) {
        await pool.query(
          `UPDATE contacts SET role_title = COALESCE(role_title, $2), in_decision_orbit = COALESCE(in_decision_orbit, true) WHERE id = $1`,
          [ex[0].id, p.role]);
        continue;
      }
      await pool.query(
        `INSERT INTO contacts (company_id, full_name, role_title, in_decision_orbit, source, payload, enriched_at)
         VALUES ($1, $2, $3, true, 'website', $4::jsonb, now())`,
        [co.id, p.name, p.role, JSON.stringify({ source_url: p.url, page: p.page, found_at: new Date().toISOString() })]);
      report.created++;
      report.orbit++;
    }
    log(`${co.name}: ${r.found} name(s) on ${r.pages.length} page(s), ${r.people.length} in orbit`);
  }
  return report;
}
