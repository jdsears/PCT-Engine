// The research side of the website trawl, 9 September 2026: a prospect's own
// site, read lightly, so the reviewer of a proposed company decides over
// what the company says about itself rather than over a name and a domain.
// The front page and a few profile pages (about, locations, contact), never
// a crawl, and the result is evidence on the proposal, not corpus: what they
// do in their own words, whether the site shows a UK address or number,
// whether it shows the Republic of Ireland, and the registered number if the
// footer states it, which the match walk already knows how to verify.
import { politeFetch, getRobots, robotsAllows, HostPacer } from './fetch.mjs';
import { extractPage, canonicalUrl, sameHost, hostOf, isAssetUrl, isDocUrl } from './extract.mjs';
import { extractRegistrationNumbers } from '../research/webRegistration.mjs';

// Links worth reading for a profile: the anchor text or the path says
// about, company, location, contact or facilities. Shallow ones only; a
// deep page is a product or a post, not the profile.
export const PROFILE_WORDS = /\b(about|who we are|our story|our company|company|overview|locations?|where we are|find us|contact|facilities|our sites|our plants|what we do|our business|history)\b/i;
const PROFILE_PATH = /\b(about|company|location|contact|facilit|our-sites|history|who-we-are)/i;
export function pickProfileLinks(links, home, { max = 4 } = {}) {
  const out = [];
  for (const l of links || []) {
    if (!l?.url || !sameHost(l.url, home) || l.url === home || isAssetUrl(l.url) || isDocUrl(l.url)) continue;
    let path;
    try { path = new URL(l.url).pathname; } catch { continue; }
    if (path.split('/').filter(Boolean).length > 2) continue;
    if (!(PROFILE_WORDS.test(l.text || '') || PROFILE_PATH.test(path))) continue;
    if (!out.includes(l.url)) out.push(l.url);
    if (out.length >= max) break;
  }
  return out;
}

// Signs of where a company sits, read plainly from its own text. A UK
// postcode needs its space, which product codes never carry; a UK number
// is +44 or a UK dialling code; the Republic shows as Dublin, an Eircode or
// +353, because the prospecting rule is about the Republic, not the island.
export function ukPresence(text) {
  const t = String(text || '');
  const postcodes = [...new Set(t.match(/\b[A-Z]{1,2}[0-9][A-Z0-9]? [0-9][A-Z]{2}\b/g) || [])].slice(0, 6);
  const ukPhone = /(\+44|\b0044)[\s()]*\d|\b0[12]\d{2,3}[ -]?\d{3}[ -]?\d{3,4}\b/.test(t);
  const mentionsUk = /\b(united kingdom|england|scotland|wales|northern ireland|great britain)\b/i.test(t) || /\bUK\b/.test(t);
  const republicOfIreland = /republic of ireland|\bdublin\b|\+353|\b00353\b|\beircode\b/i.test(t);
  return { postcodes, ukPhone, mentionsUk, republicOfIreland };
}

// The one-line summary: the site's own description when it has one, else
// the first sentence-length line of the front page.
export function summariseSite(home) {
  const desc = (home?.description || '').trim();
  if (desc) return desc.slice(0, 300);
  const line = String(home?.text || '').split('\n').map(l => l.trim()).find(l => l.length >= 60 && !/^- /.test(l));
  return line ? line.slice(0, 300) : null;
}

// The profile: front page plus up to four profile pages, robots obeyed,
// paced, bounded. Unreachable is an honest answer and costs nothing.
export async function profileSite(domainOrUrl, { fetchImpl = politeFetch, maxPages = 5, delayMs = 1000, timeoutMs = 10_000 } = {}) {
  const d = String(domainOrUrl || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!d) return null;
  const hosts = d.startsWith('www.') ? [d] : [d, `www.${d}`];
  const pacer = new HostPacer({ delayMs });
  let home = null, homeHtml = null;
  for (const h of hosts) {
    await pacer.wait(hostOf(`https://${h}/`));
    const r = await fetchImpl(`https://${h}/`, { timeoutMs });
    if (r.ok && r.body && /html/.test(r.contentType)) {
      homeHtml = r.body.toString('utf8');
      home = extractPage(homeHtml, canonicalUrl(r.url) || `https://${h}/`);
      break;
    }
  }
  if (!home) return { domain: d, unreachable: true };
  await pacer.wait(hostOf(home.url));
  const robots = await getRobots(new URL(home.url).origin, { fetchImpl });
  const pages = [];
  for (const u of pickProfileLinks(home.links, home.url, { max: Math.max(0, maxPages - 1) })) {
    if (!robotsAllows(robots, new URL(u).pathname).allowed) continue;
    await pacer.wait(hostOf(u));
    const r = await fetchImpl(u, { timeoutMs });
    if (!r.ok || !r.body || !/html/.test(r.contentType)) continue;
    const p = extractPage(r.body.toString('utf8'), u);
    if (p.noindex || p.words < 20) continue;
    pages.push({ url: u, title: p.title, text: p.text.slice(0, 6000) });
  }
  const all = [home.text, ...pages.map(p => p.text)].join('\n\n');
  return {
    domain: d, url: home.url, title: home.title,
    summary: summariseSite(home),
    pages: pages.map(p => ({ url: p.url, title: p.title })),
    uk: ukPresence(all),
    registrationNumbers: extractRegistrationNumbers(homeHtml),
    fetchedAt: new Date().toISOString(),
  };
}

// The evidence line a reviewer reads, pure over the profile. Plain words,
// no claim the site did not make.
export function describeProfile(p) {
  if (!p) return null;
  if (p.unreachable) return `Their site (${p.domain}) could not be read.`;
  const bits = [];
  if (p.summary) bits.push(p.summary);
  const uk = p.uk || {};
  if (uk.postcodes?.length) bits.push(`UK postcode${uk.postcodes.length > 1 ? 's' : ''} on the site: ${uk.postcodes.join(', ')}.`);
  else if (uk.ukPhone) bits.push('A UK phone number is on the site.');
  else if (uk.mentionsUk) bits.push('The site mentions the UK but shows no UK address or number.');
  else bits.push('No UK address or number found on the site.');
  if (uk.republicOfIreland) bits.push('The site shows the Republic of Ireland, which is out of scope for prospecting.');
  if (p.registrationNumbers?.length) bits.push(`Registered number on the site: ${p.registrationNumbers.join(', ')}.`);
  return bits.join(' ');
}
