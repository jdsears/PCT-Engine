import { pool } from '../src/db.mjs';
import { findContacts, enrichDirectors, laneReady } from '../src/research/linkedinResearch.mjs';
import { callsUsedToday, dailyCap, CapReached, AccountUnhealthy, accountForCampaign } from '../src/research/unipile.mjs';
import { ensureContactEmail, getCreditsSpent } from '../src/research/findymail.mjs';
import { getCampaign, requireCampaign } from '../src/campaigns/registry.mjs';
import { roleWindow } from '../src/research/orbitRules.mjs';

// The LinkedIn lane's orchestrator. Dry run by default: it prints what it
// would search and write, calling nothing. --apply does the work, within the
// daily cap, stopping immediately on any account-health error.
//
//   node scripts/linkedin-enrich.mjs [--company "Name"] [--campaign pharma_steriflow] [--limit 10] [--new] [--apply]

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const flag = (name, def) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] != null ? args[i + 1] : def;
};
const companyFilter = flag('--company', '');
const companyLimit = Math.max(1, parseInt(flag('--limit', '5'), 10) || 5);
// --campaign scopes the walk to one campaign's members and routes every
// search through that campaign's connected account. This is the force lever
// for a fresh research wave, John's instruction, 12 August 2026: pharma had
// 125 researched leads all waiting on contact discovery, and the in-cycle
// search's small batches would have taken days to reach them.
const campaignArg = flag('--campaign', '');
const camp = campaignArg ? requireCampaign(campaignArg) : null;
const emailDiscovery = (process.env.EMAIL_DISCOVERY || 'off') === 'on';
// Register-director enrichment is opt-in. Across the first runs it enriched
// none and ate the daily cap, since statutory directors are not the specifiers,
// so the people search keeps the cap by default. Pass --directors to include it.
const doDirectors = args.includes('--directors');
// --new advances coverage: skip companies already people-searched in the last
// thirty days, so each run picks up the next highest-scoring untouched accounts
// rather than re-searching the ones already done. Read from the call ledger, so
// it counts a search even when it found nobody.
const onlyNew = args.includes('--new');

if (apply && !laneReady()) {
  console.log('The lane is not configured. Set UNIPILE_DSN, UNIPILE_API_KEY and UNIPILE_ACCOUNT_ID');
  console.log('(run scripts/unipile-check.mjs first to resolve the account id), then re-run.');
  await pool.end();
  process.exit(1);
}

// When advancing, exclude accounts with a findContacts call logged in the last
// thirty days. The target string is exactly what findContacts records.
const newClause = onlyNew ? `AND NOT EXISTS (
       SELECT 1 FROM unipile_calls u
       WHERE u.target = 'findContacts: ' || companies.name
         AND u.called_at > now() - interval '30 days')` : '';
// Selection order serves the drafting queue, the same rule as the in-cycle
// search: companies whose researched leads are waiting on an emailable
// specifier come first, then the rest by score. A force run works the
// backlog that is actually blocking outreach before it explores.
const params = [companyFilter];
let scope = '';
if (camp) { params.push(camp.id); scope = ` AND EXISTS (SELECT 1 FROM company_campaigns m WHERE m.company_id = companies.id AND m.campaign = $${params.length})`; }
params.push(companyLimit);
const { rows: companies } = await pool.query(
  `SELECT id, name, domain, ch_number,
          (SELECT array_agg(cc.campaign ORDER BY cc.campaign) FROM company_campaigns cc WHERE cc.company_id = companies.id) AS memberships,
          (SELECT count(*)::int FROM unipile_calls u WHERE u.target = 'findContacts: ' || companies.name) AS prior_searches
   FROM companies
   WHERE named_account AND ($1 = '' OR name ILIKE '%' || $1 || '%')${scope}
   ${newClause}
   ORDER BY EXISTS (
       SELECT 1 FROM leads l WHERE l.company_id = companies.id AND l.stage = 'researched'
         AND NOT EXISTS (
           SELECT 1 FROM contacts ct WHERE ct.company_id = companies.id
             AND ct.in_decision_orbit AND NOT ct.suppressed AND NOT ct.rehearsal
             AND ct.email IS NOT NULL AND ct.email_bounced_at IS NULL)
     ) DESC,
     icp_score DESC NULLS LAST, name LIMIT $${params.length}`,
  params);

