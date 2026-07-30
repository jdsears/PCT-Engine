import { normalizeTokens } from './match.mjs';

// Pairing a duplicate account with its twin.
//
// The first version of this compared names as concatenated strings with the
// corporate suffixes removed, then accepted a pair when either string contained
// the other. On the live register that paired Echelon Data Centres, 4D Data
// Centres, Custodian Data Centres and Equans Data Centres, four unrelated
// operators, all with the same twin: "DATA CENTRE UK LTD". Stripping "uk" and
// "ltd" left "datacentre", which is a substring of every one of them. Applied,
// it would have deleted four real accounts and merged them into one. Only the
// --id scoping stopped it.
//
// So pairing uses the matcher's own token vocabulary, which already knows that
// "data", "centre" and the corporate suffixes carry no identity. Two names pair
// only when their distinctive tokens are exactly equal. "DATA CENTRE UK LTD"
// reduces to no distinctive tokens at all and therefore pairs with nothing,
// which is the right answer: a name made entirely of generic words cannot
// identify a company. "PP O'Connor" and "PP O'CONNOR LIMITED" both reduce to
// the same three tokens and pair, which is the real duplicate.
//
// Exact equality rather than subset, deliberately. A subset rule would pair
// "Skanska" with "Skanska Rail", which are different companies, and the cost of
// missing a duplicate is a moment of manual work while the cost of a wrong pair
// is a deleted account.

export const distinctiveTokens = name => normalizeTokens(name).slice().sort();

export function sameCompany(a, b) {
  const ta = distinctiveTokens(a), tb = distinctiveTokens(b);
  if (!ta.length || !tb.length) return false; // nothing distinctive cannot identify anything
  return ta.length === tb.length && ta.every((t, i) => t === tb[i]);
}

// Pair each account lacking a Companies House number with a CH-matched twin.
// Returns the pairs and the rows left alone, and never pairs one twin with more
// than one duplicate: if two unmatched rows both claim the same twin, neither is
// paired, because a real pair is one to one and anything else needs a human.
export function pairDuplicates(accounts) {
  const matched = (accounts || []).filter(a => a.ch_number);
  const unmatched = (accounts || []).filter(a => !a.ch_number);

  const claims = new Map(); // twin id -> the unmatched rows claiming it
  const leftovers = [];
  for (const u of unmatched) {
    const twin = matched.find(m => sameCompany(m.name, u.name));
    if (!twin) { leftovers.push(u); continue; }
    if (!claims.has(twin.id)) claims.set(twin.id, { twin, claimants: [] });
    claims.get(twin.id).claimants.push(u);
  }

  const pairs = [], contested = [];
  for (const { twin, claimants } of claims.values()) {
    if (claimants.length === 1) pairs.push({ u: claimants[0], m: twin });
    else contested.push({ twin, claimants });
  }
  for (const c of contested) leftovers.push(...c.claimants);
  return { pairs, leftovers, contested };
}
