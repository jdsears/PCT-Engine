import { createHash } from 'node:crypto';
import { pool } from '../db.mjs';
import { classifySignal } from './relevance.mjs';
import { extractParties } from './parties.mjs';
import { requireCampaign } from '../campaigns/registry.mjs';

// Tavily news research. The sweep queries are plain data so the campaign focus
// can be edited without touching code.
const TAVILY_URL = 'https://api.tavily.com/search';

// The sweep queries are campaign data now. The export stays so anything holding
// a reference to the data centre list still resolves, and it reads from the
// registry rather than a second copy that could drift.
export const DC_SWEEP_QUERIES = requireCampaign('marwin_dc').signals.sweepQueries;

// Shared Tavily search. The days window only applies to the news topic, so it
// is omitted for general searches such as domain resolution.
export async function tavilySearch(query, { days = 14, maxResults = 8, topic = 'news' } = {}) {
  const body = {
    api_key: (process.env.TAVILY_API_KEY || '').trim(),
    query,
    topic,
    max_results: maxResults,
    include_answer: false,
  };
  if (topic === 'news') body.days = days;
  const res = await fetch(TAVILY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Tavily ${res.status} on "${query}": ${await res.text()}`);
  const json = await res.json();
  return json.results || [];
}

const tavily = tavilySearch;

const hash = (s) => createHash('sha256').update(s).digest('hex');

// Runs the campaign's sweep and stores results as signals, deduped on url hash.
// Every result must pass that campaign's relevance gate before it is stored, so a
// school job or a care home is never typed as a build signal. A confirmed signal
// is routed by its UK dimension: uk_project and expansion_watch are stored,
// foreign-only builds are dropped as context. The classifier is injectable so the
// sweep can be tested offline.
export async function dcSignalSweep({ classify = classifySignal, extract = extractParties, campaign = 'marwin_dc' } = {}) {
  const def = typeof campaign === 'string' ? requireCampaign(campaign) : campaign;
  const queries = def.signals.sweepQueries;
  const counts = { campaign: def.id, queries: queries.length, seen: 0, inserted: 0, rejected: 0, foreignOnly: 0 };
  for (const { query, type } of queries) {
    let results = [];
    try { results = await tavily(query); }
    catch (e) { console.log(`  sweep query failed: ${String(e.message).slice(0, 120)}`); continue; }
    counts.seen += results.length;
    for (const r of results) {
      if (!r.url) continue;
      let cls;
      try { cls = await classify({ title: r.title, content: r.content, query }, { campaign: def }); }
      catch { cls = { dcRelevant: false }; }
      if (!cls.dcRelevant) { counts.rejected++; console.log(`  reject, not ${def.signals.gate.subjectNoun}: ${(r.title || '').slice(0, 80)}`); continue; }
      if (cls.geoScope === 'foreign_only') { counts.foreignOnly++; console.log(`  drop, foreign only: ${(r.title || '').slice(0, 80)}`); continue; }
      // A kept signal names its parties in a second, smaller call. The gate's
      // operator stands as given; the extraction adds the contractor, and may
      // fill an operator the gate left null, never overwrite one.
      let parties = { operator: null, contractor: null };
      try { parties = await extract({ title: r.title, content: r.content }, { campaign: def }); }
      catch { /* both stay null; the signal is still stored */ }
      const { rowCount } = await pool.query(
        `INSERT INTO signals (signal_type, title, url, url_hash, payload, dc_relevant, relevant, geo_scope, operator, contractor, campaign)
         VALUES ($1, $2, $3, $4, $5::jsonb, true, true, $6, $7, $8, $9) ON CONFLICT (url_hash) DO NOTHING`,
        [type, (r.title || '').slice(0, 300), r.url, hash(r.url),
         JSON.stringify({ query, content: (r.content || '').slice(0, 1000), published: r.published_date ?? null }),
         cls.geoScope, cls.operator || parties.operator, parties.contractor, def.id]);
      if (rowCount) counts.inserted++;
    }
  }
  return counts;
}

// Targeted check for one company. Returns snippets for ICP confirmation; not
// stored as signals.
export async function companyNewsCheck(companyName) {
  const results = await tavily(`"${companyName}" UK data centre OR construction OR contract`, { days: 365, maxResults: 5 });
  return results.map(r => ({ title: r.title, url: r.url, snippet: (r.content || '').slice(0, 300) }));
}
