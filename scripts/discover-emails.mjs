import { pool } from '../src/db.mjs';
import { ensureContactEmail, getCreditsSpent } from '../src/research/findymail.mjs';

// Backfill emails for the decision makers already on file. Findymail credits
// cost money and the standing decision keeps automatic discovery off until the
// curated account list is applied, so this script is the deliberate manual
// spend: dry run by default, showing exactly who would be looked up and how,
// and --apply does the lookups for the best accounts first.
//
//   node --env-file=.env scripts/discover-emails.mjs                 (dry run)
//   node --env-file=.env scripts/discover-emails.mjs --apply --limit 10
//
// A contact with a verified email is never looked up again, per the client.

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const limArg = args[args.indexOf('--limit') + 1];
const LIMIT = args.includes('--limit') && /^\d+$/.test(limArg || '') ? Math.min(Number(limArg), 50) : 10;

const { rows: candidates } = await pool.query(
  `SELECT ct.id, ct.full_name, ct.role_title, ct.linkedin_url, ct.email, ct.email_verified_at,
          c.name AS company, c.domain, round(c.icp_score)::int AS score
   FROM contacts ct JOIN companies c ON c.id = ct.company_id
   WHERE ct.in_decision_orbit AND NOT ct.suppressed
     AND (ct.email IS NULL OR ct.email_verified_at IS NULL)
   ORDER BY c.icp_score DESC NULLS LAST, ct.full_name
   LIMIT $1`, [LIMIT]);

const route = (ct) => ct.linkedin_url ? 'LinkedIn profile' : (ct.full_name && ct.domain ? `name + ${ct.domain}` : null);

console.log(`${APPLY ? 'Discovering' : 'Dry run, would discover'} emails for up to ${LIMIT} decision maker(s) without a verified email.\n`);
let withRoute = 0;
for (const ct of candidates) {
  const r = route(ct);
  if (r) withRoute++;
  console.log(`  ${ct.full_name}  (${ct.company}, ICP ${ct.score ?? '—'})  ->  ${r || 'no route: no LinkedIn URL and no company domain'}`);
}

if (!APPLY) {
  console.log(`\n${candidates.length} candidate(s), ${withRoute} with a lookup route. Each lookup spends up to two Findymail credits.`);
  console.log('Re-run with --apply to spend the credits. This is the deliberate manual step; automatic discovery stays off.');
  await pool.end();
  process.exit(0);
}

if (!(process.env.FINDYMAIL_API_KEY || '').trim()) {
  console.log('\nFINDYMAIL_API_KEY is not set, so nothing can be looked up.');
  await pool.end();
  process.exit(1);
}

const report = { resolved: 0, notFound: 0, skipped: 0, failed: 0 };
for (const ct of candidates) {
  if (!route(ct)) { report.skipped++; continue; }
  try {
    const r = await ensureContactEmail(ct, ct.domain);
    if (r.email) { report.resolved++; console.log(`  resolved: ${ct.full_name} -> ${r.email}`); }
    else if (r.skipped === 'already verified') report.skipped++;
    else { report.notFound++; console.log(`  not found: ${ct.full_name}`); }
  } catch (e) {
    report.failed++;
    console.log(`  FAILED ${ct.full_name}: ${String(e.message).slice(0, 120)}`);
  }
}

console.log('\n=== Email discovery run ===');
console.log(`Resolved: ${report.resolved}   Not found: ${report.notFound}   Skipped: ${report.skipped}   Failed: ${report.failed}`);
console.log(`Findymail credits spent this run: ${getCreditsSpent()}`);
console.log('Resolved emails feed the outbound drafts and the contactability scoring; re-running never re-spends on a verified contact.');
await pool.end();
