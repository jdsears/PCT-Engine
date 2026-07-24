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
import { sendMail, sendMailTest, sendMailReply, sendInternal, sendTeamNote, digestRecipients, isTestRecipient, textToHtml, testRecipientList, prospectHtml, signatureBlock } from './mail.mjs';
import { gatherDigestData, renderDigest, digestDue } from './digest.mjs';
import { canSendReal, hasBlockingFlag } from './outbound/sendDecision.mjs';
import { reflagText } from './outbound/draft.mjs';
import { runResearch } from './research/runResearch.mjs';
import { shouldRun } from './research/schedule.mjs';
import { generateDrafts } from './outbound/generateDrafts.mjs';
import { pollReplies } from './outbound/replies.mjs';
import { triageReplies } from './outbound/triage.mjs';
import { sweepFollowups } from './outbound/followups.mjs';
import { rotateContacts } from './outbound/rotation.mjs';
import { draftResponse } from './outbound/respond.mjs';
import { gatherHandoffData, renderHandoffPack } from './outbound/handoff.mjs';
import { startRehearsal, rehearsalStatus, endRehearsal } from './outbound/rehearsal.mjs';
import { lookupPrice, priceStatus } from './pricing/lookup.mjs';
import { buildRangeTree } from './pricing/marwinRanges.mjs';
import { senderFor } from './outbound/senders.mjs';
import { syncSharepointDocs, syncRoots } from './sharepointSync.mjs';
import { resolveSite, resolveDrive, docWebUrl } from './sharepoint.mjs';
import { discoverEmails } from './research/emailDiscovery.mjs';
import { discoverPeople } from './research/peopleDiscovery.mjs';
import { processIntelInbox, pendingIntelEmails, intelSenders } from './studio/intelInbox.mjs';
import { canInvite, sendConnectionInvite, invitesUsedToday, inviteDailyCap, inviteReady } from './studio/liInvite.mjs';
import { CapReached, AccountUnhealthy } from './research/unipile.mjs';
import { generateLiPosts, connectNote, postFlags } from './studio/liPosts.mjs';

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
    // A completed build carries its pricing answer when the price lookup is
    // on: a stored price where one exists, or for the quoted lines the
    // enquiry process, never a guessed number. A pricing failure never fails
    // the build.
    let pricing = null;
    if (result.configurator?.code) {
      try {
        if ((await kvGet('pricelookup_enabled')) === 'on') pricing = await lookupPrice(result.configurator.code);
      } catch { pricing = null; }
    }
    res.json({ ...result, ...(pricing ? { pricing } : {}), queryLogId });

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

