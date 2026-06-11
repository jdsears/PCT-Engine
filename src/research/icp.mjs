// ICP filter for the Marwin data centre campaign. The config is data, and the
// thresholds are drafts for sign-off by James and Andy.

export const ICP_CONFIG = {
  // Draft thresholds for the Marwin DC campaign. For sign-off by James and Andy.
  minProjectSizeMW: 10,          // build-stage signal threshold
  buildStages: ['planning_granted', 'construction', 'fit_out'],
  minContractValueGBP: 250_000,  // contract value floor for M&E signals
  companyTypes: ['dc_developer', 'me_contractor', 'end_client'],
  ukOnly: true,
};

// Draft weights. Each component is capped and the breakdown is stored so every
// score is explainable later. Exported so the curation pack reports the same
// numbers the scorer uses.
export const WEIGHTS = {
  namedAccount: 25,
  typeFit: 25,
  signals: 30,
  chHealth: 20,
};

// Signal recency tiers: up to each day bound, the points awarded. Data, so the
// curation pack and the scorer cannot drift apart.
export const SIGNAL_RECENCY_TIERS = [
  { withinDays: 30, points: WEIGHTS.signals, label: 'within 30 days' },
  { withinDays: 90, points: 22, label: 'within 90 days' },
  { withinDays: 180, points: 15, label: 'within 180 days' },
  { withinDays: Infinity, points: 8, label: 'older than 180 days' },
];

// Draft contactability component, staged for James and Andy to approve. Off
// until ICP_CONTACTABILITY=on. When on, named account and type fit each give
// up five points to make room, and a company earns up to ten for being
// reachable: a decision-orbit contact on file, more with a verified email.
// Switching it on re-scores cleanly on the next research run.
export const CONTACTABILITY_DRAFT = {
  enabled: () => (process.env.ICP_CONTACTABILITY || 'off') === 'on',
  weights: { namedAccount: 20, typeFit: 20, signals: 30, chHealth: 20, contactability: 10 },
  points: { orbitContact: 5, verifiedEmail: 5 },
};

function contactabilityPoints(contacts) {
  const orbit = (contacts || []).filter(c => c.in_decision_orbit && !c.suppressed);
  if (!orbit.length) return { points: 0, reason: 'no decision-orbit contact on file' };
  const verified = orbit.some(c => c.email_verified_at);
  return {
    points: CONTACTABILITY_DRAFT.points.orbitContact + (verified ? CONTACTABILITY_DRAFT.points.verifiedEmail : 0),
    reason: verified ? 'decision-orbit contact with a verified email' : 'decision-orbit contact on file, no verified email yet',
  };
}

const DC_SIGNAL_TYPES = new Set(['news_dc_build', 'news_contract', 'planning']);

function signalPoints(signals) {
  const dcSignals = (signals || []).filter(s => DC_SIGNAL_TYPES.has(s.signal_type));
  if (dcSignals.length === 0) return { points: 0, reason: 'no data centre build or contract signals' };
  const newest = Math.max(...dcSignals.map(s => new Date(s.observed_at || 0).getTime()));
  const ageDays = (Date.now() - newest) / 86_400_000;
  const tier = SIGNAL_RECENCY_TIERS.find(t => ageDays <= t.withinDays);
  return { points: tier.points, reason: `${dcSignals.length} signal(s), newest ${tier.label}` };
}

function chHealthPoints(company) {
  const p = company.ch_profile;
  if (!p) return { points: 10, reason: 'no Companies House profile cached, neutral' };
  if (p.company_status !== 'active') return { points: 0, reason: `status ${p.company_status}` };
  if (p.has_insolvency_history) return { points: 0, reason: 'insolvency history on record' };
  return { points: WEIGHTS.chHealth, reason: 'active, no insolvency history' };
}

// Returns { score: 0..100, breakdown }. Pure, so it is easy to test; the
// orchestrator persists the result onto the companies row. Each component
// stores the cap it was scored against, so the display can never misreport a
// row scored under different weights. The optional contacts argument feeds
// the contactability draft and is ignored while the draft is off.
export function scoreCompany(company, signals, contacts = null) {
  const draft = CONTACTABILITY_DRAFT.enabled();
  const W = draft ? CONTACTABILITY_DRAFT.weights : WEIGHTS;
  const breakdown = {};

  breakdown.named_account = company.named_account
    ? { points: W.namedAccount, max: W.namedAccount, reason: 'on the named account list' }
    : { points: 0, max: W.namedAccount, reason: 'not a named account' };

  breakdown.company_type = ICP_CONFIG.companyTypes.includes(company.company_type)
    ? { points: W.typeFit, max: W.typeFit, reason: `type ${company.company_type} fits the campaign` }
    : { points: 0, max: W.typeFit, reason: `type ${company.company_type || 'unknown'} outside the campaign types` };

  breakdown.signals = { ...signalPoints(signals), max: W.signals };
  breakdown.ch_health = { ...chHealthPoints(company), max: W.chHealth };
  if (draft) breakdown.contactability = { ...contactabilityPoints(contacts), max: W.contactability };

  const score = Math.max(0, Math.min(100,
    breakdown.named_account.points + breakdown.company_type.points +
    breakdown.signals.points + breakdown.ch_health.points +
    (draft ? breakdown.contactability.points : 0)));

  return { score, breakdown: { ...breakdown, total: score } };
}
