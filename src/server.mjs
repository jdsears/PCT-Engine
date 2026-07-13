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
import { sendMail, sendMailTest, sendInternal, digestRecipients, isTestRecipient, textToHtml, testRecipientList } from './mail.mjs';
import { gatherDigestData, renderDigest, digestDue } from './digest.mjs';
import { canSendReal } from './outbound/sendDecision.mjs';
import { runResearch } from './research/runResearch.mjs';
import { shouldRun } from './research/schedule.mjs';
import { generateDrafts } from './outbound/generateDrafts.mjs';
import { discoverEmails } from './research/emailDiscovery.mjs';
import { generateLiPosts, connectNote } from './studio/liPosts.mjs';

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
    if (String(question).length > 2000) {
      return res.status(400).json({ error: 'the question is too long; please ask it in a shorter form' });
    }
    const result = await ask(question, {
      history: Array.isArray(history) ? history : [],
      configState: configState || null,
    });
    // Log before replying, so the reply can carry the row id and the answer's
    // feedback chips have something to attach to. The insert is a few
    // milliseconds on the internal network; a logging failure still never fails
    // the answer, the id is simply null and the chips do not show. A
    // configurator turn is not a retrieval query, so it is not logged here.
    const isConfigTurn = !!(result.configState || result.configOptions || result.configurator || result.configLog);
    let queryLogId = null;
    if (!isConfigTurn) try {
      const ins = await pool.query(
        `INSERT INTO copilot_queries (question, detected_filters, declined, citations_used, sources_offered, latency_ms)
         VALUES ($1, $2::jsonb, $3, $4::jsonb, $5, $6) RETURNING id`,
        [question, JSON.stringify(result.filters || {}), !!result.declined,
         JSON.stringify(result.citationsUsed || []), result.sourcesOffered ?? null, result.latencyMs ?? null]);
      queryLogId = ins.rows[0]?.id ?? null;
    } catch (e) { console.error('query log insert failed:', e.message); }
    res.json({ ...result, queryLogId });

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

