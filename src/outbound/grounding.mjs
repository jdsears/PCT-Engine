import { pool, hasColumn } from '../db.mjs';
import { search } from '../retrieve.mjs';
import { requireCampaign } from '../campaigns/registry.mjs';
import { isOpenerGrade, openerNote } from './openerGrade.mjs';
import { freshOnly } from '../research/freshness.mjs';

// The highest-scoring component reason from the stored ICP breakdown, in the
// engine's own recorded terms. Nothing inferred.
function topReason(breakdown) {
  if (!breakdown || typeof breakdown !== 'object') return null;
  let best = null;
  for (const v of Object.values(breakdown)) {
    if (v && typeof v === 'object' && typeof v.points === 'number' && (!best || v.points > best.points)) best = v;
  }
  return best?.reason || null;
}

// Assemble the only inputs an outbound draft is allowed to draw on: the lead's
// triggering signal, the ICP reason, the contact record (name and role only if
// recorded), and grounded product facts retrieved from the corpus with citations.
// Missing pieces are reported in `missing`, never invented around; the drafter
// must write less when grounding is thin, not fill the gap.
export async function gatherGrounding(leadId, { k = 4 , campaign = 'marwin_dc', contactId = null, screen = null } = {}) {
  // customer_status and the crm payload arrived with the customer list
  // import (migration 026); the service can deploy before the migration is
  // applied, so ask the schema rather than fail every draft in that window.
  const statusCol = (await hasColumn('companies', 'customer_status')) ? ', c.customer_status' : '';
  const crmCol = (await hasColumn('companies', 'crm')) ? ", c.crm->>'segment' AS crm_segment" : '';
  const lead = (await pool.query(
    `SELECT l.id, l.company_id, l.contact_id, l.campaign, l.score, l.score_breakdown,
            c.name AS company, c.company_type, c.region, c.domain${statusCol}${crmCol}
     FROM leads l JOIN companies c ON c.id = l.company_id WHERE l.id = $1`, [leadId])).rows[0];
  if (!lead) throw new Error(`lead ${leadId} not found`);

  // The contact: a caller's pinned contact first, else the lead's own, else
  // the best decision-orbit contact for the company. The pin exists for
  // follow-ups, 18 August 2026: a thread belongs to the person the sent
  // emails went to, and re-resolving the lead's current best mid-thread put
  // one person's greeting on another person's break-up.
  let contact = null;
  let passedOver = 0;
  const pick = async (sql, p) => (await pool.query(sql, p)).rows[0] || null;
  const row = contactId
    ? await pick(`SELECT id, full_name, role_title, email, payload->'recipient_confirmed' IS NOT NULL AS confirmed FROM contacts WHERE id = $1`, [contactId])
    : lead.contact_id
    ? await pick(`SELECT id, full_name, role_title, email, payload->'recipient_confirmed' IS NOT NULL AS confirmed FROM contacts WHERE id = $1`, [lead.contact_id])
    : await (async () => {
        // Recipient truth applies at selection since 24 August 2026: the pool
        // still holds contacts attached by the old loose people search, and
        // drafting them only manufactures blocked cards. The usual order
        // stands, and the first candidate the caller's screen passes clean is
        // the recipient. When nobody passes, the best candidate stands and
        // the card blocks for a human exactly as before, so a company is
        // never silently skipped. A pinned or lead-recorded contact is never
        // screened away: that choice was already made.
        const cands = (await pool.query(
          `SELECT id, full_name, role_title, email, payload->'recipient_confirmed' IS NOT NULL AS confirmed FROM contacts
           WHERE company_id = $1 AND in_decision_orbit AND NOT suppressed
           ORDER BY email_verified_at IS NULL, email_confidence DESC NULLS LAST LIMIT 6`, [lead.company_id])).rows;
        if (!screen || cands.length <= 1) return cands[0] || null;
        const co = { name: lead.company, domain: lead.domain };
        const idx = cands.findIndex(r => screen(
          { name: r.full_name, role: r.role_title, email: r.email, confirmed: !!r.confirmed }, co).length === 0);
        passedOver = idx > 0 ? idx : 0;
        return idx >= 0 ? cands[idx] : cands[0];
      })();
  // confirmed carries a recorded human attestation that this person works
  // at this company, which stands the recipient nets down for them.
  if (row) contact = { id: row.id, name: row.full_name || null, role: row.role_title || null, email: row.email || null, confirmed: !!row.confirmed };

  // The triggering signal: the most recent real, titled signal linked to the
  // company on either side. Which side matters: a contractor contact reads
  // about the project they were appointed to, an operator contact about their
  // build, and the drafter must know which it is writing to, so the linkage
  // travels with the signal as matchedAs.
  // A few candidates, freshest observed first, then the published date
  // decides: a story with a printed date older than the freshness window is
  // never the opener, because a cold email built on a three-year-old article
  // reads as exactly that. An undated story keeps today's behaviour.
  const sigs = (await pool.query(
    `SELECT id, signal_type, title, url, observed_at, payload->>'published' AS published,
            (contractor_company_id = $1) AS via_contractor
     FROM signals
     WHERE (company_id = $1 OR contractor_company_id = $1) AND title IS NOT NULL
     ORDER BY observed_at DESC LIMIT 5`, [lead.company_id])).rows;
  const sig = freshOnly(sigs, r => r.published)[0] || null;
  const signal = sig ? {
    id: sig.id, type: sig.signal_type, text: sig.title, source: sig.url || null, observedAt: sig.observed_at,
    publishedAt: sig.published || null,
    matchedAs: sig.via_contractor ? 'contractor' : 'operator',
  } : null;
  // A grounded signal can be true and still be unfit to open a cold email on. An
  // administrative filing informs that the account is worth approaching; it is
  // never the hook. The grade decides the opening; the note travels for review.
  const openerGrade = isOpenerGrade(signal);

  // Grounded product facts, retrieved the same way a co-pilot answer is, so any
  // product claim carries a citation and the supplier-naming policy travels with it.
  let product = [];
  let blockedSuppliers = [];
  try {
    // The campaign's grounding scope, so a pharma draft cannot cite data centre
    // material and a data centre draft cannot cite sanitary material. One line
    // filters directly; several are searched in turn and merged, since the
    // retrieval filter takes a single line.
    const def = typeof campaign === 'string' ? requireCampaign(campaign) : campaign;
    const q = `${def.grounding.retrievalFocus} ${lead.company_type || ''}`.trim();
    const lines = def.grounding.lines;
    const per = Math.max(1, Math.ceil(k / lines.length));
    const gathered = [];
    for (const line of lines) gathered.push(...await search(q, { filters: { line }, k: per }));
    const hits = gathered.slice(0, k);
    product = hits.map(h => ({
      title: h.title, page: h.page ?? null, section: h.section ?? null, sourceId: h.sourceId,
      snippet: (h.content || h.snippet || '').slice(0, 400),
    }));
    blockedSuppliers = [...new Set(hits.filter(h => h.nameable === false).map(h => h.manufacturer).filter(Boolean))];
  } catch {
    product = []; // thin grounding is handled by writing less, never by inventing
  }

  const missing = [];
  if (!signal) missing.push('signal');
  if (!product.length) missing.push('product_facts');
  if (!contact) missing.push('contact');

  return {
    leadId: lead.id, companyId: lead.company_id, contactId: contact?.id ?? null, campaign: lead.campaign,
    company: { name: lead.company, type: lead.company_type || null, region: lead.region || null,
               domain: lead.domain || null,
               customerStatus: lead.customer_status || null, segment: lead.crm_segment || null },
    contact, signal, openerGrade, openerNote: openerNote(signal, openerGrade),
    icpReason: topReason(lead.score_breakdown),
    product, blockedSuppliers, missing, passedOver,
  };
}
