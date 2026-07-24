// The document sync: the engine pulls chosen SharePoint folders into its own
// knowledge corpus on the engine cycle, so the co-pilot's product knowledge
// tracks the files James maintains rather than whatever was uploaded once.
// Documents only, and never price material: the corpus serves text verbatim
// to the co-pilot, so supplier price books and workbooks are refused here by
// name and by type, with the refusals reported. Prices reach the engine only
// through the ingest scripts' transform path, dry run, human check, apply.
//
// Sync mechanics: each configured root is walked, files are compared by etag
// and size against the last sync, changed files are re-extracted, re-chunked
// and re-embedded wholesale (delete then insert, per document), and a file
// gone from the site has its chunks withdrawn. A failure on one file is
// reported and never stops the rest.

import { parseOfficeAsync } from 'officeparser';
import { pool } from './db.mjs';
import { embedTexts } from './embeddings.mjs';
import { listFolder, downloadFile, spSite } from './sharepoint.mjs';

// Folders to sync, set deliberately: nothing syncs until the variable names
// the roots, so folders like Customer Lists stay untouched by default.
export const syncRoots = () =>
  String(process.env.SHAREPOINT_SYNC_FOLDERS || '').split(',').map(s => s.trim()).filter(Boolean);

// The corpus line for a path, from the site's own folder names to the
// engine's canonical line keys. Unknown folders file under general.
const FOLDER_LINE = {
  '1. jordan valve': 'jordan', '2. steriflow': 'steriflow',
  '3. steriflow food and beverage': 'steriflow_fb', '4. low flow': 'low_flow',
  '5. hexvalve': 'hexvalve', '6. bestobell steam': 'bestobell_steam',
  '7. marwin': 'marwin', '8. equilibar': 'equilibar',
  'pct information': 'general', 'data centres': 'data_centre',
};
export function lineForPath(path) {
  for (const seg of String(path || '').split('/')) {
    const hit = FOLDER_LINE[seg.trim().toLowerCase()];
    if (hit) return hit;
  }
  return 'general';
}

// What the sync will and will not touch. Price material is refused by name
// whatever its type, and spreadsheets are refused entirely, since a workbook
// in these folders is a calculator or a price sheet, never a data sheet.
const PRICE_NAME = /price|pricing|\bcost|margin|calculator|(^|[-_ ])PL([-_. ]|$)/i;
const DOC_TYPE = /\.(pdf|docx|pptx|txt|md)$/i;
export function syncDecision(name) {
  if (!DOC_TYPE.test(String(name || ''))) return { sync: false, why: 'type' };
  if (PRICE_NAME.test(String(name || ''))) return { sync: false, why: 'price rule' };
  return { sync: true };
}

// Plain text into corpus-sized chunks on paragraph boundaries, hard-split
// only when a single paragraph exceeds the size, capped so one enormous
// document cannot flood the corpus.
export function chunkText(text, { size = 1500, cap = 400 } = {}) {
  const chunks = [];
  let buf = '';
  for (const para of String(text || '').split(/\n\s*\n/)) {
    const p = para.replace(/[ \t]+/g, ' ').trim();
    if (!p) continue;
    if ((buf + '\n\n' + p).length > size && buf) { chunks.push(buf); buf = ''; }
    if (p.length > size) {
      for (let i = 0; i < p.length; i += size) chunks.push(p.slice(i, i + size));
      continue;
    }
    buf = buf ? `${buf}\n\n${p}` : p;
    if (chunks.length >= cap) break;
  }
  if (buf && chunks.length < cap) chunks.push(buf);
  return { chunks: chunks.slice(0, cap), truncated: chunks.length >= cap };
}

async function extractText(name, buf) {
  if (/\.(txt|md)$/i.test(name)) return buf.toString('utf8');
  return await parseOfficeAsync(buf);
}

async function walk(root, out, depth = 0) {
  if (depth > 4) return;
  for (const item of await listFolder(root)) {
    const path = root ? `${root}/${item.name}` : item.name;
    if (item.folder) await walk(path, out, depth + 1);
    else out.push({ path, name: item.name, etag: item.etag, size: item.size, modified: item.modified });
  }
}

