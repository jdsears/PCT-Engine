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

// Resolve a brand through the alias map before tokenising.
function canonical(operator) {
  const lc = String(operator || '').trim().toLowerCase();
  for (const [k, v] of Object.entries(OPERATOR_ALIASES)) if (lc === k || lc.includes(k)) return v;
  return operator;
}

// Match an operator name to exactly one company, or return null. A company is a
// candidate when its significant tokens contain the operator's, or the operator's
// contain the company's (so a longer brand still matches a shorter entity). A
// unique candidate links; zero or several stay unmatched.
export function matchOperator(operator, companies) {
  const opTokens = normalizeTokens(canonical(operator));
  if (!opTokens.length) return null;
  const subset = (a, b) => a.every(t => b.includes(t));
  const candidates = [];
  for (const c of companies || []) {
    const ct = normalizeTokens(c.name);
    if (ct.length && (subset(opTokens, ct) || subset(ct, opTokens))) candidates.push(c);
  }
  return candidates.length === 1 ? { id: candidates[0].id, name: candidates[0].name } : null;
}
