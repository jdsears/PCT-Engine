import { cleanChNumber } from './companiesHouse.mjs';

// The register probe: reading a company's registration number off its own
// website. John's observation, 12 August 2026, on Upperton: the register
// says Upperton Pharma Solutions, Companies House says Upperton Limited,
// and no name rule can bridge a trading name to a differently named legal
// entity. But the footer of upperton.com states the number, because the
// trading disclosure rules require a UK company to publish its registered
// number on its business website. That makes the company's own site the
// one source that can speak when the name search cannot: the site the
// register row already points at, stating the company's own legal identity.
//
// The probe fetches the homepage only, never crawls, and extracts numbers
// only from text sitting next to registration language, so a phone number,
// a VAT number or a copyright year can never be mistaken for an identity.
// What the caller does with the number is the caller's discipline: the
// match walk verifies it against Companies House before anything is
// attached, and several distinct numbers on one page go to a human.

// Pure extraction, gate-testable without a network. Tags come off first,
// then each patch of registration language opens a short window and the
// window is searched for the two Companies House shapes: six to eight
// digits (short old registrations pad), or a two-letter prefix and six
// digits. A window whose language is about VAT is skipped.
const KEYWORD_RE = /\b(?:registration|registered|company|companies|co\.|reg\.?)\s*(?:number|no\b\.?:?|reg\b)|registered in (?:england|scotland|wales|northern ireland)|companies house/gi;
export function extractRegistrationNumbers(html) {
  const text = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/\s+/g, ' ');
  const found = new Set();
  KEYWORD_RE.lastIndex = 0;
  let m;
  while ((m = KEYWORD_RE.exec(text)) !== null) {
    const before = text.slice(Math.max(0, m.index - 24), m.index);
    if (/\bvat\b/i.test(before) || /\bvat\b/i.test(m[0])) continue;
    const window = text.slice(m.index, m.index + 140);
    for (const raw of window.match(/\b(?:\d{6,8}|[A-Za-z]{2}\d{6})\b/g) || []) {
      const clean = cleanChNumber(raw);
      if (clean) found.add(clean);
    }
  }
  return [...found];
}

// Fetches the homepage and extracts. Https first, a www fallback for hosts
// that only answer there, a bounded timeout, and any failure is simply no
// information: a site that is down or refuses robots tells us nothing and
// costs nothing. The page is capped so a heavy homepage cannot balloon the
// walk's memory.
export async function registrationFromSite(domain, { timeoutMs = 10_000 } = {}) {
  const d = String(domain || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!d) return { numbers: [] };
  const hosts = d.startsWith('www.') ? [d] : [d, `www.${d}`];
  for (const host of hosts) {
    try {
      const url = `https://${host}`;
      const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PCT-Engine register probe)', Accept: 'text/html' },
      });
      if (!res.ok) continue;
      const html = (await res.text()).slice(0, 800_000);
      return { numbers: extractRegistrationNumbers(html), url };
    } catch { /* try the next host form, or give up quietly */ }
  }
  return { numbers: [], unreachable: true };
}
