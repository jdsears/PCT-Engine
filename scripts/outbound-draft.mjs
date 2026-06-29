import { pool } from '../src/db.mjs';
import { draftForLead } from '../src/outbound/draft.mjs';

// Generates first-touch email drafts for researched leads and queues them for a
// human to approve. Nothing sends here, and the lead stays at the researched
// stage until a real send in a later phase. Dry run by default: it prints the
// leads it would draft for and the opener reason. --apply calls the model and
// writes the drafts. --limit caps the batch (default 10), --campaign scopes it.

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const limitArg = args[args.indexOf('--limit') + 1];
const LIMIT = args.includes('--limit') && /^\d+$/.test(limitArg || '') ? Number(limitArg) : 10;
const campArg = args[args.indexOf('--campaign') + 1];
const CAMPAIGN = args.includes('--campaign') && campArg ? campArg : 'marwin_dc';

// The highest-scoring component reason from the stored ICP breakdown, for the
// review surface so a human can see why this account was picked.
function topReason(breakdown) {
  if (!breakdown || typeof breakdown !== 'object') return null;
  let best = null;
  for (const v of Object.values(breakdown)) {
    if (v && typeof v === 'object' && typeof v.points === 'number' && (!best || v.points > best.points)) best = v;
  }
  return best?.reason || null;
}

// Researched leads with no open draft, best-scoring first.
const { rows: leads } = await pool.query(
  `SELECT l.id AS lead_id, l.company_id, l.score, l.score_breakdown, c.name AS company
   FROM leads l JOIN companies c ON c.id = l.company_id
   WHERE l.campaign = $1 AND l.stage = 'researched'
     AND NOT EXISTS (
       SELECT 1 FROM outbound_drafts d
       WHERE d.lead_id = l.id AND d.campaign = $1 AND d.status IN ('draft','approved'))
   ORDER BY l.score DESC NULLS LAST
   LIMIT $2`,
  [CAMPAIGN, LIMIT]);

console.log(`${APPLY ? 'Drafting' : 'Dry run, would draft'} for ${leads.length} researched lead(s) in campaign ${CAMPAIGN} (limit ${LIMIT}).\n`);

const report = { drafted: 0, previewed: 0, failed: 0 };
for (const lead of leads) {
  // Best decision-orbit, non-suppressed contact, preferring a verified email.
  const { rows: contacts } = await pool.query(
    `SELECT id, full_name, role_title, email FROM contacts
     WHERE company_id = $1 AND in_decision_orbit AND NOT suppressed
     ORDER BY email_verified_at IS NULL, email_confidence DESC NULLS LAST
     LIMIT 1`,
    [lead.company_id]);
  const contact = contacts[0] || null;

  // The opener reason: a recent signal if there is one, else the campaign fit.
  const { rows: signals } = await pool.query(
    `SELECT title FROM signals WHERE company_id = $1 AND title IS NOT NULL
     ORDER BY observed_at DESC LIMIT 1`,
    [lead.company_id]);
  const reasonLine = signals[0]?.title
    ? `a data centre signal in the public record about ${lead.company}: ${signals[0].title}`
    : `${lead.company} fits the data centre cooling projects PCT supplies into`;

  if (!APPLY) {
    console.log(`- ${lead.company} (score ${lead.score ?? '—'})  ->  ${contact ? contact.full_name : 'no named contact'}`);
    console.log(`    opener: ${reasonLine}`);
    report.previewed++;
    continue;
  }

  try {
    const { subject, body, model } = await draftForLead({ company: { name: lead.company }, contact, reasonLine });
    const rationale = {
      score: lead.score,
      reason: reasonLine,
      topScoreReason: topReason(lead.score_breakdown),
      contact: contact ? { name: contact.full_name, role: contact.role_title, hasEmail: !!contact.email } : null,
    };
    await pool.query(
      `INSERT INTO outbound_drafts (lead_id, company_id, contact_id, campaign, subject, body, rationale, model, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'draft')`,
      [lead.lead_id, lead.company_id, contact?.id ?? null, CAMPAIGN, subject, body, JSON.stringify(rationale), model]);
    report.drafted++;
    console.log(`  drafted: ${lead.company}  |  ${subject}`);
  } catch (e) {
    report.failed++;
    console.log(`  FAILED: ${lead.company}: ${String(e.message).slice(0, 140)}`);
  }
}

console.log('\n=== Outbound draft run ===');
if (APPLY) console.log(`Drafted: ${report.drafted}   Failed: ${report.failed}`);
else console.log(`Previewed: ${report.previewed}. Re-run with --apply to generate and queue these drafts.`);
console.log('Drafts queue for approval in the Outbound tab. Nothing sends from this script.');
await pool.end();
