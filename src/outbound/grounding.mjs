import { pool } from '../db.mjs';
import { search } from '../retrieve.mjs';

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
export async function gatherGrounding(leadId, { k = 4 } = {}) {
  const lead = (await pool.query(
    `SELECT l.id, l.company_id, l.contact_id, l.campaign, l.score, l.score_breakdown,
            c.name AS company, c.company_type, c.region
     FROM leads l JOIN companies c ON c.id = l.company_id WHERE l.id = $1`, [leadId])).rows[0];
  if (!lead) throw new Error(`lead ${leadId} not found`);

  // The contact: the lead's own contact if set, else the best decision-orbit
  // contact for the company. Name and role only if recorded, otherwise null.
  let contact = null;
  const pick = async (sql, p) => (await pool.query(sql, p)).rows[0] || null;
  const row = lead.contact_id
    ? await pick(`SELECT id, full_name, role_title, email FROM contacts WHERE id = $1`, [lead.contact_id])
    : await pick(
        `SELECT id, full_name, role_title, email FROM contacts
         WHERE company_id = $1 AND in_decision_orbit AND NOT suppressed
         ORDER BY email_verified_at IS NULL, email_confidence DESC NULLS LAST LIMIT 1`, [lead.company_id]);
  if (row) contact = { id: row.id, name: row.full_name || null, role: row.role_title || null, email: row.email || null };

  // The triggering signal: the most recent real, titled signal for the company.
  const sig = await pick(
    `SELECT id, signal_type, title, url, observed_at FROM signals
     WHERE company_id = $1 AND title IS NOT NULL ORDER BY observed_at DESC LIMIT 1`, [lead.company_id]);
  const signal = sig ? { id: sig.id, type: sig.signal_type, text: sig.title, source: sig.url || null, observedAt: sig.observed_at } : null;

  // Grounded product facts, retrieved the same way a co-pilot answer is, so any
  // product claim carries a citation and the supplier-naming policy travels with it.
  let product = [];
  let blockedSuppliers = [];
  try {
    const q = `Marwin control valve data centre chilled water cooling ${lead.company_type || ''}`.trim();
    const hits = await search(q, { filters: { line: 'marwin' }, k });
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
    company: { name: lead.company, type: lead.company_type || null, region: lead.region || null },
    contact, signal, icpReason: topReason(lead.score_breakdown),
    product, blockedSuppliers, missing,
  };
}
