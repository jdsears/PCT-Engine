import { pool } from '../src/db.mjs';
import { requireCampaign } from '../src/campaigns/registry.mjs';
import { tavilySearch } from '../src/research/newsResearch.mjs';
import { searchCompanies, candidateRows } from '../src/research/companiesHouse.mjs';
import { resolveDomain } from '../src/research/domains.mjs';
import { buildCensusSystem, parseCensus, censusDiff, censusProposalsMax } from '../src/research/census.mjs';

// The census run: population coverage for one campaign, proposed into the
// confirm queue for a human to decide. John's instruction of 10 August 2026,
// after James walked the register against a general model by hand.
//
//   node --env-file=.env scripts/census-run.mjs --campaign marwin_dc
//   node --env-file=.env scripts/census-run.mjs --campaign marwin_dc --propose
//
// Dry by default: it enumerates, diffs against the register, and prints what
// it would propose, changing nothing. --propose writes the fresh names into
// the confirm queue as proposals with Companies House candidates and a
// resolved domain, capped per run (CENSUS_PROPOSALS_MAX, default 15), where
// they wait for confirm, merge or dismiss like any signal proposal. The first
// run is a calibration event: read the enumeration line by line before
// proposing, the way the pharma sweep was calibrated.
//
// What this never does: write to companies, create leads or contacts, spend
// Findymail credits, or touch LinkedIn.

const PROPOSE = process.argv.includes('--propose');
const campArg = process.argv[process.argv.indexOf('--campaign') + 1];
if (!process.argv.includes('--campaign')) {
  console.error('usage: node --env-file=.env scripts/census-run.mjs --campaign <id> [--propose]');
  process.exit(1);
}
const def = requireCampaign(campArg);
console.log(`Campaign: ${def.id}`);

const queries = def.census?.queries || [];
if (!queries.length) {
  console.error(`The ${def.id} definition has no census queries; add a census block before running.`);
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY || !process.env.TAVILY_API_KEY) {
  console.error('The census needs ANTHROPIC_API_KEY and TAVILY_API_KEY.');
  process.exit(1);
}

// Ground the enumeration: population queries through general search, not the
// news window, since a census wants the standing world rather than the week.
const snippets = [];
for (const q of queries) {
  try {
    const results = await tavilySearch(q, { topic: 'general', maxResults: 8 });
    for (const r of results) snippets.push(`${r.title}: ${(r.content || '').slice(0, 300)}`);
    console.log(`  searched: ${q} (${results.length} results)`);
  } catch (e) { console.log(`  search failed: ${q}: ${String(e.message).slice(0, 100)}`); }
}
if (!snippets.length) {
  console.error('No research snippets at all; stopping rather than enumerating from model memory alone.');
  process.exit(1);
}

const res = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
  body: JSON.stringify({
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
    max_tokens: 2000,
    system: buildCensusSystem(def),
    messages: [{ role: 'user', content: `Research snippets:\n${snippets.join('\n').slice(0, 12000)}\n\nCompile the census.` }],
  }),
});
if (!res.ok) { console.error(`Claude failed: ${res.status} ${await res.text()}`); process.exit(1); }
const json = await res.json();
const raw = (json.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
const candidates = parseCensus(raw);
console.log(`\nEnumerated ${candidates.length} candidate name(s).`);

const { rows: register } = await pool.query(`SELECT id, name FROM companies`);
const aliases = Object.fromEntries(
  (await pool.query(`SELECT alias, canonical FROM matcher_aliases`)).rows.map(r => [r.alias, r.canonical]));
// A name already waiting, confirmed or dismissed in the queue is not fresh:
// a dismissal is a decision and the census must not relitigate it.
const { rows: reviewed } = await pool.query(
  `SELECT name_norm FROM party_reviews WHERE campaign = $1`, [def.id]);
const alreadyReviewed = new Set(reviewed.map(r => r.name_norm));

const { fresh: freshAll, known, ambiguous } = censusDiff(candidates, register, { aliases });
const fresh = freshAll.filter(c => !alreadyReviewed.has(c.norm));
const blocked = freshAll.length - fresh.length;

console.log(`${known.length} already on the register, ${ambiguous.length} ambiguous, ${blocked} already decided in the queue, ${fresh.length} genuinely new.`);
for (const c of known.slice(0, 10)) console.log(`  known    ${c.name} -> #${c.companyId} ${c.companyName}`);
for (const c of ambiguous) console.log(`  ambiguous ${c.name}: ${c.candidates.map(x => x.name).join('; ')}`);
const cap = censusProposalsMax();
const toPropose = fresh.slice(0, cap);
for (const c of fresh) {
  const held = !toPropose.includes(c);
  console.log(`  new      ${c.name} (${c.party})${held ? '  [held over the per-run cap]' : ''}`);
}

if (!PROPOSE) {
  console.log(`\nDry run. Nothing written. Re-run with --propose to queue ${toPropose.length} proposal(s) (cap ${cap}).`);
  await pool.end();
  process.exit(0);
}

let proposed = 0;
for (const c of toPropose) {
  // The same read-only enrichment a signal proposal gets, so the human
  // decides over evidence: Companies House candidates and a domain. No
  // Findymail, no LinkedIn, no spend.
  let chCandidates = null, domain = null;
  try { chCandidates = candidateRows(await searchCompanies(c.name)); } catch { /* the proposal stands without candidates */ }
  try { domain = await resolveDomain(c.name); } catch { /* optional */ }
  const { rowCount } = await pool.query(
    `INSERT INTO party_reviews (kind, printed_name, name_norm, party, campaign, signal_id, ch_candidates, domain)
     VALUES ('proposal', $1, $2, $3, $4, NULL, $5::jsonb, $6) ON CONFLICT (name_norm, campaign) DO NOTHING`,
    [c.name, c.norm, c.party, def.id, chCandidates ? JSON.stringify(chCandidates) : null, domain]);
  if (rowCount) { proposed++; console.log(`  proposed ${c.name}`); }
}
console.log(`\n${proposed} proposal(s) queued. Review them in Accounts; confirm, merge or dismiss decides, as with any proposal.`);
await pool.end();
