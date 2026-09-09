// The website trawl's reading layer, 9 September 2026, pure and dependency
// free. A page becomes readable prose with headings on their own lines, so
// the corpus chunker can split it on blank lines the way it splits a
// document, plus the absolute links the crawler follows. Nothing here touches
// the network; the gate proves every rule on synthetic HTML.
//
// John's instruction was website trawl capabilities that assist research
// too, so the same extractor serves both the corpus (a supplier's product
// pages, Alicat first) and the research funnel (a prospect's own site).

import { syncDecision } from '../sharepointSync.mjs';

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™',
  deg: '°', pound: '£', euro: '€', yen: '¥', cent: '¢', micro: 'µ', plusmn: '±', times: '×', divide: '÷',
  middot: '·', hellip: '…', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»', frac12: '½', frac14: '¼', frac34: '¾', sup2: '²', sup3: '³', bull: '•', shy: '',
};
export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    const k = e.toLowerCase();
    return k in NAMED ? NAMED[k] : m;
  });
}

const collapse = s => decodeEntities(String(s ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// Tracking parameters are never part of a page's identity.
const TRACKING = /^(utm_|gclid$|fbclid$|msclkid$|mc_cid$|mc_eid$|_ga$|_gl$|ref$|yclid$)/i;

// One canonical form per page, so the same page reached by two links is one
// page: lower-case host, no fragment, no tracking parameters, no default
// port, no trailing slash except the root, no index.html. Null for anything
// that is not an http(s) URL.
export function canonicalUrl(href, base = undefined) {
  let u;
  try { u = new URL(String(href || '').trim(), base); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) u.port = '';
  for (const key of [...u.searchParams.keys()]) if (TRACKING.test(key)) u.searchParams.delete(key);
  let path = u.pathname.replace(/\/index\.(html?|php)$/i, '/');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  u.pathname = path || '/';
  u.username = ''; u.password = '';
  return u.toString();
}

export function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}
export const sameHost = (a, b) => !!hostOf(a) && hostOf(a) === hostOf(b);

// Files the crawler never reads: images, styles, scripts, fonts, archives,
// media. A PDF is a document, handled by the crawler's own rule, and a
// spreadsheet is refused by type through the sync's decision, since a
// workbook on a supplier site is a price sheet more often than not.
const ASSET_EXT = /\.(png|jpe?g|gif|svg|webp|avif|ico|bmp|tiff?|css|js|mjs|map|json|woff2?|ttf|otf|eot|zip|gz|tar|rar|7z|dmg|exe|msi|apk|mp4|mp3|wav|avi|mov|webm|m4a|ogg|wmv|xml|rss|atom|step|stp|igs|iges|dwg|dxf|stl)$/i;
export const isAssetUrl = u => { try { return ASSET_EXT.test(new URL(u).pathname); } catch { return true; } };
export const isDocUrl = u => { try { return /\.(pdf|docx?|pptx?)$/i.test(new URL(u).pathname); } catch { return false; } };
export const isSpreadsheetUrl = u => { try { return /\.(xlsx?|xlsm|csv)$/i.test(new URL(u).pathname); } catch { return false; } };

// Localised sections of a site are skipped: the corpus is English, and a
// German product page is the English one again in another language. A path
// whose first segment is a language code, or a language-region pair that is
// not English, is a locale path.
const LOCALE = /^(de|fr|es|it|nl|pt|pt-br|ja|jp|zh|zh-cn|zh-tw|cn|ko|kr|ru|pl|sv|da|fi|no|nb|cs|tr|ar|he|hi|th|vi|id|ms|hu|ro|el|uk|sk|bg|hr|sl|lt|lv|et)$/i;
export function isLocalePath(u) {
  try {
    const first = new URL(u).pathname.split('/').filter(Boolean)[0] || '';
    if (!first) return false;
    if (/^en(-[a-z]{2})?$/i.test(first)) return false;
    if (LOCALE.test(first)) return true;
    const m = /^([a-z]{2})-([a-z]{2})$/i.exec(first);
    return !!m && m[1].toLowerCase() !== 'en';
  } catch { return false; }
}

// The price rule the SharePoint sync applies to file names, applied to a
// page's path and title: a price list on a supplier's site is refused the
// same way, whatever its type. One definition, so the two cannot drift.
export function priceRule(url, title = '') {
  let path = '';
  try { path = decodeURIComponent(new URL(url).pathname); } catch { path = String(url || ''); }
  const name = `${path.split('/').filter(Boolean).slice(-2).join(' ')} ${title || ''}.pdf`;
  return syncDecision(name).why === 'price rule';
}

const attr = (tag, name) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? '') : null;
};
const metaContent = (html, name) => {
  const re = /<meta\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const n = attr(m[0], 'name') || attr(m[0], 'property');
    if (n && n.toLowerCase() === name) return attr(m[0], 'content');
  }
  return null;
};
const strip = (html, tag) => html.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), ' ');

