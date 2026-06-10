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
