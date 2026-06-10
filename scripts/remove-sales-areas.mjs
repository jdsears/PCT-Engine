import { pool } from '../src/db.mjs';
const res = await pool.query(`DELETE FROM kb_chunks WHERE metadata->>'title' ILIKE '%Sales Areas%'`);
console.log(`Removed ${res.rowCount} Sales Areas chunks.`);
await pool.end();
