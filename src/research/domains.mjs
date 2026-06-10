import { tavilySearch } from './newsResearch.mjs';

// Resolves a company's official web domain so the name-and-domain email lookup
// can work for contacts who are not on LinkedIn. Conservative on purpose: a
// domain is only accepted when its name matches the company name, and null is
// returned otherwise, since a wrong domain wastes Findymail credits later.

// Hosts that appear in search results but are never a company's own site.
// Plain data, extend freely.
export const NON_COMPANY_HOSTS = [
  'linkedin.com', 'wikipedia.org', 'gov.uk', 'crunchbase.com', 'bloomberg.com',
  'ft.com', 'theregister.com', 'datacenterdynamics.com', 'datacentremagazine.com',
  'computerweekly.com', 'bbc.co.uk', 'theguardian.com', 'telegraph.co.uk',
  'facebook.com', 'x.com', 'twitter.com', 'youtube.com', 'instagram.com',
  'glassdoor.com', 'glassdoor.co.uk', 'indeed.com', 'indeed.co.uk',
  'endole.co.uk', 'opencorporates.com', 'dnb.com', 'zoominfo.com',
  'prnewswire.com', 'businesswire.com', 'globenewswire.com', 'reuters.com',
  'datacenterknowledge.com', 'capacitymedia.com', 'intelligentdatacentres.com',
  'constructionenquirer.com', 'building.co.uk', 'theconstructionindex.co.uk',
  'newcivilengineer.com', 'techerati.com', 'datacentrereview.com',
];

const MULTI_PART_TLDS = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'net.uk', 'ltd.uk', 'plc.uk']);

const norm = (s) => String(s || '').toLowerCase()
  .replace(/\b(ltd|limited|plc|llp|uk|group|holdings|unlimited|company)\b/g, '')
  .replace(/[^a-z0-9]/g, '');

// Reduce a URL to its registrable domain, for example docs.kaodata.com to
// kaodata.com and www.tclarke.co.uk to tclarke.co.uk. Returns null on junk.
export function registrableDomain(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  const parts = host.replace(/^www\./, '').split('.');
  if (parts.length < 2) return null;
  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_PART_TLDS.has(lastTwo)) {
    return parts.length >= 3 ? parts.slice(-3).join('.') : null;
  }
  return lastTwo;
}

const isBlocked = (domain) => NON_COMPANY_HOSTS.some(b => domain === b || domain.endsWith('.' + b));

// The label is the name part of the domain: kaodata from kaodata.com.
const domainLabel = (domain) => domain.split('.')[0].replace(/[^a-z0-9]/g, '');

// Pick the official domain for a company from a list of result URLs. Exact
// label match against the normalised name first, then containment either way.
export function pickDomain(companyName, urls) {
  const name = norm(companyName);
  if (!name) return null;
  const candidates = [];
  for (const u of urls) {
    const d = registrableDomain(u);
    if (d && !isBlocked(d) && !candidates.includes(d)) candidates.push(d);
  }
  const exact = candidates.find(d => domainLabel(d) === name);
  if (exact) return exact;
  return candidates.find(d => {
    const label = domainLabel(d);
    return label.length >= 3 && (name.includes(label) || label.includes(name));
  }) ?? null;
}

export async function resolveDomain(companyName) {
  const results = await tavilySearch(`"${companyName}" official website`, { topic: 'general', maxResults: 8 });
  return pickDomain(companyName, results.map(r => r.url).filter(Boolean));
}
