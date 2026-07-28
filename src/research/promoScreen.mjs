// The promotional and roundup screen.
//
// The first live sweeps kept three items that the event test exists to fail:
// "Our Lighting and Acoustics teams were pleased to support", the "10 UK data
// centre construction projects to watch" listicle, and a LinkedIn post. The
// cause was not the event test but the path around it: promotional pages,
// listicles and social posts are JS-rendered or truncated, so the fetched
// content is thin, and the gate falls back to judging the title alone. In that
// path the roundup and primary-subject rules do not bite, and a title naming
// "data centre construction" passes. They became kept signals and consumed
// proposal capacity.
//
// This screen refuses those genres on the title before a model is called. It
// costs nothing, it is provable offline where the gate suite runs with no key,
// and it is deliberately narrow: a false positive silently drops a real lead,
// which is a worse failure than the noise it prevents. So every pattern here
// must be one that no genuine project report would carry, and the ambiguous
// cases are left to the model and to the prompt rule that accompanies this.
//
// Notably NOT screened, because they collide with real events:
//   "award" and "awarded", which is how a real contract win is reported;
//   "top" or "best" alone, which appear in ordinary prose;
//   any company or place name, which carries no genre signal.

// A numbered listicle: a leading count and a listicle cue. Both are required,
// so "10 Downing Street data centre approved" is untouched while "10 UK data
// centre construction projects to watch" is refused.
const LISTICLE_LEAD = /^\s*(?:top\s+)?\d{1,3}\b/i;
const LISTICLE_CUE = /\b(?:to watch|to know|you (?:should|need to) know|worth watching|ranked|the biggest|the best|round[- ]?up)\b/i;

// First-person supplier or consultancy promotion. The pronoun and the pleasure
// word must both appear and sit close together, so "the team were pleased with
// the result of the contract" in a real report is not caught by accident.
const FIRST_PERSON_PROMO = /\b(?:we|our|i)\b[^.!?]{0,60}\b(?:pleased|delighted|proud|excited|thrilled|honoured|honored|chuffed)\b/i;

// A social post captured with its platform furniture, for example
// "Gabriel Morelli's Post".
const SOCIAL_POST = /['’]s\s+post\s*$/i;

// Digests and periodicals: a collection, never one project event.
const DIGEST = /\b(?:round[- ]?up|roundup|digest|newsletter|weekly wrap|week in review|this week in|in pictures|photo gallery)\b/i;

// Marketing and calendar items rather than build events. "awards" is plural
// and word-bounded on purpose: "contract awarded" must never match.
const PROMOTIONAL = /\b(?:webinar|podcast|whitepaper|white paper|case study|brochure|awards|shortlist(?:ed|ing)?|nominat(?:ed|ion)|sponsor(?:ed|ship)|advertorial|now hiring|we are hiring|join our team|open day|trade show|exhibition stand|book your place|register now)\b/i;

// Each rule names itself, so a rejection can say which genre it matched and a
// reviewer can judge the screen rather than trust it.
const RULES = [
  { name: 'listicle', test: t => LISTICLE_LEAD.test(t) && LISTICLE_CUE.test(t) },
  { name: 'first-person promotion', test: t => FIRST_PERSON_PROMO.test(t) },
  { name: 'social post', test: t => SOCIAL_POST.test(t) },
  { name: 'digest or roundup', test: t => DIGEST.test(t) },
  { name: 'marketing or calendar item', test: t => PROMOTIONAL.test(t) },
];

// Returns the genre matched, or null. Pure.
export function promoGenre(title) {
  const t = String(title || '').trim();
  if (!t) return null;
  for (const r of RULES) if (r.test(t)) return r.name;
  return null;
}

export const isPromoOrRoundup = title => promoGenre(title) !== null;
