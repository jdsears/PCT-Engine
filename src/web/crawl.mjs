// The website trawl, 9 September 2026: one site, breadth first from its
// front page, same host only, bounded in depth and in pages, seeded from the
// sitemap when there is one, and reported. Every reason a page was not
// taken is counted, and the price rule that governs the SharePoint sync
// governs here too: a price list on a supplier's site is refused by name.
//
// The crawl is pure over its fetch function, so the gate runs it against a
// local server and proves the manners without touching the internet.
import { createHash } from 'node:crypto';
import { parseOfficeAsync } from 'officeparser';
import { politeFetch, getRobots, robotsAllows, HostPacer } from './fetch.mjs';
import { canonicalUrl, hostOf, sameHost, isAssetUrl, isDocUrl, isSpreadsheetUrl, isLocalePath, priceRule, extractPage, parseSitemap } from './extract.mjs';

export const contentHash = text => createHash('sha1').update(String(text || '')).digest('hex');

// Why a link is or is not followed, decided before any request is made.
// Pure, so each refusal is provable: another host, an asset, a spreadsheet,
// a localised section, a price list by name, or outside the stated scope.
export function linkDecision(url, { start, include = null, exclude = null, includePdfs = false } = {}) {
  if (!url) return { follow: false, why: 'asset' };
  if (!sameHost(url, start)) return { follow: false, why: 'offHost' };
  if (isSpreadsheetUrl(url)) return { follow: false, why: 'type' };
  if (isDocUrl(url)) {
    const pdf = /\.pdf$/i.test(new URL(url).pathname);
    return includePdfs && pdf ? { follow: true, kind: 'pdf' } : { follow: false, why: 'type' };
  }
  if (isAssetUrl(url)) return { follow: false, why: 'asset' };
  if (isLocalePath(url)) return { follow: false, why: 'locale' };
  if (priceRule(url)) return { follow: false, why: 'priceRule' };
  if (exclude && exclude.test(url)) return { follow: false, why: 'excluded' };
  if (include && url !== start && !include.test(url)) return { follow: false, why: 'excluded' };
  return { follow: true, kind: 'page' };
}

const wordsOf = text => String(text || '').split(/\s+/).filter(w => /[a-z0-9]/i.test(w)).length;

