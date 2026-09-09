// The corpus side of the website trawl, 9 September 2026: a registered site
// is read into kb_chunks the way the SharePoint sync reads a folder, page by
// page, replaced wholesale when its content changes and withdrawn when it is
// gone from the site. Each chunk carries the page's address, so the
// co-pilot's citation can link to the page itself. A refresh runs on the
// engine cycle, one site per cycle, once a site is older than the refresh
// window, so a supplier's site drifts into the corpus without a click.
import { pool } from '../db.mjs';
import { embedTexts } from '../embeddings.mjs';
import { chunkText } from '../sharepointSync.mjs';
import { crawlSite, describeSkips } from './crawl.mjs';
import { canonicalUrl, hostOf } from './extract.mjs';

export const refreshDays = () => Math.max(1, parseInt(process.env.WEB_TRAWL_REFRESH_DAYS || '7', 10) || 7);

// The chunk metadata for a page, the one shape every web chunk carries.
// source_id is the page's canonical address prefixed web:, so a page is one
// document however many chunks it makes and however it was reached.
export function siteMeta(site, page, i, n) {
  return {
    source_id: `web:${page.url}`, url: page.url, title: page.title, line: site.line || 'general',
    corpus: 'web', site: site.host, kind: page.kind || 'page', section: `chunk ${i + 1} of ${n}`,
  };
}

// What a person may register: a web address with a real host, a corpus line
// key, a page cap within reason. Pure, so the gate proves the refusals.
export function validateSite({ url, line, maxPages, includePdfs } = {}) {
  const canon = canonicalUrl(url);
  const host = canon ? hostOf(canon) : null;
  if (!canon || !host || !host.includes('.')) return { ok: false, error: 'enter the site\'s web address, for example https://www.alicat.com' };
  const l = String(line || 'general').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]*$/.test(l)) return { ok: false, error: 'the line must be a plain key, for example alicat' };
  const cap = maxPages == null || maxPages === '' ? 150 : parseInt(maxPages, 10);
  if (!Number.isFinite(cap) || cap < 10 || cap > 1000) return { ok: false, error: 'the page cap must be between 10 and 1000' };
  return { ok: true, site: { url: canon, host, line: l, maxPages: cap, includePdfs: includePdfs === true } };
}

export async function tablesReady() {
  try { return !!(await pool.query(`SELECT to_regclass('web_sites') AS t`)).rows[0]?.t; }
  catch { return false; }
}

export async function listSites() {
  const { rows } = await pool.query(
    `SELECT s.id, s.url, s.host, s.line, s.max_pages, s.include_pdfs, s.enabled, s.added_by, s.added_at, s.last_trawl_at, s.last_report,
            count(d.url)::int AS pages, COALESCE(sum(d.chunks), 0)::int AS chunks
     FROM web_sites s LEFT JOIN web_docs d ON d.site_id = s.id
     GROUP BY s.id ORDER BY s.added_at ASC`);
  return rows;
}

export async function getSite(id) {
  return (await pool.query(`SELECT * FROM web_sites WHERE id = $1`, [id])).rows[0] || null;
}

// Register a site, or update its settings if the host is already known. A
// re-added site is enabled again; nothing is trawled here, the caller does
// that so the request returns at once.
export async function addSite(input, { addedBy = null } = {}) {
  const v = validateSite(input);
  if (!v.ok) return { error: v.error };
  const { rows } = await pool.query(
    `INSERT INTO web_sites (url, host, line, max_pages, include_pdfs, enabled, added_by)
     VALUES ($1, $2, $3, $4, $5, true, $6)
     ON CONFLICT (host) DO UPDATE SET url = EXCLUDED.url, line = EXCLUDED.line, max_pages = EXCLUDED.max_pages,
       include_pdfs = EXCLUDED.include_pdfs, enabled = true
     RETURNING *`,
    [v.site.url, v.site.host, v.site.line, v.site.maxPages, v.site.includePdfs, addedBy]);
  return { site: rows[0] };
}

