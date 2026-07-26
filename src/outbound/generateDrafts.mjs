import { pool } from '../db.mjs';
import { gatherGrounding } from './grounding.mjs';
import { composeDraft } from './draft.mjs';
import { crossCampaignClause, crossCampaignDays } from './crossCampaign.mjs';

// Generate grounded cold-open drafts for researched leads and queue them as
// 'draft' for a human to approve. Extracted from scripts/draft-coldopen.mjs so
// the manual script, the Outbound page's generate button and the signal
// engine's auto-draft step share one source of truth. There is no send path in
// here and the kill switch is never touched: every draft lands in the review
// queue, and the one-open-draft-per-lead rule means re-running never piles up
// duplicates.
// A lead may only be drafted when its company has someone to write to: an
// in-orbit contact, not suppressed, with a live email. A draft without a
// recipient cannot be sent and only clutters the review queue; the people
// search and email discovery keep working the waiting leads until they
// qualify, and the report says how many are held back so the queue's
// silence is explained rather than mysterious.
// A contact inside another campaign's cross-campaign window is not eligible,
// so the draft is never generated rather than generated and blocked. The held
// leads are counted and reported, so the queue's silence is explained.
const HAS_CONTACT = `EXISTS (
  SELECT 1 FROM contacts ct WHERE ct.company_id = l.company_id
    AND ct.in_decision_orbit AND NOT ct.suppressed AND NOT ct.rehearsal
    AND ct.email IS NOT NULL AND ct.email_bounced_at IS NULL
    AND ${crossCampaignClause({ campaignParam: '$1', windowParam: '$3' })})`;

// The same lead, but ignoring the cross-campaign window, so the report can say
// how many leads are waiting on it rather than leaving the queue unexplained.
const HAS_CONTACT_IGNORING_WINDOW = `EXISTS (
  SELECT 1 FROM contacts ct WHERE ct.company_id = l.company_id
    AND ct.in_decision_orbit AND NOT ct.suppressed AND NOT ct.rehearsal
    AND ct.email IS NOT NULL AND ct.email_bounced_at IS NULL)`;

export async function generateDrafts({ limit = 5, leadId = null, campaign = 'marwin_dc', log = () => {} } = {}) {
  const windowDays = String(crossCampaignDays());
  const leadIds = leadId ? [leadId] : (await pool.query(
    `SELECT l.id FROM leads l
     WHERE l.campaign = $1 AND l.stage = 'researched'
       AND NOT EXISTS (SELECT 1 FROM outbound_drafts d WHERE d.lead_id = l.id AND d.campaign = $1 AND d.status IN ('draft','approved'))
       AND ${HAS_CONTACT}
     ORDER BY l.score DESC NULLS LAST LIMIT $2`, [campaign, Math.min(Math.max(1, limit), 20), windowDays])).rows.map(r => r.id);

  // Leads whose only reachable contact sits inside another campaign's window.
  let heldByWindow = 0;
  try {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM leads l
       WHERE l.campaign = $1 AND l.stage = 'researched'
         AND NOT EXISTS (SELECT 1 FROM outbound_drafts d WHERE d.lead_id = l.id AND d.campaign = $1 AND d.status IN ('draft','approved'))
         AND ${HAS_CONTACT_IGNORING_WINDOW} AND NOT ${HAS_CONTACT}`, [campaign, null, windowDays]);
    heldByWindow = rows[0]?.n ?? 0;
    if (heldByWindow) log(`  ${heldByWindow} lead(s) held: their contact was cold-opened by another campaign inside the ${windowDays} day window.`);
  } catch { heldByWindow = 0; }

  const waiting = leadId ? 0 : (await pool.query(
    `SELECT count(*)::int AS n FROM leads l
     WHERE l.campaign = $1 AND l.stage = 'researched'
       AND NOT EXISTS (SELECT 1 FROM outbound_drafts d WHERE d.lead_id = l.id AND d.campaign = $1 AND d.status IN ('draft','approved'))
       AND NOT ${HAS_CONTACT}`, [campaign])).rows[0].n;

  log(`Drafting cold-open emails for ${leadIds.length} lead(s) in campaign ${campaign}${waiting ? `; ${waiting} lead(s) waiting on contact discovery` : ''}.`);

  const report = { considered: leadIds.length, drafted: 0, flagged: 0, failed: 0, waitingContact: waiting };
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
