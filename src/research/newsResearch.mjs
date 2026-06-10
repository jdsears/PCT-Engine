import { createHash } from 'node:crypto';
import { pool } from '../db.mjs';

// Tavily news research. The sweep queries are plain data so the campaign focus
// can be edited without touching code.
const TAVILY_URL = 'https://api.tavily.com/search';

export const DC_SWEEP_QUERIES = [
  { query: 'UK data centre planning permission granted', type: 'news_dc_build' },
  { query: 'UK data centre construction contract awarded', type: 'news_contract' },
  { query: 'hyperscaler UK data centre capacity expansion announcement', type: 'news_dc_build' },
  { query: 'UK data centre M&E contractor appointed', type: 'news_contract' },
  { query: 'new UK data centre campus investment announced', type: 'news_dc_build' },
];

async function tavily(query, { days = 14, maxResults = 8 } = {}) {
  const res = await fetch(TAVILY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: (process.env.TAVILY_API_KEY || '').trim(),
      query,
      topic: 'news',
      days,
      max_results: maxResults,
      include_answer: false,
    }),
  });
  if (!res.ok) throw new Error(`Tavily ${res.status} on "${query}": ${await res.text()}`);
  const json = await res.json();
  return json.results || [];
}

const hash = (s) => createHash('sha256').update(s).digest('hex');

// Runs the fixed sweep and inserts results as signals, deduped on url hash.
export async function dcSignalSweep() {
  const counts = { queries: DC_SWEEP_QUERIES.length, inserted: 0, seen: 0 };
  for (const { query, type } of DC_SWEEP_QUERIES) {
    let results = [];
    try { results = await tavily(query); }
    catch (e) { console.log(`  sweep query failed: ${String(e.message).slice(0, 120)}`); continue; }
    counts.seen += results.length;
    for (const r of results) {
      if (!r.url) continue;
      const { rowCount } = await pool.query(
        `INSERT INTO signals (signal_type, title, url, url_hash, payload)
         VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (url_hash) DO NOTHING`,
        [type, (r.title || '').slice(0, 300), r.url, hash(r.url), JSON.stringify({ query, content: (r.content || '').slice(0, 1000), published: r.published_date ?? null })]);
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
