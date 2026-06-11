import { writeFile } from 'node:fs/promises';
import { pool } from '../src/db.mjs';
import { REGIONS, REGION_BY_POSTCODE_AREA } from '../src/research/region.mjs';
import { ICP_CONFIG, WEIGHTS, SIGNAL_RECENCY_TIERS, CONTACTABILITY_DRAFT } from '../src/research/icp.mjs';
import { ORBIT_TITLES, EXCLUDE_TITLES } from '../src/research/orbitRules.mjs';

// Exports the curation brief for Andy: everything awaiting his eye, in one
// markdown file to forward. Sections 1 to 3 are his (named accounts, region
// table, decision-orbit titles); section 4 is the ICP thresholds for James and
// Andy together, grounded with the live score distribution. Read-only; it
// changes nothing in the database. Needs DATABASE_URL.

const TYPE_LABELS = {
  dc_developer: 'DC developer', me_contractor: 'M&E contractor',
  end_client: 'End client', oem: 'OEM', other: 'Other',
};
const typeLabel = t => TYPE_LABELS[t] || t || 'unknown';
const regionLabel = code => (code && REGIONS[code] ? `${REGIONS[code].name}` : 'unassigned');
const gbp = n => '£' + Number(n).toLocaleString('en-GB');

const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

const accounts = await pool.query(
  `SELECT c.name, c.company_type, c.region, c.postcode, c.domain, c.ch_number,
          round(c.icp_score)::int AS score,
          (SELECT count(*)::int FROM contacts ct
           WHERE ct.company_id = c.id AND ct.in_decision_orbit AND NOT ct.suppressed) AS in_orbit,
          (SELECT count(*)::int FROM signals s WHERE s.company_id = c.id) AS signals
   FROM companies c WHERE c.named_account
   ORDER BY c.icp_score DESC NULLS LAST, c.name`);

const bands = await pool.query(
  `SELECT count(*) FILTER (WHERE icp_score >= 70)::int AS strong,
          count(*) FILTER (WHERE icp_score >= 40 AND icp_score < 70)::int AS middle,
          count(*) FILTER (WHERE icp_score < 40)::int AS weak,
          count(*) FILTER (WHERE icp_score IS NULL)::int AS unscored
   FROM companies WHERE named_account`);

const leads = await pool.query(
  `SELECT count(*)::int AS n FROM leads WHERE stage = 'researched'`);

const threshold = Number(process.env.RESEARCH_LEAD_THRESHOLD || 40);
const withOrbit = accounts.rows.filter(a => a.in_orbit > 0).length;

// Region code -> sorted postcode areas, for the table Andy checks.
const areasByRegion = {};
for (const [area, code] of Object.entries(REGION_BY_POSTCODE_AREA)) {
  (areasByRegion[code] ||= []).push(area);
}
for (const list of Object.values(areasByRegion)) list.sort();

const lines = [];
const push = (...xs) => lines.push(...xs);

push(`# PCT Engine, account curation brief`, ``,
  `For Andy. Generated ${today} from the live engine.`, ``,
  `The engine has built a first draft of the Marwin data centre campaign: a`,
  `named-account list, a UK region map, and a way of telling who at each account`,
  `makes the call on flow instrumentation. None of it is settled until you have`,
  `looked at it. Sections 1 to 3 are yours; section 4 is for you and James`,
  `together.`, ``,
  `Mark it up however suits, on this document or in a note back to John. Every`,
  `correction is a small data change, not a rebuild, so it is cheap to iterate`,
  `as often as you like. Nothing here contacts anyone: the engine is still only`,
  `researching, and the send switch stays off.`, ``);

// ---- 1. Named accounts ----
push(`## 1. Named accounts`, ``,
  `${accounts.rows.length} accounts, sorted by our ICP score, which is the`,
  `engine's read of fit for the Marwin DC campaign. ${withOrbit} of them have at`,
  `least one likely decision-maker found so far; that count grows as the`,
  `LinkedIn lane works through the list. Strike anyone who does not belong, add`,
  `names we have missed, and correct a wrong type or region in place.`, ``,
  `"In orbit" is how many people we have found whose job title marks them as a`,
  `likely specifier, in the sense of section 3. "unmatched" or "none found" mean`,
  `the engine could not match the company at Companies House or find an official`,
  `website, worth a glance since it may be the wrong entity.`, ``,
  `| Account | Type | Region | CH number | Domain | Score | In orbit | Signals |`,
  `| --- | --- | --- | --- | --- | ---: | ---: | ---: |`);
for (const a of accounts.rows) {
  push(`| ${a.name} | ${typeLabel(a.company_type)} | ${regionLabel(a.region)} | ${a.ch_number || 'unmatched'} | ${a.domain || 'none found'} | ${a.score ?? '—'} | ${a.in_orbit} | ${a.signals} |`);
}
push(``);

// ---- 2. Region table ----
push(`## 2. Region table`, ``,
  `The engine sorts each account into one of the six sales areas by postcode,`,
  `using the table below. It is a best effort from public geography: the weakest`,
  `guesses are the Midlands and Wales, which have no area of their own, so check`,
  `those hardest. Moving a postcode area from one region to another is a`,
  `one-line change.`, ``,
  `| Region | Name | Active | Postcode areas |`,
  `| --- | --- | --- | --- |`);