// Remove a site and everything it put in the corpus, in one transaction, so
// a wrong site is gone from the co-pilot the moment it is gone from the list.
export async function removeSite(id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const site = (await client.query(`SELECT * FROM web_sites WHERE id = $1`, [id])).rows[0];
    if (!site) { await client.query('ROLLBACK'); return { error: 'no such site' }; }
    const chunks = await client.query(
      `DELETE FROM kb_chunks WHERE metadata->>'source_id' IN (SELECT 'web:' || url FROM web_docs WHERE site_id = $1)`, [id]);
    const docs = await client.query(`DELETE FROM web_docs WHERE site_id = $1`, [id]);
    await client.query(`DELETE FROM web_sites WHERE id = $1`, [id]);
    await client.query('COMMIT');
    return { removed: site.host, pages: docs.rowCount, chunks: chunks.rowCount };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Sites being trawled right now, so a second click or a cycle cannot start
// the same site twice.
const inFlight = new Set();
export const trawlInFlight = id => inFlight.has(Number(id));

// Read one site into the corpus. Dry (apply false) crawls and reports what
// would change without embedding or writing. The crawl is injectable so the
// gate can prove the storage discipline with a stand-in.
export async function trawlSite(site, { apply = true, log = () => {}, crawl = crawlSite, embed = embedTexts } = {}) {
  const id = Number(site.id);
  if (id && inFlight.has(id)) return { skipped: 'already trawling' };
  if (apply && !process.env.VOYAGE_API_KEY) return { skipped: 'no embedding key on this service' };
  if (id) inFlight.add(id);
  const report = { site: site.host, startedAt: new Date().toISOString(), pages: 0, fetched: 0, unchanged: 0, updated: 0, removed: 0, chunks: 0, skips: null, priceRule: [], errors: [], truncated: false };
  try {
    const crawled = await crawl(site.url, { maxPages: site.max_pages ?? site.maxPages ?? 150, includePdfs: !!(site.include_pdfs ?? site.includePdfs), log });
    report.pages = crawled.pages.length;
    report.fetched = crawled.fetched;
    report.truncated = crawled.truncated;
    report.skips = describeSkips(crawled.skipped);
    report.priceRule = (crawled.skipped.priceRule || []).slice(0, 20);
    report.errors = (crawled.skipped.errors || []).slice(0, 20).map(e => `${e.url}: ${e.error || `HTTP ${e.status}`}`);

    const known = new Map(id
      ? (await pool.query(`SELECT url, content_hash FROM web_docs WHERE site_id = $1`, [id])).rows.map(r => [r.url, r.content_hash])
      : []);
    const seen = new Set();
    const changed = [];
    for (const page of crawled.pages) {
      seen.add(page.url);
      if (known.get(page.url) === page.hash) { report.unchanged++; continue; }
      changed.push(page);
    }
    // A page the site no longer offers is withdrawn, but only after a
    // complete crawl: a capped or failed walk proves nothing about absence.
    const complete = !crawled.truncated && crawled.pages.length > 0;
    const gone = complete ? [...known.keys()].filter(u => !seen.has(u)) : [];
    if (!apply) {
      report.updated = changed.length;
      report.removed = gone.length;
      report.sample = crawled.pages.slice(0, 12).map(p => ({ url: p.url, title: p.title, words: p.words, kind: p.kind }));
      return report;
    }

    for (const page of changed) {
      try {
        const { chunks, truncated } = chunkText(page.text);
        if (!chunks.length) { report.errors.push(`${page.url}: no text to keep`); continue; }
        const vectors = [];
        for (let i = 0; i < chunks.length; i += 64) vectors.push(...await embed(chunks.slice(i, i + 64), 'document'));
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(`DELETE FROM kb_chunks WHERE metadata->>'source_id' = $1`, [`web:${page.url}`]);
          for (let i = 0; i < chunks.length; i++) {
            await client.query(
              `INSERT INTO kb_chunks (content, embedding, "sourceType", metadata) VALUES ($1, $2::vector, 'document', $3::jsonb)`,
              [chunks[i], '[' + vectors[i].join(',') + ']', JSON.stringify(siteMeta(site, page, i, chunks.length))]);
          }
          await client.query(
            `INSERT INTO web_docs (url, site_id, title, content_hash, chunks, fetched_at) VALUES ($1, $2, $3, $4, $5, now())
             ON CONFLICT (url) DO UPDATE SET site_id = EXCLUDED.site_id, title = EXCLUDED.title, content_hash = EXCLUDED.content_hash,
               chunks = EXCLUDED.chunks, fetched_at = now()`,
            [page.url, id, page.title, page.hash, chunks.length]);
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        } finally {
          client.release();
        }
        report.updated++;
        report.chunks += chunks.length;
        log(`${page.url}: ${chunks.length} chunk(s)${truncated ? ', truncated at the cap' : ''}`);
      } catch (e) {
        report.errors.push(`${page.url}: ${String(e?.message || e).slice(0, 140)}`);
      }
    }
    for (const url of gone) {
      await pool.query(`DELETE FROM kb_chunks WHERE metadata->>'source_id' = $1`, [`web:${url}`]);
      await pool.query(`DELETE FROM web_docs WHERE url = $1`, [url]);
      report.removed++;
      log(`${url}: gone from the site, chunks withdrawn`);
    }
    report.finishedAt = new Date().toISOString();
    if (id) await pool.query(`UPDATE web_sites SET last_trawl_at = now(), last_report = $2::jsonb WHERE id = $1`, [id, JSON.stringify(report)]);
    return report;
  } catch (e) {
    report.errors.push(String(e?.message || e).slice(0, 200));
    report.finishedAt = new Date().toISOString();
    if (id) await pool.query(`UPDATE web_sites SET last_trawl_at = now(), last_report = $2::jsonb WHERE id = $1`, [id, JSON.stringify(report)]).catch(() => {});
    return report;
  } finally {
    if (id) inFlight.delete(id);
  }
}

