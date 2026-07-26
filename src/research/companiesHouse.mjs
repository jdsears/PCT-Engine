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
      const { rowCount } = await pool.query(
        `INSERT INTO signals (company_id, signal_type, title, url, url_hash, payload)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb) ON CONFLICT (url_hash) DO NOTHING`,
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
