// Story freshness.
//
// James posted a story from the Studio and found on clicking through that it
// was three years old. It was the UK option among US ones, which is exactly
// why it got picked. The gap ran the whole pipeline: the sweep trusts Tavily's
// fourteen-day news window, but republished and aggregated stories arrive
// with fresh URLs, and once a signal is stored every consumer sorts by
// observed_at, when WE saw it, not when the story was published. The same
// fault could open a cold email on a three-year-old story, which is worse
// than an awkward LinkedIn post.
//
// The published date Tavily returns is already stored in the signal payload;
// nothing ever read it. This module reads it, one honest rule throughout:
// a story is stale only on evidence, a parseable published date older than
// the window. A missing or unparseable date is never treated as stale,
// because the engine does not guess; it is shown as unknown wherever a human
// decides, which is the visible gap rather than a silent one.
//
// Deliberately no SQL predicate: payload dates are third-party text and a
// failed timestamp cast aborts a whole query. Consumers over-fetch a little
// and filter here in code, where a junk date is just null.

// Two windows, John's design, told to James on 30 July 2026: signals are
// allowed to be old, because builds run for years and an eighteen-month-old
// planning story can still be this quarter's lead, while a LinkedIn post must
// be current, because a feed is a claim about now. Both env-tunable.
export function signalMaxAgeDays() {
  const n = parseInt(process.env.SIGNAL_MAX_AGE_DAYS || '730', 10);
  return Math.max(30, Math.min(1095, Number.isNaN(n) ? 730 : n));
}

export function postMaxAgeDays() {
  const n = parseInt(process.env.POST_MAX_AGE_DAYS || '30', 10);
  return Math.max(7, Math.min(365, Number.isNaN(n) ? 30 : n));
}

// A published value as a timestamp, or null. Tavily dates arrive in several
// shapes; Date.parse covers ISO and RFC forms, and anything it cannot read is
// unknown, never an error.
export function parsePublished(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

// Stale on evidence only: a parseable date older than the window.
export function isStaleStory(published, { now = Date.now(), maxAgeDays = signalMaxAgeDays() } = {}) {
  const t = parsePublished(published);
  if (t === null) return false;
  return (now - t) / 86_400_000 > maxAgeDays;
}

// The filter consumers apply after fetching: keeps unknown-dated stories,
// drops evidenced-stale ones.
export function freshOnly(rows, getPublished, opts = {}) {
  return (rows || []).filter(r => !isStaleStory(getPublished(r), opts));
}
