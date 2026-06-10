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
// score is explainable later.
const WEIGHTS = {
  namedAccount: 25,
  typeFit: 25,
  signals: 30,
  chHealth: 20,
};

const DC_SIGNAL_TYPES = new Set(['news_dc_build', 'news_contract', 'planning']);

function signalPoints(signals) {
  const dcSignals = (signals || []).filter(s => DC_SIGNAL_TYPES.has(s.signal_type));
  if (dcSignals.length === 0) return { points: 0, reason: 'no data centre build or contract signals' };
  const newest = Math.max(...dcSignals.map(s => new Date(s.observed_at || 0).getTime()));
  const ageDays = (Date.now() - newest) / 86_400_000;
  let points, recency;
  if (ageDays <= 30) { points = WEIGHTS.signals; recency = 'within 30 days'; }
  else if (ageDays <= 90) { points = 22; recency = 'within 90 days'; }
  else if (ageDays <= 180) { points = 15; recency = 'within 180 days'; }
  else { points = 8; recency = 'older than 180 days'; }
  return { points, reason: `${dcSignals.length} signal(s), newest ${recency}` };
}

function chHealthPoints(company) {
  const p = company.ch_profile;
  if (!p) return { points: 10, reason: 'no Companies House profile cached, neutral' };
  if (p.company_status !== 'active') return { points: 0, reason: `status ${p.company_status}` };
  if (p.has_insolvency_history) return { points: 0, reason: 'insolvency history on record' };
  return { points: WEIGHTS.chHealth, reason: 'active, no insolvency history' };
}

// Returns { score: 0..100, breakdown }. Pure, so it is easy to test; the
// orchestrator persists the result onto the companies row.
export function scoreCompany(company, signals) {
  const breakdown = {};

  breakdown.named_account = company.named_account
    ? { points: WEIGHTS.namedAccount, reason: 'on the named account list' }
    : { points: 0, reason: 'not a named account' };

  breakdown.company_type = ICP_CONFIG.companyTypes.includes(company.company_type)
    ? { points: WEIGHTS.typeFit, reason: `type ${company.company_type} fits the campaign` }
    : { points: 0, reason: `type ${company.company_type || 'unknown'} outside the campaign types` };

  breakdown.signals = signalPoints(signals);
  breakdown.ch_health = chHealthPoints(company);

  const score = Math.max(0, Math.min(100,
    breakdown.named_account.points + breakdown.company_type.points +
    breakdown.signals.points + breakdown.ch_health.points));

  return { score, breakdown: { ...breakdown, total: score } };
}
