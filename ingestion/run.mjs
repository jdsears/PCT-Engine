import { localFolderSource } from './sources/localFolder.mjs';
import { extractText, checkTooling } from './extract.mjs';
import { chunkDocument } from './chunk.mjs';
import { pool } from '../src/db.mjs';
import { embedTexts } from '../src/embeddings.mjs';
import { mapFolder as richardsMapFolder, EXCLUDED_FOLDERS as richardsExcluded } from './folderMap.mjs';
import { mapFolder as pctMapFolder, EXCLUDED_FOLDERS as pctExcluded, excludeFile as pctExcludeFile } from './pctFolderMap.mjs';

// Each corpus pairs a folder mapping with a default sourceType and the name of
// its root folder in the SharePoint library. The sourceType default applies
// only when a chunk carries no docType of its own.
const CORPORA = {
  richards: {
    mapping: { mapFolder: richardsMapFolder, excludedFolders: richardsExcluded },
    sourceType: (c) => c.docType || (c.contentType === 'table' ? 'product_table' : 'product_datasheet'),
    spRoot: 'Richards',
  },
  pct: {
    mapping: { mapFolder: pctMapFolder, excludedFolders: pctExcluded, excludeFile: pctExcludeFile },
    sourceType: (c) => c.docType || (c.contentType === 'table' ? 'company_table' : 'company_overview'),
    spRoot: 'PCT Information',
  },
};

// Usage: node ingestion/run.mjs [--source=sharepoint] [--sp-root="<folder>"] ["<local path>"] [--corpus richards|pct]
let CORPUS = 'richards';
let useSharepoint = false;
let spRoot = null;
const positional = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--corpus') CORPUS = argv[++i];
  else if (a.startsWith('--corpus=')) CORPUS = a.slice('--corpus='.length);
  else if (a === '--source=sharepoint') useSharepoint = true;
  else if (a === '--source=local') useSharepoint = false;
  else if (a.startsWith('--sp-root=')) spRoot = a.slice('--sp-root='.length);
  else if (!a.startsWith('--')) positional.push(a);
}
const root = positional[0];
const cfg = CORPORA[CORPUS];
if (!cfg || (!useSharepoint && !root)) {
  console.error('Usage: node ingestion/run.mjs [--source=sharepoint] [--sp-root="<folder>"] ["<local path>"] [--corpus richards|pct]');
  if (CORPUS && !cfg) console.error(`Unknown corpus "${CORPUS}". Known corpora: ${Object.keys(CORPORA).join(', ')}`);
  process.exit(1);
}

const tooling = await checkTooling();
console.log(`PDF tooling: pdftotext ${tooling.pdftotext ? 'found' : 'missing'}, ocrmypdf ${tooling.ocrmypdf ? 'found' : 'missing'}.`);
if (!tooling.pdftotext) {
  console.log('Warning: pdftotext is not on PATH, so PDF files will be skipped. Install poppler to read them.');
}

const vectorLiteral = (a) => '[' + a.join(',') + ']';

async function existingHashes() {
  const { rows } = await pool.query(
    `SELECT DISTINCT metadata->>'source_id' AS sid, metadata->>'content_hash' AS h
     FROM kb_chunks WHERE metadata->>'corpus' = $1`, [CORPUS]);
  const m = new Map();
  for (const r of rows) if (r.sid) m.set(r.sid, r.h);
  return m;
}
const deleteDoc = (sid) => pool.query(
  `DELETE FROM kb_chunks WHERE metadata->>'corpus' = $1 AND metadata->>'source_id' = $2`, [CORPUS, sid]);

async function insertChunks(chunks) {
  // Never send a blank string to the embedder; Voyage rejects empty inputs.
  const clean = chunks.filter(c => c.content && c.content.trim());
  const BATCH = 64;
  for (let i = 0; i < clean.length; i += BATCH) {
    const slice = clean.slice(i, i + BATCH);
    const vectors = await embedTexts(slice.map(c => c.content));
    for (let j = 0; j < slice.length; j++) {
      const c = slice[j];
      const sourceType = cfg.sourceType(c);
      await pool.query(
        `INSERT INTO kb_chunks (content, embedding, "sourceType", segment, metadata)
         VALUES ($1, $2::vector, $3, $4, $5::jsonb)`,
        [c.content, vectorLiteral(vectors[j]), sourceType, c.segment, JSON.stringify({
          corpus: CORPUS, source_id: c.source_id, content_hash: c.content_hash,
          title: c.title, topFolder: c.topFolder, line: c.line ?? null,
          campaignLine: !!c.campaignLine, application: c.application ?? null,
          nameable: c.nameable ?? true, manufacturer: c.manufacturer ?? null,
          page: c.page ?? null, section: c.section ?? null, contentType: c.contentType,
        })]);
    }
  }
}