// The intel inbox, on demand: see what is waiting, or process it now. The tick
// polls by itself every five minutes when INTEL_SENDERS is set.
app.get('/api/intel/status', async (_req, res) => {
  try {
    res.json({
      senders: intelSenders().length, running: intelRunning,
      pending: (await pendingIntelEmails()).map(e => ({ subject: e.subject, from: e.from, receivedAt: e.receivedAt })),
      lastRun: await kvGet('intel_last_run'),
    });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
app.post('/api/intel/poll', async (_req, res) => {
  try {
    if (intelRunning) return res.json({ started: false, reason: 'an intel run is already in flight' });
    if (!intelSenders().length) return res.json({ started: false, reason: 'INTEL_SENDERS is not set' });
    pollIntelOnce('manual'); // deliberately not awaited: splitting and gating takes a minute
    res.json({ started: true });
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
    autoPeople: (await kvGet('autopeople_enabled')) === 'on',
    autoSync: (await kvGet('sharepoint_sync_enabled')) === 'on',
    syncConfigured: syncRoots().length > 0,
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
    // With the people search on, a tiny batch of unsearched named accounts
    // gets its specifiers found each cycle, before email discovery so the new
    // orbit contacts can have their addresses resolved in the same pass. It
    // runs on James's account, so an account-health error stands the feature
    // down rather than letting the schedule knock again.
    let people = null;
    if ((await kvGet('autopeople_enabled')) === 'on') {
      people = await discoverPeople({ log: m => console.log('[people]', m) });
      if (people.unhealthy) {
        await kvSet('autopeople_enabled', 'off');
        await sendTeamNote('LinkedIn account health stopped the people search',
          `Unipile reported an account health problem during the engine's people search, so the automatic search has switched itself off and nothing will retry.\n\n${people.unhealthy}\n\nCheck the LinkedIn account (a login prompt or checkpoint usually explains it), then turn the switch back on from the Health page.`);
      }
    }
    // With auto email discovery on, decision makers found this cycle (and any
    // backlog) get their emails resolved before drafting, capped per cycle so
    // the Findymail spend stays bounded. A verified email is never re-bought.
    let discovery = null;
    if ((await kvGet('autodiscover_enabled')) === 'on') {
      const cap = Math.max(1, Number(process.env.ENGINE_EMAIL_DISCOVERY_LIMIT || 10));
      discovery = await discoverEmails({ limit: cap, log: m => console.log('[emails]', m) });
    }
    // With the SharePoint sync on, the corpus refreshes from the configured
    // folders: changed files re-embed, removed files withdraw. A sync failure
    // is recorded and never fails the cycle.
    let spSync = null;
    if ((await kvGet('sharepoint_sync_enabled')) === 'on') {
      spSync = await syncSharepointDocs({ log: m => console.log('[sharepoint]', m) })
        .catch(e => ({ errors: [String(e.message).slice(0, 200)] }));
      if (spSync?.errors?.length) console.log('[sharepoint] errors:', spSync.errors.join(' | '));
    }
    await kvSet('engine_last_run', {
      ok: true, at: startedAt, trigger,
      signalsStored: r.newsCounts.inserted ?? 0, signalsRejected: r.newsCounts.rejected ?? 0,
      filings: (r.chCounts.ch_filing ?? 0) + (r.chCounts.ch_director_change ?? 0),
      matched: r.newsMatched, scored: r.scored,
      leadsCreated: r.leadsCreated, leadsUpdated: r.leadsUpdated,
      awaitingMatch: r.awaitingMatch,
      peopleSearched: people ? people.companies : undefined,
      peopleFound: people ? people.created : undefined,
      peopleOrbit: people ? people.orbit : undefined,
      peopleStopped: people?.unhealthy ? 'account health' : people?.capStopped ? 'daily cap' : undefined,
      emailsResolved: discovery ? discovery.resolved : undefined,
      emailCredits: discovery ? discovery.credits : undefined,
      docsChecked: spSync && !spSync.skipped ? spSync.files : undefined,
      docsUpdated: spSync && !spSync.skipped ? spSync.updated : undefined,
      docsRemoved: spSync && !spSync.skipped ? spSync.removed : undefined,
      docsErrors: spSync?.errors?.length ? spSync.errors.length : undefined,
      docsSkipped: spSync?.skipped || undefined,
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
const autodraftLimit = () => Math.max(1, Math.min(20, parseInt(process.env.ENGINE_AUTODRAFT_LIMIT || '10', 10) || 10));
let draftingRunning = false;
async function runDraftsOnce(trigger, limit = autodraftLimit()) {
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

// Reply capture and triage: poll the mailbox for replies to our sends, then
// read, classify and act on each new one, notify the team within minutes, and
// draft the grounded response where the reply earns one. Behind its own kv
// switch; one run at a time.
let repliesRunning = false;
async function pollAndTriageOnce(trigger) {
  if (repliesRunning) return false;
  repliesRunning = true;
  const startedAt = new Date().toISOString();
  try {
    const polled = await pollReplies(pool, { apply: true });
    let triage = null;
    if (process.env.ANTHROPIC_API_KEY) {
      triage = await triageReplies({ log: m => console.log('[replies]', m) });
    }
    // Always recorded, quiet runs included: the banner shows the heartbeat, so
    // a silent poller is visible rather than indistinguishable from a broken one.
    await kvSet('replies_last_run', { ok: true, at: startedAt, trigger, ...polled, triage });
  } catch (e) {
    console.error('[replies] poll failed:', e.message);
    try { await kvSet('replies_last_run', { ok: false, at: startedAt, trigger, error: String(e.message).slice(0, 300) }); } catch { /* next read */ }
  } finally { repliesRunning = false; }
  return true;
}

// The follow-up sweep: draft the next touch for threads that have gone quiet,
// into the review queue, and rotate spent sequences to the company's next
// specifier so a dead thread becomes a fresh one after the rest period.
// Behind the follow-ups switch; one run at a time.
let followupsRunning = false;
async function sweepFollowupsOnce(trigger) {
  if (followupsRunning) return false;
  followupsRunning = true;
  const startedAt = new Date().toISOString();
  try {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set on this service');
    const r = await sweepFollowups({ log: m => console.log('[followups]', m) });
    const rot = await rotateContacts({ log: m => console.log('[rotate]', m) });
    if (r.due > 0 || r.failed > 0 || rot.rotated > 0 || rot.rested > 0) {
      await kvSet('followups_last_run', { ok: true, at: startedAt, trigger, ...r, rotation: rot });
    }
  } catch (e) {
    console.error('[followups] sweep failed:', e.message);
    try { await kvSet('followups_last_run', { ok: false, at: startedAt, trigger, error: String(e.message).slice(0, 300) }); } catch { /* next read */ }
  } finally { followupsRunning = false; }
  return true;
}

// The intel inbox: forwarded newsletters split and routed through the same
// relevance gate as the sweep. Polled on the tick when INTEL_SENDERS is set;
// one run at a time, and its outcome lands in kv for the status read.
let intelRunning = false;
async function pollIntelOnce(trigger) {
  if (intelRunning) return false;
  intelRunning = true;
  const startedAt = new Date().toISOString();
  try {
    const r = await processIntelInbox({ log: m => console.log('[intel]', m) });
    if (r.emails > 0) {
      try { await kvSet('intel_last_run', { ok: true, at: startedAt, trigger, ...r }); } catch { /* next read */ }
    }
  } catch (e) {
    console.error('[intel] poll failed:', e.message);
    try { await kvSet('intel_last_run', { ok: false, at: startedAt, trigger, error: String(e.message).slice(0, 300) }); } catch { /* next read */ }
  } finally { intelRunning = false; }
  return true;
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
    if (intelSenders().length) await pollIntelOnce('schedule');
    if ((await kvGet('replycapture_enabled')) === 'on') await pollAndTriageOnce('schedule');
    if ((await kvGet('followups_enabled')) === 'on') await sweepFollowupsOnce('schedule');
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

// The people search switch: when on, each engine cycle finds specifiers for a
// tiny batch of unsearched named accounts through the LinkedIn lane. It works
// James's account, so it stands itself down on any account-health error.
app.post('/api/engine/autopeople', async (req, res) => {
  try {
    const enabled = (req.body || {}).enabled === true;
    await kvSet('autopeople_enabled', enabled ? 'on' : 'off');
    res.json(await engineStatus());
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// What the document sync currently holds, for the Health card: totals, the
// recently refreshed documents, and links back to the site, because adding
// or updating a file there is how the co-pilot learns.
app.get('/api/sharepoint/docs', async (_req, res) => {
  try {
    let totals, docs;
    try {
      totals = (await pool.query(
        `SELECT count(*)::int AS docs, COALESCE(sum(chunks), 0)::int AS chunks, max(synced_at) AS last
         FROM sharepoint_docs`)).rows[0];
      docs = (await pool.query(
        `SELECT path, line, chunks, synced_at FROM sharepoint_docs
         ORDER BY synced_at DESC LIMIT 12`)).rows;
    } catch {
      return res.json({ migrationPending: true });
    }
    let siteUrl = null, driveUrl = null;
    try {
      siteUrl = (await resolveSite()).webUrl || null;
      driveUrl = (await resolveDrive()).webUrl || null;
    } catch { /* no Graph from here; the card still shows what the database knows */ }
    res.json({
      configured: syncRoots().length > 0,
      enabled: (await kvGet('sharepoint_sync_enabled')) === 'on',
      siteUrl,
      totals: { docs: totals.docs, chunks: totals.chunks, lastSync: totals.last },
      docs: docs.map(r => ({
        name: String(r.path).split('/').pop(), path: r.path, line: r.line,
        chunks: r.chunks, syncedAt: r.synced_at, url: docWebUrl(driveUrl, r.path),
      })),
    });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// The SharePoint document sync switch: when on, each engine cycle refreshes
// the corpus from the configured Sales Engine folders. Documents only; price
// material is refused inside the sync itself.
app.post('/api/engine/autosync', async (req, res) => {
  try {
    const enabled = (req.body || {}).enabled === true;
    await kvSet('sharepoint_sync_enabled', enabled ? 'on' : 'off');
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

// The end-customer check re-runs against the edited text, so a fixed post can
// be marked posted and an unfixed one keeps its flag.
app.patch('/api/studio/posts/:id', async (req, res) => {
  try {
    const body = String((req.body || {}).body || '').trim();
    if (!body) return res.status(400).json({ error: 'a post body is required' });
    const { rows } = await pool.query(
      `UPDATE li_posts SET body = $2, updated_at = now() WHERE id = $1 AND status = 'draft'
       RETURNING grounding`, [req.params.id, body]);
    if (!rows.length) return res.status(409).json({ error: 'only a draft post can be edited' });
    const flags = postFlags(body, rows[0].grounding?.signal?.operator || null);
    await pool.query(
      `UPDATE li_posts SET grounding = jsonb_set(COALESCE(grounding, '{}'::jsonb), '{flags}', $2::jsonb) WHERE id = $1`,
      [req.params.id, JSON.stringify(flags)]);
    res.json({ ok: true, flags });
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
    res.json({
      inviteReady: inviteReady(),
      invitesToday: inviteReady() ? await invitesUsedToday() : 0,
      inviteCap: inviteDailyCap(),
      connects: rows.map(ct => ({
        id: ct.id, name: ct.full_name, role: ct.role_title, linkedin: ct.linkedin_url,
        company: ct.company, score: ct.score,
        note: connectNote({ full_name: ct.full_name, role_title: ct.role_title }, ct.company),
      })),
    });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// The sanctioned send: one invite, one named contact, one human click. The
// eligibility gate runs first, then the strict invites-per-day cap, then the
// two ledgered Unipile calls; success records the invite so the queue never
// offers the person again. An account-health error reports plainly and stops.
app.post('/api/studio/connects/:id/send-invite', async (req, res) => {
  try {
    if (!inviteReady()) return res.json({ sent: false, reason: 'Unipile is not configured on this service' });
    const { rows } = await pool.query(
      `SELECT ct.*, c.name AS company FROM contacts ct JOIN companies c ON c.id = ct.company_id WHERE ct.id = $1`,
      [req.params.id]);
    const ct = rows[0];
    const gate = canInvite(ct);
    if (!gate.ok) return res.status(409).json({ sent: false, reason: gate.reason });
    const used = await invitesUsedToday();
    if (used >= inviteDailyCap()) {
      return res.json({ sent: false, reason: `today's invite cap is reached (${used} of ${inviteDailyCap()}); the queue keeps until tomorrow` });
    }
    const note = String((req.body || {}).note || '').slice(0, 300) || connectNote({ full_name: ct.full_name, role_title: ct.role_title }, ct.company);
    const r = await sendConnectionInvite(ct, note);
    if (r.sent) {
      await pool.query(`UPDATE contacts SET li_invited_at = now(), li_invite_note = $2 WHERE id = $1`, [ct.id, note]);
    }
    res.json(r);
  } catch (e) {
    if (e instanceof AccountUnhealthy) return res.json({ sent: false, reason: `LinkedIn account health problem reported; everything stopped, nothing retried: ${String(e.message).slice(0, 200)}` });
    if (e instanceof CapReached) return res.json({ sent: false, reason: 'the daily Unipile call cap is reached; more tomorrow' });
    res.status(500).json({ error: String(e) });
  }
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
      conversation: {
        replyCapture: (await kvGet('replycapture_enabled')) === 'on',
        followups: (await kvGet('followups_enabled')) === 'on',
        followupDays: process.env.FOLLOWUP_DAYS || '4,7',
        sender: signatureBlock().split('\n')[0],
        meetingLink: Boolean((process.env.MEETING_LINK || '').trim()),
        lastReplies: await kvGet('replies_last_run'),
        lastFollowups: await kvGet('followups_last_run'),
      },
    });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// The conversation-stage switches, kv-backed like the others: reply capture
// with triage, and the follow-up sweep. No redeploy to flip either.
app.post('/api/outbound/replycapture', async (req, res) => {
  try {
    const enabled = (req.body || {}).enabled === true;
    await kvSet('replycapture_enabled', enabled ? 'on' : 'off');
    res.json({ replyCapture: enabled });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
app.post('/api/outbound/followups', async (req, res) => {
  try {
    const enabled = (req.body || {}).enabled === true;
    await kvSet('followups_enabled', enabled ? 'on' : 'off');
    res.json({ followups: enabled });
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
              d.email_type, d.campaign, d.created_at, d.sent_at,
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
      emailType: r.email_type, rehearsal: r.campaign === 'rehearsal', createdAt: r.created_at, sentAt: r.sent_at,
      company: r.company, region: r.region, score: r.icp_score,
      contact: r.contact_name ? { name: r.contact_name, role: r.role_title, email: r.email } : null,
    })) });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Edit subject or body, allowed only while the draft is still open. The
// deterministic guardrails re-run against the edited text and the stored
// flags are rewritten to match, so a hand-fixed draft approves and an
// unfixed fault keeps its flag.
app.patch('/api/outbound/drafts/:id', async (req, res) => {
  try {
    const { subject, body } = req.body || {};
    if (subject == null && body == null) return res.status(400).json({ error: 'nothing to update' });
    const { rows } = await pool.query(
      `UPDATE outbound_drafts SET subject = COALESCE($2, subject), body = COALESCE($3, body), updated_at = now()
       WHERE id = $1 AND status IN ('draft','approved') RETURNING status, subject, body, grounding`,
      [req.params.id, subject ?? null, body ?? null]);
    if (!rows.length) return res.status(409).json({ error: 'draft is not editable' });
    const flags = reflagText({ subject: rows[0].subject, body: rows[0].body, grounding: rows[0].grounding || {} });
    await pool.query(`UPDATE outbound_drafts SET grounding_flags = $2::jsonb WHERE id = $1`,
      [req.params.id, JSON.stringify(flags)]);
    res.json({ ok: true, status: rows[0].status, flags });
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
    // A blocking flag (a named end customer, an invented web address) prevents
    // clean approval; it must be rewritten first. Advisory flags do not block.
    const fr = await pool.query(`SELECT grounding_flags FROM outbound_drafts WHERE id = $1`, [req.params.id]);
    if (hasBlockingFlag(fr.rows[0]?.grounding_flags)) {
      return res.status(409).json({ error: 'this draft has a blocking flag and cannot be approved until it is rewritten' });
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

// Bulk review, for the testing loop of reject, regenerate, review. Approval in
// bulk still refuses blocking flags per draft and says how many it skipped;
// rejection in bulk frees each lead's slot for a fresh draft. Neither touches
// the rehearsal lane, so a bulk action can never kill a rehearsal mid-flight,
// and sending remains one click per email, always.
app.post('/api/outbound/drafts/approve-all', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, grounding_flags FROM outbound_drafts WHERE status = 'draft' AND campaign <> 'rehearsal'`);
    const clean = rows.filter(r => !hasBlockingFlag(r.grounding_flags)).map(r => r.id);
    const skipped = rows.length - clean.length;
    if (clean.length) {
      await pool.query(
        `UPDATE outbound_drafts SET status = 'approved', updated_at = now() WHERE id = ANY($1) AND status = 'draft'`, [clean]);
    }
    res.json({ approved: clean.length, skippedBlocking: skipped });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
app.post('/api/outbound/drafts/reject-all', async (_req, res) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE outbound_drafts SET status = 'rejected', updated_at = now()
       WHERE status = 'draft' AND campaign <> 'rehearsal'`);
    res.json({ rejected: rowCount });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Internal test send. The recipient must be on the internal allowlist; mail.mjs
// refuses anything else and refuses entirely unless test sends are enabled. Every
// attempt is logged, and a test send never changes the draft status.
app.post('/api/outbound/drafts/:id/send-test', async (req, res) => {
  try {
    const to = String((req.body || {}).to || '').trim();
    if (!isTestRecipient(to)) return res.status(400).json({ error: 'recipient is not on the internal test allowlist' });
    const { rows } = await pool.query(
      `SELECT d.id, d.subject, d.body, COALESCE(l.region, co.region) AS region
       FROM outbound_drafts d
       LEFT JOIN leads l ON l.id = d.lead_id
       LEFT JOIN companies co ON co.id = d.company_id
       WHERE d.id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'draft not found' });
    const d = rows[0];
    // The test send mirrors the real one exactly, footer, regional sender and
    // all, so what the team reviews in their inbox is what a prospect would
    // receive, from the mailbox that would really send it.
    const sender = senderFor(d.region);
    const result = await sendMailTest({ to, subject: d.subject, html: prospectHtml(d.body, sender), from: sender?.mailbox || null });
    await pool.query(
      `INSERT INTO outbound_sends (draft_id, to_email, subject, test_mode, sent, reason, sender_mailbox)
       VALUES ($1, $2, $3, true, $4, $5, $6)`,
      [d.id, to, d.subject, !!result.sent, result.reason || null, sender?.mailbox || null]);
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
      `SELECT d.id, d.subject, d.body, d.status, d.lead_id, d.email_type, d.reply_id,
              ct.email, ct.suppressed, ct.email_bounced_at,
              r.graph_message_id AS inbound_message_id, r.mailbox AS inbound_mailbox,
              COALESCE(l.region, co.region) AS region
       FROM outbound_drafts d
       LEFT JOIN contacts ct ON ct.id = d.contact_id
       LEFT JOIN outbound_replies r ON r.id = d.reply_id
       LEFT JOIN leads l ON l.id = d.lead_id
       LEFT JOIN companies co ON co.id = d.company_id
       WHERE d.id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'draft not found' });
    const d = rows[0];
    const gate = canSendReal({ status: d.status, contactEmail: d.email, suppressed: d.suppressed });
    if (!gate.ok) return res.status(409).json({ error: gate.reason });
    if (d.email_bounced_at) return res.status(409).json({ error: 'the address on file has bounced; find a fresh one before sending' });

    // A response threads as a true reply to the prospect's own message, through
    // the mailbox the inbound message lives in; a cold open or follow-up sends
    // as a tracked message from the lead's regional sender. Same footer rules,
    // same kill switch.
    const sender = senderFor(d.region);
    const html = prospectHtml(d.body, sender);
    const result = d.email_type === 'response' && d.inbound_message_id
      ? await sendMailReply({ inboundMessageId: d.inbound_message_id, html, to: d.email, from: d.inbound_mailbox || null })
      : await sendMail({ to: d.email, subject: d.subject, html, from: sender?.mailbox || null });
    const sentFrom = d.email_type === 'response' && d.inbound_message_id
      ? (d.inbound_mailbox || null) : (sender?.mailbox || null);
    await pool.query(
      `INSERT INTO outbound_sends (draft_id, to_email, subject, test_mode, sent, reason, graph_message_id, conversation_id, internet_message_id, sender_mailbox)
       VALUES ($1, $2, $3, false, $4, $5, $6, $7, $8, $9)`,
      [d.id, d.email, d.subject, !!result.sent, result.reason || null,
       result.messageId || null, result.conversationId || null, result.internetMessageId || null, sentFrom]);

    if (result.sent) {
      await pool.query(`UPDATE outbound_drafts SET status = 'sent', sent_at = now(), updated_at = now() WHERE id = $1`, [d.id]);
      if (d.lead_id) await pool.query(
        `UPDATE leads SET stage = 'outbound', updated_at = now() WHERE id = $1 AND stage IN ('sourced','researched')`, [d.lead_id]);
    }
    res.json(result);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Captured prospect replies, newest first, with their triage verdicts.
app.get('/api/outbound/replies', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.id, r.from_email, r.subject, r.snippet, r.received_at, r.draft_id,
              r.category, r.confidence, r.triaged_at, c.name AS company
       FROM outbound_replies r
       LEFT JOIN outbound_drafts d ON d.id = r.draft_id
       LEFT JOIN companies c ON c.id = d.company_id
       ORDER BY r.received_at DESC NULLS LAST LIMIT 200`);
    res.json({ replies: rows.map(r => ({
      id: r.id, from: r.from_email, subject: r.subject, snippet: r.snippet,
      receivedAt: r.received_at, draftId: r.draft_id, company: r.company,
      category: r.category, confidence: r.confidence, triagedAt: r.triaged_at,
    })) });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// The conversations: every lead with a sent thread, latest activity first,
// with enough on the card to act without opening the detail.
app.get('/api/outbound/conversations', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT l.id, l.stage, l.campaign, l.snoozed_until, l.meeting_booked_at, l.meeting_kind, l.meeting_at, l.handed_off_at,
              c.name AS company, c.icp_score,
              d.contact_id, ct.full_name AS contact_name, ct.role_title, ct.email, ct.suppressed, ct.email_bounced_at, ct.li_invited_at,
              (SELECT count(*)::int FROM outbound_drafts x WHERE x.lead_id = l.id AND x.status = 'sent') AS sent_count,
              (SELECT max(sent_at) FROM outbound_drafts x WHERE x.lead_id = l.id AND x.status = 'sent') AS last_sent_at,
              (SELECT count(*)::int FROM outbound_replies r JOIN outbound_drafts x ON x.id = r.draft_id WHERE x.lead_id = l.id) AS reply_count,
              (SELECT r.category FROM outbound_replies r JOIN outbound_drafts x ON x.id = r.draft_id
               WHERE x.lead_id = l.id ORDER BY r.received_at DESC NULLS LAST LIMIT 1) AS last_category,
              (SELECT max(r.received_at) FROM outbound_replies r JOIN outbound_drafts x ON x.id = r.draft_id WHERE x.lead_id = l.id) AS last_reply_at,
              EXISTS(SELECT 1 FROM outbound_drafts x WHERE x.lead_id = l.id AND x.status IN ('draft','approved')) AS open_draft
       FROM leads l
       JOIN companies c ON c.id = l.company_id
       JOIN LATERAL (
         SELECT contact_id FROM outbound_drafts WHERE lead_id = l.id AND status = 'sent'
         ORDER BY sequence_step DESC, sent_at DESC LIMIT 1
       ) d ON true
       LEFT JOIN contacts ct ON ct.id = d.contact_id
       ORDER BY GREATEST(COALESCE((SELECT max(sent_at) FROM outbound_drafts x WHERE x.lead_id = l.id AND x.status = 'sent'), 'epoch'),
                         COALESCE((SELECT max(r.received_at) FROM outbound_replies r JOIN outbound_drafts x ON x.id = r.draft_id WHERE x.lead_id = l.id), 'epoch')) DESC
       LIMIT 100`);
    res.json({ conversations: rows.map(r => ({
      leadId: r.id, stage: r.stage, rehearsal: r.campaign === 'rehearsal', company: r.company, score: r.icp_score,
      contact: r.contact_name ? { name: r.contact_name, role: r.role_title, email: r.email, suppressed: r.suppressed, bounced: !!r.email_bounced_at, liInvited: !!r.li_invited_at } : null,
      sent: r.sent_count, replies: r.reply_count, lastCategory: r.last_category,
      lastSentAt: r.last_sent_at, lastReplyAt: r.last_reply_at, openDraft: r.open_draft,
      snoozedUntil: r.snoozed_until, meeting: r.meeting_booked_at ? { bookedAt: r.meeting_booked_at, kind: r.meeting_kind, at: r.meeting_at } : null,
      handedOffAt: r.handed_off_at,
    })) });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// One conversation's full thread: sent emails, replies with verdicts, and any
// open draft, merged newest last, for the timeline view.
app.get('/api/outbound/conversations/:leadId', async (req, res) => {
  try {
    const drafts = (await pool.query(
      `SELECT id, email_type, sequence_step, subject, body, status, grounding_flags, sent_at, created_at
       FROM outbound_drafts WHERE lead_id = $1 AND status IN ('sent','draft','approved')
       ORDER BY created_at ASC`, [req.params.leadId])).rows;
    const replies = (await pool.query(
      `SELECT r.id, r.from_email, r.subject, COALESCE(r.body, r.snippet) AS text, r.category, r.confidence,
              r.triage, r.received_at
       FROM outbound_replies r JOIN outbound_drafts d ON d.id = r.draft_id
       WHERE d.lead_id = $1 ORDER BY r.received_at ASC`, [req.params.leadId])).rows;
    const items = [
      ...drafts.map(d => ({
        kind: d.status === 'sent' ? 'sent' : 'open_draft', id: d.id, emailType: d.email_type, step: d.sequence_step,
        subject: d.subject, body: d.body, status: d.status, flags: d.grounding_flags || [],
        at: d.sent_at || d.created_at,
      })),
      ...replies.map(r => ({
        kind: 'reply', id: r.id, from: r.from_email, subject: r.subject, body: r.text,
        category: r.category, confidence: r.confidence, reason: r.triage?.reason || null, at: r.received_at,
      })),
    ].sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));
    res.json({ items });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Draft a grounded response to a specific reply on demand, for the cases triage
// leaves to a human: a wrong-person pointer, an unclear message they still want
// to answer. Runs in the foreground; one reply's draft is a short wait.
app.post('/api/outbound/replies/:id/respond', async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY is not set on this service' });
    const r = await draftResponse(req.params.id);
    if (!r.drafted) return res.status(409).json({ error: r.reason });
    res.json({ ok: true, subject: r.subject, flags: r.flags });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Meeting booked: the engine's goal for the thread. Records kind and time,
// moves the lead to qualified, and tells the team.
app.post('/api/outbound/leads/:id/meeting', async (req, res) => {
  try {
    const kind = (req.body || {}).kind === 'f2f' ? 'f2f' : 'video';
    const atRaw = (req.body || {}).at ? new Date((req.body || {}).at) : null;
    const at = atRaw && !Number.isNaN(atRaw.getTime()) ? atRaw.toISOString() : null;
    const { rows } = await pool.query(
      `UPDATE leads SET stage = 'qualified', meeting_booked_at = now(), meeting_kind = $2, meeting_at = $3, updated_at = now()
       WHERE id = $1 AND stage NOT IN ('handed_off') RETURNING campaign`, [req.params.id, kind, at]);
    if (!rows.length) return res.status(409).json({ error: 'lead not found or already handed off' });
    const tag = rows[0].campaign === 'rehearsal' ? 'Rehearsal, ' : '';
    const who = (await pool.query(
      `SELECT c.name AS company, ct.full_name FROM leads l JOIN companies c ON c.id = l.company_id
       LEFT JOIN contacts ct ON ct.id = l.contact_id WHERE l.id = $1`, [req.params.id])).rows[0] || {};
    await sendTeamNote(`${tag}meeting booked: ${who.company || 'lead ' + req.params.id}`,
      `A ${kind === 'f2f' ? 'face to face' : 'video'} meeting is booked${who.full_name ? ' with ' + who.full_name : ''}${who.company ? ' at ' + who.company : ''}${at ? ', ' + at.slice(0, 16).replace('T', ' ') + ' UTC' : ''}.\n\nHand the thread off from the app when someone owns it.`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Handoff: a person now owns the conversation. The pack email carries the whole
// grounded story; the engine stops writing on the thread from here.
app.post('/api/outbound/leads/:id/handoff', async (req, res) => {
  try {
    const note = String((req.body || {}).note || '').slice(0, 500) || null;
    const data = await gatherHandoffData(req.params.id);
    if (!data) return res.status(404).json({ error: 'lead not found' });
    const { rows } = await pool.query(
      `UPDATE leads SET stage = 'handed_off', handed_off_at = now(), handoff_note = $2, updated_at = now()
       WHERE id = $1 AND stage NOT IN ('handed_off') RETURNING id`, [req.params.id, note]);
    if (!rows.length) return res.status(409).json({ error: 'already handed off' });
    const pack = renderHandoffPack(data, { note });
    const isRehearsal = (await pool.query(`SELECT campaign FROM leads WHERE id = $1`, [req.params.id])).rows[0]?.campaign === 'rehearsal';
    const sent = await sendTeamNote(isRehearsal ? `Rehearsal, ${pack.subject.charAt(0).toLowerCase()}${pack.subject.slice(1)}` : pack.subject, pack.text);
    res.json({ ok: true, packSentTo: sent });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// The rehearsal lane: clone a real draft onto a tagged lead addressed to a
// teammate, run the whole journey through the production path, then wipe.
app.get('/api/outbound/rehearsal', async (_req, res) => {
  try { res.json(await rehearsalStatus()); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});
app.post('/api/outbound/rehearsal/start', async (req, res) => {
  try {
    const r = await startRehearsal({ draftId: (req.body || {}).draftId || null, to: (req.body || {}).to });
    if (!r.started) return res.status(409).json({ error: r.reason });
    res.json(r);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
app.post('/api/outbound/rehearsal/end', async (req, res) => {
  try { res.json(await endRehearsal({ to: (req.body || {}).to || null })); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

// The human stop: suppress the contact and close the lead, whatever triage
// thought. An opt-out honoured by hand is still an opt-out.
app.post('/api/outbound/leads/:id/suppress', async (req, res) => {
  try {
    await pool.query(
      `UPDATE contacts SET suppressed = true
       WHERE id IN (SELECT contact_id FROM outbound_drafts WHERE lead_id = $1 AND contact_id IS NOT NULL
                    UNION SELECT contact_id FROM leads WHERE id = $1 AND contact_id IS NOT NULL)`, [req.params.id]);
    const { rows } = await pool.query(
      `UPDATE leads SET stage = 'closed', updated_at = now() WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'lead not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Price lookup: deterministic, no model in the path, and prices never touch
// the embedding pipeline. The co-pilot card appears only when the switch is
// on and the lists are loaded; the switch stays off until James has verified
// a sample of stored prices against what he would quote.
app.get('/api/price/status', async (_req, res) => {
  try {
    const s = await priceStatus();
    const enabled = (await kvGet('pricelookup_enabled')) === 'on';
    res.json({ ...s, enabled, ready: enabled && s.parts > 0 });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
app.post('/api/price/toggle', async (req, res) => {
  try {
    const enabled = (req.body || {}).enabled === true;
    await kvSet('pricelookup_enabled', enabled ? 'on' : 'off');
    res.json({ enabled });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
app.get('/api/price', async (req, res) => {
  try {
    if ((await kvGet('pricelookup_enabled')) !== 'on') return res.status(409).json({ error: 'price lookup is switched off' });
    res.json(await lookupPrice(String(req.query.q || '')));
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// The Marwin range builder, stage one: choosers over the priced book. Every
// leaf the tree offers is a stored part, so the builder cannot invent a
// code; the tree itself is derived per request from the prices table.
app.get('/api/marwin/ranges', async (_req, res) => {
  try {
    if ((await kvGet('pricelookup_enabled')) !== 'on') return res.status(409).json({ error: 'price lookup is switched off' });
    const { rows } = await pool.query(
      `SELECT substring(description from '^Marwin ([^,]+?) series') AS series,
              count(DISTINCT norm_key)::int AS parts, min(sell_price) AS floor
       FROM prices WHERE product_line = 'marwin' AND currency = 'GBP'
         AND description LIKE 'Marwin %'
       GROUP BY 1 ORDER BY 1`);
    res.json({ ranges: rows.filter(r => r.series).map(r => ({ series: r.series, parts: r.parts, floorGBP: Number(r.floor) })) });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
app.get('/api/marwin/range/:series', async (req, res) => {
  try {
    if ((await kvGet('pricelookup_enabled')) !== 'on') return res.status(409).json({ error: 'price lookup is switched off' });
    const { rows } = await pool.query(
      `SELECT part_number, min(description) AS description,
              max(sell_price) FILTER (WHERE currency = 'GBP') AS gbp,
              max(sell_price) FILTER (WHERE currency = 'EUR') AS eur,
              max(sell_price) FILTER (WHERE currency = 'USD') AS usd
       FROM prices WHERE product_line = 'marwin' AND description LIKE $1
       GROUP BY part_number ORDER BY part_number`,
      [`Marwin ${String(req.params.series)} series%`]);
    const tree = buildRangeTree(rows.map(r => ({
      part_number: r.part_number, description: r.description,
      prices: { GBP: Number(r.gbp), EUR: Number(r.eur), USD: Number(r.usd) },
    })));
    res.json({ series: req.params.series, ...tree });
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
// Cache discipline, so every deploy reaches every browser on its next load.
// Vite names the bundles by content hash, so anything under assets/ may be
// cached hard and forever; the shell (index.html) must never be cached at
// all, since a stale shell keeps pointing at old bundles and a user can sit
// on last week's app while fixes deploy around them. That was a live
// failure: a blank screen that the current bundle could not produce.
const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist');
app.use(express.static(dist, {
  setHeaders: (res, filePath) => {
    if (/[/\\]assets[/\\]/.test(filePath) && /\.(js|css|woff2?|svg|png|jpg|jpeg)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      res.setHeader('Cache-Control', 'no-store');
    }
  },
}));
app.get('*', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(join(dist, 'index.html'));
});

app.listen(PORT, () => console.log(`pct-knowledge-copilot listening on ${PORT}`));
