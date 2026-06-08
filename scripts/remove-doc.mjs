import { pool } from '../src/db.mjs';

// Delete every chunk of a single document, by exact source id. Read the source
// id from inspect.mjs first. Removes across whichever corpus the document is in.
const sid = process.argv[2];
if (!sid) { console.error('Usage: node scripts/remove-doc.mjs "<source_id>"'); process.exit(1); }
const res = await pool.query(`DELETE FROM kb_chunks WHERE metadata->>'source_id' = $1`, [sid]);
console.log(`Removed ${res.rowCount} chunks for ${sid}.`);
await pool.end();