// A thumb up or down against a logged answer. No identity, only the verdict.
app.post('/api/feedback', async (req, res) => {
  try {
    const { queryLogId, verdict } = req.body || {};
    if (!Number.isInteger(queryLogId) || !['up', 'down'].includes(verdict)) {
      return res.status(400).json({ error: 'queryLogId and a verdict of up or down are required' });
    }
    const { rowCount } = await pool.query(
      `UPDATE copilot_queries SET feedback = $2, feedback_at = now() WHERE id = $1`,
      [queryLogId, verdict]);
    if (!rowCount) return res.status(404).json({ error: 'no logged answer with that id' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// The weekly digest, on demand: preview the wording, or send it now to the
// digest list. The Monday schedule runs by itself when DIGEST_RECIPIENTS is set.
app.get('/api/digest/preview', async (_req, res) => {
  try { res.json(renderDigest(await gatherDigestData())); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});
app.post('/api/digest/send', async (_req, res) => {
  try { res.json(await sendDigestOnce('manual')); }
  catch (e) { res.status(500).json({ error: String(e) }); }
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
              count(*) FILTER (WHERE feedback = 'up')::int AS fb_up,
              count(*) FILTER (WHERE feedback = 'down')::int AS fb_down,
              round(avg(latency_ms))::int AS avg_latency_ms
       FROM copilot_queries WHERE created_at >= now() - make_interval(days => $1)`, [days]);
    const channels = await pool.query(
      `SELECT COALESCE(channel, 'web') AS channel, count(*)::int AS n
       FROM copilot_queries WHERE created_at >= now() - make_interval(days => $1)
       GROUP BY 1 ORDER BY n DESC`, [days]);
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
      feedback: { up: t.fb_up, down: t.fb_down },
      byChannel: channels.rows,
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
              (SELECT count(*)::int FROM signals s WHERE s.company_id = c.id) AS signals,
              (SELECT count(*)::int FROM contacts ct
                WHERE ct.company_id = c.id AND ct.in_decision_orbit AND NOT ct.suppressed) AS people
       FROM companies c WHERE c.named_account
       ORDER BY c.icp_score DESC NULLS LAST, c.name LIMIT 200`);
    res.json({ companies: rows.map(c => ({
      id: c.id, name: c.name, type: c.company_type, region: regionName(c.region),
      domain: c.domain, chNumber: c.ch_number, score: c.score, signals: c.signals, people: c.people,
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
    // The people the research actually identified to contact: decision-orbit
    // contacts from any source, verified emails first. These are the build-spec
    // specifiers and buyers, distinct from the statutory directors below.
    const people = await pool.query(
      `SELECT full_name, role_title, email, linkedin_url FROM contacts
       WHERE company_id = $1 AND in_decision_orbit AND NOT suppressed
       ORDER BY email_verified_at IS NULL, email_confidence DESC NULLS LAST, full_name LIMIT 12`, [id]);
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
      people: people.rows.map(p => ({ name: p.full_name, role: p.role_title, email: p.email, linkedin: p.linkedin_url })),
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
      `SELECT s.id, s.signal_type, s.title, s.url, s.observed_at, s.geo_scope,
              c.id AS company_id, c.name AS company
       FROM signals s LEFT JOIN companies c ON c.id = s.company_id
       WHERE s.dc_relevant IS NOT FALSE AND ($1::text[] IS NULL OR s.signal_type = ANY($1))
       ORDER BY s.observed_at DESC LIMIT 50`, [types]);
    const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };
    res.json({ signals: rows.map(s => ({
      id: s.id, type: s.signal_type, title: s.title, observedAt: s.observed_at, geoScope: s.geo_scope,
      source: host(s.url) || (s.signal_type.startsWith('ch_') ? 'Companies House stream' : null),
      companyId: s.company_id, company: s.company,
    })) });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// The BD watchlist: data-centre operators the engine has spotted expanding, where
// a UK move is plausible but not yet a project. Intelligence, not leads.
app.get('/api/watchlist', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, signal_type, title, url, operator, observed_at FROM signals
       WHERE dc_relevant AND geo_scope = 'expansion_watch'
       ORDER BY observed_at DESC LIMIT 50`);
    const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };
    res.json({ watchlist: rows.map(s => ({
      id: s.id, type: s.signal_type, title: s.title, operator: s.operator,
      source: host(s.url), url: s.url, observedAt: s.observed_at,
    })) });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ----- The signal engine -----
// Finding signals and pulling leads runs in the service on a cycle, switched
// from the UI. The on/off lives in the kv store so a toggle needs no redeploy,
// and the last run's summary is kept there for the Health card. The research
// run sends nothing and never touches the LinkedIn lane or the mail kill
// switch; drafting and sending stay manual and gated as before.
const ENGINE_INTERVAL_MS = Math.max(1, Number(process.env.ENGINE_RUN_INTERVAL_HOURS || 6)) * 3600_000;
let engineRunning = false;

const kvGet = async (key) => (await pool.query(`SELECT value FROM kv WHERE key = $1`, [key])).rows[0]?.value ?? null;
const kvSet = (key, value) => pool.query(
  `INSERT INTO kv (key, value, updated_at) VALUES ($1, $2::jsonb, now())
   ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = now()`,
  [key, JSON.stringify(value)]);

async function engineStatus() {
  const enabled = (await kvGet('engine_enabled')) === 'on';
  const lastRun = await kvGet('engine_last_run');
  return {
    enabled, running: engineRunning,
    autoDiscover: (await kvGet('autodiscover_enabled')) === 'on',
    intervalHours: ENGINE_INTERVAL_MS / 3600_000,
    lastRun,
    keys: {
      companiesHouse: !!process.env.COMPANIES_HOUSE_API_KEY,
      tavily: !!process.env.TAVILY_API_KEY,
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      findymail: !!(process.env.FINDYMAIL_API_KEY || '').trim(),
    },
  };
}

async function runEngineOnce(trigger) {
  if (engineRunning) return false;
  engineRunning = true;
  const startedAt = new Date().toISOString();
  try {
    const r = await runResearch({ log: m => console.log('[engine]', m) });
    // With auto email discovery on, decision makers found this cycle (and any
    // backlog) get their emails resolved before drafting, capped per cycle so
    // the Findymail spend stays bounded. A verified email is never re-bought.
    let discovery = null;
    if ((await kvGet('autodiscover_enabled')) === 'on') {
      const cap = Math.max(1, Number(process.env.ENGINE_EMAIL_DISCOVERY_LIMIT || 10));
      discovery = await discoverEmails({ limit: cap, log: m => console.log('[emails]', m) });
    }
    await kvSet('engine_last_run', {
      ok: true, at: startedAt, trigger,
      signalsStored: r.newsCounts.inserted ?? 0, signalsRejected: r.newsCounts.rejected ?? 0,
      filings: (r.chCounts.ch_filing ?? 0) + (r.chCounts.ch_director_change ?? 0),
      matched: r.newsMatched, scored: r.scored,
      leadsCreated: r.leadsCreated, leadsUpdated: r.leadsUpdated,
      awaitingMatch: r.awaitingMatch,
      emailsResolved: discovery ? discovery.resolved : undefined,
      emailCredits: discovery ? discovery.credits : undefined,
    });
    // With auto-draft on, freshly researched leads get a grounded draft into
    // the review queue at the end of the cycle. Review, approval and sending
    // are untouched: a generated draft is still only a draft.
    if ((await kvGet('autodraft_enabled')) === 'on') await runDraftsOnce('engine');
  } catch (e) {
    console.error('[engine] run failed:', e.message);
    try { await kvSet('engine_last_run', { ok: false, at: startedAt, trigger, error: String(e.message).slice(0, 300) }); } catch { /* reported on the next status read */ }
  } finally { engineRunning = false; }
  return true;
}

// Draft generation, shared by the Outbound page's generate button, the manual
// script, and the engine's auto-draft step. One run at a time; every attempt's
// outcome lands in kv for the Outbound banner. No send path is involved.
let draftingRunning = false;
async function runDraftsOnce(trigger, limit = 5) {
  if (draftingRunning) return false;
  draftingRunning = true;
  const startedAt = new Date().toISOString();
  try {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set on this service');
    const r = await generateDrafts({ limit, log: m => console.log('[drafts]', m) });
    await kvSet('outbound_last_draft_run', { ok: true, at: startedAt, trigger, ...r });
  } catch (e) {
    console.error('[drafts] run failed:', e.message);
    try { await kvSet('outbound_last_draft_run', { ok: false, at: startedAt, trigger, error: String(e.message).slice(0, 300) }); } catch { /* reported on the next read */ }
  } finally { draftingRunning = false; }
  return true;
}

// The weekly digest: the engine reporting its week to the internal digest list
// every Monday morning. Internal mail only, its own allowlist, no prospects.
async function sendDigestOnce(trigger) {
  const recipients = digestRecipients();
  if (!recipients.length) return { sent: 0, reason: 'DIGEST_RECIPIENTS is not set' };
  const { subject, text } = renderDigest(await gatherDigestData());
  let sent = 0;
  for (const to of recipients) {
    try { const r = await sendInternal({ to, subject, html: textToHtml(text) }); if (r.sent) sent++; }
    catch (e) { console.error('[digest] send failed:', e.message); }
  }
  try { await kvSet('digest_last_sent', { at: new Date().toISOString(), trigger, sent, of: recipients.length }); } catch { /* next tick retries */ }
  return { sent, of: recipients.length };
}

// The tick is cheap: read the switch and the last run, decide, maybe run. Any
// error is logged and the next tick tries again.
setInterval(async () => {
  try {
    const enabled = (await kvGet('engine_enabled')) === 'on';
    const lastRun = await kvGet('engine_last_run');
    if (shouldRun({ enabled, running: engineRunning, lastRunAt: lastRun?.at ?? null, intervalMs: ENGINE_INTERVAL_MS })) {
      await runEngineOnce('schedule');
    }
    if (digestRecipients().length) {
      const lastDigest = await kvGet('digest_last_sent');
      if (digestDue({ lastSentAt: lastDigest?.at ?? null })) await sendDigestOnce('schedule');
    }
  } catch (e) { console.error('[engine] tick failed:', e.message); }
}, 5 * 60_000).unref();

app.get('/api/engine/status', async (_req, res) => {
  try { res.json(await engineStatus()); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/engine/toggle', async (req, res) => {
  try {
    const enabled = (req.body || {}).enabled === true;
    await kvSet('engine_enabled', enabled ? 'on' : 'off');
    res.json(await engineStatus());
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// The auto email discovery switch: when on, each engine cycle resolves emails
// for decision makers without a verified one, capped per cycle. Lives in kv.
app.post('/api/engine/autodiscover', async (req, res) => {
  try {
    const enabled = (req.body || {}).enabled === true;
    await kvSet('autodiscover_enabled', enabled ? 'on' : 'off');
    res.json(await engineStatus());
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/engine/run-now', async (_req, res) => {
  try {
    if (engineRunning) return res.json({ started: false, reason: 'a run is already in flight' });
    runEngineOnce('manual'); // deliberately not awaited: the run takes minutes
    res.json({ started: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ----- The LinkedIn studio -----
// Post drafts from the engine's gated signals, and the connect queue over the
// decision-orbit contacts. Nothing here posts to LinkedIn or sends an invite:
// the human copies and acts from their own account, then marks it done, and the
// engine keeps the books. The lane's read-only rule stands untouched.
app.get('/api/studio/posts', async (req, res) => {
  try {
    const status = /^[a-z]+$/.test(String(req.query.status || '')) ? req.query.status : 'draft';
    const { rows } = await pool.query(
      `SELECT id, topic, body, grounding, status, created_at, posted_at FROM li_posts
       WHERE status = $1 ORDER BY created_at DESC LIMIT 50`, [status]);
    res.json({ posts: rows.map(p => ({
      id: p.id, topic: p.topic, body: p.body, status: p.status,
      source: p.grounding?.signal?.source ?? null, flags: p.grounding?.flags ?? [],
      createdAt: p.created_at, postedAt: p.posted_at,
    })) });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/studio/posts/generate', async (req, res) => {
  try {
    const limit = Number.isInteger((req.body || {}).limit) ? (req.body || {}).limit : 3;
    if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY is not set on this service' });
    res.json(await generateLiPosts({ limit }));
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.patch('/api/studio/posts/:id', async (req, res) => {
  try {
    const body = String((req.body || {}).body || '').trim();
    if (!body) return res.status(400).json({ error: 'a post body is required' });
    const { rowCount } = await pool.query(
      `UPDATE li_posts SET body = $2, updated_at = now() WHERE id = $1 AND status = 'draft'`, [req.params.id, body]);
    if (!rowCount) return res.status(409).json({ error: 'only a draft post can be edited' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Marked by the human after they have posted it from their own account.
app.post('/api/studio/posts/:id/posted', async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE li_posts SET status = 'posted', posted_at = now(), updated_at = now() WHERE id = $1 AND status = 'draft'`, [req.params.id]);
    if (!rowCount) return res.status(409).json({ error: 'only a draft post can be marked posted' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/studio/posts/:id/reject', async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE li_posts SET status = 'rejected', updated_at = now() WHERE id = $1 AND status = 'draft'`, [req.params.id]);
    if (!rowCount) return res.status(409).json({ error: 'only a draft post can be rejected' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// The connect queue: decision-orbit people with a LinkedIn profile who have not
// been invited, best accounts first, each with a suggested note to copy.
app.get('/api/studio/connects', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ct.id, ct.full_name, ct.role_title, ct.linkedin_url, c.name AS company, round(c.icp_score)::int AS score
       FROM contacts ct JOIN companies c ON c.id = ct.company_id
       WHERE ct.in_decision_orbit AND NOT ct.suppressed AND ct.linkedin_url IS NOT NULL AND ct.li_invited_at IS NULL
       ORDER BY c.icp_score DESC NULLS LAST, ct.full_name LIMIT 50`);
    res.json({ connects: rows.map(ct => ({
      id: ct.id, name: ct.full_name, role: ct.role_title, linkedin: ct.linkedin_url,
      company: ct.company, score: ct.score,
      note: connectNote({ full_name: ct.full_name, role_title: ct.role_title }, ct.company),
    })) });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Marked by the human after they have sent the invite from their own account,
// so the queue never suggests the same person twice.
app.post('/api/studio/connects/:id/invited', async (req, res) => {
  try {
    const note = String((req.body || {}).note || '').slice(0, 300) || null;
    const { rowCount } = await pool.query(
      `UPDATE contacts SET li_invited_at = now(), li_invite_note = $2 WHERE id = $1 AND li_invited_at IS NULL`, [req.params.id, note]);
    if (!rowCount) return res.status(409).json({ error: 'already marked invited' });
    res.json({ ok: true });
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
      drafting: {
        running: draftingRunning,
        autoDraft: (await kvGet('autodraft_enabled')) === 'on',
        lastRun: await kvGet('outbound_last_draft_run'),
      },
    });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Generate a batch of drafts now, from the Outbound page. Kicks off in the
// background since a batch takes a minute or two of model calls.
app.post('/api/outbound/generate', async (req, res) => {
  try {
    if (draftingRunning) return res.json({ started: false, reason: 'a drafting run is already in flight' });
    const limit = Number.isInteger((req.body || {}).limit) ? (req.body || {}).limit : 5;
    runDraftsOnce('manual', limit); // deliberately not awaited
    res.json({ started: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// The auto-draft switch: when on, the signal engine drafts for newly researched
// leads at the end of each cycle. Lives in kv, so no redeploy to flip it.
app.post('/api/outbound/autodraft', async (req, res) => {
  try {
    const enabled = (req.body || {}).enabled === true;
    await kvSet('autodraft_enabled', enabled ? 'on' : 'off');
    res.json({ autoDraft: enabled });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// The review queue. Lists drafts with their lead, evidence and recipient so a
// human can read, edit, approve, reject or test-send before anything goes out.
app.get('/api/outbound/drafts', async (req, res) => {
  try {
    const status = /^[a-z]+$/.test(String(req.query.status || '')) ? req.query.status : null;
    const { rows } = await pool.query(
      `SELECT d.id, d.subject, d.body, d.status, d.rationale, d.grounding, d.grounding_flags,
              d.email_type, d.created_at, d.sent_at,
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
      rationale: r.rationale, grounding: r.grounding || null, groundingFlags: r.grounding_flags || [],
      emailType: r.email_type, createdAt: r.created_at, sentAt: r.sent_at,
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
    // A blocking flag (a named end customer) prevents clean approval; it must be
    // rewritten first. Advisory flags do not block.
    const fr = await pool.query(`SELECT grounding_flags FROM outbound_drafts WHERE id = $1`, [req.params.id]);
    const flags = Array.isArray(fr.rows[0]?.grounding_flags) ? fr.rows[0].grounding_flags : [];
    if (flags.some(f => /^blocking/i.test(String(f)))) {
      return res.status(409).json({ error: 'this draft has a blocking flag (a named end customer) and cannot be approved until it is rewritten' });
    }
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

// Real prospect send. Allowed only for an approved draft with a deliverable,
// non-suppressed recipient; the kill switch (in sendMail) is the final gate, so a
// refused send returns 200 with the reason and changes nothing. A real send logs,
// marks the draft sent, and advances the lead to the outbound stage.
app.post('/api/outbound/drafts/:id/send', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT d.id, d.subject, d.body, d.status, d.lead_id, ct.email, ct.suppressed
       FROM outbound_drafts d LEFT JOIN contacts ct ON ct.id = d.contact_id
       WHERE d.id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'draft not found' });
    const d = rows[0];
    const gate = canSendReal({ status: d.status, contactEmail: d.email, suppressed: d.suppressed });
    if (!gate.ok) return res.status(409).json({ error: gate.reason });

    const result = await sendMail({ to: d.email, subject: d.subject, html: textToHtml(d.body) });
    await pool.query(
      `INSERT INTO outbound_sends (draft_id, to_email, subject, test_mode, sent, reason, graph_message_id, conversation_id, internet_message_id)
       VALUES ($1, $2, $3, false, $4, $5, $6, $7, $8)`,
      [d.id, d.email, d.subject, !!result.sent, result.reason || null,
       result.messageId || null, result.conversationId || null, result.internetMessageId || null]);

    if (result.sent) {
      await pool.query(`UPDATE outbound_drafts SET status = 'sent', sent_at = now(), updated_at = now() WHERE id = $1`, [d.id]);
      if (d.lead_id) await pool.query(
        `UPDATE leads SET stage = 'outbound', updated_at = now() WHERE id = $1 AND stage IN ('sourced','researched')`, [d.lead_id]);
    }
    res.json(result);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Captured prospect replies, newest first, for the review surface.
app.get('/api/outbound/replies', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.id, r.from_email, r.subject, r.snippet, r.received_at, r.draft_id, c.name AS company
       FROM outbound_replies r
       LEFT JOIN outbound_drafts d ON d.id = r.draft_id
       LEFT JOIN companies c ON c.id = d.company_id
       ORDER BY r.received_at DESC NULLS LAST LIMIT 200`);
    res.json({ replies: rows.map(r => ({
      id: r.id, from: r.from_email, subject: r.subject, snippet: r.snippet,
      receivedAt: r.received_at, draftId: r.draft_id, company: r.company,
    })) });
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
