import { matchParty } from './match.mjs';
import { normName } from './partyActions.mjs';
import { requireCampaign } from '../campaigns/registry.mjs';

// The census: population coverage to sit beside the sweep's event coverage.
//
// The sweep finds a company at the moment it does something, which is the
// right way to find the timely prospect and the wrong way to ever finish the
// map. The only enumeration the engine ever ran was the July seed, once.
// James proved the gap by hand in August 2026, cross-checking the register
// against a general model and adding what was missing; John's instruction
// followed: make the engine do that walk itself, with the checking built in.
//
// The design keeps the spine. Enumeration is research plus model over the
// campaign's census queries; the diff runs through the same matcher the
// queue trusts, with learned aliases honoured; and everything genuinely new
// becomes a proposal in the confirm queue, Companies House candidates
// attached, capped per run. Nothing reaches the register without a human
// confirm, because general models conflate and invent companies at exactly
// this task, and the queue's verification step is the part they cannot do.

// The enumeration prompt: the campaign supplies its sector and its two party
// nouns; the rules are shared. Snippets ground the recall, and the
// instruction is to list, never to invent, with the confirm queue as the
// stated safety net for the model being told so.
export function buildCensusSystem(campaign) {
  const def = typeof campaign === 'string' ? requireCampaign(campaign) : campaign;
  const g = def.signals.gate;
  return (
    `You compile a census of the UK population of companies relevant to ${g.sellerDescription}. ` +
    `From the research snippets provided and well-established knowledge of the ${g.sector} sector, list real companies active in the UK in two roles: ` +
    `"operator" for the organisations that own or operate ${g.subjectNounPlural}, and "contractor" for the contractors that build and fit them out. ` +
    'HARD RULES: list only companies you are confident actually exist under that name; never invent, merge or guess a name; when unsure of a name, leave it out, because every name you return is reviewed by a person against Companies House and a made-up company wastes their time. ' +
    'UK-active only. No consultancies, no suppliers, no publications, no trade bodies. ' +
    'Return strict JSON only, no preamble: {"companies":[{"name":"<company name as commonly written>","party":"operator"|"contractor"}]}.'
  );
}

// The model's reply into clean candidates: tolerant of fences and stray
// text, strict about shape. Anything without a plausible name and a known
// party is dropped, and duplicates collapse on the queue's own normal form.
export function parseCensus(raw) {
  const s = String(raw || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return [];
  let parsed;
  try { parsed = JSON.parse(s.slice(start, end + 1)); } catch { return []; }
  const seen = new Set();
  const out = [];
  for (const c of parsed?.companies || []) {
    const name = String(c?.name || '').trim();
    const party = c?.party === 'contractor' ? 'contractor' : c?.party === 'operator' ? 'operator' : null;
    if (!name || name.length > 80 || !party) continue;
    const norm = normName(name);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push({ name, party, norm });
  }
  return out;
}

// The diff against the register, through the matcher the queue trusts:
// matched names are already known and skipped, ambiguous names are a data
// quality note for a human, and the fresh remainder is what the census was
// for. Pure, so the gate proves the judgement without a database.
export function censusDiff(candidates, register, { aliases = {} } = {}) {
  const fresh = [], known = [], ambiguous = [];
  for (const c of candidates || []) {
    const m = matchParty(c.name, register, { aliases });
    if (m.status === 'matched') known.push({ ...c, companyId: m.company.id, companyName: m.company.name });
    else if (m.status === 'ambiguous') ambiguous.push({ ...c, candidates: m.candidates });
    else fresh.push(c);
  }
  return { fresh, known, ambiguous };
}

// The per-run proposal cap, the queue's protection from a flood: a census
// that finds forty new names feeds them over several runs, not one morning.
export const censusProposalsMax = () => Math.max(1, Math.min(50, parseInt(process.env.CENSUS_PROPOSALS_MAX || '15', 10) || 15));
