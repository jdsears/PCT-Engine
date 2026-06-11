import { writeFile } from 'node:fs/promises';
import { pool } from '../src/db.mjs';
import { REGIONS, REGION_BY_POSTCODE_AREA } from '../src/research/region.mjs';
import { ICP_CONFIG, WEIGHTS, SIGNAL_RECENCY_TIERS, CONTACTABILITY_DRAFT } from '../src/research/icp.mjs';

// Exports the curation pack: everything awaiting human sign-off, gathered into
// one markdown file to forward. Section 1 is the named-account list for Andy,
// section 2 the region table for Andy, section 3 the ICP thresholds and
// weights for James and Andy, grounded with the live score distribution.
// Read-only; it changes nothing in the database. Needs DATABASE_URL.

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
           WHERE ct.company_id = c.id AND ct.source = 'ch_officers' AND NOT ct.suppressed) AS directors,
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

// Region code -> sorted postcode areas, for the table Andy checks.
const areasByRegion = {};
for (const [area, code] of Object.entries(REGION_BY_POSTCODE_AREA)) {
  (areasByRegion[code] ||= []).push(area);
}
for (const list of Object.values(areasByRegion)) list.sort();

const lines = [];
const push = (...xs) => lines.push(...xs);

push(`# PCT Engine curation pack`, ``,
  `Generated ${today} from the live database. Read-only: exporting this changed`,
  `nothing. Corrections go back to John as edits to this file or one-liners in`,
  `conversation; each lands as a small data change in the engine.`, ``);

// ---- 1. Named accounts ----
push(`## 1. Named accounts, for Andy`, ``,
  `${accounts.rows.length} accounts, sorted by ICP score. Add, strike or correct`,
  `directly on this list. "Directors" counts current officers pulled from the`,
  `public register; "unassigned" regions mean the engine has no postcode yet.`, ``,
  `| Account | Type | Region | CH number | Domain | Score | Directors | Signals |`,
  `| --- | --- | --- | --- | --- | ---: | ---: | ---: |`);
for (const a of accounts.rows) {
  push(`| ${a.name} | ${typeLabel(a.company_type)} | ${regionLabel(a.region)} | ${a.ch_number || 'unmatched'} | ${a.domain || 'none found'} | ${a.score ?? '—'} | ${a.directors} | ${a.signals} |`);
}
push(``);

// ---- 2. Region table ----
push(`## 2. Region table draft, for Andy`, ``,
  `The engine maps postcodes to the six sales areas with the table below. It is`,
  `a best effort from public geography: the weakest guesses are the Midlands and`,
  `Wales, which have no region of their own, so check those rows hardest. A`,
  `correction is a one-line edit.`, ``,
  `| Region | Name | Active | Postcode areas |`,
  `| --- | --- | --- | --- |`);
for (const [code, def] of Object.entries(REGIONS)) {
  push(`| ${code} | ${def.name} | ${def.active ? 'yes' : 'no'} | ${(areasByRegion[code] || []).join(', ') || '—'} |`);
}
push(``);

// ---- 3. ICP thresholds and weights ----
const b = bands.rows[0];
push(`## 3. ICP thresholds and weights, for James and Andy`, ``,
  `Drafts the scorer runs with today. Every stored score keeps its component`,
  `breakdown, so a change here re-scores cleanly on the next research run.`, ``,
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
  `(RESEARCH_LEAD_THRESHOLD, default 40). Where the named accounts sit today:`, ``,
  `- 70 and above: ${b.strong}`,
  `- 40 to 69: ${b.middle}`,
  `- under 40: ${b.weak}`,
  `- not yet scored: ${b.unscored}`, ``,
  `Leads at stage researched right now: ${leads.rows[0].n}.`, ``,
  `### Draft awaiting your approval: contactability`, ``,
  `The current weights mean a clean named account scores 70 with no recent`,
  `data centre signals, so the list barely differentiates. The proposal makes`,
  `reachability count: named account ${CONTACTABILITY_DRAFT.weights.namedAccount}, type fit ${CONTACTABILITY_DRAFT.weights.typeFit}, signals ${CONTACTABILITY_DRAFT.weights.signals},`,
  `Companies House health ${CONTACTABILITY_DRAFT.weights.chHealth}, contactability ${CONTACTABILITY_DRAFT.weights.contactability} (${CONTACTABILITY_DRAFT.points.orbitContact} for a decision-orbit`,
  `contact on file, ${CONTACTABILITY_DRAFT.points.verifiedEmail} more when one has a verified email).`, ``,
  `It is ${CONTACTABILITY_DRAFT.enabled() ? 'ON' : 'off'} right now and stays off until you both approve; switching it`,
  `on is one setting (ICP_CONTACTABILITY=on) and every account re-scores with`,
  `an updated breakdown on the next research run.`, ``);

const out = new URL('../CURATION_PACK.md', import.meta.url).pathname;
await writeFile(out, lines.join('\n'));

console.log(`Curation pack written to ${out}`);
console.log(`  accounts: ${accounts.rows.length} (scores: ${b.strong} strong, ${b.middle} middle, ${b.weak} weak, ${b.unscored} unscored)`);
console.log(`  regions: ${Object.keys(REGIONS).length}, postcode areas mapped: ${Object.keys(REGION_BY_POSTCODE_AREA).length}`);
console.log(`  leads at researched: ${leads.rows[0].n}`);
await pool.end();