export async function syncSharepointDocs({ apply = true, log = () => {} } = {}) {
  const roots = syncRoots();
  if (!roots.length) return { skipped: 'SHAREPOINT_SYNC_FOLDERS is not set; nothing is synced without it' };
  if (!process.env.VOYAGE_API_KEY) return { skipped: 'no embedding key on this service' };

  const report = { roots: roots.length, files: 0, unchanged: 0, updated: 0, removed: 0, chunks: 0, skippedType: 0, skippedPriceRule: [], errors: [] };
  const found = [];
  for (const root of roots) {
    try { await walk(root, found); }
    catch (e) { report.errors.push(`${root}: ${String(e.message).slice(0, 140)}`); }
  }

  const seen = new Set();
  const known = new Map((await pool.query(`SELECT path, etag, size FROM sharepoint_docs`)).rows
    .map(r => [r.path, r]));

  for (const f of found) {
    const d = syncDecision(f.name);
    if (!d.sync) {
      if (d.why === 'price rule') report.skippedPriceRule.push(f.path);
      else report.skippedType++;
      continue;
    }
    report.files++;
    seen.add(f.path);
    const prev = known.get(f.path);
    if (prev && prev.etag === f.etag && Number(prev.size) === Number(f.size)) { report.unchanged++; continue; }
    if (!apply) { report.updated++; continue; }
    try {
      const buf = await downloadFile(f.path);
      const text = await extractText(f.name, buf);
      const { chunks, truncated } = chunkText(text);
      if (!chunks.length) { report.errors.push(`${f.path}: no extractable text`); continue; }
      const line = lineForPath(f.path);
      const sid = `sharepoint:${f.path}`;
      const embeddings = [];
      for (let i = 0; i < chunks.length; i += 64) {
        embeddings.push(...await embedTexts(chunks.slice(i, i + 64), 'document'));
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`DELETE FROM kb_chunks WHERE metadata->>'source_id' = $1`, [sid]);
        for (let i = 0; i < chunks.length; i++) {
          await client.query(
            `INSERT INTO kb_chunks (content, embedding, "sourceType", metadata)
             VALUES ($1, $2::vector, 'document', $3::jsonb)`,
            [chunks[i], '[' + embeddings[i].join(',') + ']',
             JSON.stringify({ source_id: sid, title: f.name, line, corpus: 'sharepoint', section: `chunk ${i + 1} of ${chunks.length}` })]);
        }
        await client.query(
          `INSERT INTO sharepoint_docs (path, etag, size, modified, line, chunks, synced_at)
           VALUES ($1, $2, $3, $4, $5, $6, now())
           ON CONFLICT (path) DO UPDATE SET etag = EXCLUDED.etag, size = EXCLUDED.size,
             modified = EXCLUDED.modified, line = EXCLUDED.line, chunks = EXCLUDED.chunks, synced_at = now()`,
          [f.path, f.etag, f.size, f.modified, line, chunks.length]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
      report.updated++;
      report.chunks += chunks.length;
      log(`${f.path}: ${chunks.length} chunk(s) as line ${line}${truncated ? ', truncated at the cap' : ''}`);
    } catch (e) {
      report.errors.push(`${f.path}: ${String(e.message).slice(0, 140)}`);
    }
  }

  // Files the site no longer has, withdrawn from the corpus. Only paths under
  // the configured roots are considered, so narrowing the roots never mass
  // deletes documents that simply were not walked this cycle.
  for (const [path] of known) {
    if (seen.has(path)) continue;
    if (!roots.some(r => path.startsWith(`${r}/`) || path === r)) continue;
    if (!apply) { report.removed++; continue; }
    await pool.query(`DELETE FROM kb_chunks WHERE metadata->>'source_id' = $1`, [`sharepoint:${path}`]);
    await pool.query(`DELETE FROM sharepoint_docs WHERE path = $1`, [path]);
    report.removed++;
    log(`${path}: gone from the site, chunks withdrawn`);
  }

  return report;
}
