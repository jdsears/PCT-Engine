import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from './db.mjs';
import { search } from './retrieve.mjs';
import { ask } from './answer.mjs';

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

// Serve the built chat UI. Kept after the API routes so they match first.
const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist');
app.use(express.static(dist));
app.get('*', (_req, res) => res.sendFile(join(dist, 'index.html')));

app.listen(PORT, () => console.log(`pct-knowledge-copilot listening on ${PORT}`));
