import { normalizeTokens } from './match.mjs';

// The decision layer between the matcher and the database: given what the
// matcher said about a signal's parties, decide what the research run does. A
// pure function, so every rule below is provable offline:
//
// - matched links, and only matched links
// - ambiguous never links and never proposes; it goes to the review queue
// - unknown proposes only from a uk_project signal, because that is the signal
//   grade whose party is worth adding to the register; everything else is
//   counted so the miss is visible, never lost and never silently added
// - the per-run proposal cap holds, and names over the cap are counted
// - a name already reviewed (whatever the outcome, including dismissed) is
//   never proposed again; dismissal is a decision, not a deferral
//
// Proposal here means propose, not create. Nothing in this module or its
// callers writes a company; a human confirms every account that enters the
// register, which is what keeps the account list a curated asset.

export const proposalsPerRun = () => {
  const n = parseInt(process.env.PROPOSALS_PER_RUN || '5', 10);
  return Math.max(1, Math.min(50, Number.isNaN(n) ? 5 : n));
};

export const normName = name => normalizeTokens(name).join(' ');

// One signal's parties in, a list of actions out. state tracks cap and
// already-known names across the whole run; the caller threads it through.
export function planPartyActions(signal, results, state) {
  const actions = [];
  for (const party of ['operator', 'contractor']) {
    const name = signal[party];
    const r = results[party];
    if (!name || !r) continue;
    const norm = normName(name);
    if (!norm) continue;

    if (r.status === 'matched') {
      actions.push({ act: 'link', party, companyId: r.company.id });
      continue;
    }

    // When the operator field was empty the matcher was fed the headline as a
    // fallback. A headline can confidently match an account; it is not a
    // company name, so it must never become a proposal, an ambiguity for
    // review, or a row in the unmatched counter. "10 UK data centre
    // construction projects" is a story, not a prospect.
    if (party === 'operator' && signal.operatorIsTitleFallback) continue;

    // Every non-match is counted, so the next alias worth adding is always
    // visible instead of invisible.
    actions.push({ act: 'count', party, name, norm });

    if (state.known.has(norm)) continue;

    if (r.status === 'ambiguous') {
      state.known.add(norm);
      actions.push({ act: 'review_ambiguous', party, name, norm, candidates: r.candidates });
      continue;
    }

    // unknown: a proposal, gated on signal grade and the cap.
    if (signal.geo_scope !== 'uk_project') continue;
    if (state.proposed >= state.cap) { actions.push({ act: 'over_cap', party, name, norm }); continue; }
    state.known.add(norm);
    state.proposed++;
    actions.push({ act: 'propose', party, name, norm });
  }
  return actions;
}
