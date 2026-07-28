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

// Titles arrive with decoration. A social post begins with an emoji, a feed
// title with a bullet or a pipe. Strip leading non-alphanumeric characters
// before any anchored test, or the pattern is defeated by a chart symbol,
// which is exactly how the live listicle got through the first cut of this
// screen: "📊 10 UK data centre construction projects to watch".
const stripDecoration = t => String(t || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();

// A numbered listicle: a leading count and a listicle cue. Both are required,
// so "10 Downing Street data centre approved" is untouched while "10 UK data
// centre construction projects to watch" is refused.
const LISTICLE_LEAD = /^(?:top\s+)?\d{1,3}\b/i;
const LISTICLE_CUE = /\b(?:to watch|to know|you (?:should|need to) know|worth watching|ranked|the biggest|the best|round[- ]?up)\b/i;

// First-person supplier or consultancy promotion. A pronoun alone is not
// enough, since trade press quotes people; it must sit near a promotional cue.
// "all systems go" earns its place here from the live Hatfield post, which is
// first-person promotion with no word of pleasure in it.
const FIRST_PERSON = /\b(?:we|we're|we've|our|us|i'm)\b/i;
const PROMO_CUE = /\b(?:pleased|delighted|proud|excited|thrilled|honoured|honored|chuffed|all systems go|check (?:it|this) out|take a look|join us|great to|happy to|look(?:ing)? forward to)\b/i;
const FIRST_PERSON_PROMO = t => FIRST_PERSON.test(t) && PROMO_CUE.test(t);

// Page furniture rather than a story: a feed or navigation title that carries
// no sentence at all, such as "Instagram" or "Newsroom". Both were stored as
// signals. A real headline is longer than three words and says something; this
// only matches a short title made entirely of generic page words, so a terse
// real headline like "Skanska wins £158m London data centre fit-out" is
// untouched by construction.
const FURNITURE_WORDS = /^(?:instagram|facebook|linkedin|x|twitter|youtube|tiktok|newsroom|news|home|homepage|blog|posts?|updates?|media|press|press releases?|insights?|articles?|events?|about|contact|untitled|page not found|404)$/i;
const FURNITURE = t => FURNITURE_WORDS.test(t.replace(/\s*[|\-–—]\s*.*$/, '').trim());

// A periodical digest titled by its month: "New Data Center Developments:
// July 2026" is a monthly collection, not one project event. A digest noun and
// a trailing month and year are both required, so an ordinary headline that
// happens to mention a date is untouched.
const MONTHLY = /\b(?:developments?|updates?|round[- ]?up|review|digest|news|report)\b[\s:,-]*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{4}\s*$/i;

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
  { name: 'first-person promotion', test: FIRST_PERSON_PROMO },
  { name: 'social post', test: t => SOCIAL_POST.test(t) },
  { name: 'page furniture', test: FURNITURE },
  { name: 'digest or roundup', test: t => DIGEST.test(t) || MONTHLY.test(t) },
  { name: 'marketing or calendar item', test: t => PROMOTIONAL.test(t) },
];

// Returns the genre matched, or null. Pure. Decoration is stripped first, so a
// leading emoji or bullet cannot defeat an anchored pattern.
export function promoGenre(title) {
  const t = stripDecoration(title);
  if (!t) return null;
  for (const r of RULES) if (r.test(t)) return r.name;
  return null;
}

export const isPromoOrRoundup = title => promoGenre(title) !== null;
