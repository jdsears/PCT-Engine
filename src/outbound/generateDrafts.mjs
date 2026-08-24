import { pool } from '../db.mjs';
import { gatherGrounding } from './grounding.mjs';
import { composeDraft, recipientMismatch } from './draft.mjs';
import { crossCampaignClause, crossCampaignDays } from './crossCampaign.mjs';
import { staleDays, staleSql } from '../research/staleness.mjs';

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
//
// The eligibility clause takes its parameter positions per query, because the
// three selection queries below bind different lists. The multi-campaign
// change taught this the hard way: the clause gained a window parameter at
// $3, two of the three queries kept their old parameter lists, and Postgres
// refused every drafting run with "could not determine data type of
// parameter $2", one query loudly and one silently. Each query now binds
// exactly what its SQL references, and the gate proves the lists are dense.
const hasContact = (campaignParam, windowParam) => `EXISTS (
  SELECT 1 FROM contacts ct WHERE ct.company_id = l.company_id
    AND ct.in_decision_orbit AND NOT ct.suppressed AND NOT ct.rehearsal
    AND ct.email IS NOT NULL AND ct.email_bounced_at IS NULL
    AND ${crossCampaignClause({ campaignParam, windowParam })})`;

// The same lead, but ignoring the cross-campaign window, so waiting-on-
// discovery and held-by-window stay distinct answers.
const HAS_CONTACT_IGNORING_WINDOW = `EXISTS (
  SELECT 1 FROM contacts ct WHERE ct.company_id = l.company_id
    AND ct.in_decision_orbit AND NOT ct.suppressed AND NOT ct.rehearsal
    AND ct.email IS NOT NULL AND ct.email_bounced_at IS NULL)`;

const NO_OPEN_DRAFT = `NOT EXISTS (
  SELECT 1 FROM outbound_drafts d
  WHERE d.lead_id = l.id AND d.campaign = $1 AND d.status IN ('draft','approved'))`;

// The three selection queries, built together and returned with their bind
// lists so the pairing is a checkable fact rather than a convention. pick is
// the batch to draft; held counts leads whose only reachable contact was
// cold-opened by another campaign inside the window; waiting counts leads
// with no reachable contact at all, the ones contact discovery is still
// working. held and waiting partition the undrafted remainder, where the old
// waiting count quietly included the held ones.
export function draftQueries({ campaign, limit, windowDays, staleWindow, includeStale = false }) {
  return {
    pick: {
      sql: `SELECT l.id FROM leads l
     WHERE l.campaign = $1 AND l.stage = 'researched'
       AND ${NO_OPEN_DRAFT}
       AND ${hasContact('$1', '$3')}
       AND ${includeStale ? 'TRUE' : `NOT ${staleSql('l', '$4')}`}
     ORDER BY l.score DESC NULLS LAST LIMIT $2`,
      params: includeStale ? [campaign, limit, windowDays] : [campaign, limit, windowDays, staleWindow],
    },
    held: {
      sql: `SELECT count(*)::int AS n FROM leads l
     WHERE l.campaign = $1 AND l.stage = 'researched'
       AND ${NO_OPEN_DRAFT}
       AND ${HAS_CONTACT_IGNORING_WINDOW} AND NOT ${hasContact('$1', '$2')}`,
      params: [campaign, windowDays],
    },
    waiting: {
      sql: `SELECT count(*)::int AS n FROM leads l
     WHERE l.campaign = $1 AND l.stage = 'researched'
       AND ${NO_OPEN_DRAFT}
       AND NOT ${HAS_CONTACT_IGNORING_WINDOW}`,
      params: [campaign],
    },
  };
}

export async function generateDrafts({ limit = 5, leadId = null, campaign = 'marwin_dc', includeStale = false, log = () => {} } = {}) {
  const windowDays = String(crossCampaignDays());
  // A stale lead is excluded from new drafting by default: opening cold on
  // research the recipient's world has moved past reads as exactly that. A
  // targeted leadId ignores the flag, since a human choosing one lead is
  // itself the human action that clears staleness.
  const q = draftQueries({
    campaign,
    limit: Math.min(Math.max(1, limit), 20),
    windowDays,
    staleWindow: String(staleDays(campaign)),
    includeStale,
  });
  const leadIds = leadId ? [leadId] : (await pool.query(q.pick.sql, q.pick.params)).rows.map(r => r.id);

  // Leads whose only reachable contact sits inside another campaign's window.
  let heldByWindow = 0;
  if (!leadId) {
    try {
      heldByWindow = (await pool.query(q.held.sql, q.held.params)).rows[0]?.n ?? 0;
      if (heldByWindow) log(`  ${heldByWindow} lead(s) held: their contact was cold-opened by another campaign inside the ${windowDays} day window.`);
    } catch { heldByWindow = 0; }
  }

  const waiting = leadId ? 0 : (await pool.query(q.waiting.sql, q.waiting.params)).rows[0].n;

  log(`Drafting cold-open emails for ${leadIds.length} lead(s) in campaign ${campaign}${waiting ? `; ${waiting} lead(s) waiting on contact discovery` : ''}.`);

  const report = { considered: leadIds.length, drafted: 0, flagged: 0, failed: 0, waitingContact: waiting, heldByWindow, passedOver: 0 };
  for (const id of leadIds) {
    try {
      // The campaign travels: retrieval scope, drafter positioning and the
      // checker's permitted facts all follow it. Left to default here, a
      // pharma lead would ground and draft as a data centre one.
      // The recipient nets screen the free pick, so a company with one
      // mismatched and one clean contact drafts to the clean one instead
      // of manufacturing a blocked card.
      const grounding = await gatherGrounding(id, { campaign, screen: recipientMismatch });
      const d = await composeDraft(grounding);
      const rationale = { reason: grounding.signal?.text || grounding.icpReason || null, score: grounding.icpReason || null };
      await pool.query(
        `INSERT INTO outbound_drafts (lead_id, company_id, contact_id, campaign, email_type, subject, body, grounding, grounding_flags, rationale, model, status)
         VALUES ($1, $2, $3, $4, 'cold_open', $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, 'draft')`,
        [id, grounding.companyId, grounding.contactId, campaign, d.subject, d.body,
         JSON.stringify(grounding), JSON.stringify(d.flags), JSON.stringify(rationale), d.model]);
      report.drafted++;
      if (d.flags.length) report.flagged++;
      report.passedOver += grounding.passedOver || 0;
      log(`  ${grounding.company.name}: ${d.subject}${d.flags.length ? `  [${d.flags.length} flag(s)]` : ''}`
        + (grounding.passedOver ? `  (picked past ${grounding.passedOver} mismatched contact(s))` : '')
        + (grounding.missing.length ? `  (thin grounding: ${grounding.missing.join(', ')})` : ''));
    } catch (e) {
      report.failed++;
      log(`  FAILED lead ${id}: ${String(e.message).slice(0, 140)}`);
    }
  }
  return report;
}
