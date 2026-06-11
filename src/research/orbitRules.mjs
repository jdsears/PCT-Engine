// Titles that put a contact in the decision orbit for the Marwin DC campaign.
// Plain data, editable without touching logic. For Andy's refinement over time.
export const ORBIT_TITLES = [
  'engineering director', 'technical director', 'projects director',
  'design manager', 'design director', 'mep', 'm&e', 'building services',
  'mechanical engineer', 'specification', 'procurement', 'category manager',
  'head of engineering', 'head of projects', 'construction director',
];

export const EXCLUDE_TITLES = ['finance', 'hr', 'people', 'legal', 'marketing', 'sales'];

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
