import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from './db.mjs';
import { search } from './retrieve.mjs';
import { ask } from './answer.mjs';
import { REGIONS } from './research/region.mjs';
import { graphToken } from './msgraph.mjs';

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

app.get('/health', async (_req, res) => {
  try {
    const ext = await pool.query(`SELECT extversion FROM pg_extension WHERE extname = 'vector'`);
    const mig = await pool.query('SELECT count(*)::int AS n FROM schema_migrations');
    const chunks = await pool.query('SELECT count(*)::int AS n FROM kb_chunks');
    res.json({ ok: true, pgvector: ext.rows[0]?.extversion ?? null, migrations: mig.rows[0].n, kb_chunks: chunks.rows[0].n });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post('/search', async (req, res) => {
  try {
    const { query, filters, k } = req.body || {};
    if (!query) return res.status(400).json({ error: 'query is required' });
    res.json({ query, results: await search(query, { filters: filters || {}, k: k || 8 }) });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/ask', async (req, res) => {
  try {
    const { question, history } = req.body || {};
    if (!question) return res.status(400).json({ error: 'question is required' });
    const result = await ask(question, { history: Array.isArray(history) ? history : [] });
    res.json(result);
    // Log usage after responding. Logging must never delay or fail the answer.
    try {
      await pool.query(
        `INSERT INTO copilot_queries (question, detected_filters, declined, citations_used, sources_offered, latency_ms)
         VALUES ($1, $2::jsonb, $3, $4::jsonb, $5, $6)`,
        [question, JSON.stringify(result.filters || {}), !!result.declined,
         JSON.stringify(result.citationsUsed || []), result.sourcesOffered ?? null, result.latencyMs ?? null]);
    } catch (e) { console.error('query log insert failed:', e.message); }
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Read-only usage insights over the query log. Open like the rest of the API;
// when an access gate arrives, these sit behind it with the other routes.
const clampDays = (v, def) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? Math.min(n, 365) : def; };

app.get('/api/insights/summary', async (req, res) => {
  try {
    const days = clampDays(req.query.days, 30);
    const totals = await pool.query(
      `SELECT count(*)::int AS questions,
              count(*) FILTER (WHERE declined)::int AS declined,
              round(avg(latency_ms))::int AS avg_latency_ms
       FROM copilot_queries WHERE created_at >= now() - make_interval(days => $1)`, [days]);
    const daily = await pool.query(
      `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, count(*)::int AS n
       FROM copilot_queries WHERE created_at >= now() - make_interval(days => $1)
       GROUP BY 1 ORDER BY 1`, [days]);
    const lines = await pool.query(
      `SELECT COALESCE(detected_filters->>'line', detected_filters->>'application', 'general') AS line, count(*)::int AS n
       FROM copilot_queries WHERE created_at >= now() - make_interval(days => $1)
       GROUP BY 1 ORDER BY n DESC, line`, [days]);
    const t = totals.rows[0];
    res.json({
      days, questions: t.questions, declined: t.declined,
      declinedRate: t.questions ? Number((t.declined / t.questions).toFixed(3)) : 0,
      avgLatencyMs: t.avg_latency_ms, daily: daily.rows, lines: lines.rows,
    });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/insights/gaps', async (req, res) => {
  try {
    const days = clampDays(req.query.days, 90);
    const { rows } = await pool.query(
      `SELECT max(question) AS question, count(*)::int AS repeats, max(created_at) AS last_asked
       FROM copilot_queries
       WHERE declined AND created_at >= now() - make_interval(days => $1)
       GROUP BY lower(btrim(question)) ORDER BY last_asked DESC`, [days]);
    res.json({ days, gaps: rows });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/insights/top-docs', async (req, res) => {
  try {
    const days = clampDays(req.query.days, 90);
    const { rows } = await pool.query(
      `SELECT c->>'title' AS title, count(*)::int AS citations
       FROM copilot_queries q, jsonb_array_elements(q.citations_used) c
       WHERE q.created_at >= now() - make_interval(days => $1) AND jsonb_typeof(q.citations_used) = 'array'
       GROUP BY c->>'title' ORDER BY citations DESC, title LIMIT 10`, [days]);
    res.json({ days, docs: rows });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Read-only views over the research stage for the web app. Same posture as the
// insights routes: open now, behind the access gate with everything else later.
const regionName = code => (code && REGIONS[code]?.name) || code || null;

const STAGES = ['sourced', 'researched', 'outbound', 'replied', 'qualified', 'handed_off'];
app.get('/api/pipeline', async (req, res) => {
  try {
    const stage = STAGES.includes(req.query.stage) ? req.query.stage : 'researched';
    const counts = await pool.query(
      `SELECT stage, count(*)::int AS n FROM leads WHERE stage = ANY($1) GROUP BY stage`, [STAGES]);
    const byStage = Object.fromEntries(counts.rows.map(r => [r.stage, r.n]));
    const { rows } = await pool.query(
      `SELECT co.name AS company, l.score, COALESCE(l.region, co.region) AS region,
              ct.full_name, ct.role_title
       FROM leads l JOIN companies co ON co.id = l.company_id
       LEFT JOIN contacts ct ON ct.id = l.contact_id
       WHERE l.stage = $1 ORDER BY l.score DESC NULLS LAST, co.name LIMIT 8`, [stage]);
    res.json({
      stage,
      stages: STAGES.map(s => ({ stage: s, count: byStage[s] || 0 })),
      total: byStage[stage] || 0,
      leads: rows.map(l => ({
        company: l.company,
        contact: l.full_name ? `${l.full_name}${l.role_title ? ', ' + l.role_title : ''}` : null,
        region: regionName(l.region),
        score: l.score == null ? null : Math.round(Number(l.score)),
      })),
    });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/accounts', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.name, c.company_type, c.region, c.domain, c.ch_number,
              round(c.icp_score)::int AS score,
              (SELECT count(*)::int FROM signals s WHERE s.company_id = c.id) AS signals
       FROM companies c WHERE c.named_account
       ORDER BY c.icp_score DESC NULLS LAST, c.name LIMIT 200`);
    res.json({ companies: rows.map(c => ({
      id: c.id, name: c.name, type: c.company_type, region: regionName(c.region),
      domain: c.domain, chNumber: c.ch_number, score: c.score, signals: c.signals,
    })) });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// The four ICP components and their caps, mirroring src/research/icp.mjs. The
// stored breakdown is the audit trail; this only shapes it for display.
const ICP_ROWS = [
  ['named_account', 'Named account', 25],
  ['company_type', 'Type fit', 25],
  ['signals', 'Signals', 30],
  ['ch_health', 'CH health', 20],
];
app.get('/api/accounts/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad id' });
    const comp = await pool.query(
      `SELECT id, name, company_type, region, domain, ch_number,
              round(icp_score)::int AS score, icp_breakdown
       FROM companies WHERE id = $1`, [id]);
    if (!comp.rows.length) return res.status(404).json({ error: 'not found' });
    const c = comp.rows[0];
    const sigs = await pool.query(
      `SELECT title, signal_type, observed_at FROM signals
       WHERE company_id = $1 ORDER BY observed_at DESC LIMIT 3`, [id]);
    const dirs = await pool.query(
      `SELECT full_name, payload->>'appointed_on' AS appointed FROM contacts
       WHERE company_id = $1 AND source = 'ch_officers' AND NOT suppressed
       ORDER BY in_decision_orbit DESC NULLS LAST, full_name LIMIT 8`, [id]);
    const bd = c.icp_breakdown || {};
    res.json({
      id: c.id, name: c.name, type: c.company_type, region: regionName(c.region),
      domain: c.domain, chNumber: c.ch_number, score: c.score,
      icp: ICP_ROWS.map(([key, label, max]) => ({
        label, max, points: bd[key]?.points ?? null, reason: bd[key]?.reason ?? null,
      })),
      recentSignals: sigs.rows.map(s => ({ title: s.title, type: s.signal_type, observedAt: s.observed_at })),
      directors: dirs.rows.map(d => ({ name: d.full_name, appointed: d.appointed })),
    });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

const SIGNAL_FILTERS = {
  filing: ['ch_filing', 'ch_incorporation'],
  director: ['ch_director_change'],
  build: ['news_dc_build', 'planning'],
  contract: ['news_contract'],
};
app.get('/api/signals', async (req, res) => {
  try {
    const types = SIGNAL_FILTERS[req.query.type] || null;
    const { rows } = await pool.query(
      `SELECT s.id, s.signal_type, s.title, s.url, s.observed_at,
              c.id AS company_id, c.name AS company
       FROM signals s LEFT JOIN companies c ON c.id = s.company_id
       WHERE $1::text[] IS NULL OR s.signal_type = ANY($1)
       ORDER BY s.observed_at DESC LIMIT 50`, [types]);
    const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };
    res.json({ signals: rows.map(s => ({
      id: s.id, type: s.signal_type, title: s.title, observedAt: s.observed_at,
      source: host(s.url) || (s.signal_type.startsWith('ch_') ? 'Companies House stream' : null),
      companyId: s.company_id, company: s.company,
    })) });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/outbound/status', (_req, res) => {
  res.json({ killSwitch: (process.env.MAIL_KILL_SWITCH || 'on') !== 'off' ? 'on' : 'off' });
});

app.get('/api/health/cards', async (_req, res) => {
  try {
    const corpus = await pool.query(
      `SELECT count(*)::int AS chunks, count(DISTINCT metadata->>'source_id')::int AS documents,
              max(created_at) AS last FROM kb_chunks`);
    const byLine = await pool.query(
      `SELECT metadata->>'line' AS line, count(DISTINCT metadata->>'source_id')::int AS docs
       FROM kb_chunks WHERE metadata->>'line' IS NOT NULL
       GROUP BY 1 ORDER BY docs DESC LIMIT 4`);
    const ext = await pool.query(`SELECT extversion FROM pg_extension WHERE extname = 'vector'`);
    const size = await pool.query(
      `SELECT round(pg_database_size(current_database()) / 1048576.0)::int AS mb`);
    const graph = {
      configured: !!(process.env.MS_TENANT_ID && process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET),
      connected: false, checkedAt: null,
    };
    if (graph.configured) {
      try {
        await Promise.race([graphToken(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))]);
        graph.connected = true;
      } catch { /* reported as not connected */ }
      graph.checkedAt = new Date().toISOString();
    }
    res.json({
      corpus: {
        chunks: corpus.rows[0].chunks, documents: corpus.rows[0].documents,
        lastIngestedAt: corpus.rows[0].last, byLine: byLine.rows,
      },
      database: { engine: 'PostgreSQL', pgvector: ext.rows[0]?.extversion ?? null, sizeMB: size.rows[0].mb },
      graph,
      killSwitch: (process.env.MAIL_KILL_SWITCH || 'on') !== 'off' ? 'on' : 'off',
    });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Serve the built chat UI. Kept after the API routes so they match first.
const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist');
app.use(express.static(dist));
app.get('*', (_req, res) => res.sendFile(join(dist, 'index.html')));

app.listen(PORT, () => console.log(`pct-knowledge-copilot listening on ${PORT}`));
