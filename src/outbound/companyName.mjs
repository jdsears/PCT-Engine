// The written form of a company name, for emails.
//
// The register stores names as Companies House prints them, "PP O'CONNOR
// LIMITED", because that is the honest record and what the matcher keys on.
// It is not how a person writes to another person: an email that shouts the
// recipient's own company in capitals with LIMITED after it reads as a mail
// merge off the register, which is exactly what it would be. So the grounding
// presents the written form and the stored form never reaches a draft.
//
// Two transformations, both conservative:
//
// Trailing corporate suffixes are dropped (Limited, Ltd, PLC, LLP and kin),
// repeatedly, so "X GROUP LIMITED" loses only the suffix and keeps Group.
// Only at the end of the name: a suffix word mid-name is part of the name.
//
// A name in capitals is recased word by word, and ONLY when the whole name is
// capitals, which is the Companies House shape. A mixed-case name is already
// someone's chosen styling ("Pure DC", "SubZero") and is never touched. Within
// an all-caps name: one and two letter words stay as they are, since they are
// initials or codes (PP, UK, DC); known acronyms stay; apostrophe and hyphen
// parts recase separately, so O'CONNOR becomes O'Connor and SMITH-JONES
// becomes Smith-Jones. A single-word all-caps name of four letters or fewer is
// left alone, because MIS recased to Mis would be wrong and there is no safe
// way to tell an acronym from a word at that length.

const SUFFIX = /\s+(?:limited|ltd\.?|plc|llp|llc|inc\.?|gmbh|co\.?)\s*$/i;

// Acronyms that read wrongly recased. Editable.
const ACRONYMS = new Set(['uk', 'usa', 'eu', 'ai', 'dc', 'it', 'hvac', 'mep', 'me', 'emea', 'gmp', 'api']);

const recaseWord = w => w.length <= 2 || ACRONYMS.has(w.toLowerCase())
  ? w
  : w.charAt(0) + w.slice(1).toLowerCase();

const recasePart = part => part.split(/([’'-])/).map(seg =>
  /[’'-]/.test(seg) ? seg : recaseWord(seg)).join('');

export function writtenCompanyName(name) {
  let s = String(name || '').replace(/\s+/g, ' ').trim();
  if (!s) return s;
  let prev;
  do { prev = s; s = s.replace(SUFFIX, '').trim(); } while (s && s !== prev);
  if (!s) return prev; // a name that was only a suffix keeps its last form
  const hasLower = /\p{Ll}/u.test(s);
  if (hasLower) return s; // mixed case is chosen styling, never touched
  const words = s.split(' ');
  if (words.length === 1 && s.length <= 4) return s; // MIS, ACME at this length is unknowable
  return words.map(recasePart).join(' ');
}