// The engine cycle's step: the most overdue enabled site, if any is older
// than the refresh window, one per cycle so a cycle stays bounded.
export async function refreshDueSites({ log = () => {} } = {}) {
  if (!(await tablesReady())) return { skipped: 'migration 037 pending' };
  const { rows } = await pool.query(
    `SELECT * FROM web_sites WHERE enabled
       AND (last_trawl_at IS NULL OR last_trawl_at < now() - ($1 || ' days')::interval)
     ORDER BY last_trawl_at ASC NULLS FIRST LIMIT 1`, [String(refreshDays())]);
  if (!rows.length) return { idle: true };
  const site = rows[0];
  log(`refreshing ${site.host}`);
  const report = await trawlSite(site, { log });
  return { site: site.host, report };
}

export async function webStatus() {
  if (!(await tablesReady())) return { migrationPending: true, sites: [], totals: { sites: 0, pages: 0, chunks: 0, lastTrawl: null } };
  const sites = await listSites();
  return {
    sites: sites.map(s => ({
      id: s.id, url: s.url, host: s.host, line: s.line, maxPages: s.max_pages, includePdfs: s.include_pdfs, enabled: s.enabled,
      addedBy: s.added_by, addedAt: s.added_at, lastTrawlAt: s.last_trawl_at, pages: s.pages, chunks: s.chunks,
      trawling: trawlInFlight(s.id), report: s.last_report || null,
    })),
    totals: {
      sites: sites.length, pages: sites.reduce((n, s) => n + s.pages, 0), chunks: sites.reduce((n, s) => n + s.chunks, 0),
      lastTrawl: sites.reduce((a, s) => (a && s.last_trawl_at && a > s.last_trawl_at ? a : s.last_trawl_at || a), null),
    },
    refreshDays: refreshDays(),
  };
}
