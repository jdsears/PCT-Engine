// Which signal types are fit to open a cold email on, because a person could
// plausibly have noticed the event and have a real reason to reach out. Plain,
// editable data: everything not listed here is treated as not opener-grade, so a
// too-cautious opener (a slightly generic email) is preferred over a too-eager
// one (the scraped-the-register tell).
//
// The research layer writes three project-event types today: news_dc_build,
// news_contract and planning. The rest are forward-looking names for when the
// taxonomy grows, so the boundary does not need re-coding then.
export const OPENER_GRADE_TYPES = [
  'planning', 'planning_granted', 'planning_submitted',
  'construction', 'fit_out', 'build_milestone',
  'contract_award', 'framework_win',
  'capacity_expansion', 'hyperscaler_announcement',
  'funding_round', 'site_acquisition',
  'news_dc_build', 'news_contract',
];

// Accepts a grounding signal ({ type }) or a raw row ({ signal_type }).
export function isOpenerGrade(signal) {
  const t = signal && (signal.type || signal.signal_type);
  return t ? OPENER_GRADE_TYPES.includes(t) : false;
}

// Plain labels for the reviewer's note. Kept server-side so the grade and its
// summary travel together as provenance on the stored draft.
const SIGNAL_LABELS = {
  news_dc_build: 'a data centre build announcement',
  news_contract: 'a contract signal',
  planning: 'planning activity',
  ch_filing: 'a routine filing',
  ch_director_change: 'an officer change',
  ch_officers: 'an officer record',
  ch_incorporation: 'a new incorporation',
};
function signalLabel(type) {
  return SIGNAL_LABELS[type] || (type ? type.replace(/_/g, ' ') : 'a signal');
}

// A short, honest line for the review queue: whether the draft opened on a real
// project event, or fell back to profile fit because the lead only moved the
// register. Returns { kind: 'event' | 'fit', text }.
export function openerNote(signal, openerGrade) {
  const type = signal && (signal.type || signal.signal_type);
  if (signal && openerGrade) return { kind: 'event', text: `Opened on: ${signalLabel(type)} (project event)` };
  if (signal) return { kind: 'fit', text: `No project event yet, opened on profile fit (lead surfaced from ${signalLabel(type)})` };
  return { kind: 'fit', text: 'No signal on file, opened on profile fit' };
}
