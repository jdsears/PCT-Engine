import { pool } from '../src/db.mjs';

// Inspect documents whose title or source id matches a substring. Prints the
// chunk count per matching document, then a few sample chunks from the largest,
// so an oversized document can be judged before deletion. Read only.
const pattern = process.argv[2];
if (!pattern) { console.error('Usage: node scripts/inspect.mjs "<title or source id substring>"'); process.exit(1); }

const { rows } = await pool.query(
  `SELECT metadata->>'source_id' AS source_id, metadata->>'title' AS title,
          metadata->>'line' AS line, metadata->>'corpus' AS corpus, count(*)::int AS chunks
   FROM kb_chunks
   WHERE metadata->>'title' ILIKE $1 OR metadata->>'source_id' ILIKE $1
   GROUP BY 1, 2, 3, 4 ORDER BY chunks DESC`, ['%' + pattern + '%']);

console.log(`Documents matching ${JSON.stringify(pattern)}`);
console.table(rows);

if (rows[0]) {
  const { rows: samples } = await pool.query(
    `SELECT "sourceType", metadata->>'section' AS section,
            regexp_replace(left(content, 220), '\\s+', ' ', 'g') AS preview
     FROM kb_chunks WHERE metadata->>'source_id' = $1 ORDER BY id LIMIT 3`, [rows[0].source_id]);
  console.log(`\nSample chunks from ${rows[0].source_id}`);
  console.table(samples);
}

await pool.end();
