import { normKey } from './parseMega.mjs';

// The valve lines are priced per enquiry, not from a stored list: a spec goes
// to the manufacturer, a quoted price comes back, and the margin is set per
// customer in the mega sheet's calculator. That means there is no fixed
// customer price for the lookup to hold, and a stored number would invite
// quoting the wrong one. So a price query against these lines answers with
// the process instead, taken from the mega sheet's own note pad. Plain data,
// so corrections are one-line edits; margins and discounts appear nowhere.

// Per James (July 2026): the mega sheet's note pad is the internal team's own
// scratchpad, supplier contacts and process intricacies included, and the
// co-pilot must not repeat it. These lines are newer brands where the team
// checks with the factory before quoting, so the only safe pointer is the
// internal one. No supplier names, addresses or order rules appear here.
const ENQUIRY_NOTE =
  'Priced per enquiry, no fixed list price is held here. Ask Andy or your area sales manager to price it; the quote comes through the internal calculator on the mega sheet, with the margin set per customer.';

// Model-code prefixes are matched on the normalised query (upper case, spaces
// stripped), brand words on whole words. Order matters, first match wins, and
// a stored part can never be shadowed because the lookup only consults this
// map when the lists returned nothing. The configurator's own models map to
// their lines: CV3000, CV4700 and JR builds are Marwin, Mark 96 builds start
// with 96 and are Steriflow, and other Mark-style codes fall to the family
// entry rather than guessing a brand.
const LINES = [
  { line: 'Marwin', note: ENQUIRY_NOTE, prefixes: [/^CV3\d{3}/, /^CV4\d{3}/, /^JR/], words: ['MARWIN'] },
  { line: 'Steriflow', note: ENQUIRY_NOTE, prefixes: [/^MK9\d/, /^MARK9\d/, /^96/], words: ['STERIFLOW', 'JPURE', 'J-PURE'] },
  { line: 'LowFlow', note: ENQUIRY_NOTE, prefixes: [], words: ['LOWFLOW'] },
  { line: 'BestoBell', note: ENQUIRY_NOTE, prefixes: [], words: ['BESTOBELL'] },
  { line: 'Hex', note: ENQUIRY_NOTE, prefixes: [], words: ['HEX'] },
  { line: 'Jordan', note: ENQUIRY_NOTE, prefixes: [], words: ['JORDAN'] },
  { line: 'Equilibar', note: ENQUIRY_NOTE, prefixes: [], words: ['EQUILIBAR'] },
  { line: 'Richards Industrials', note: ENQUIRY_NOTE, prefixes: [/^MK\d{2,}/, /^MARK\d{2,}/, /^601/], words: ['RICHARDS'] },
];

// Which quoted line a price query concerns, or null. Pure, so the routing is
// testable, and deliberately conservative: an unrecognised query stays an
// honest nothing rather than a guessed pointer.
export function quotedLine(query) {
  const key = normKey(query);
  if (!key) return null;
  const words = String(query || '').toUpperCase().split(/[^A-Z0-9-]+/).filter(Boolean);
  for (const l of LINES) {
    if (l.prefixes.some(p => p.test(key))) return { line: l.line, note: l.note };
    if (l.words.some(w => words.includes(w))) return { line: l.line, note: l.note };
  }
  return null;
}
