// The website trawl's manners, 9 September 2026: one identifiable agent, a
// bounded read, robots.txt obeyed to the letter, and one request at a time
// per host with a gap between them. A supplier's site is a courtesy to read,
// not a resource to hammer, and a prospect's site even more so.

export const USER_AGENT = 'Mozilla/5.0 (compatible; PCT-Engine trawl)';
// The token robots.txt groups are matched against, lower case.
export const AGENT_TOKEN = 'pct-engine';

// robots.txt, parsed to groups. Each group names its agents and carries its
// allow and disallow patterns and an optional crawl delay. Comments and
// unknown directives are ignored, as the standard says.
export function parseRobots(text) {
  const groups = [];
  let cur = null, lastWasAgent = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase(), value = m[2].trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], allow: [], disallow: [], crawlDelay: null }; groups.push(cur); }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === 'allow') cur.allow.push(value);
    else if (key === 'disallow') cur.disallow.push(value);
    else if (key === 'crawl-delay') { const n = parseFloat(value); if (Number.isFinite(n) && n >= 0) cur.crawlDelay = n; }
  }
  return groups;
}

// A robots pattern to a regular expression: * matches anything, $ anchors
// the end, everything else is literal, and the match is from the start.
function patternRe(p) {
  const esc = String(p).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + (esc.endsWith('\\$') ? esc.slice(0, -2) + '$' : esc));
}

// Is this path allowed for our agent? The group for our token wins over the
// wildcard group; no group means everything is allowed. Within a group the
// longest matching pattern decides, allow winning a tie, and an empty
// Disallow allows everything, per the standard.
export function robotsAllows(groups, pathWithQuery, agent = AGENT_TOKEN) {
  const path = String(pathWithQuery || '/');
  const gs = groups || [];
  const mine = gs.find(g => g.agents.some(a => a !== '*' && (a.includes(agent) || agent.includes(a))));
  const group = mine || gs.find(g => g.agents.includes('*'));
  if (!group) return { allowed: true, delay: null };
  let best = null;
  for (const [kind, list] of [['allow', group.allow], ['disallow', group.disallow]]) {
    for (const p of list) {
      if (!p) continue;
      if (!patternRe(p).test(path)) continue;
      if (!best || p.length > best.p.length || (p.length === best.p.length && kind === 'allow')) best = { kind, p };
    }
  }
  return { allowed: !best || best.kind === 'allow', delay: group.crawlDelay };
}

// One fetch with a timeout, a byte cap on the body and an honest result
// shape: the final address after redirects, the status, the content type
// and the body as a Buffer. Never throws for an HTTP error; a network error
// or a timeout comes back as ok false with the reason.
export async function politeFetch(url, { timeoutMs = 15_000, maxBytes = 1_500_000, accept = 'text/html,application/xhtml+xml,application/pdf;q=0.8,*/*;q=0.5' } = {}) {
  let res;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': USER_AGENT, Accept: accept, 'Accept-Language': 'en-GB,en;q=0.9' },
    });
  } catch (e) {
    return { ok: false, status: 0, url, contentType: null, body: null, error: String(e?.message || e).slice(0, 160) };
  }
  const contentType = String(res.headers.get('content-type') || '').toLowerCase();
  const out = { ok: res.ok, status: res.status, url: res.url || url, contentType, body: null, truncated: false };
  if (!res.ok || !res.body) { try { await res.arrayBuffer(); } catch { /* drained */ } return out; }
  const reader = res.body.getReader();
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      size += value.length;
      if (size >= maxBytes) { out.truncated = true; try { await reader.cancel(); } catch { /* gone */ } break; }
    }
  } catch (e) {
    out.error = String(e?.message || e).slice(0, 160);
  }
  out.body = Buffer.concat(parts.map(p => Buffer.from(p))).subarray(0, maxBytes);
  return out;
}

// robots.txt per origin, fetched once and remembered for the process. A
// missing or unreadable file allows everything, which is what the standard
// says a missing file means.
const robotsCache = new Map();
export async function getRobots(origin, { fetchImpl = politeFetch } = {}) {
  const key = String(origin || '').replace(/\/+$/, '');
  if (robotsCache.has(key)) return robotsCache.get(key);
  let groups = [];
  try {
    const r = await fetchImpl(`${key}/robots.txt`, { accept: 'text/plain', maxBytes: 200_000 });
    // A site that answers robots.txt with an HTML page has no robots file.
    if (r.ok && r.body && !/html/.test(r.contentType)) groups = parseRobots(r.body.toString('utf8'));
  } catch { groups = []; }
  robotsCache.set(key, groups);
  return groups;
}
export const forgetRobots = () => robotsCache.clear();

// One request at a time per host, with at least the gap between them. The
// gap is the site's crawl delay when it states one, else ours.
export class HostPacer {
  constructor({ delayMs = 1000, sleep = ms => new Promise(r => setTimeout(r, ms)), now = () => Date.now() } = {}) {
    this.delayMs = delayMs; this.sleep = sleep; this.now = now; this.next = new Map();
  }
  async wait(host, delayMs = this.delayMs) {
    const at = this.next.get(host) || 0;
    const gap = at - this.now();
    if (gap > 0) await this.sleep(gap);
    this.next.set(host, this.now() + Math.max(0, delayMs));
  }
}
