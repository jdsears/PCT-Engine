import pg from 'pg';
const { Pool } = pg;

// Railway provides DATABASE_URL. Internal connections usually need no SSL;
// the public proxy connection does. If you hit an SSL error, adjust here.
const url = process.env.DATABASE_URL || '';
export const pool = new Pool({
  connectionString: url,
  ssl: url.includes('localhost') || url.includes('railway.internal')
    ? false
    : { rejectUnauthorized: false },
});

// An idle client losing its connection, for example a brief network drop,
// emits an error on the pool. Without a listener that would crash the process,
// so log it calmly and let the next query open a fresh connection.
pool.on('error', (err) => console.error('Postgres pool error (idle client):', err.message));

// Does the live schema have a column yet? The service deploys from main
// automatically while migrations are applied by hand, so new code routinely
// meets an old schema; readers and writers of a recent column ask first
// rather than fail a working feature in that window.
//
// Cache semantics matter: a present column is cached forever, since a column
// does not vanish, while an absent one is re-checked, so the moment the
// migration is applied the column starts being used with no redeploy or
// restart. These are human-paced actions, so the extra lookup costs nothing.
const columnCache = new Map();
export async function hasColumn(table, column) {
  const key = `${table}.${column}`;
  if (columnCache.get(key)) return true;
  try {
    const { rowCount } = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
      [table, column]);
    const present = rowCount > 0;
    if (present) columnCache.set(key, true);
    return present;
  } catch {
    return false; // unknown means do without, never fail the action
  }
}
