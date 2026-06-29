import { pool } from '../src/db.mjs';
import { gatherGrounding } from '../src/outbound/grounding.mjs';
import { composeDraft } from '../src/outbound/draft.mjs';

// Generates grounded cold-open (Email 1) drafts and queues them as 'draft' for a
// human to approve. Every draft stores its grounding and any unsupported-claim
// flags. There is no send path in here, and the kill switch is never touched.
//
//   node --env-file=.env scripts/draft-coldopen.mjs            (top 5 researched leads)
//   node --env-file=.env scripts/draft-coldopen.mjs --lead 42  (one lead)
//   node --env-file=.env scripts/draft-coldopen.mjs --limit 10

const args = process.argv.slice(2);
const leadArg = args[args.indexOf('--lead') + 1];
const ONE = args.includes('--lead') && /^\d+$/.test(leadArg || '') ? Number(leadArg) : null;
const limArg = args[args.indexOf('--limit') + 1];
const LIMIT = args.includes('--limit') && /^\d+$/.test(limArg || '') ? Number(limArg) : 5;
const CAMPAIGN = 'marwin_dc';

const leadIds = ONE ? [ONE] : (await pool.query(
  `SELECT l.id FROM leads l
   WHERE l.campaign = $1 AND l.stage = 'researched'
     AND NOT EXISTS (SELECT 1 FROM outbound_drafts d WHERE d.lead_id = l.id AND d.campaign = $1 AND d.status IN ('draft','approved'))
   ORDER BY l.score DESC NULLS LAST LIMIT $2`, [CAMPAIGN, LIMIT])).rows.map(r => r.id);

console.log(`Drafting cold-open emails for ${leadIds.length} lead(s) in campaign ${CAMPAIGN}.\n`);

const report = { drafted: 0, flagged: 0, failed: 0 };
for (const id of leadIds) {
  try {
    const grounding = await gatherGrounding(id);
    const d = await composeDraft(grounding);
    const rationale = { reason: grounding.signal?.text || grounding.icpReason || null, score: grounding.icpReason || null };
    await pool.query(
      `INSERT INTO outbound_drafts (lead_id, company_id, contact_id, campaign, email_type, subject, body, grounding, grounding_flags, rationale, model, status)
       VALUES ($1, $2, $3, $4, 'cold_open', $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, 'draft')`,
      [id, grounding.companyId, grounding.contactId, CAMPAIGN, d.subject, d.body,
       JSON.stringify(grounding), JSON.stringify(d.flags), JSON.stringify(rationale), d.model]);
    report.drafted++;
    if (d.flags.length) report.flagged++;
    console.log(`  ${grounding.company.name}: ${d.subject}${d.flags.length ? `  [${d.flags.length} flag(s)]` : ''}`
      + (grounding.missing.length ? `  (thin grounding: ${grounding.missing.join(', ')})` : ''));
  } catch (e) {
    report.failed++;
    console.log(`  FAILED lead ${id}: ${String(e.message).slice(0, 140)}`);
  }
}

console.log('\n=== Cold-open draft run ===');
console.log(`Drafted: ${report.drafted}   With flags for review: ${report.flagged}   Failed: ${report.failed}`);
console.log('Drafts queue in the Outbound tab for approval. Nothing sends from this script.');
await pool.end();
