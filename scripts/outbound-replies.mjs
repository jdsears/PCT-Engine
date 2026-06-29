import { pool } from '../src/db.mjs';
import { pollReplies } from '../src/outbound/replies.mjs';

// Polls the engine mailbox for prospect replies to our outbound mail, matches
// each to the send it answers, and advances the lead to replied. Dry run by
// default; --apply records the replies and moves the leads. Idempotent: replies
// dedupe on the Graph message id, and the last poll time is kept in kv.

const APPLY = process.argv.includes('--apply');
const report = await pollReplies(pool, { apply: APPLY });

console.log(`Reply poll: scanned ${report.scanned} inbox message(s), matched ${report.matched} to a send`
  + (APPLY ? `, recorded ${report.recorded} new.` : ' (dry run, no writes).'));
if (!APPLY) console.log('Re-run with --apply to record replies and advance leads to replied.');
await pool.end();
