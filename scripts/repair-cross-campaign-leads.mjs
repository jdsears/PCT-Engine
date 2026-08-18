import { pool, hasColumn } from '../src/db.mjs';

// Repairs the leads the filing-signal default created, 18 August 2026: every
// Companies House filing landed as a marwin_dc signal (migration 023's
// single-tenant default), which pulled pharma-only companies into the data
// centre run, scored them on name and register health alone, created data
// centre leads and memberships for them, and drafted hyperscale copy to
// their people. Varicon Aqua, a bioreactor maker, was the live case. The
// insert is fixed at the source; this walks back the damage.
//
//   node --env-file=.env scripts/repair-cross-campaign-leads.mjs           (dry run)
//   node --env-file=.env scripts/repair-cross-campaign-leads.mjs --apply
//
// Scope is deliberately unambiguous: only marwin_dc leads and memberships
// on companies whose type is pharma_manufacturer or biotech_manufacturer,
// types the data centre campaign does not even score. A lead with a sent
// email is never touched, only reported, because a sent thread is history.
// Open drafts on the removed leads are rejected, never deleted.

const APPLY = process.argv.includes('--apply');
const TYPES = ['pharma_manufacturer', 'biotech_manufacturer'];

const { rows } = await pool.query(
  `SELECT l.id AS lead_id, l.stage, c.id AS company_id, c.name, c.company_type,
          (SELECT count(*)::int FROM outbound_drafts d WHERE d.lead_id = l.id AND d.status = 'sent') AS sent,
          (SELECT count(*)::int FROM outbound_drafts d WHERE d.lead_id = l.id AND d.status IN ('draft','approved')) AS open
   FROM leads l JOIN companies c ON c.id = l.company_id
   WHERE l.campaign = 'marwin_dc' AND c.company_type = ANY($1)
   ORDER BY c.name`, [TYPES]);

console.log(`${rows.length} data centre lead(s) on pharma-typed companies.`);
for (const r of rows) {
  console.log(`  lead #${r.lead_id} ${r.name} (${r.company_type})  stage ${r.stage}, ${r.open} open draft(s), ${r.sent} sent${r.sent ? '  <- has sent email, will be left for hand review' : ''}`);
}
if (!rows.length) { await pool.end(); process.exit(0); }

if (!APPLY) {
  console.log('\nDry run. Nothing changed. Re-run with --apply to reject their open drafts,');
  console.log('remove the untouched leads and their wrongly created marwin_dc memberships.');
  await pool.end();
  process.exit(0);
}

const removable = rows.filter(r => !r.sent);
const kept = rows.filter(r => r.sent);
const leadIds = removable.map(r => r.lead_id);
const companyIds = [...new Set(removable.map(r => r.company_id))];

const actor = (await hasColumn('outbound_drafts', 'decided_by')) ? `, decided_by = 'repair-cross-campaign script'` : '';
const rej = leadIds.length ? await pool.query(
  `UPDATE outbound_drafts SET status = 'rejected'${actor}
   WHERE lead_id = ANY($1) AND status IN ('draft', 'approved')`, [leadIds]) : { rowCount: 0 };
const led = leadIds.length ? await pool.query(`DELETE FROM leads WHERE id = ANY($1)`, [leadIds]) : { rowCount: 0 };
// The membership row research wrote is what keeps re-inviting these
// companies into the data centre run; removing it closes the loop. A
// company with a sent thread keeps everything until a human decides.
const mem = companyIds.length ? await pool.query(
  `DELETE FROM company_campaigns WHERE campaign = 'marwin_dc' AND company_id = ANY($1)`, [companyIds]) : { rowCount: 0 };

console.log(`\nRejected ${rej.rowCount} open draft(s), removed ${led.rowCount} lead(s) and ${mem.rowCount} marwin_dc membership(s).`);
if (kept.length) console.log(`Left for hand review (sent email on the thread): ${kept.map(r => r.name).join('; ')}.`);
console.log('Scores and breakdowns refresh on the next research run; nothing was sent.');
await pool.end();
