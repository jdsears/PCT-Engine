import { pool } from '../db.mjs';
import { ensureContactEmail, getCreditsSpent } from './findymail.mjs';

// Resolve emails for decision makers who do not have a verified one yet, best
// accounts first. Shared by the signal engine's auto-discovery step and the
// manual backfill script, so there is one spend-point and one set of rules:
// only decision-orbit contacts, never a suppressed one, never a re-spend on a
// verified email (ensureContactEmail skips those), and a hard cap per run so
// the credit spend stays bounded and visible.
export async function discoverEmails({ limit = 10, log = () => {} } = {}) {
  if (!(process.env.FINDYMAIL_API_KEY || '').trim()) {
    log('FINDYMAIL_API_KEY is not set, skipping email discovery');
    return { candidates: 0, resolved: 0, notFound: 0, failed: 0, credits: 0, skippedRun: 'no key' };
  }
  const before = getCreditsSpent();
  const { rows } = await pool.query(
    `SELECT ct.id, ct.full_name, ct.linkedin_url, ct.email, ct.email_verified_at,
            c.domain, c.name AS company
     FROM contacts ct JOIN companies c ON c.id = ct.company_id
     WHERE ct.in_decision_orbit AND NOT ct.suppressed
       AND (ct.email IS NULL OR ct.email_verified_at IS NULL)
       AND (ct.linkedin_url IS NOT NULL OR (ct.full_name IS NOT NULL AND c.domain IS NOT NULL))
       -- A recorded miss stands down for ninety days rather than being
       -- re-bought at the top of every run.
       AND (ct.payload->'email_lookup'->>'at' IS NULL
            OR (ct.payload->'email_lookup'->>'at')::timestamptz < now() - interval '90 days')
     ORDER BY c.icp_score DESC NULLS LAST, ct.full_name
     LIMIT $1`, [Math.min(Math.max(1, limit), 50)]);

  const report = { candidates: rows.length, resolved: 0, notFound: 0, failed: 0 };
  for (const ct of rows) {
    try {
      const r = await ensureContactEmail(ct, ct.domain);
      if (r.email) { report.resolved++; log(`resolved: ${ct.full_name} (${ct.company})`); }
      else if (r.skipped !== 'already verified') { report.notFound++; log(`not found: ${ct.full_name} (${ct.company})`); }
    } catch (e) {
      report.failed++;
      log(`failed: ${ct.full_name}: ${String(e.message).slice(0, 100)}`);
    }
  }
  report.credits = getCreditsSpent() - before;
  return report;
}
