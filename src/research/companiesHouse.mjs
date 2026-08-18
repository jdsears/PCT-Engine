import { createHash } from 'node:crypto';
import { pool } from '../db.mjs';

// Companies House free REST API. HTTP basic auth, key as username, empty
// password. Public limit is 600 requests per five minutes; the throttle below
// spaces requests to stay well under it.
const BASE = 'https://api.company-information.service.gov.uk';
const MIN_GAP_MS = 700; // about 85 requests per minute, roughly 430 per five minutes
let lastCall = 0;

async function throttle() {
  const wait = lastCall + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCall = Date.now();
}

async function chFetch(path) {
  await throttle();
  const auth = Buffer.from(`${(process.env.COMPANIES_HOUSE_API_KEY || '').trim()}:`).toString('base64');
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Basic ${auth}` } });
  if (res.status === 404) return null;
  if (res.status === 429) {
    // Backoff once on a rate limit, then retry the same path.
    await new Promise(r => setTimeout(r, 60_000));
    return chFetch(path);
  }
  if (!res.ok) throw new Error(`Companies House ${res.status} on ${path}: ${await res.text()}`);
  return res.json();
}

// Pure mapping from the Companies House search response, split out so the
// gate can prove the shape without a network.
export function searchResultRows(json) {
  return (json?.items || []).map(it => ({
    name: it.title,
    chNumber: it.company_number,
    status: it.company_status,
    address: it.address_snippet || null,
    postcode: it.address?.postal_code || null,
    incorporated: it.date_of_creation || null,
  }));
}

export async function searchCompanies(name) {
  return searchResultRows(await chFetch(`/search/companies?q=${encodeURIComponent(name)}&items_per_page=10`));
}

// The candidate rows a review proposal stores and the queue renders. This is
// the ONLY place that shapes them: a first cut re-mapped searchCompanies
// output reading the raw API field names, which are already gone by then, so
// every candidate rendered as an empty pair of brackets. searchCompanies has
// one shape and this passes it through.
export function candidateRows(results) {
  return (results || []).slice(0, 5).map(c => ({
    name: c.name, chNumber: c.chNumber, status: c.status, address: c.address || null,
  }));
}

// The confidence rule for attaching a Companies House entity to a register
// name without a human in the loop, extracted from the July seed and
// tightened for bulk use: the candidate must be active, the names must
// contain one another after suffix stripping, and there must be exactly one
// such candidate, because walking a thousand rows automatically deserves a
// stricter bar than seeding forty by hand. Anything else is ambiguous or
// none, left for the amend form, never guessed.
// Tightened 11 August 2026 after the first live walk leaked: substring
// containment matched Oxitec to OXI-TECH SOLUTIONS across a word boundary
// and Olympus Surgical Technologies to bare SURGICAL TECHNOLOGIES by
// swallowing the identity word. The rule is now token-shaped: the first
// token must agree, because identity lives at the front of a name, and the
// shorter side's tokens must all appear in the longer's. Recall is traded
// for precision deliberately; a bulk auto-attach that is sometimes wrong is
// worse than one that leaves more for the amend form.
const tokenise = (s, stop) => String(s || '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').split(/\s+/)
  .filter(t => t && !stop.includes(t));
const FIT_STOP = ['ltd', 'limited', 'plc', 'llp', 'uk', 'group', 'holdings', 'the'];
// Only the legal dressing: an exact match may strip LIMITED or PLC, never
// HOLDINGS, GROUP or UK, because a holdings shell or a group parent is the
// classic wrong attach and a UK arm of a foreign group deserves a human eye.
const LEGAL_STOP = ['ltd', 'limited', 'plc', 'llp', 'the'];
export function confidentChMatch(name, results) {
  const nTok = tokenise(name, FIT_STOP);
  if (!nTok.length) return { status: 'none' };
  const nameFits = (results || []).filter(r => {
    const cTok = tokenise(r.name, FIT_STOP);
    if (!cTok.length || cTok[0] !== nTok[0]) return false;
    const [a, b] = cTok.length <= nTok.length ? [cTok, nTok] : [nTok, cTok];
    return a.every(t => b.includes(t));
  });
  const fits = nameFits.filter(r => r.status === 'active');
  // The Fletchers shape: the name agrees and every agreeing entity is
  // dissolved. That is not "none", it is news, the business behind this
  // register row may be gone, and the caller should say so rather than
  // leave a dead company scoring like a prospect.
  if (!fits.length && nameFits.length) return { status: 'dissolved_only', candidates: nameFits };
  // GSK's shape, from the first live walk: the register name sits among
  // extensions, GSK Accountancy and kin, but exactly one candidate IS the
  // name once the legal dressing comes off, GSK PLC. That one wins.
  const nLegal = tokenise(name, LEGAL_STOP).join(' ');
  const exact = fits.filter(r => tokenise(r.name, LEGAL_STOP).join(' ') === nLegal);
  if (exact.length === 1) return { status: 'matched', match: exact[0] };
  if (fits.length === 1) return { status: 'matched', match: fits[0] };
  if (fits.length > 1) return { status: 'ambiguous', candidates: fits };
  return { status: 'none' };
}

// A hand-entered company number into Companies House's canonical form, or
// null when it cannot be one. Numbers are eight characters: all digits, with
// short old registrations zero-padded, or a two-letter prefix and six digits
// (SC, NI and kin). Typed input arrives with spaces and lower case; a value
// this cannot shape is refused before any API call is spent on it.
export function cleanChNumber(v) {
  const s = String(v || '').replace(/\s+/g, '').toUpperCase();
  if (/^\d{1,8}$/.test(s)) return s.padStart(8, '0');
  if (/^[A-Z]{2}\d{6}$/.test(s)) return s;
  return null;
}

// The profile alone, no cache write: the match walk judges a number found
// on a company's own website before anything is attached, so the read must
// not touch the database.
export async function fetchCompanyProfile(chNumber) {
  return chFetch(`/company/${chNumber}`);
}

// Fetches the profile and caches it onto the companies row when one exists.
export async function companyProfile(chNumber) {
  const profile = await chFetch(`/company/${chNumber}`);
  if (profile) {
    await pool.query(
      `UPDATE companies SET ch_profile = $1::jsonb, updated_at = now() WHERE ch_number = $2`,
      [JSON.stringify(profile), chNumber]);
  }
  return profile;
}

export async function companyOfficers(chNumber) {
  const json = await chFetch(`/company/${chNumber}/officers?items_per_page=50`);
  return (json?.items || []).filter(o => !o.resigned_on);
}

export async function recentFilings(chNumber, sinceDays = 30) {
  const json = await chFetch(`/company/${chNumber}/filing-history?items_per_page=50`);
  const cutoff = Date.now() - sinceDays * 86_400_000;
  return (json?.items || []).filter(it => it.date && new Date(it.date).getTime() >= cutoff);
}

const hash = (s) => createHash('sha256').update(s).digest('hex');

// Polls filings for every company with a Companies House number and inserts new
// ones as signals. Filings in the officers category are classed as director
// changes. Deduped on a stable hash of company number plus transaction id.
export async function pollCompaniesHouse() {
  const { rows: lastRows } = await pool.query(`SELECT value FROM kv WHERE key = 'ch_last_poll'`);
  const lastPoll = lastRows[0]?.value?.at ? new Date(lastRows[0].value.at) : null;
  const sinceDays = lastPoll ? Math.max(1, Math.ceil((Date.now() - lastPoll.getTime()) / 86_400_000)) : 30;

  const { rows: tracked } = await pool.query(
    `SELECT id, name, ch_number FROM companies WHERE ch_number IS NOT NULL ORDER BY id`);

  const counts = { companies: tracked.length, ch_filing: 0, ch_director_change: 0 };
  for (const co of tracked) {
    let filings = [];
    try { filings = await recentFilings(co.ch_number, sinceDays); }
    catch (e) { console.log(`  filings failed for ${co.name}: ${String(e.message).slice(0, 120)}`); continue; }
    for (const f of filings) {
      const type = f.category === 'officers' ? 'ch_director_change' : 'ch_filing';
      const urlHash = hash(`${co.ch_number}:${f.transaction_id}`);
      const url = `https://find-and-update.company-information.service.gov.uk/company/${co.ch_number}/filing-history`;
      // Filings are campaign-neutral: the register knows companies, not
      // campaigns. Left to the column default they landed as marwin_dc
      // (migration 023's single-tenant assumption), and that one word
      // dragged pharma-only companies into the data centre run, built them
      // data centre leads, and drafted hyperscale copy to a bioreactor
      // maker. The 'register' sentinel belongs to no campaign, so a filing
      // can never again be the door into the wrong one; members still score
      // through their memberships, exactly as they should.
      const { rowCount } = await pool.query(
        `INSERT INTO signals (company_id, signal_type, title, url, url_hash, payload, campaign)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'register') ON CONFLICT (url_hash) DO NOTHING`,
        [co.id, type, f.description || f.type || 'filing', url, urlHash, JSON.stringify(f)]);
      if (rowCount) counts[type]++;
    }
  }

  await pool.query(
    `INSERT INTO kv (key, value, updated_at) VALUES ('ch_last_poll', $1::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = now()`,
    [JSON.stringify({ at: new Date().toISOString() })]);

  return counts;
}
