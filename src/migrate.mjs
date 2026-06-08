import { pool } from './db.mjs';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`);

for (const f of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()) {
  const sql = await readFile(join(dir, f), 'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex');
  const { rows } = await pool.query('SELECT checksum FROM schema_migrations WHERE version = $1', [f]);
  if (rows[0]) {
    if (rows[0].checksum !== checksum) console.warn(`Migration ${f} changed since applied, skipping.`);
    continue;
  }
  console.log('Applying', f);
  await pool.query('BEGIN');
  try {
    await pool.query(sql);
    await pool.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [f, checksum]);
    await pool.query('COMMIT');
  } catch (e) { await pool.query('ROLLBACK'); throw e; }
}
console.log('Migrations up to date.');
await pool.end();
