import { search } from '../src/retrieve.mjs';
const query = process.argv[2];
if (!query) { console.error('Usage: node scripts/spotcheck.mjs "<query>"'); process.exit(1); }
const results = await search(query, { k: 5 });
console.log(`Query: "${query}"`);
console.table(results.map(r => ({
  title: r.title, section: r.section, line: r.line, sourceType: r.sourceType,
  score: r.score, preview: (r.snippet || '').slice(0, 80),
})));
process.exit(0);