export async function crawlSite(startUrl, opts = {}) {
  const {
    maxPages = 150, maxDepth = 3, delayMs = 1000, includePdfs = false, maxPdfs = 40,
    include = null, exclude = null, minWords = 40, fetchImpl = politeFetch, sitemap = true,
    pacer = new HostPacer({ delayMs }), log = () => {},
  } = opts;
  const start = canonicalUrl(startUrl);
  if (!start) throw new Error(`not a web address: ${startUrl}`);
  const origin = new URL(start).origin;
  const host = hostOf(start);
  // Even the robots fetch keeps the gap: the site sees one paced visitor.
  await pacer.wait(host, delayMs);
  const robots = await getRobots(origin, { fetchImpl });

  const report = {
    start, host, pages: [], fetched: 0, sitemapUrls: 0, truncated: false,
    skipped: { robots: 0, offHost: 0, asset: 0, type: 0, locale: 0, priceRule: [], excluded: 0, noindex: 0, language: 0, thin: 0, duplicate: 0, errors: [] },
  };
  const queue = [{ url: start, depth: 0, kind: 'page' }];
  const queued = new Set([start]);
  const enqueue = (url, depth) => {
    if (!url || queued.has(url)) return;
    const d = linkDecision(url, { start, include, exclude, includePdfs });
    if (!d.follow) {
      if (d.why === 'priceRule') { if (report.skipped.priceRule.length < 50) report.skipped.priceRule.push(url); }
      else report.skipped[d.why]++;
      return;
    }
    queued.add(url);
    queue.push({ url, depth, kind: d.kind });
  };

  // The sitemap seeds the queue at depth one: a site's own list of pages
  // reaches corners a three-deep walk from the front page would miss.
  if (sitemap) {
    const seen = new Set();
    const pending = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
    while (pending.length && seen.size < 12) {
      const u = pending.shift();
      if (seen.has(u)) continue;
      seen.add(u);
      if (!robotsAllows(robots, new URL(u).pathname).allowed) continue;
      await pacer.wait(host, delayMs);
      const r = await fetchImpl(u, { accept: 'application/xml,text/xml;q=0.9,*/*;q=0.5', maxBytes: 3_000_000 });
      if (!r.ok || !r.body || /html/.test(r.contentType)) continue;
      const sm = parseSitemap(r.body.toString('utf8'));
      for (const child of sm.sitemaps) if (sameHost(child, start)) pending.push(child);
      for (const page of sm.urls) { report.sitemapUrls++; enqueue(page, 1); }
    }
  }

  const seenHashes = new Set();
  let pdfs = 0;
  while (queue.length && report.pages.length < maxPages) {
    const item = queue.shift();
    const u = new URL(item.url);
    const rb = robotsAllows(robots, u.pathname + u.search);
    if (!rb.allowed) { report.skipped.robots++; continue; }
    if (item.kind === 'pdf' && pdfs >= maxPdfs) { report.skipped.type++; continue; }
    await pacer.wait(host, rb.delay != null ? Math.max(delayMs, rb.delay * 1000) : delayMs);
    const r = await fetchImpl(item.url, item.kind === 'pdf' ? { maxBytes: 8_000_000, accept: 'application/pdf' } : {});
    report.fetched++;
    if (!r.ok || !r.body) {
      if (report.skipped.errors.length < 50) report.skipped.errors.push({ url: item.url, status: r.status, error: r.error || null });
      continue;
    }
    const finalUrl = canonicalUrl(r.url) || item.url;
    if (!sameHost(finalUrl, start)) { report.skipped.offHost++; continue; }

    if (item.kind === 'pdf' || /application\/pdf/.test(r.contentType)) {
      if (!includePdfs) { report.skipped.type++; continue; }
      pdfs++;
      const title = decodeURIComponent(u.pathname.split('/').pop() || '').replace(/\.pdf$/i, '').replace(/[-_]+/g, ' ').trim();
      if (priceRule(finalUrl, title)) { report.skipped.priceRule.push(finalUrl); continue; }
      let text = '';
      try { text = String(await parseOfficeAsync(r.body) || ''); }
      catch (e) { report.skipped.errors.push({ url: item.url, error: `pdf: ${String(e?.message || e).slice(0, 120)}` }); continue; }
      text = text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      const words = wordsOf(text);
      if (words < minWords) { report.skipped.thin++; continue; }
      const hash = contentHash(text);
      if (seenHashes.has(hash)) { report.skipped.duplicate++; continue; }
      seenHashes.add(hash);
      report.pages.push({ url: finalUrl, title: title || finalUrl, description: null, text, words, depth: item.depth, kind: 'pdf', hash });
      continue;
    }

    if (!/text\/html|application\/xhtml/.test(r.contentType)) { report.skipped.type++; continue; }
    const page = extractPage(r.body.toString('utf8'), finalUrl);
    // A canonical address on the same host is the page's real identity; the
    // address we arrived by is a variant of it.
    const storeUrl = page.canonical && sameHost(page.canonical, start) ? page.canonical : finalUrl;
    queued.add(storeUrl); queued.add(finalUrl);
    if (page.noindex) report.skipped.noindex++;
    else if (page.lang && !/^en\b/.test(page.lang)) report.skipped.language++;
    else if (priceRule(storeUrl, page.title)) { if (report.skipped.priceRule.length < 50) report.skipped.priceRule.push(storeUrl); }
    else if (page.words < minWords) report.skipped.thin++;
    else {
      const hash = contentHash(page.text);
      if (seenHashes.has(hash) || report.pages.some(p => p.url === storeUrl)) report.skipped.duplicate++;
      else {
        seenHashes.add(hash);
        report.pages.push({ url: storeUrl, title: page.title, description: page.description, text: page.text, words: page.words, depth: item.depth, kind: 'page', hash });
        if (report.pages.length % 25 === 0) log(`${host}: ${report.pages.length} page(s) read, ${queue.length} queued`);
      }
    }
    if (item.depth < maxDepth && !page.nofollow) for (const l of page.links) enqueue(l.url, item.depth + 1);
  }
  report.truncated = queue.length > 0 && report.pages.length >= maxPages;
  return report;
}

// The skip counts in one line for a report or a log, price-rule refusals
// named because those are the ones a human should see.
export function describeSkips(skipped) {
  const s = skipped || {};
  const parts = [];
  const names = { robots: 'refused by robots.txt', offHost: 'on other hosts', asset: 'assets', type: 'other file types', locale: 'localised pages', excluded: 'outside the stated scope', noindex: 'marked noindex', language: 'not in English', thin: 'too thin to keep', duplicate: 'duplicates' };
  for (const [k, label] of Object.entries(names)) if (s[k]) parts.push(`${s[k]} ${label}`);
  if (s.priceRule?.length) parts.push(`${s.priceRule.length} refused by the price rule (${s.priceRule.slice(0, 3).join(', ')}${s.priceRule.length > 3 ? ', ...' : ''})`);
  if (s.errors?.length) parts.push(`${s.errors.length} fetch error(s)`);
  return parts.join('; ') || 'nothing skipped';
}
