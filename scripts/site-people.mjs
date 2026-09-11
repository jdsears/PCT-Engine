#!/usr/bin/env node
// People from a company's own website, from the terminal: the same read the
// engine cycle makes, for one company or for a batch, dry by default.
//
//   node --env-file=.env scripts/site-people.mjs --domain global.ntt --campaign marwin_dc
//   node --env-file=.env scripts/site-people.mjs --company "Greystoke Land Limited"
//   node --env-file=.env scripts/site-people.mjs --company "Greystoke Land Limited" --apply
//   node --env-file=.env scripts/site-people.mjs --batch 10 --apply
//
// --domain reads a site and prints what it found, nothing written, no
// database needed beyond the campaign vocabulary. --company reads the
// register row's domain and prints the people it would create; --apply
// creates them as contacts with source website, and email discovery picks
// them up on the next cycle. --batch runs the cycle's own pass over the
// accounts most in need, dry unless --apply.
import { pool } from '../src/db.mjs';
import { getCampaign } from '../src/campaigns/registry.mjs';
import { findPeopleOnSite, discoverSitePeople } from '../src/research/sitePeople.mjs';

const args = process.argv.slice(2);
const flag = n => { const i = args.indexOf(n); return i === -1 ? null : (args[i + 1] || null); };
const APPLY = args.includes('--apply');
const DOMAIN = flag('--domain');
const COMPANY = flag('--company');
const BATCH = flag('--batch');
const CAMPAIGN = flag('--campaign') || 'marwin_dc';

function printRead(name, r) {
  if (!r || r.unreachable) { console.log(`${name}: the site could not be read.`); return; }
  console.log(`${name}: ${r.pages.length} page(s) read, ${r.found} name(s) with a role, ${r.people.length} in the ${CAMPAIGN} orbit.`);
  for (const p of r.pages) console.log(`  page: ${p.title}  ${p.url}`);
  for (const p of r.people) console.log(`  in orbit: ${p.name}, ${p.role}  (${p.url})`);
  for (const p of r.unqualified) console.log(`  not in orbit: ${p.name}${p.role ? `, ${p.role}` : ''}`);
}

if (DOMAIN) {
  const titles = getCampaign(CAMPAIGN)?.orbitTitles || [];
  printRead(DOMAIN, await findPeopleOnSite(DOMAIN, { titles }));
  process.exit(0);
}

if (COMPANY) {
  const { rows } = await pool.query(
    `SELECT id, name, domain, (SELECT array_agg(cc.campaign) FROM company_campaigns cc WHERE cc.company_id = companies.id) AS memberships
     FROM companies WHERE lower(name) = lower($1) OR name ILIKE $2 ORDER BY (lower(name) = lower($1)) DESC LIMIT 1`, [COMPANY, `${COMPANY}%`]);
  const co = rows[0];
  if (!co) { console.error(`No account named ${COMPANY}.`); await pool.end(); process.exit(1); }
  if (!co.domain) { console.error(`${co.name} has no domain on file; resolve one first.`); await pool.end(); process.exit(1); }
  const campaign = (co.memberships || []).filter(m => getCampaign(m)).length === 1 ? co.memberships.filter(m => getCampaign(m))[0] : CAMPAIGN;
  const titles = getCampaign(campaign)?.orbitTitles || [];
  const r = await findPeopleOnSite(co.domain, { titles });
  printRead(co.name, r);
  if (!APPLY) { console.log('\nDry run, nothing written. Re-run with --apply to create the people in orbit as contacts.'); await pool.end(); process.exit(0); }
  let created = 0;
  for (const p of r?.people || []) {
    const { rows: ex } = await pool.query(`SELECT id FROM contacts WHERE company_id = $1 AND lower(full_name) = lower($2) LIMIT 1`, [co.id, p.name]);
    if (ex.length) { console.log(`  already on file: ${p.name}`); continue; }
    await pool.query(
      `INSERT INTO contacts (company_id, full_name, role_title, in_decision_orbit, source, payload, enriched_at)
       VALUES ($1, $2, $3, true, 'website', $4::jsonb, now())`,
      [co.id, p.name, p.role, JSON.stringify({ source_url: p.url, page: p.page, found_at: new Date().toISOString() })]);
    created++;
  }
  await pool.query(`UPDATE companies SET site_people_checked_at = now(), site_people_found = $2 WHERE id = $1`, [co.id, r?.people?.length ?? 0]).catch(() => {});
  console.log(`\n${created} contact(s) created with source website. Email discovery resolves their addresses on the next cycle.`);
  await pool.end();
  process.exit(0);
}

if (BATCH) {
  const limit = Math.max(1, parseInt(BATCH, 10) || 10);
  if (!APPLY) {
    const { rows } = await pool.query(
      `SELECT name, domain, icp_score FROM companies
       WHERE named_account AND domain IS NOT NULL
         AND (site_people_checked_at IS NULL OR site_people_checked_at < now() - interval '14 days')
         AND NOT EXISTS (SELECT 1 FROM contacts ct WHERE ct.company_id = companies.id AND ct.in_decision_orbit
                         AND NOT ct.suppressed AND NOT ct.rehearsal AND ct.email IS NOT NULL AND ct.email_bounced_at IS NULL)
       ORDER BY icp_score DESC NULLS LAST, name LIMIT $1`, [limit]);
    console.log(`The next pass would read ${rows.length} site(s):`);
    for (const r of rows) console.log(`  ${r.name}  ${r.domain}  (score ${r.icp_score ?? 'none'})`);
    console.log('\nDry run. Re-run with --apply to read them and create the people in orbit as contacts.');
    await pool.end();
    process.exit(0);
  }
  const report = await discoverSitePeople({ limit, log: m => console.log('  ' + m) });
  console.log(`\n${JSON.stringify(report)}`);
  await pool.end();
  process.exit(0);
}

console.error('Usage: node --env-file=.env scripts/site-people.mjs (--domain <host> [--campaign <id>] | --company "<name>" [--apply] | --batch <n> [--apply])');
process.exit(1);
