import { pool } from '../db.mjs';
import { companyOfficers } from './companiesHouse.mjs';
import { inOrbit } from './orbitRules.mjs';

// Contact discovery from the public register. Current directors of a named
// account become contacts with provenance ch_officers, so the funnel can reach
// people who are not on LinkedIn. Corporate officers and secretaries are
// skipped: one cannot be emailed and the other is usually a formation agent.

// Officer roles treated as people worth holding. Plain data.
export const PERSON_OFFICER_ROLES = ['director', 'llp-member', 'llp-designated-member', 'member'];

// Companies House gives names as "SURNAME, Forename Middle". Convert to a
// natural "Forename Middle Surname" with best-effort capitalisation.
export function formatOfficerName(raw) {
  if (!raw) return null;
  const titleCase = (s) => s.toLowerCase().replace(/(^|[\s\-'])([a-z])/g, (_, b, c) => b + c.toUpperCase());
  const ix = raw.indexOf(',');
  if (ix === -1) return titleCase(raw.trim());
  const surname = raw.slice(0, ix).trim();
  const forenames = raw.slice(ix + 1).trim();
  return titleCase(`${forenames} ${surname}`.replace(/\s+/g, ' ').trim());
}

// One definition of the decision orbit across the engine: the job title, via
// orbitRules. A register occupation of "Director", "Company Director" or blank
// says nothing about whether the person specifies flow plant, so a director
// qualifies only when the occupation names a specifier role, the same test the
// LinkedIn lane applies. This is why a board with no stated trades does not
// count, which is the honest answer.
export function inDecisionOrbit(officer) {
  if (!PERSON_OFFICER_ROLES.includes(officer.officer_role)) return false;
  return inOrbit(officer.occupation) === true;
}

// Fetches current officers for one company and upserts them as contacts.
// Never touches Findymail; email resolution is a separate, credit-spending
// decision for the outbound stage.
export async function syncOfficerContacts(company) {
  const counts = { added: 0, updated: 0, inOrbit: 0 };
  if (!company.ch_number) return counts;
  const officers = await companyOfficers(company.ch_number);
  for (const o of officers) {
    if (!PERSON_OFFICER_ROLES.includes(o.officer_role)) continue;
    const fullName = formatOfficerName(o.name);
    if (!fullName) continue;
    const roleTitle = (o.occupation && !/^none$/i.test(o.occupation))
      ? formatOfficerName(o.occupation) : 'Director';
    const orbit = inDecisionOrbit(o);
    if (orbit) counts.inOrbit++;
    const { rows } = await pool.query(
      `INSERT INTO contacts (company_id, full_name, role_title, in_decision_orbit, source, payload)
       VALUES ($1, $2, $3, $4, 'ch_officers', $5::jsonb)
       ON CONFLICT (company_id, lower(full_name)) DO UPDATE SET
         role_title = EXCLUDED.role_title, in_decision_orbit = EXCLUDED.in_decision_orbit,
         source = COALESCE(contacts.source, EXCLUDED.source)
       RETURNING (xmax = 0) AS inserted`,
      [company.id, fullName, roleTitle, orbit,
       JSON.stringify({ officer_role: o.officer_role, appointed_on: o.appointed_on ?? null, occupation: o.occupation ?? null })]);
    if (rows[0]?.inserted) counts.added++; else counts.updated++;
  }
  return counts;
}
