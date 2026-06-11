import { pool } from '../src/db.mjs';
import { findContacts, enrichDirectors, laneReady } from '../src/research/linkedinResearch.mjs';
import { callsUsedToday, dailyCap, CapReached, AccountUnhealthy } from '../src/research/unipile.mjs';
import { ensureContactEmail, getCreditsSpent } from '../src/research/findymail.mjs';
import { ORBIT_TITLES } from '../src/research/orbitRules.mjs';

// The LinkedIn lane's orchestrator. Dry run by default: it prints what it
// would search and write, calling nothing. --apply does the work, within the
// daily cap, stopping immediately on any account-health error.
//
//   node scripts/linkedin-enrich.mjs [--company "Name"] [--limit 10] [--apply]

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const flag = (name, def) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] != null ? args[i + 1] : def;
};
const companyFilter = flag('--company', '');
const companyLimit = Math.max(1, parseInt(flag('--limit', '5'), 10) || 5);
const emailDiscovery = (process.env.EMAIL_DISCOVERY || 'off') === 'on';

if (apply && !laneReady()) {
  console.log('The lane is not configured. Set UNIPILE_DSN, UNIPILE_API_KEY and UNIPILE_ACCOUNT_ID');
  console.log('(run scripts/unipile-check.mjs first to resolve the account id), then re-run.');
  await pool.end();
  process.exit(1);
}

const { rows: companies } = await pool.query(
  `SELECT id, name, domain, ch_number FROM companies
   WHERE named_account AND ($1 = '' OR name ILIKE '%' || $1 || '%')
   ORDER BY icp_score DESC NULLS LAST, name LIMIT $2`,
  [companyFilter, companyLimit]);

if (!companies.length) {
  console.log(companyFilter ? `No named account matches "${companyFilter}".` : 'No named accounts found.');
  await pool.end();
  process.exit(0);
}

const ids = companies.map(c => c.id);
const orbitCount = async () => (await pool.query(
  `SELECT count(*)::int AS n FROM contacts
   WHERE company_id = ANY($1) AND in_decision_orbit AND NOT suppressed`, [ids])).rows[0].n;

const orbitBefore = await orbitCount();
const report = {
  touched: 0, enriched: 0, leftBlank: 0, ambiguous: 0,
  newContacts: 0, updated: 0, kept: 0, examples: [], found: [], stoppedEarly: null,
  emailsResolved: 0, potentialEmails: 0,
};

console.log(`${apply ? 'Apply run' : 'Dry run'}: ${companies.length} compan${companies.length === 1 ? 'y' : 'ies'}, email discovery ${emailDiscovery ? 'on' : 'off'}.\n`);

