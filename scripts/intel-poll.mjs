import { pool } from '../src/db.mjs';
import { pendingIntelEmails, processIntelInbox } from '../src/studio/intelInbox.mjs';

// The intel inbox by hand. Dry run lists the forwarded newsletters waiting to
// be processed; --apply splits them, routes each item through the relevance
// gate, and files signals and studio post drafts. The service tick does the
// same automatically every five minutes when INTEL_SENDERS is set.
//
//   node --env-file=.env scripts/intel-poll.mjs
//   node --env-file=.env scripts/intel-poll.mjs --apply

const APPLY = process.argv.includes('--apply');

const pending = await pendingIntelEmails();
if (!pending.length) {
  console.log('Nothing waiting: no unprocessed newsletters from the intel senders in the engine inbox.');
  await pool.end();
  process.exit(0);
}

console.log(`${pending.length} forwarded newsletter(s) waiting:`);
for (const e of pending) console.log(`  - "${e.subject}" from ${e.from}, ${String(e.receivedAt).slice(0, 16)}`);

if (!APPLY) {
  console.log('\nDry run, nothing processed. Re-run with --apply to split, gate and file them.');
  await pool.end();
  process.exit(0);
}

const r = await processIntelInbox({ log: m => console.log(`  ${m}`) });
console.log('\n=== Intel inbox run ===');
console.log(`Emails: ${r.emails}   Items: ${r.items}   Signals filed: ${r.signals}   Post drafts: ${r.posts}   Dropped foreign: ${r.droppedForeign}   Ignored: ${r.ignored}`);
console.log('Signals join the pipeline on the next engine cycle; post drafts are in the Studio queue.');
await pool.end();