const report = { docs: 0, skipped: 0, inserted: 0, updated: 0, chunks: 0, noText: [], failed: [], byLine: {} };
const known = await existingHashes();
const seen = new Set();

const source = useSharepoint
  ? (await import('./sources/sharepointFolder.mjs')).sharepointSource(cfg.mapping, { rootFolder: spRoot ?? cfg.spRoot })
  : localFolderSource(root, cfg.mapping);

console.log(`Scanning ${useSharepoint ? 'the SharePoint site' : CORPUS} and embedding new or changed files ...`);
let walkComplete = false;
try {
for await (const doc of source) {
  report.docs++; seen.add(doc.sourceId);
  if (known.get(doc.sourceId) === doc.hash) { report.skipped++; continue; }

  try {
    process.stdout.write(`  reading ${doc.sourceId} ... `);
    const { text } = await extractText(doc.path, doc.ext);
    if (!text || text.trim().length < 30) { report.noText.push(doc.sourceId); console.log('no text'); continue; }

    const pages = doc.ext === '.pdf' ? text.split('\f') : [text];
    const chunks = [];
    pages.forEach((pageText, idx) => {
      const baseMeta = {
        source_id: doc.sourceId, content_hash: doc.hash, title: doc.title,
        topFolder: doc.meta.topFolder, segment: doc.meta.segment, line: doc.meta.line,
        campaignLine: doc.meta.campaignLine, application: doc.meta.application,
        nameable: doc.meta.nameable, manufacturer: doc.meta.manufacturer, docType: doc.meta.docType,
        page: doc.ext === '.pdf' ? idx + 1 : null, section: null,
      };
      for (const ch of chunkDocument(pageText, baseMeta)) chunks.push(ch);
    });
    // Drop blank chunks so a single empty string cannot fail the whole batch.
    const usable = chunks.filter(c => c.content && c.content.trim());
    if (usable.length === 0) { report.noText.push(doc.sourceId); console.log('no usable text'); continue; }

    if (known.has(doc.sourceId)) await deleteDoc(doc.sourceId);
    await insertChunks(usable);
    if (known.has(doc.sourceId)) report.updated++; else report.inserted++;
    report.chunks += usable.length;
    const k = doc.meta.line || doc.meta.application || doc.meta.topFolder || 'other';
    report.byLine[k] = (report.byLine[k] || 0) + usable.length;
    console.log(`${usable.length} chunks`);
  } catch (e) {
    // One bad document must not stop the run. Record it and carry on.
    console.log('failed');
    report.failed.push({ id: doc.sourceId, error: String(e?.message || e).slice(0, 200) });
  }
}
walkComplete = true;
} catch (e) {
  // The source walk itself failed, for example a SharePoint listing error, so
  // skip the removal sweep. We never delete chunks for documents we merely
  // failed to read on this run.
  console.error('\nSource walk did not complete:', e?.message || e);
  report.walkError = String(e?.message || e);
}

if (walkComplete) {
  for (const sid of known.keys()) if (!seen.has(sid)) await deleteDoc(sid);
} else {
  console.log('Walk incomplete, so the stale-document sweep was skipped.');
}

console.log('\n=== Ingestion run report ===');
console.log('Corpus:', CORPUS);
console.log('Documents seen:', report.docs);
console.log('Skipped (unchanged):', report.skipped);
console.log('New documents:', report.inserted, '  Updated documents:', report.updated);
console.log('Chunks written this run:', report.chunks);
console.log('Chunks by line, application or folder:', report.byLine);
console.log('Files with no extractable text:', report.noText.length);
for (const f of report.noText) console.log('  -', f);
console.log('Documents that failed:', report.failed.length);
for (const f of report.failed) console.log('  -', f.id, ':', f.error);
console.log('\nDone.');
await pool.end();
