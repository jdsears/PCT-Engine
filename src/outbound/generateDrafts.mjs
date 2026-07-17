import { pool } from '../db.mjs';
import { gatherGrounding } from './grounding.mjs';
import { composeDraft } from './draft.mjs';

// Generate grounded cold-open drafts for researched leads and queue them as
// 'draft' for a human to approve. Extracted from scripts/draft-coldopen.mjs so
// the manual script, the Outbound page's generate button and the signal
// engine's auto-draft step share one source of truth. There is no send path in
// here and the kill switch is never touched: every draft lands in the review
// queue, and the one-open-draft-per-lead rule means re-running never piles up
// duplicates.
export async function generateDrafts({ limit = 5, leadId = null, campaign = 'marwin_dc', log = () => {} } = {}) {
  const leadIds = leadId ? [leadId] : (await pool.query(
    `SELECT l.id FROM leads l
     WHERE l.campaign = $1 AND l.stage = 'researched'
       AND NOT EXISTS (SELECT 1 FROM outbound_drafts d WHERE d.lead_id = l.id AND d.campaign = $1 AND d.status IN ('draft','approved'))
     ORDER BY l.score DESC NULLS LAST LIMIT $2`, [campaign, Math.min(Math.max(1, limit), 20)])).rows.map(r => r.id);

  log(`Drafting cold-open emails for ${leadIds.length} lead(s) in campaign ${campaign}.`);

  const report = { considered: leadIds.length, drafted: 0, flagged: 0, failed: 0 };
  for (const id of leadIds) {
    try {
      const grounding = await gatherGrounding(id);
      const d = await composeDraft(grounding);
      const rationale = { reason: grounding.signal?.text || grounding.icpReason || null, score: grounding.icpReason || null };
      await pool.query(
        `INSERT INTO outbound_drafts (lead_id, company_id, contact_id, campaign, email_type, subject, body, grounding, grounding_flags, rationale, model, status)
         VALUES ($1, $2, $3, $4, 'cold_open', $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, 'draft')`,
        [id, grounding.companyId, grounding.contactId, campaign, d.subject, d.body,
         JSON.stringify(grounding), JSON.stringify(d.flags), JSON.stringify(rationale), d.model]);
      report.drafted++;
      if (d.flags.length) report.flagged++;
      log(`  ${grounding.company.name}: ${d.subject}${d.flags.length ? `  [${d.flags.length} flag(s)]` : ''}`
        + (grounding.missing.length ? `  (thin grounding: ${grounding.missing.join(', ')})` : ''));
    } catch (e) {
      report.failed++;
      log(`  FAILED lead ${id}: ${String(e.message).slice(0, 140)}`);
    }
  }
  return report;
}
