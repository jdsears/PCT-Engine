import { pool } from '../src/db.mjs';
import { generateDrafts } from '../src/outbound/generateDrafts.mjs';

// The manual drafting run: the same generateDrafts() behind the Outbound page's
// generate button and the engine's auto-draft step, with the report printed.
// Nothing sends from this script; drafts queue for approval.
//
//   node --env-file=.env scripts/draft-coldopen.mjs            (top 5 researched leads)
//   node --env-file=.env scripts/draft-coldopen.mjs --lead 42  (one lead)
//   node --env-file=.env scripts/draft-coldopen.mjs --limit 10

const args = process.argv.slice(2);
const leadArg = args[args.indexOf('--lead') + 1];
const leadId = args.includes('--lead') && /^\d+$/.test(leadArg || '') ? Number(leadArg) : null;
const limArg = args[args.indexOf('--limit') + 1];
const limit = args.includes('--limit') && /^\d+$/.test(limArg || '') ? Number(limArg) : 5;

const r = await generateDrafts({ limit, leadId, log: console.log });

console.log('\n=== Cold-open draft run ===');
console.log(`Considered: ${r.considered}   Drafted: ${r.drafted}   With flags for review: ${r.flagged}   Failed: ${r.failed}`);
console.log('Drafts queue in the Outbound tab for approval. Nothing sends from this script.');
await pool.end();