for (const co of companies) {
  console.log(`${co.name}`);
  const { rows: pending } = await pool.query(
    `SELECT full_name FROM contacts
     WHERE company_id = $1 AND source = 'ch_officers' AND NOT suppressed
       AND (enriched_at IS NULL OR enriched_at < now() - interval '30 days')
     ORDER BY full_name`, [co.id]);

  if (!apply) {
    console.log(`  would run one people search: "${co.name}" for the specifier roles (${ORBIT_TITLES.slice(0, 4).join(', ')}, ...), limit 5`);
    console.log(`  would then enrich ${pending.length} register director${pending.length === 1 ? '' : 's'} by name${pending.length ? ': ' + pending.map(p => p.full_name).join(', ') : ''}`);
    if (emailDiscovery) {
      if (co.domain) {
        const { rows: [{ n }] } = await pool.query(
          `SELECT count(*)::int AS n FROM contacts
           WHERE company_id = $1 AND in_decision_orbit AND NOT suppressed AND email_verified_at IS NULL`, [co.id]);
        report.potentialEmails += n;
        console.log(`  would look up ${n} email${n === 1 ? '' : 's'} via Findymail, ${n} credit${n === 1 ? '' : 's'}, on the in-orbit contacts here`);
      } else {
        console.log(`  no domain on file, Findymail would be skipped`);
      }
    }
    continue;
  }

  try {
    // People search first: the decision-makers for flow instrumentation are
    // the design and project engineers on the build, not the statutory
    // directors. Directors are enriched second, opportunistically.
    const f = await findContacts(co, { limit: 5 });
    const d = await enrichDirectors(co);
    report.touched++;
    report.enriched += d.enriched; report.leftBlank += d.left; report.ambiguous += d.ambiguous;
    report.examples.push(...d.examples);
    report.newContacts += f.created || 0; report.updated += f.updated || 0; report.kept += f.kept || 0;
    report.found.push(...(f.contacts || []).filter(c => c.outcome === 'created'));
    const oa = f.filteredOutOfArea ? `, ${f.filteredOutOfArea} dropped as out of area` : '';
    console.log(`  people search: ${f.created || 0} new, ${f.updated || 0} updated, ${f.kept || 0} kept fresh${oa}. Directors: ${d.enriched} enriched, ${d.left} left as register data.`);

    if (emailDiscovery && co.domain) {
      const { rows: orbit } = await pool.query(
        `SELECT id, full_name, email, email_verified_at, linkedin_url FROM contacts
         WHERE company_id = $1 AND in_decision_orbit AND NOT suppressed
           AND email_verified_at IS NULL`, [co.id]);
      for (const c of orbit) {
        try {
          const r = await ensureContactEmail(c, co.domain);
          if (!r?.skipped) report.emailsResolved++;
        } catch (e) { console.log(`  email lookup failed for ${c.full_name}: ${String(e.message).slice(0, 80)}`); }
      }
    }
  } catch (e) {
    if (e instanceof CapReached) { report.stoppedEarly = e.message; break; }
    if (e instanceof AccountUnhealthy) { report.stoppedEarly = e.message; break; }
    console.log(`  failed for ${co.name}: ${String(e.message).slice(0, 160)}`);
  }
}

const orbitAfter = apply ? await orbitCount() : orbitBefore;
const used = laneReady() ? await callsUsedToday().catch(() => null) : null;

console.log('\n=== LinkedIn enrich report ===');
console.log(`Mode: ${apply ? 'apply' : 'dry run, nothing called, nothing written'}`);
console.log(`Companies touched: ${apply ? report.touched : companies.length}${companyFilter ? ` (filter "${companyFilter}")` : ''}`);
if (apply) {
  console.log(`Directors enriched: ${report.enriched}   Left as register data: ${report.leftBlank}   Ambiguous, skipped: ${report.ambiguous}`);
  console.log(`People search contacts: ${report.newContacts} new, ${report.updated} updated, ${report.kept} kept fresh`);
  console.log(`Decision orbit: ${orbitBefore} before, ${orbitAfter} after`);
  if (report.found.length) {
    console.log('New contacts from the people search (the specifiers):');
    for (const c of report.found.slice(0, 6)) {
      console.log(`  ${c.name} - ${c.title || 'no title given'} (orbit: ${c.orbit === null ? 'unknown' : c.orbit})`);
    }
  }
  if (report.examples.length) {
    console.log('Directors enriched with a real title:');
    for (const ex of report.examples.slice(0, 5)) {
      console.log(`  ${ex.name}: "${ex.oldRole || 'no title'}" -> "${ex.newTitle}" (orbit: ${ex.orbit === null ? 'unknown' : ex.orbit})`);
    }
  }
}
if (used != null) console.log(`Unipile calls used today: ${used} of ${dailyCap()} (UTC day)`);
if (!apply && emailDiscovery) {
  console.log(`Email discovery: on, a real run would look up about ${report.potentialEmails} email(s), ${report.potentialEmails} Findymail credit(s), on the in-orbit contacts shown`);
} else {
  console.log(`Email discovery: ${emailDiscovery ? `on, ${report.emailsResolved} resolved, ${getCreditsSpent()} credits spent` : 'off (EMAIL_DISCOVERY=off), no Findymail credits spent'}`);
}
if (report.stoppedEarly) console.log(`Stopped early: ${report.stoppedEarly}`);
console.log('Done.');
await pool.end();