if (!companies.length) {
  const reason = onlyNew
    ? `No named accounts left to search${camp ? ` on ${camp.id}` : ''}. Every account has been searched in the last thirty days.`
    : (companyFilter ? `No named account matches "${companyFilter}".` : `No named accounts found${camp ? ` on ${camp.id}` : ''}.`);
  console.log(reason);
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

// The search rides the campaign's own connected account, exactly as the
// in-cycle search does: the flag decides when given, otherwise a company
// with exactly one known membership uses that campaign's account, and
// anything else uses the data centre default. A stray membership value
// never decides anything.
const laneFor = (co) => {
  if (camp) return camp.id;
  const known = (co.memberships || []).filter(id => getCampaign(id));
  return known.length === 1 ? known[0] : 'marwin_dc';
};
// The lane's own vocabulary, from the campaign definition: the first eight
// titles key the search, the whole list widens the orbit classification, so
// a pharma walk asks for process and CQV people and believes the answer.
const lanePeople = (id) => getCampaign(id)?.orbitTitles || [];

console.log(`${apply ? 'Apply run' : 'Dry run'}: ${companies.length} compan${companies.length === 1 ? 'y' : 'ies'}${onlyNew ? ' not yet searched' : ''}${camp ? ` on ${camp.id}` : ''}, email discovery ${emailDiscovery ? 'on' : 'off'}.\n`);

for (const co of companies) {
  console.log(`${co.name}`);

  if (!apply) {
    console.log(`  would run one people search: "${co.name}" for the specifier roles (${roleWindow(lanePeople(laneFor(co)), co.prior_searches).slice(0, 4).join(', ')}, ...), limit 5, via the ${laneFor(co)} account${co.prior_searches ? `, pass ${co.prior_searches + 1}` : ''}`);
    if (doDirectors) {
      const { rows: pending } = await pool.query(
        `SELECT full_name FROM contacts
         WHERE company_id = $1 AND source = 'ch_officers' AND NOT suppressed
           AND (enriched_at IS NULL OR enriched_at < now() - interval '30 days')
         ORDER BY full_name`, [co.id]);
      console.log(`  would then enrich ${pending.length} register director${pending.length === 1 ? '' : 's'} by name${pending.length ? ': ' + pending.map(p => p.full_name).join(', ') : ''}`);
    }
    if (emailDiscovery) {
      if (co.domain) {
        const { rows: [{ n }] } = await pool.query(
          `SELECT count(*)::int AS n FROM contacts
           WHERE company_id = $1 AND in_decision_orbit AND NOT suppressed AND email_verified_at IS NULL
             AND (payload->'email_lookup'->>'at' IS NULL
                  OR (payload->'email_lookup'->>'at')::timestamptz < now() - interval '90 days')`, [co.id]);
        report.potentialEmails += n;
        console.log(`  would look up ${n} email${n === 1 ? '' : 's'} via Findymail, ${n} credit${n === 1 ? '' : 's'}, on the in-orbit contacts here`);
      } else {
        console.log(`  no domain on file, Findymail would be skipped`);
      }
    }
    continue;
  }

  try {
    // The decision-makers for flow instrumentation are the design and project
    // people on the build, found by the people search. Register directors are
    // enriched only when asked for, since they are not the specifiers.
    const laneTitles = lanePeople(laneFor(co));
    const f = await findContacts(co, { limit: 5, accountId: accountForCampaign(laneFor(co)),
      searchRoles: roleWindow(laneTitles, co.prior_searches), orbitExtra: laneTitles, retryNone: Boolean(companyFilter) });
    const d = doDirectors
      ? await enrichDirectors(co)
      : { enriched: 0, left: 0, ambiguous: 0, examples: [] };
    report.touched++;
    report.enriched += d.enriched; report.leftBlank += d.left; report.ambiguous += d.ambiguous;
    report.examples.push(...d.examples);
    report.newContacts += f.created || 0; report.updated += f.updated || 0; report.kept += f.kept || 0;
    report.found.push(...(f.contacts || []).filter(c => c.outcome === 'created'));
    const oa = f.filteredOutOfArea ? `, ${f.filteredOutOfArea} dropped as out of area` : '';
    const we = f.filteredWrongEmployer ? `, ${f.filteredWrongEmployer} dropped as employed elsewhere` : '';
    const how = f.mode === 'company_scoped' ? 'searched within the company page' : `keyword search${f.lookupNote ? ', ' + f.lookupNote : ''}`;
    const dir = doDirectors ? ` Directors: ${d.enriched} enriched, ${d.left} left as register data.` : '';
    console.log(`  people search (${how}): ${f.created || 0} new, ${f.updated || 0} updated, ${f.kept || 0} kept fresh${oa}${we}.${dir}`);

    if (emailDiscovery && co.domain) {
      const { rows: orbit } = await pool.query(
        `SELECT id, full_name, email, email_verified_at, linkedin_url FROM contacts
         WHERE company_id = $1 AND in_decision_orbit AND NOT suppressed
           AND email_verified_at IS NULL
           AND (payload->'email_lookup'->>'at' IS NULL
                OR (payload->'email_lookup'->>'at')::timestamptz < now() - interval '90 days')`, [co.id]);
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
console.log(`Companies touched: ${apply ? report.touched : companies.length}${companyFilter ? ` (filter "${companyFilter}")` : ''}${camp ? ` (campaign ${camp.id})` : ''}`);
if (apply) {
  if (doDirectors) {
    console.log(`Directors enriched: ${report.enriched}   Left as register data: ${report.leftBlank}   Ambiguous, skipped: ${report.ambiguous}`);
  } else {
    console.log(`Register directors: skipped (pass --directors to include them)`);
  }
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
