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

// Lowercase match against the includes, then the excludes. Excludes win unless
// the title also mentions procurement. Null or empty titles return null, not
// false, so unknowns stay visible rather than quietly out of orbit.
export function inOrbit(title) {
  if (title == null || !String(title).trim()) return null;
  const t = String(title).toLowerCase();
  if (!ORBIT_TITLES.some(x => t.includes(x))) return false;
  if (EXCLUDE_TITLES.some(x => t.includes(x)) && !t.includes('procurement')) return false;
  return true;
}
