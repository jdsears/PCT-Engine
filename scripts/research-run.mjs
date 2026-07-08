import { pool } from '../src/db.mjs';
import { runResearch } from '../src/research/runResearch.mjs';

// The manual research run. The same runResearch() the in-service scheduler
// calls, with the full report printed for a human. Idempotent, safe to repeat,
// sends nothing.

const r = await runResearch({ log: console.log });

console.log('\n=== Research run report ===');
console.log(`Companies House: ${r.chCounts.companies} tracked, ${r.chCounts.ch_filing} filings, ${r.chCounts.ch_director_change} director changes inserted`);
console.log(`News sweep: ${r.newsCounts.queries} queries, ${r.newsCounts.seen} seen, ${r.newsCounts.inserted} stored, ${r.newsCounts.rejected ?? 0} rejected (not DC), ${r.newsCounts.foreignOnly ?? 0} dropped (foreign only)`);
console.log(`News signals matched to accounts: ${r.newsMatched}`);
console.log(`Companies scored: ${r.scored}`);
console.log(`Domains resolved: ${r.domains}`);
console.log(`Officer contacts: ${r.officersAdded} added, ${r.officersUpdated} refreshed, ${r.inOrbit} in the decision orbit`);
console.log(`Leads created: ${r.leadsCreated}   Leads updated: ${r.leadsUpdated}   (threshold ${r.threshold}, campaign ${r.campaign})`);
console.log(`Signals marked processed: ${r.processedCount}   Awaiting company match: ${r.awaitingMatch}`);
console.log(`Findymail credits spent this run: ${r.findymailCredits}`);
console.log(`Skipped below threshold: ${r.skippedCount}`);
for (const s of r.skipped.slice(0, 15)) console.log(`  - ${s}`);
if (r.skippedCount > 15) console.log(`  ... and ${r.skippedCount - 15} more`);
console.log('\nDone.');
await pool.end();
