import { localFolderSource } from './sources/localFolder.mjs';
import { extractText } from './extract.mjs';
import { chunkDocument } from './chunk.mjs';
import { pool } from '../src/db.mjs';
import { embedTexts } from '../src/embeddings.mjs';

const CORPUS = 'richards';
const root = process.argv[2];
if (!root) { console.error('Usage: node ingestion/run.mjs "<path to Richards folder>"'); process.exit(1); }

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
  const BATCH = 64;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const slice = chunks.slice(i, i + BATCH);
    const vectors = await embedTexts(slice.map(c => c.content));
    for (let j = 0; j < slice.length; j++) {
      const c = slice[j];
      const sourceType = c.docType || (c.contentType === 'table' ? 'product_table' : 'product_datasheet');
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

const report = { docs: 0, skipped: 0, inserted: 0, updated: 0, chunks: 0, noText: [], byLine: {} };
const known = await existingHashes();
const seen = new Set();

for await (const doc of localFolderSource(root)) {
  report.docs++; seen.add(doc.sourceId);
  if (known.get(doc.sourceId) === doc.hash) { report.skipped++; continue; }

  const { text } = await extractText(doc.path, doc.ext);
  if (!text || text.trim().length < 30) { report.noText.push(doc.sourceId); continue; }

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
  if (chunks.length === 0) { report.noText.push(doc.sourceId); continue; }

  if (known.has(doc.sourceId)) { await deleteDoc(doc.sourceId); report.updated++; }
  else report.inserted++;
  await insertChunks(chunks);
  report.chunks += chunks.length;
  const k = doc.meta.line || doc.meta.application || 'other';
  report.byLine[k] = (report.byLine[k] || 0) + chunks.length;
}

for (const sid of known.keys()) if (!seen.has(sid)) await deleteDoc(sid);

console.log('\n=== Ingestion run report ===');
console.log('Documents seen:', report.docs);
console.log('Skipped (unchanged):', report.skipped);
console.log('New documents:', report.inserted, '  Updated documents:', report.updated);
console.log('Chunks written this run:', report.chunks);
console.log('Chunks by line or application:', report.byLine);
console.log('Files with no extractable text:', report.noText.length);
for (const f of report.noText) console.log('  -', f);
console.log('\nDone.');
await pool.end();
