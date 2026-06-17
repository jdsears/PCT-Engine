import { pool } from '../src/db.mjs';
import { search } from '../src/retrieve.mjs';

// Phase 0 helper for the part-number configurator. Read-only: it surfaces the
// corpus text behind an ordering matrix or the PricingLevel exercises so the
// matrix can be extracted by hand into a config file. It writes nothing.
//
//   node --env-file=.env scripts/configurator-source.mjs --list "Jordan"
//       distinct documents whose title or id matches, with chunk counts, to
//       see what the corpus holds and pick the cleanest model.
//
//   node --env-file=.env scripts/configurator-source.mjs --doc "PricingLevel1"
//       the full text of every chunk of the matching documents, in order, so
//       the whole matrix or exercise set is recoverable, not a search snippet.
//
//   node --env-file=.env scripts/configurator-source.mjs --query "Jordan ordering matrix how to order" --k 8
//       top hybrid-search hits with full content, using the model-code retrieval.
//
// --list and --doc need DATABASE_URL only. --query also needs VOYAGE_API_KEY,
// since it embeds the query.

const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const list = get('--list');
const doc = get('--doc');
const query = get('--query');

if (list) {
  const { rows } = await pool.query(
    `SELECT metadata->>'title' AS title, metadata->>'source_id' AS source_id,
            metadata->>'line' AS line, count(*)::int AS chunks
     FROM kb_chunks
     WHERE metadata->>'title' ILIKE '%' || $1 || '%' OR metadata->>'source_id' ILIKE '%' || $1 || '%'
     GROUP BY 1, 2, 3 ORDER BY title`, [list]);
  console.log(`# Documents matching "${list}": ${rows.length}\n`);
  for (const r of rows) {
    console.log(`- ${r.title}  [line ${r.line || '-'}, ${r.chunks} chunk(s), id ${r.source_id || '-'}]`);
  }
} else if (doc) {
  const { rows } = await pool.query(
    `SELECT metadata->>'title' AS title, metadata->>'source_id' AS source_id,
            metadata->>'page' AS page, metadata->>'section' AS section,
            metadata->>'line' AS line, content
     FROM kb_chunks
     WHERE metadata->>'title' ILIKE '%' || $1 || '%' OR metadata->>'source_id' ILIKE '%' || $1 || '%'
     ORDER BY metadata->>'title', id`, [doc]);
  console.log(`# Full chunks for documents matching "${doc}": ${rows.length}\n`);
  let lastTitle = null;
  for (const r of rows) {
    if (r.title !== lastTitle) {
      console.log(`\n===== ${r.title}  (id ${r.source_id || '-'}, line ${r.line || '-'}) =====`);
      lastTitle = r.title;
    }
    console.log(`\n--- page ${r.page || '-'}${r.section ? ', ' + r.section : ''} ---`);
    console.log(r.content || '');
  }
} else if (query) {
  const results = await search(query, { k: Number(get('--k')) || 8 });
  console.log(`# Top ${results.length} hits for "${query}"\n`);
  for (const r of results) {
    console.log(`\n===== ${r.title}${r.page ? ', p' + r.page : ''}${r.section ? ', ' + r.section : ''}  (line ${r.line || '-'}, ${r.sourceType || '-'}) =====`);
    console.log(r.content || r.snippet || '');
  }
} else {
  console.log('Usage:');
  console.log('  --list "<term>"          documents matching, with chunk counts');
  console.log('  --doc "<title or id>"    full text of matching documents, in order');
  console.log('  --query "<query>" [--k N] top hybrid-search hits with full content');
}
await pool.end();
