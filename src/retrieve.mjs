import { pool } from './db.mjs';
import { embedTexts } from './embeddings.mjs';

const RRF_K = 60;
const MODEL_CODE = /\b([A-Za-z]{1,4}\d{2,5}[A-Za-z0-9-]*)\b/g;

function filterClause(filters, params) {
  const parts = [];
  for (const [key, val] of Object.entries(filters || {})) {
    if (val == null) continue;
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) continue; // only allow plain metadata keys, never raw SQL
    params.push(String(val));
    parts.push(`metadata->>'${key}' = $${params.length}`);
  }
  return parts.length ? ' AND ' + parts.join(' AND ') : '';
}

// Hybrid search: vector + lexical + model-code, fused with Reciprocal Rank Fusion.
export async function search(query, { filters = {}, k = 8 } = {}) {
  const [qvec] = await embedTexts([query], 'query');
  const vecLit = '[' + qvec.join(',') + ']';

  const vparams = [vecLit];
  const vec = await pool.query(
    `SELECT id, content, metadata, "sourceType"
     FROM kb_chunks WHERE TRUE ${filterClause(filters, vparams)}
     ORDER BY embedding <=> $1::vector LIMIT 40`, vparams);

  const lparams = [query];
  const lfilter = filterClause(filters, lparams);
  const lex = await pool.query(
    `SELECT id, content, metadata, "sourceType",
            ts_rank(content_tsv, plainto_tsquery('english', $1)) AS r
     FROM kb_chunks
     WHERE content_tsv @@ plainto_tsquery('english', $1) ${lfilter}
     ORDER BY r DESC LIMIT 40`, lparams);

  const codes = [...new Set((query.match(MODEL_CODE) || []).map(c => c.toUpperCase()))].filter(c => /\d/.test(c));
  let code = { rows: [] };
  if (codes.length) {
    const cparams = [];
    const likes = codes.map(c => { cparams.push('%' + c + '%'); const i = cparams.length;
      return `(upper(content) LIKE $${i} OR upper(metadata->>'title') LIKE $${i})`; });
    code = await pool.query(
      `SELECT id, content, metadata, "sourceType"
       FROM kb_chunks WHERE (${likes.join(' OR ')}) ${filterClause(filters, cparams)} LIMIT 40`, cparams);
  }

  const fused = new Map();
  const add = (rows, weight) => rows.forEach((row, idx) => {
    const cur = fused.get(row.id) || { row, score: 0 };
    cur.score += weight * (1 / (RRF_K + idx + 1));
    cur.row = row; fused.set(row.id, cur);
  });
  add(vec.rows, 1);
  add(lex.rows, 1);
  add(code.rows, 1.5); // a model code in the query is a strong signal, so weight it up

  const ranked = [...fused.values()].sort((a, b) => b.score - a.score);

  // Diversity: no single document may take more than MAX_PER_DOC of the returned slots.
  const MAX_PER_DOC = 3;
  const perDoc = new Map();
  const picked = [];
  for (const item of ranked) {
    const sid = item.row.metadata.source_id;
    const n = perDoc.get(sid) || 0;
    if (n >= MAX_PER_DOC) continue;
    perDoc.set(sid, n + 1);
    picked.push(item);
    if (picked.length >= k) break;
  }

  return picked.map(({ row, score }) => ({
    id: row.id, score: Number(score.toFixed(4)),
    title: row.metadata.title, page: row.metadata.page, section: row.metadata.section,
    line: row.metadata.line, sourceType: row.sourceType, sourceId: row.metadata.source_id,
    nameable: row.metadata.nameable, manufacturer: row.metadata.manufacturer,
    snippet: (row.content || '').slice(0, 240),
    content: row.content,
  }));
}
