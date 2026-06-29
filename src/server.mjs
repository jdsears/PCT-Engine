import express from 'express';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from './db.mjs';
import { search } from './retrieve.mjs';
import { ask } from './answer.mjs';
import { REGIONS } from './research/region.mjs';
import { graphToken } from './msgraph.mjs';
import { handleTeamsMessage } from './teams.mjs';
import { sendMailTest, isTestRecipient, textToHtml, testRecipientList } from './mail.mjs';

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

// ----- Access gate -----
// A single shared key for the pilot. When APP_ACCESS_KEY is set the data routes
// require a valid cookie; when it is not set the gate is open, so local runs and
// the existing deploy keep working until the key is configured. The cookie holds
// a hash of the key, never the key itself, and is compared in constant time.
const ACCESS_KEY = process.env.APP_ACCESS_KEY || '';
const GATE_ON = ACCESS_KEY.length > 0;
const COOKIE = 'pct_access';
const tokenFor = k => crypto.createHash('sha256').update(String(k)).digest('hex');
const ACCESS_TOKEN = GATE_ON ? tokenFor(ACCESS_KEY) : '';
if (!GATE_ON) {
  console.warn('APP_ACCESS_KEY is not set: the access gate is open. Set it to protect /ask, /search and /api.');
}

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i !== -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
function constantTimeEqual(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
function hasAccess(req) {
  if (!GATE_ON) return true;
  const c = readCookie(req, COOKIE);
  return !!c && constantTimeEqual(c, ACCESS_TOKEN);
}

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

// These two stay public so the UI can check the gate and enter the key.
app.get('/api/access/status', (req, res) => {
  res.json({ required: GATE_ON, authed: hasAccess(req) });
});

app.post('/api/access', async (req, res) => {
  if (!GATE_ON) return res.json({ ok: true });
  const key = req.body && typeof req.body.key === 'string' ? req.body.key : '';
  if (key && constantTimeEqual(tokenFor(key), ACCESS_TOKEN)) {
    res.cookie(COOKIE, ACCESS_TOKEN, {
      httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production',
      path: '/', maxAge: 30 * 24 * 60 * 60 * 1000,
    });
    return res.json({ ok: true });
  }
  // A small delay so the key cannot be brute-forced cheaply.
  await new Promise(r => setTimeout(r, 600));
  res.status(401).json({ ok: false, error: 'unauthorized' });
});

// The Teams bot endpoint. Registered before the gate so it is exempt from the
// access-gate cookie check: its protection is Bot Framework token validation,
// done inside handleTeamsMessage, not the shared key. This is the only path
// under /api that the gate does not cover, and it is exempt by design.
app.post('/api/teams/messages', (req, res) => handleTeamsMessage(req, res));

// Guard the data: /ask, /search and everything under /api. The static app shell
// served below stays public; the data behind these routes does not. The access
// routes above are registered first, so they are reachable without a cookie.
app.use(['/api', '/ask', '/search'], (req, res, next) => {
  if (hasAccess(req)) return next();
  res.status(401).json({ error: 'unauthorized' });
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
    const { question, history, configState } = req.body || {};
    if (!question) return res.status(400).json({ error: 'question is required' });
    const result = await ask(question, {
      history: Array.isArray(history) ? history : [],
      configState: configState || null,
    });
    res.json(result);
    // Log usage after responding. Logging must never delay or fail the answer.
    // A configurator turn is not a retrieval query, so it is not logged to
    // copilot_queries. The turn is a build when it carries config state, an
    // options list, a completed code, or a terminal build-log record.
    const isConfigTurn = !!(result.configState || result.configOptions || result.configurator || result.configLog);
    if (!isConfigTurn) try {
      await pool.query(
        `INSERT INTO copilot_queries (question, detected_filters, declined, citations_used, sources_offered, latency_ms)
         VALUES ($1, $2::jsonb, $3, $4::jsonb, $5, $6)`,
        [question, JSON.stringify(result.filters || {}), !!result.declined,
         JSON.stringify(result.citationsUsed || []), result.sourcesOffered ?? null, result.latencyMs ?? null]);
    } catch (e) { console.error('query log insert failed:', e.message); }

    // A build that ended this turn logs one row: the model, whether a code was
    // assembled, how far it got, the code, and the turn latency. No user identity.
    if (result.configLog) try {
      const g = result.configLog;
      await pool.query(
        `INSERT INTO configurator_builds (model, completed, slot_count, code, latency_ms)
         VALUES ($1, $2, $3, $4, $5)`,
        [g.model, !!g.completed, g.slots ?? 0, g.code ?? null, result.latencyMs ?? null]);
    } catch (e) { console.error('configurator build log insert failed:', e.message); }
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
// Sort keys are whitelisted to SQL expressions; nothing from the query string
// reaches the statement text except through this map.
const LEAD_SORTS = {
  score: 'l.score',
  company: 'co.name',
  region: 'COALESCE(l.region, co.region)',
};
const LEAD_LIMITS = [10, 20, 50, 100];

app.get('/api/pipeline', async (req, res) => {
  try {
    const stage = STAGES.includes(req.query.stage) ? req.query.stage : 'researched';
    const limit = LEAD_LIMITS.includes(parseInt(req.query.limit, 10)) ? parseInt(req.query.limit, 10) : 10;
    const sort = LEAD_SORTS[req.query.sort] ? req.query.sort : 'score';
    const dir = req.query.dir === 'asc' ? 'ASC' : 'DESC';
    const q = String(req.query.q || '').trim();

    const counts = await pool.query(
      `SELECT stage, count(*)::int AS n FROM leads WHERE stage = ANY($1) GROUP BY stage`, [STAGES]);
    const byStage = Object.fromEntries(counts.rows.map(r => [r.stage, r.n]));

    // The track keeps the unfiltered funnel counts; total is the match count for
    // the list, so "Showing x of n" stays honest under a search.
    const where = `l.stage = $1 AND ($2 = '' OR co.name ILIKE '%' || $2 || '%' OR ct.full_name ILIKE '%' || $2 || '%')`;
    const total = await pool.query(
      `SELECT count(*)::int AS n
       FROM leads l JOIN companies co ON co.id = l.company_id
       LEFT JOIN contacts ct ON ct.id = l.contact_id WHERE ${where}`, [stage, q]);
    const { rows } = await pool.query(
      `SELECT co.name AS company, l.score, COALESCE(l.region, co.region) AS region,
              ct.full_name, ct.role_title
       FROM leads l JOIN companies co ON co.id = l.company_id
       LEFT JOIN contacts ct ON ct.id = l.contact_id
       WHERE ${where}
       ORDER BY ${LEAD_SORTS[sort]} ${dir} NULLS LAST, co.name ASC LIMIT $3`, [stage, q, limit]);
    res.json({
      stage, limit, sort, dir: dir.toLowerCase(), q,
      stages: STAGES.map(s => ({ stage: s, count: byStage[s] || 0 })),
      total: total.rows[0].n,
      leads: rows.map(l => ({
        company: l.company,
        contact: l.full_name ? `${l.full_name}${l.role_title ? ', ' + l.role_title : ''}` : null,
        region: regionName(l.region),
        score: l.score == null ? null : Math.round(Number(l.score)),
      })),
    });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Read-only analytics over the live funnel: regions, score spread, coverage and
// signal momentum across the active stages.
app.get('/api/pipeline/analytics', async (_req, res) => {
  try {
    const [regions, scores, coverage, momentum] = await Promise.all([
      pool.query(
        `SELECT COALESCE(l.region, co.region) AS region, count(*)::int AS n
         FROM leads l JOIN companies co ON co.id = l.company_id
         WHERE l.stage = ANY($1) GROUP BY 1 ORDER BY n DESC`, [STAGES]),
      pool.query(
        `SELECT count(*) FILTER (WHERE score >= 70)::int AS strong,
                count(*) FILTER (WHERE score >= 40 AND score < 70)::int AS middle,
                count(*) FILTER (WHERE score < 40)::int AS weak,
                count(*) FILTER (WHERE score IS NULL)::int AS unscored,
                round(percentile_cont(0.5) WITHIN GROUP (ORDER BY score))::int AS median,
                count(*)::int AS total
         FROM leads WHERE stage = ANY($1)`, [STAGES]),
      pool.query(
        `SELECT count(*)::int AS leads,
                count(*) FILTER (WHERE EXISTS (
                  SELECT 1 FROM contacts ct
                  WHERE ct.company_id = l.company_id AND ct.source = 'ch_officers' AND NOT ct.suppressed
                ))::int AS with_contact,
                count(*) FILTER (WHERE co.domain IS NOT NULL)::int AS with_domain
         FROM leads l JOIN companies co ON co.id = l.company_id
         WHERE l.stage = ANY($1)`, [STAGES]),
      pool.query(
        `SELECT count(*)::int AS n FROM signals s
         WHERE s.observed_at >= now() - interval '30 days'
           AND s.company_id IN (SELECT company_id FROM leads WHERE stage = ANY($1))`, [STAGES]),
    ]);
    res.json({
      regions: regions.rows.map(r => ({ region: regionName(r.region) || 'Unassigned', n: r.n })),
      scores: scores.rows[0],
      coverage: {
        leads: coverage.rows[0].leads,
        withContact: coverage.rows[0].with_contact,
        withDomain: coverage.rows[0].with_domain,
      },
      signals30: momentum.rows[0].n,
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
      // Stored breakdowns carry their own max per component, so rows scored
      // under the contactability draft display against the right caps.
      icp: [...ICP_ROWS, ...(bd.contactability ? [['contactability', 'Contactability', 10]] : [])]
        .map(([key, label, max]) => ({
          label, max: bd[key]?.max ?? max, points: bd[key]?.points ?? null, reason: bd[key]?.reason ?? null,
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

app.get('/api/outbound/status', async (_req, res) => {
  try {
    const counts = (await pool.query(
      `SELECT status, count(*)::int AS n FROM outbound_drafts GROUP BY status`)).rows
      .reduce((a, r) => { a[r.status] = r.n; return a; }, {});
    res.json({
      killSwitch: (process.env.MAIL_KILL_SWITCH || 'on') !== 'off' ? 'on' : 'off',
      testSends: (process.env.OUTBOUND_TEST_SENDS || 'off') === 'on' ? 'on' : 'off',
      testRecipients: testRecipientList(),
      counts,
    });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// The review queue. Lists drafts with their lead, evidence and recipient so a
// human can read, edit, approve, reject or test-send before anything goes out.
app.get('/api/outbound/drafts', async (req, res) => {
  try {
    const status = /^[a-z]+$/.test(String(req.query.status || '')) ? req.query.status : null;
    const { rows } = await pool.query(
      `SELECT d.id, d.subject, d.body, d.status, d.rationale, d.created_at, d.sent_at,
              c.name AS company, c.region, c.icp_score,
              ct.full_name AS contact_name, ct.role_title, ct.email
       FROM outbound_drafts d
       JOIN companies c ON c.id = d.company_id
       LEFT JOIN contacts ct ON ct.id = d.contact_id
       ${status ? 'WHERE d.status = $1' : ''}
       ORDER BY d.created_at DESC LIMIT 200`,
      status ? [status] : []);
    res.json({ drafts: rows.map(r => ({
      id: r.id, subject: r.subject, body: r.body, status: r.status,
      rationale: r.rationale, createdAt: r.created_at, sentAt: r.sent_at,
      company: r.company, region: r.region, score: r.icp_score,
      contact: r.contact_name ? { name: r.contact_name, role: r.role_title, email: r.email } : null,
    })) });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Edit subject or body, allowed only while the draft is still open.
app.patch('/api/outbound/drafts/:id', async (req, res) => {
  try {
    const { subject, body } = req.body || {};
    if (subject == null && body == null) return res.status(400).json({ error: 'nothing to update' });
    const { rows } = await pool.query(
      `UPDATE outbound_drafts SET subject = COALESCE($2, subject), body = COALESCE($3, body), updated_at = now()
       WHERE id = $1 AND status IN ('draft','approved') RETURNING status`,
      [req.params.id, subject ?? null, body ?? null]);
    if (!rows.length) return res.status(409).json({ error: 'draft is not editable' });
    res.json({ ok: true, status: rows[0].status });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Approve moves a draft to approved; reject closes it from either open state and
// frees the lead's slot for a future draft.
async function setDraftStatus(id, to, from) {
  const { rows } = await pool.query(
    `UPDATE outbound_drafts SET status = $2, updated_at = now()
     WHERE id = $1 AND status = ANY($3) RETURNING status`,
    [id, to, from]);
  return rows[0]?.status || null;
}
app.post('/api/outbound/drafts/:id/approve', async (req, res) => {
  try {
    const s = await setDraftStatus(req.params.id, 'approved', ['draft']);
    if (!s) return res.status(409).json({ error: 'only a draft can be approved' });
    res.json({ ok: true, status: s });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
app.post('/api/outbound/drafts/:id/reject', async (req, res) => {
  try {
    const s = await setDraftStatus(req.params.id, 'rejected', ['draft', 'approved']);
    if (!s) return res.status(409).json({ error: 'draft is not open' });
    res.json({ ok: true, status: s });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Internal test send. The recipient must be on the internal allowlist; mail.mjs
// refuses anything else and refuses entirely unless test sends are enabled. Every
// attempt is logged, and a test send never changes the draft status.
app.post('/api/outbound/drafts/:id/send-test', async (req, res) => {
  try {
    const to = String((req.body || {}).to || '').trim();
    if (!isTestRecipient(to)) return res.status(400).json({ error: 'recipient is not on the internal test allowlist' });
    const { rows } = await pool.query(`SELECT id, subject, body FROM outbound_drafts WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'draft not found' });
    const d = rows[0];
    const result = await sendMailTest({ to, subject: d.subject, html: textToHtml(d.body) });
    await pool.query(
      `INSERT INTO outbound_sends (draft_id, to_email, subject, test_mode, sent, reason)
       VALUES ($1, $2, $3, true, $4, $5)`,
      [d.id, to, d.subject, !!result.sent, result.reason || null]);
    res.json(result);
  } catch (e) { res.status(500).json({ error: String(e) }); }
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