// Text from markup: the main or article element when the page has one, else
// the body without its navigation, footer and asides. Block elements end
// lines, headings sit alone between blank lines, list items take a dash, and
// table cells are separated by a bar so a row reads as a row.
export function htmlToText(html) {
  let h = String(html || '');
  h = h.replace(/<!--[\s\S]*?-->/g, ' ');
  for (const t of ['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'canvas', 'video', 'audio', 'object']) h = strip(h, t);
  const main = /<main\b[^>]*>([\s\S]*?)<\/main\s*>/i.exec(h) || /<article\b[^>]*>([\s\S]*?)<\/article\s*>/i.exec(h);
  if (main) h = main[1];
  else {
    const body = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(h);
    if (body) h = body[1];
    for (const t of ['nav', 'footer', 'aside', 'form']) h = strip(h, t);
    // A header that carries navigation is chrome; a header inside an article
    // holds its title and stays.
    h = h.replace(/<header\b[^>]*>[\s\S]*?<\/header\s*>/gi, m => (/<nav\b/i.test(m) || /\bmenu\b/i.test(m) ? ' ' : m));
  }
  h = h.replace(/<br\s*\/?>/gi, '\n');
  h = h.replace(/<\/?h[1-6]\b[^>]*>/gi, '\n\n');
  h = h.replace(/<li\b[^>]*>/gi, '\n- ');
  h = h.replace(/<\/(p|div|tr|section|article|blockquote|pre|table|ul|ol|dl|dd|dt|figure|figcaption|summary|details)\s*>/gi, '\n');
  h = h.replace(/<(p|div|section|article|blockquote|table|ul|ol|dl|figure)\b[^>]*>/gi, '\n');
  h = h.replace(/<\/t[dh]\s*>\s*<t[dh]\b[^>]*>/gi, ' | ');
  h = h.replace(/<[^>]+>/g, ' ');
  h = decodeEntities(h);
  return h
    .replace(/[ \t ]+/g, ' ')
    .split('\n').map(l => l.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Anchor links resolved absolute, fragments dropped, nothing that is not a
// web page: mailto, tel and script links are not links to follow. A link
// marked nofollow is left alone.
export function extractLinks(html, baseUrl) {
  const baseTag = /<base\b[^>]*>/i.exec(String(html || ''));
  const base = (baseTag && attr(baseTag[0], 'href')) || baseUrl;
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi;
  let m;
  while ((m = re.exec(String(html || ''))) !== null) {
    const tag = m[0].slice(0, m[0].indexOf('>') + 1);
    const href = attr(tag, 'href');
    if (!href || /^\s*(mailto:|tel:|javascript:|sms:|#)/i.test(href)) continue;
    if (/\bnofollow\b/i.test(attr(tag, 'rel') || '')) continue;
    let abs;
    try { abs = canonicalUrl(href, base); } catch { abs = null; }
    if (!abs || seen.has(abs)) continue;
    seen.add(abs);
    out.push({ url: abs, text: collapse(m[1]).slice(0, 120) });
  }
  return out;
}

// The whole page read: title, description, language, canonical address, the
// robots meta, text and links. The title falls back to the first heading and
// then to the path, so a page is never nameless in a citation.
export function extractPage(html, url) {
  const h = String(html || '');
  const lang = (/<html\b[^>]*>/i.exec(h) && attr(/<html\b[^>]*>/i.exec(h)[0], 'lang')) || null;
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(h);
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(h);
  let title = titleTag ? collapse(titleTag[1]) : '';
  if (!title && h1) title = collapse(h1[1]);
  if (!title) {
    try { title = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || new URL(url).hostname).replace(/[-_]+/g, ' '); }
    catch { title = String(url || ''); }
  }
  const robots = (metaContent(h, 'robots') || '').toLowerCase();
  const canonicalTag = /<link\b[^>]*\brel\s*=\s*["']?canonical["']?[^>]*>/i.exec(h);
  const canonical = canonicalTag ? canonicalUrl(attr(canonicalTag[0], 'href') || '', url) : null;
  const text = htmlToText(h);
  return {
    url, title: title.slice(0, 200),
    description: (metaContent(h, 'description') || metaContent(h, 'og:description') || '').replace(/\s+/g, ' ').trim().slice(0, 500) || null,
    lang: lang ? lang.toLowerCase() : null,
    canonical,
    noindex: /\bnoindex\b/.test(robots),
    nofollow: /\bnofollow\b/.test(robots),
    text,
    words: text ? text.split(/\s+/).filter(w => /[a-z0-9]/i.test(w)).length : 0,
    links: extractLinks(h, url),
  };
}

// Sitemap addresses, from a sitemap or a sitemap index. A plain list of
// locations, capped, because a sitemap is a seed for the crawl and not a
// promise to read everything it names.
export function parseSitemap(xml, { cap = 500 } = {}) {
  const urls = [], sitemaps = [];
  const src = String(xml || '');
  const re = /<(sitemap|url)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    const loc = /<loc\b[^>]*>([\s\S]*?)<\/loc\s*>/i.exec(m[2]);
    if (!loc) continue;
    const u = canonicalUrl(decodeEntities(loc[1]).trim());
    if (!u) continue;
    (m[1].toLowerCase() === 'sitemap' ? sitemaps : urls).push(u);
    if (urls.length >= cap) break;
  }
  return { urls, sitemaps };
}
