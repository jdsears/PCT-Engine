// Titles that put a contact in the decision orbit for the Marwin DC campaign.
// Plain data, editable without touching logic. For Andy's refinement over time.
//
// The decision-maker for flow instrumentation is not the statutory company
// director: it is the senior or lead design engineer, the M&E or building
// services engineer, the project engineer specifying and procuring plant on
// the build. Those roles lead the list, the design and engineering leadership
// follow, and procurement closes it. The list is ordered on purpose: the
// people-search keys on the first several entries.
export const ORBIT_TITLES = [
  // Primary: the engineers who specify and procure plant on the build.
  'design engineer', 'building services', 'mechanical engineer', 'mep',
  'commissioning engineer', 'project engineer', 'mechanical design', 'm&e',
  // Design and engineering leadership on the project.
  'design manager', 'design director', 'head of engineering', 'engineering manager',
  'engineering director', 'technical director', 'projects director', 'construction director',
  // Procurement.
  'specification', 'procurement', 'category manager',
];

// Functions and support roles that are never the specifier, even at a target
// company. Recruiters and talent in particular crowd a people-search.
export const EXCLUDE_TITLES = [
  'finance', 'hr', 'human resources', 'people', 'legal', 'marketing', 'sales',
  'recruit', 'talent', 'account executive', 'business development',
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
