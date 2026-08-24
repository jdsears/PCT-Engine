import { pool } from '../src/db.mjs';

// The sweep's correction path, 24 August 2026: John's first live run caught
// nine right people whose companies' register rows held a different arm's
// domain (Colt's people mail from coltdcs.com, Virtus's from virtusdcs.com,
// SES's from ses-ltd.co.uk). This restores named contacts the sweep
// suppressed and stamps them recipient-confirmed, the same attestation the
// "they do work here" button records, so every net stands down for them from
// now on. It touches only rows the sweep itself suppressed, never a hand
// suppression, and their leads simply re-draft on the next cycle.
//
// Usage: node --env-file=.env scripts/restore-swept-contacts.mjs \
//          --domain coltdcs.com --domain virtusdcs.com --email x@y.com [--apply]
// --domain restores sweep-suppressed contacts whose mailbox is at that exact
// domain; --email restores one exact address. Dry by default.

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const take = flag => args.flatMap((a, i) => (a === flag && args[i + 1] ? [String(args[i + 1]).toLowerCase()] : []));
const domains = take('--domain');
const emails = take('--email');

if (!domains.length && !emails.length) {
  console.log('Nothing to restore: name at least one --domain or --email.');
  console.log('Example: node --env-file=.env scripts/restore-swept-contacts.mjs --domain coltdcs.com --email zmciwem@amazon.com --apply');
  await pool.end();
  process.exit(0);
}

const { rows } = await pool.query(
  `SELECT ct.id, ct.full_name, ct.email, c.name AS company,
          ct.payload->'suppressed'->>'reason' AS reason
   FROM contacts ct JOIN companies c ON c.id = ct.company_id
   WHERE ct.suppressed AND ct.payload->'suppressed'->>'by' = 'recipient sweep'
   ORDER BY c.name, ct.full_name`);

const wanted = rows.filter(r => {
  const em = String(r.email || '').toLowerCase();
  const dom = em.split('@')[1] || '';
  return emails.includes(em) || domains.includes(dom);
});

console.log(`${rows.length} contact(s) were suppressed by the sweep; ${wanted.length} match what you named.${APPLY ? '' : ' Dry run: nothing changes without --apply.'}\n`);
for (const r of wanted) console.log(`  ${r.full_name}  <${r.email}>  on ${r.company}`);

if (!APPLY) {
  if (wanted.length) console.log('\nRun again with --apply to restore and confirm them.');
  await pool.end();
  process.exit(0);
}

for (const r of wanted) {
  await pool.query(
    `UPDATE contacts SET suppressed = false,
       payload = (COALESCE(payload, '{}'::jsonb) - 'suppressed')
         || jsonb_build_object('recipient_confirmed', jsonb_build_object(
              'at', $2::text, 'by', 'sweep correction',
              'overrode', $3::text))
     WHERE id = $1 AND suppressed AND payload->'suppressed'->>'by' = 'recipient sweep'`,
    [r.id, new Date().toISOString(), String(r.reason || 'swept in error').slice(0, 200)]);
}
console.log(`\nApplied: ${wanted.length} contact(s) restored and recipient-confirmed; every net stands down for them from now on.`);
console.log('Their leads re-draft on the next cycle; nothing else to do.');
await pool.end();
