import { pool } from '../src/db.mjs';

// Read-only snapshot of what is in kb_chunks. Needs DATABASE_URL in the shell.
// Usage: node scripts/status.mjs

const show = async (label, sql) => {
  const { rows } = await pool.query(sql);
  console.log(`\n${label}`);
  console.table(rows);
};

const totals = await pool.query(
  `SELECT count(*)::int AS chunks,
          count(DISTINCT metadata->>'source_id')::int AS documents
   FROM kb_chunks`);
console.log('Totals:', totals.rows[0]);

await show('By corpus', `
  SELECT metadata->>'corpus' AS corpus,
         count(DISTINCT metadata->>'source_id')::int AS documents,
         count(*)::int AS chunks
  FROM kb_chunks GROUP BY 1 ORDER BY 1`);

await show('By segment', `
  SELECT segment, count(*)::int AS chunks
  FROM kb_chunks GROUP BY 1 ORDER BY 1`);

await show('By sourceType', `
  SELECT "sourceType", count(*)::int AS chunks
  FROM kb_chunks GROUP BY 1 ORDER BY 2 DESC`);

await show('Richards chunks by line', `
  SELECT metadata->>'line' AS line, count(*)::int AS chunks
  FROM kb_chunks WHERE metadata->>'corpus' = 'richards'
  GROUP BY 1 ORDER BY 2 DESC`);

await show('PCT chunks by top folder', `
  SELECT metadata->>'topFolder' AS folder, count(*)::int AS chunks
  FROM kb_chunks WHERE metadata->>'corpus' = 'pct'
  GROUP BY 1 ORDER BY 2 DESC`);

await show('Content type mix', `
  SELECT metadata->>'contentType' AS type, count(*)::int AS chunks
  FROM kb_chunks GROUP BY 1 ORDER BY 2 DESC`);

await pool.end();
