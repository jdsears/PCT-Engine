// Conservative operator-to-account matching. A news headline names a brand
// ("Microsoft", "Pure DC"); the register holds the entity ("MICROSOFT PROPERTIES
// UK LIMITED", "PURE DATA CENTRES GROUP LTD"). We match on tolerant tokens, not
// exact strings, and link only on a single confident candidate. Anything
// ambiguous or unknown stays unmatched, because a wrong link would fire a cold
// email at the wrong account, which is worse than no link.

// Editable alias map, seeded from known operators. A brand on the left maps to
// the canonical operator name on the right, used only to tokenise the headline
// name closer to the registered entity.
export const OPERATOR_ALIASES = {
  aws: 'amazon',
  'pure dc': 'pure data centres',
  'stt gdc': 'stt global data centres',
};

// Corporate suffixes and generic data-centre words carry no identity, so they are
// dropped before comparison. Editable.
const STOP = new Set([
  'limited', 'ltd', 'plc', 'llp', 'uk', 'group', 'holdings', 'holding',
  'properties', 'property', 'international', 'global', 'services', 'solutions',
  'company', 'co', 'the', 'and', 'of', 'data', 'centre', 'centres', 'center',
  'centers', 'dc', 'datacentre', 'datacentres', 'datacenter', 'datacenters',
  'campus', 'project', 'development', 'developments',
]);

export function normalizeTokens(name) {
  return [...new Set(String(name || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
    .filter(t => t && !STOP.has(t)))];
}

// Match a party name against the register, telling the caller what actually
// happened. Zero candidates and several candidates used to collapse into the
// same null, which conflated a lead-generation opportunity (a company we have
// never heard of) with a data-quality problem (a name our register holds twice
// over). The three outcomes are now distinct:
//
//   { status: 'matched', company }        one confident candidate, link it
//   { status: 'unknown' }                 no candidate, a proposal opportunity
//   { status: 'ambiguous', candidates }   several, a human resolves, never link
//
// Extra aliases learned through the review queues arrive as data; the seeded
// map stays as the floor. The function stays pure so the whole matcher tests
// offline; callers load the stored aliases and pass them in.
export function matchParty(name, companies, { aliases = {} } = {}) {
  const merged = { ...OPERATOR_ALIASES, ...aliases };
  const lc = String(name || '').trim().toLowerCase();
  let resolved = name;
  for (const [k, v] of Object.entries(merged)) if (lc === k || lc.includes(k)) { resolved = v; break; }
  const opTokens = normalizeTokens(resolved);
  if (!opTokens.length) return { status: 'unknown' };
  const subset = (a, b) => a.every(t => b.includes(t));
  const candidates = [];
  for (const c of companies || []) {
    const ct = normalizeTokens(c.name);
    if (ct.length && (subset(opTokens, ct) || subset(ct, opTokens))) candidates.push(c);
  }
  if (candidates.length === 1) return { status: 'matched', company: { id: candidates[0].id, name: candidates[0].name } };
  if (candidates.length === 0) return { status: 'unknown' };
  return { status: 'ambiguous', candidates: candidates.map(c => ({ id: c.id, name: c.name })) };
}

// The original single-answer shape, preserved exactly: one confident candidate
// links, everything else is null. Implemented over matchParty so the two can
// never disagree about what matches.
export function matchOperator(operator, companies) {
  const r = matchParty(operator, companies);
  return r.status === 'matched' ? r.company : null;
}
