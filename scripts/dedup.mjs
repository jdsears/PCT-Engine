import { pool } from '../src/db.mjs';

const CORPUS = process.argv[2] || 'richards';
const { rows } = await pool.query(
  `SELECT metadata->>'content_hash' AS h, array_agg(DISTINCT metadata->>'source_id') AS sids
   FROM kb_chunks WHERE metadata->>'corpus' = $1
   GROUP BY metadata->>'content_hash'
   HAVING count(DISTINCT metadata->>'source_id') > 1`, [CORPUS]);

let docs = 0, chunks = 0;
for (const r of rows) {
  const sids = r.sids.filter(Boolean).sort((a, b) => a.length - b.length || a.localeCompare(b));
  for (const sid of sids.slice(1)) { // keep the shortest path, drop the rest
    const res = await pool.query(
      `DELETE FROM kb_chunks WHERE metadata->>'corpus' = $1 AND metadata->>'source_id' = $2`, [CORPUS, sid]);
    docs++; chunks += res.rowCount;
  }
}
console.log(`Dedup: removed ${docs} duplicate documents, ${chunks} chunks. One copy of each kept.`);
await pool.end();