for (const [code, def] of Object.entries(REGIONS)) {
  push(`| ${code} | ${def.name} | ${def.active ? 'yes' : 'no'} | ${(areasByRegion[code] || []).join(', ') || '—'} |`);
}
push(``);

// ---- 3. Decision-orbit titles ----
push(`## 3. Decision-orbit job titles`, ``,
  `When the engine finds a person at a target company, it decides whether they`,
  `are a likely decision-maker for flow instrumentation from their job title.`,
  `The person we want is the engineer who specifies and procures plant on the`,
  `build, the senior or lead design engineer, the M&E or building services`,
  `engineer, not the statutory company director. These two lists are how it`,
  `judges that, and they are the part most worth your eye, since you know the`,
  `real job titles on these projects. Add one we should be catching, strike one`,
  `that pulls in the wrong people.`, ``,
  `A person counts as a likely decision-maker if their title contains any of:`, ``,
  ORBIT_TITLES.map(t => `- ${t}`).join('\n'), ``,
  `A person never counts, even at a target company, if their title contains any`,
  `of these (they override the list above, unless the title also says`,
  `procurement):`, ``,
  EXCLUDE_TITLES.map(t => `- ${t}`).join('\n'), ``);

// ---- 4. ICP thresholds and weights ----
const b = bands.rows[0];
push(`## 4. ICP thresholds and weights, for James and Andy`, ``,
  `The score that ranks section 1. These are drafts the engine runs with today.`,
  `Every stored score keeps its full breakdown, so a change here re-scores every`,
  `account cleanly on the next research run.`, ``,
  `Campaign filters:`, ``,
  `- Minimum project size for a build signal: ${ICP_CONFIG.minProjectSizeMW} MW`,
  `- Build stages counted: ${ICP_CONFIG.buildStages.join(', ')}`,
  `- Minimum contract value for an M&E signal: ${gbp(ICP_CONFIG.minContractValueGBP)}`,
  `- Company types in scope: ${ICP_CONFIG.companyTypes.map(typeLabel).join(', ')}`,
  `- UK only: ${ICP_CONFIG.ukOnly ? 'yes' : 'no'}`, ``,
  `Score weights, out of 100:`, ``,
  `| Component | Weight |`,
  `| --- | ---: |`,
  `| Named account | ${WEIGHTS.namedAccount} |`,
  `| Type fit | ${WEIGHTS.typeFit} |`,
  `| Signals | ${WEIGHTS.signals} |`,
  `| Companies House health | ${WEIGHTS.chHealth} |`, ``,
  `Signal points decay with age: ${SIGNAL_RECENCY_TIERS.map(t => `${t.points} ${t.label}`).join(', ')}.`, ``,
  `Lead threshold: a company becomes a lead at ${threshold} or above`,
  `(default 40). Where the named accounts sit today:`, ``,
  `- 70 and above: ${b.strong}`,
  `- 40 to 69: ${b.middle}`,
  `- under 40: ${b.weak}`,
  `- not yet scored: ${b.unscored}`, ``,
  `Leads at stage researched right now: ${leads.rows[0].n}.`, ``,
  `### Draft awaiting your approval: contactability`, ``,
  `A clean named account scores 70 today with no recent data centre signals, so`,
  `the list barely separates, which is why so many sit at the same score. The`,
  `proposal makes reachability count: named account ${CONTACTABILITY_DRAFT.weights.namedAccount}, type fit ${CONTACTABILITY_DRAFT.weights.typeFit},`,
  `signals ${CONTACTABILITY_DRAFT.weights.signals}, Companies House health ${CONTACTABILITY_DRAFT.weights.chHealth}, and a new contactability`,
  `component worth ${CONTACTABILITY_DRAFT.weights.contactability} (${CONTACTABILITY_DRAFT.points.orbitContact} for a decision-orbit contact on file, ${CONTACTABILITY_DRAFT.points.verifiedEmail} more once one`,
  `has a verified email). It is ${CONTACTABILITY_DRAFT.enabled() ? 'on' : 'off'} now and stays off until you both approve;`,
  `turning it on is one setting and every account re-scores on the next run.`, ``);

const out = new URL('../CURATION_PACK.md', import.meta.url).pathname;
await writeFile(out, lines.join('\n'));

console.log(`Curation brief written to ${out}`);
console.log(`  accounts: ${accounts.rows.length}, ${withOrbit} with an in-orbit contact (scores: ${b.strong} strong, ${b.middle} middle, ${b.weak} weak, ${b.unscored} unscored)`);
console.log(`  regions: ${Object.keys(REGIONS).length}, postcode areas mapped: ${Object.keys(REGION_BY_POSTCODE_AREA).length}`);
console.log(`  orbit titles: ${ORBIT_TITLES.length} in, ${EXCLUDE_TITLES.length} excluded`);
console.log(`  leads at researched: ${leads.rows[0].n}`);
await pool.end();
