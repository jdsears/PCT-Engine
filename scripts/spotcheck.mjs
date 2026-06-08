import { pool } from '../src/db.mjs';
import { embedTexts } from '../src/embeddings.mjs';

// Read-only similarity spot check. Embeds the query, then returns the nearest
// chunks by cosine distance. Needs DATABASE_URL and VOYAGE_API_KEY in the shell.
//
// Usage:
//   node scripts/spotcheck.mjs "CV3000 pressure rating"
//   node scripts/spotcheck.mjs "who is PCT" --corpus pct
//   node scripts/spotcheck.mjs "bellows seal" --k 5

const argv = process.argv.slice(2);
let corpus = null, k = 3;
const terms = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--corpus') corpus = argv[++i];
  else if (a.startsWith('--corpus=')) corpus = a.slice('--corpus='.length);
  else if (a === '--k') k = parseInt(argv[++i], 10) || 3;
  else terms.push(a);
}
const query = terms.join(' ') || 'CV3000 pressure rating';

const [vec] = await embedTexts([query], 'query');
const lit = '[' + vec.join(',') + ']';

const params = [lit, k];
let filter = '';
if (corpus) { filter = `WHERE metadata->>'corpus' = $3`; params.push(corpus); }

const { rows } = await pool.query(
  `SELECT metadata->>'title' AS title,
          metadata->>'section' AS section,
          metadata->>'line' AS line,
          metadata->>'corpus' AS corpus,
          "sourceType",
          round((1 - (embedding <=> $1::vector))::numeric, 4) AS score,
          regexp_replace(left(content, 90), '\\s+', ' ', 'g') AS preview
   FROM kb_chunks
   ${filter}
   ORDER BY embedding <=> $1::vector
   LIMIT $2`, params);

console.log(`Query: ${JSON.stringify(query)}${corpus ? `  corpus=${corpus}` : ''}`);
console.table(rows);
await pool.end();
