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
