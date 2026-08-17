// Titles that put a contact in the decision orbit for the Marwin DC campaign.
// Plain data, editable without touching logic. For Andy's refinement over time.
//
// The decision-maker for flow instrumentation is the engineer who specifies and
// procures plant on the build, and the project and commissioning people who run
// it: the design, mechanical, building services, controls and HVAC engineers,
// the project managers, the water and cooling specialists. Not the statutory
// company director. The list is ordered on purpose: the people-search keys on
// the first eight, which lead with the chilled-water cooling roles PCT sells
// into. Bare "design" is deliberately omitted, since at a hyperscaler it pulls
// in product and UX designers.
export const ORBIT_TITLES = [
  // Primary, also the people-search keywords (the first eight).
  'design engineer', 'building services', 'mechanical engineer', 'mep',
  'controls', 'hvac', 'project manager', 'commissioning engineer',
  // Further cooling, water, project and engineering roles, for classification.
  'cooling', 'chilled water', 'water', 'mechanical design', 'project engineer',
  'programme manager', 'program manager', 'm&e', 'design manager', 'design director',
  'head of engineering', 'engineering manager', 'engineering director',
  'technical director', 'projects director', 'project director', 'construction director',
  // Operator-side design authority, evidenced at Virtus (Fellow of Data Design).
  'data design',
  // The people who select, price and buy the kit, at the M&E contractors and
  // on the operator's build side. Cost management runs procurement on DC
  // builds; all three preconstruction spellings occur in real headlines.
  'estimator', 'contracts manager', 'preconstruction', 'pre-construction',
  'pre construction', 'cost manager', 'cost management',
  'specification', 'procurement', 'category manager',
];

// Functions and support roles that are never the specifier, even at a target
// company. Recruiters and talent in particular crowd a people-search.
// "project controls" is cost and schedule management, not building or BMS
// controls, so it is excluded while plain "controls" stays in scope.
export const EXCLUDE_TITLES = [
  'finance', 'hr', 'human resources', 'people', 'legal', 'marketing', 'sales',
  'recruit', 'talent', 'account executive', 'business development', 'project controls',
];

// Each pass over the same account asks a fresh window of the campaign's
// vocabulary instead of repeating the first eight forever, John's push of
// 17 August 2026 on optimising the decision-maker hunt: attempt zero is
// byte-identical to the original keys, attempt one asks titles nine to
// sixteen, and the window wraps. A revisit spends the same one call and
// asks a question it has not asked before.
export function roleWindow(titles, attempt = 0) {
  const t = (titles || []).filter(Boolean);
  if (t.length <= 8) return t;
  const windows = Math.ceil(t.length / 8);
  const start = (Math.max(0, Number(attempt) || 0) % windows) * 8;
  return t.slice(start, start + 8);
}

// Lowercase match against the includes, then the excludes. Excludes win unless
// the title also mentions procurement. Null or empty titles return null, not
// false, so unknowns stay visible rather than quietly out of orbit.
// A campaign may widen the includes with its own vocabulary, the definition's
// orbitTitles, wired through on 12 August 2026 when the pharma force run
// showed the search speaking data centre language at pharma companies: a
// process engineer or a CQV lead classified out of orbit and could never
// draft. The excludes always stand; a recruiter never orbits anywhere.
export function inOrbit(title, extraTitles = []) {
  if (title == null || !String(title).trim()) return null;
  const t = String(title).toLowerCase();
  if (![...ORBIT_TITLES, ...extraTitles].some(x => t.includes(String(x).toLowerCase()))) return false;
  if (EXCLUDE_TITLES.some(x => t.includes(x)) && !t.includes('procurement')) return false;
  return true;
}
