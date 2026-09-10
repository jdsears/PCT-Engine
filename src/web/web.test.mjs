// The website trawl, proven offline: the extractor and the URL rules on
// synthetic HTML, robots.txt on synthetic files, and the crawl itself
// against a local HTTP server that stands in for a supplier's site, so the
// manners (robots, pacing, same host, depth, caps, the price rule) are
// demonstrated rather than promised. No request leaves the machine.
import { createServer } from 'node:http';
import { decodeEntities, htmlToText, extractPage, extractLinks, canonicalUrl, hostOf, sameHost,
  isAssetUrl, isDocUrl, isLocalePath, priceRule, parseSitemap } from './extract.mjs';
import { parseRobots, robotsAllows, HostPacer, politeFetch, getRobots, forgetRobots, USER_AGENT } from './fetch.mjs';
import { crawlSite, linkDecision, describeSkips, contentHash } from './crawl.mjs';
import { pickProfileLinks, ukPresence, summariseSite, describeProfile, profileSite } from './siteProfile.mjs';
import { validateSite, siteMeta, trawlSite } from './siteCorpus.mjs';

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  pass  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}: ${e.message}`); fail++; }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

console.log('The page reader (pure):');

await check('entities decode, chrome is stripped, headings and lists and tables read as text', async () => {
  const html = `<html lang="en-GB"><head><title>Mass Flow &amp; Pressure</title>
    <meta name="description" content="Flow instruments &#8211; made well">
    <link rel="canonical" href="/products/flow/"></head>
    <body><header><nav><a href="/menu">Menu</a></nav></header>
    <main><h1>Flow controllers</h1><p>The MC series &ldquo;works&rdquo; at 0&deg;C.</p>
    <script>var x = 1;</script><style>.a{}</style>
    <ul><li>One</li><li>Two</li></ul>
    <table><tr><th>Range</th><th>Accuracy</th></tr><tr><td>0.5 sccm</td><td>&plusmn;0.6%</td></tr></table>
    <a href="/about#team">About</a> <a href="mailto:x@y.com">mail</a> <a rel="nofollow" href="/login">login</a>
    <a href="https://other.example/x">elsewhere</a> <a href="/products?utm_source=news&id=2">link</a></main>
    <footer>Copyright</footer></body></html>`;
  const p = extractPage(html, 'https://www.alicat.com/products/flow?ref=a');
  assert(p.title === 'Mass Flow & Pressure', `title decodes: ${p.title}`);
  assert(p.description === 'Flow instruments – made well', `description decodes: ${p.description}`);
  assert(p.lang === 'en-gb' && p.canonical === 'https://www.alicat.com/products/flow', `lang and canonical: ${p.lang} ${p.canonical}`);
  assert(!p.noindex && !p.nofollow, 'no robots meta means indexable');
  assert(/^Flow controllers\n\nThe MC series “works” at 0°C\./.test(p.text), `heading then paragraph: ${JSON.stringify(p.text.slice(0, 80))}`);
  assert(/- One\n- Two/.test(p.text), 'list items take dashes');
  assert(/Range \| Accuracy\n0\.5 sccm \| ±0\.6%/.test(p.text), `table rows read as rows: ${JSON.stringify(p.text)}`);
  assert(!/Menu|Copyright|var x/.test(p.text), 'navigation, footer and script text are gone');
  const urls = p.links.map(l => l.url);
  assert(urls.includes('https://www.alicat.com/about'), 'a relative link resolves and loses its fragment');
  assert(urls.includes('https://www.alicat.com/products?id=2'), 'tracking parameters drop, real ones stay');
  assert(!urls.some(u => /mailto|login/.test(u)), 'mailto and nofollow links are not links to follow');
  assert(urls.includes('https://other.example/x'), 'an off-host link is still reported; the crawler decides');
  assert(decodeEntities('&#x41;&#66;&nbsp;&unknown;') === 'AB &unknown;', 'numeric entities decode, unknown names stay');
});

await check('a page with no main keeps article headers and drops navigation headers', async () => {
  const html = `<body><header><nav>Top</nav></header><article><header><h2>Story title</h2></header><p>Body text here.</p></article><aside>Related</aside></body>`;
  const t = htmlToText(html);
  assert(/Story title/.test(t) && /Body text here/.test(t), 'the article and its header survive');
  assert(!/Top|Related/.test(t), 'navigation and asides do not');
  const p = extractPage('<html><body><p>no title anywhere</p></body></html>', 'https://x.example/data-sheets/mc-series');
  assert(p.title === 'mc series', `the path names an untitled page: ${p.title}`);
  assert(p.words === 3, `words are counted: ${p.words}`);
});

await check('canonical addresses: one form per page', async () => {
  assert(canonicalUrl('HTTPS://WWW.Alicat.com:443/products/index.html#top') === 'https://www.alicat.com/products', 'host lowers, default port and index and fragment go');
  assert(canonicalUrl('https://a.example/x/?utm_source=t&b=2&fbclid=9') === 'https://a.example/x?b=2', 'tracking drops, trailing slash drops');
  assert(canonicalUrl('https://a.example/') === 'https://a.example/', 'the root keeps its slash');
  assert(canonicalUrl('/rel/path', 'https://a.example/base/') === 'https://a.example/rel/path', 'relative resolves against a base');
  assert(canonicalUrl('mailto:x@y.com') === null && canonicalUrl('javascript:void(0)') === null && canonicalUrl('') === null, 'non-web schemes are null');
  assert(hostOf('https://www.alicat.com/x') === 'alicat.com' && sameHost('https://alicat.com/a', 'https://www.alicat.com/b'), 'www is the same host');
  assert(!sameHost('https://de.alicat.com/a', 'https://www.alicat.com/b'), 'a subdomain is another host');
});

await check('the URL rules: assets, documents, locales and the price rule', async () => {
  assert(isAssetUrl('https://a.example/logo.png') && isAssetUrl('https://a.example/x.css') && !isAssetUrl('https://a.example/page'), 'assets by extension');
  assert(isDocUrl('https://a.example/datasheet.pdf') && !isDocUrl('https://a.example/pdf-guide'), 'a PDF is a document, a path word is not');
  assert(isLocalePath('https://a.example/de/produkte') && isLocalePath('https://a.example/fr-ca/x') && isLocalePath('https://a.example/zh-cn/'), 'language sections are locale paths');
  assert(!isLocalePath('https://a.example/en-us/x') && !isLocalePath('https://a.example/products') && !isLocalePath('https://a.example/'), 'English and plain paths are not');
  assert(priceRule('https://a.example/resources/price-list') && priceRule('https://a.example/x', 'Pricing 2026') && priceRule('https://a.example/downloads/alicat-PL-2026'), 'price lists by path or title are refused');
  assert(!priceRule('https://a.example/products/flow-controllers', 'Mass flow controllers'), 'a product page is not');
});

await check('sitemaps parse, index and urlset alike, capped', async () => {
  const idx = parseSitemap('<sitemapindex><sitemap><loc>https://a.example/post-sitemap.xml</loc></sitemap></sitemapindex>');
  assert(idx.sitemaps[0] === 'https://a.example/post-sitemap.xml' && idx.urls.length === 0, 'an index lists sitemaps');
  const set = parseSitemap('<urlset><url><loc>https://a.example/one/</loc></url><url><loc>https://a.example/two?utm_source=x</loc></url></urlset>', { cap: 1 });
  assert(set.urls.length === 1 && set.urls[0] === 'https://a.example/one', 'locations canonicalise and the cap holds');
});

console.log('\nrobots.txt (pure):');

await check('groups parse and our token wins over the wildcard, longest match decides', async () => {
  const groups = parseRobots(`# comment\nUser-agent: *\nDisallow: /private/\nCrawl-delay: 5\n\nUser-agent: Googlebot\nUser-agent: pct-engine\nDisallow: /secret/\nAllow: /secret/open\nDisallow: /*.json$\n`);
  assert(groups.length === 2 && groups[1].agents.includes('pct-engine'), `two groups: ${JSON.stringify(groups.map(g => g.agents))}`);
  assert(robotsAllows(groups, '/private/x').allowed === true, 'the wildcard group does not bind an agent with its own group');
  assert(robotsAllows(groups, '/secret/x').allowed === false, 'our group disallows');
  assert(robotsAllows(groups, '/secret/open/page').allowed === true, 'the longer allow wins');
  assert(robotsAllows(groups, '/data/file.json').allowed === false && robotsAllows(groups, '/data/file.json.html').allowed === true, 'wildcards and the end anchor');
  assert(robotsAllows(groups, '/private/x', 'otherbot').allowed === false && robotsAllows(groups, '/private/x', 'otherbot').delay === 5, 'another agent falls to the wildcard group and its delay');
  assert(robotsAllows([], '/anything').allowed === true, 'no robots file allows everything');
  assert(robotsAllows(parseRobots('User-agent: *\nDisallow:'), '/x').allowed === true, 'an empty Disallow allows everything');
  assert(/PCT-Engine/.test(USER_AGENT), 'the agent names itself');
});

await check('the pacer keeps the gap per host with a fake clock', async () => {
  let now = 1000; const slept = [];
  const p = new HostPacer({ delayMs: 500, sleep: async ms => { slept.push(ms); now += ms; }, now: () => now });
  await p.wait('a.example'); await p.wait('b.example'); await p.wait('a.example');
  assert(slept.length === 1 && slept[0] === 500, `one sleep of the gap for the repeat host: ${JSON.stringify(slept)}`);
  now += 10_000; await p.wait('a.example');
  assert(slept.length === 1, 'no sleep once the gap has passed');
});

console.log('\nThe crawl, against a local server standing in for a supplier site:');

// A miniature site with every case the crawler must handle. Requests are
// logged with their times so robots and pacing are proven by what the
// server saw, not by what the crawler claims.
const seen = [];
// Every page names itself in its body, because the crawler folds pages with
// identical text into one and the fixture's prose is shared.
const page = (title, body, extra = '') => `<html lang="en"><head><title>${title}</title>${extra}</head><body><nav><a href="/">Home</a> <a href="/contact">Contact</a></nav><main><p>This is the ${title} page.</p>${body}</main></body></html>`;
const prose = 'The MC series mass flow controller covers ranges from 0.5 sccm to 5000 slpm with a fast valve and a clear display for the operator. '.repeat(3);
const routes = {
  '/robots.txt': ['text/plain', 'User-agent: *\nDisallow: /private/\n\nUser-agent: pct-engine\nDisallow: /secret/\nAllow: /secret/open\n'],
  '/sitemap.xml': ['application/xml', '<urlset><url><loc>http://HOST/deep/orphan</loc></url><url><loc>http://HOST/logo.png</loc></url></urlset>'],
  '/': ['text/html', page('Home', `<h1>Alicat stand-in</h1><p>${prose}</p>
    <a href="/products">Products</a> <a href="/about-us">About us</a> <a href="/private/x">private</a> <a href="/secret/x">secret</a> <a href="/secret/open">open</a>
    <a href="/de/produkte">DE</a> <a href="/price-list">Prices</a> <a href="/logo.png">logo</a> <a href="/sheet.xlsx">sheet</a>
    <a href="https://other.example/page">other</a> <a href="/products?utm_source=x">dup</a> <a href="/noindex">n</a> <a href="/thin">t</a>
    <a href="/french">f</a> <a href="/resources/list">list</a> <a href="/redirect">r</a> <a href="/canon">c</a> <a href="mailto:a@b.c">m</a>`)],
  '/products': ['text/html', page('Products', `<h1>Products</h1><p>${prose}</p><a href="/products/flow">Flow</a>`)],
  '/products/flow': ['text/html', page('Flow', `<h1>Flow</h1><p>${prose}</p><a href="/products/flow/deep3">Deeper</a>`)],
  '/products/flow/deep3': ['text/html', page('Deep three', `<h1>Deep three</h1><p>${prose}</p><a href="/products/flow/deep3/deep4">Deepest</a>`)],
  '/products/flow/deep3/deep4': ['text/html', page('Deep four', `<p>${prose}</p>`)],
  '/about-us': ['text/html', page('About us', `<h1>About</h1><p>${prose}</p><p>Registered office: 12 Mill Lane, Reading RG1 4AB. Tel +44 (0)118 000 0000. Registered in England, Company No. 07053790.</p><a href="/contact">Contact</a>`,
    '<meta name="description" content="A stand-in supplier of mass flow instruments to UK industry.">')],
  '/contact': ['text/html', page('Contact', `<p>${prose}</p><p>Dublin office: 1 Quay Street, Dublin 2, +353 1 000 0000.</p>`)],
  '/private/x': ['text/html', page('Private', `<p>${prose}</p>`)],
  '/secret/x': ['text/html', page('Secret', `<p>${prose}</p>`)],
  '/secret/open': ['text/html', page('Open secret', `<p>${prose}</p>`)],
  '/noindex': ['text/html', page('Hidden', `<p>${prose}</p><a href="/products/flow">flow</a>`, '<meta name="robots" content="noindex">')],
  '/thin': ['text/html', page('Thin', '<p>five words are not enough</p>')],
  '/french': ['text/html', `<html lang="fr"><head><title>Produits</title></head><body><main><p>${prose}</p></main></body></html>`],
  '/resources/list': ['text/html', page('Price list 2026', `<p>${prose}</p>`)],
  '/deep/orphan': ['text/html', page('Orphan', `<h1>Only in the sitemap</h1><p>${prose}</p>`)],
  '/canon': ['text/html', page('Canon', `<p>${prose}</p>`, '<link rel="canonical" href="/products">')],
};
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  seen.push({ path: url.pathname, at: Date.now(), ua: req.headers['user-agent'] });
  if (url.pathname === '/redirect') { res.writeHead(302, { Location: '/products' }); return res.end(); }
  const r = routes[url.pathname];
  if (!r) { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('<p>gone</p>'); }
  res.writeHead(200, { 'content-type': r[0] });
  res.end(r[1].replace(/HOST/g, req.headers.host));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

await check('the crawl reads the site with its manners on and reports every refusal', async () => {
  forgetRobots();
  const t0 = Date.now();
  const r = await crawlSite(`${base}/`, { maxPages: 50, maxDepth: 3, delayMs: 40, log: () => {} });
  const urls = r.pages.map(p => new URL(p.url).pathname).sort();
  const want = ['/', '/about-us', '/contact', '/deep/orphan', '/private/x', '/products', '/products/flow', '/products/flow/deep3', '/secret/open'];
  assert(JSON.stringify(urls) === JSON.stringify(want), `pages read: ${JSON.stringify(urls)}`);
  assert(!seen.some(s => s.path === '/secret/x'), 'the robots disallow was never requested');
  assert(!seen.some(s => s.path === '/products/flow/deep3/deep4'), 'depth four was never requested');
  assert(!seen.some(s => /^\/(de\/|price-list|logo|sheet)/.test(s.path)), 'locale, price-list, asset and spreadsheet links were never requested');
  assert(seen.some(s => s.path === '/sitemap.xml') && r.sitemapUrls === 2 && !seen.some(s => s.path === '/logo.png'), 'the sitemap offered two addresses, seeded the orphan and never fetched the asset');
  assert(seen.every(s => /PCT-Engine/.test(s.ua)), 'every request carried the agent');
  const s = r.skipped;
  assert(s.robots === 1 && s.locale === 1 && s.offHost === 1 && s.asset >= 1 && s.type >= 1, `refusals counted: ${JSON.stringify(s)}`);
  assert(s.priceRule.some(u => /price-list$/.test(u)) && s.priceRule.some(u => /resources\/list$/.test(u)), 'price lists refused by path and by title, both named');
  assert(s.noindex === 1 && s.language === 1 && s.thin === 1, `noindex, language and thin pages counted: ${JSON.stringify(s)}`);
  assert(s.duplicate >= 2, `the redirect and the canonical variant are duplicates, not pages: ${s.duplicate}`);
  assert(r.pages.find(p => /about-us/.test(p.url)).description?.startsWith('A stand-in supplier'), 'descriptions travel');
  assert(r.pages.every(p => p.hash === contentHash(p.text) && p.words > 40), 'every page carries its hash and its size');
  assert(!r.truncated, 'the whole site fit under the cap');
  // A redirect is followed inside one request, so the hop it lands on is the
  // one gap that is not the crawler's to keep. The very first request,
  // robots.txt, arrives late by however long the first connection takes to
  // set up, so the gap after it is measured from a moving start and is
  // left out. Unpaced requests arrive a few milliseconds apart, so the
  // threshold under the 40ms gap still separates the two clearly.
  const gaps = seen.slice(2).map((x, i) => ({ gap: x.at - seen[i + 1].at, after: seen[i + 1].path }));
  assert(gaps.length >= 15, `enough requests to judge the pacing: ${gaps.length}`);
  assert(gaps.every(x => x.gap >= 25 || x.after === '/redirect'), `requests were paced at least the gap apart: ${gaps.map(x => `${x.after} ${x.gap}`).join(', ')}`);
  assert(/refused by the price rule/.test(describeSkips(s)) && /1 refused by robots/.test(describeSkips(s)), describeSkips(s));
  assert(Date.now() - t0 < 20_000, 'the miniature crawl is quick');
});

await check('the page cap truncates honestly and link decisions are pure', async () => {
  seen.length = 0;
  const r = await crawlSite(`${base}/`, { maxPages: 3, delayMs: 5, sitemap: false });
  assert(r.pages.length === 3 && r.truncated, 'three pages and a truncated flag');
  const d = u => linkDecision(u, { start: 'https://a.example/' });
  assert(d('https://b.example/x').why === 'offHost' && d('https://a.example/x.png').why === 'asset' && d('https://a.example/x.pdf').why === 'type', 'other host, asset, document');
  assert(linkDecision('https://a.example/x.pdf', { start: 'https://a.example/', includePdfs: true }).kind === 'pdf', 'a PDF follows when asked for');
  assert(d('https://a.example/de/x').why === 'locale' && d('https://a.example/price-list').why === 'priceRule', 'locale and price rule');
  assert(linkDecision('https://a.example/blog/x', { start: 'https://a.example/', exclude: /\/blog\// }).why === 'excluded', 'an exclusion applies');
  assert(d('https://a.example/products').follow === true, 'an ordinary page follows');
});

console.log('\nThe research profile (a prospect\'s own site, read lightly):');

await check('profile links, UK presence and the summary are pure and plain', async () => {
  const links = [
    { url: 'https://a.example/about-us', text: 'About us' }, { url: 'https://a.example/products/x', text: 'X' },
    { url: 'https://a.example/contact', text: 'Get in touch' }, { url: 'https://a.example/news/2026/01/post', text: 'Locations' },
    { url: 'https://b.example/about', text: 'About' }, { url: 'https://a.example/about-us', text: 'About' },
  ];
  assert(JSON.stringify(pickProfileLinks(links, 'https://a.example/')) === JSON.stringify(['https://a.example/about-us', 'https://a.example/contact']),
    'about and contact by text or path, same host, shallow, once each');
  const uk = ukPresence('Head office, 12 Mill Lane, Reading RG1 4AB, United Kingdom. Tel +44 118 000 0000. Model MC500SCCM.');
  assert(uk.postcodes.join() === 'RG1 4AB' && uk.ukPhone && uk.mentionsUk && !uk.republicOfIreland, `UK signs read: ${JSON.stringify(uk)}`);
  const ie = ukPresence('Unit 4, Sandyford, Dublin 18, D18 X2Y3. +353 1 000 0000.');
  assert(ie.republicOfIreland && ie.postcodes.length === 0, 'the Republic shows and an Eircode is not a UK postcode');
  assert(summariseSite({ description: '  A maker of things.  ' }) === 'A maker of things.', 'the description leads');
  assert(summariseSite({ description: '', text: 'Short\n- bullet\nA first sentence that is long enough to stand as the summary of the site.' }).startsWith('A first sentence'), 'else the first sentence-length line');
  const text = describeProfile({ domain: 'a.example', summary: 'A maker of things.', uk: { postcodes: ['RG1 4AB'], ukPhone: true, mentionsUk: true, republicOfIreland: true }, registrationNumbers: ['07053790'] });
  assert(/UK postcode on the site: RG1 4AB/.test(text) && /Republic of Ireland, which is out of scope/.test(text) && /Registered number on the site: 07053790/.test(text), text);
  assert(!/[—–!]/.test(text) && !/\bgenuinely\b/i.test(text), 'voice rules hold');
  assert(/could not be read/.test(describeProfile({ domain: 'x', unreachable: true })) && describeProfile(null) === null, 'unreachable and absent are honest');
});

await check('the profile reads the front page and its about and contact pages from the local site', async () => {
  seen.length = 0;
  const p = await profileSite(base.replace('http://', ''), { fetchImpl: (u, o) => politeFetch(u.replace('https://', 'http://'), o), delayMs: 5 });
  assert(p && !p.unreachable, `reachable: ${JSON.stringify(p)}`);
  assert(p.title === 'Home' && p.summary && p.summary.startsWith('The MC series'), `title and summary: ${p.title} / ${p.summary}`);
  assert(p.pages.some(x => /about-us/.test(x.url)) && p.pages.some(x => /contact/.test(x.url)), `profile pages read: ${JSON.stringify(p.pages)}`);
  assert(p.uk.postcodes.includes('RG1 4AB') && p.uk.ukPhone && p.uk.republicOfIreland, `signs from all pages: ${JSON.stringify(p.uk)}`);
  assert(p.registrationNumbers.length === 0, 'the register number is read from the front page only, and this front page states none');
  assert(seen.filter(s => s.path !== '/robots.txt').length <= 5, `a profile is a light read: ${seen.map(s => s.path).join(', ')}`);
  const gone = await profileSite('127.0.0.1:1', { fetchImpl: (u, o) => politeFetch(u.replace('https://', 'http://'), { ...o, timeoutMs: 800 }) });
  assert(gone.unreachable === true, 'a dead site is unreachable, not an error');
});

console.log('\nThe corpus side (pure pieces and a dry trawl with a stand-in crawl):');

await check('what may be registered, and what every web chunk carries', async () => {
  assert(validateSite({ url: 'www.alicat.com', line: 'alicat' }).ok === false, 'a bare host is not an address');
  const ok = validateSite({ url: 'https://www.alicat.com/?utm_source=x', line: 'Alicat', maxPages: '200', includePdfs: true });
  assert(ok.ok && ok.site.host === 'alicat.com' && ok.site.url === 'https://www.alicat.com/' && ok.site.line === 'alicat' && ok.site.maxPages === 200 && ok.site.includePdfs, JSON.stringify(ok));
  assert(validateSite({ url: 'https://x.example/', line: 'bad key!' }).ok === false && validateSite({ url: 'https://x.example/', maxPages: 5 }).ok === false, 'a bad line key and a silly cap are refused');
  assert(validateSite({ url: 'https://x.example/' }).site.line === 'general' && validateSite({ url: 'https://x.example/' }).site.maxPages === 150, 'defaults');
  const meta = siteMeta({ host: 'alicat.com', line: 'alicat' }, { url: 'https://www.alicat.com/products/flow', title: 'Flow', kind: 'page' }, 0, 3);
  assert(meta.source_id === 'web:https://www.alicat.com/products/flow' && meta.url === 'https://www.alicat.com/products/flow' && meta.corpus === 'web' && meta.line === 'alicat' && meta.section === 'chunk 1 of 3', JSON.stringify(meta));
});

await check('a dry trawl reports what would change and an apply without a key stands down', async () => {
  const fakeCrawl = async () => ({ pages: [{ url: 'https://x.example/a', title: 'A', text: 'text a', words: 50, hash: 'h1', kind: 'page' }], fetched: 2, truncated: false,
    skipped: { robots: 0, offHost: 0, asset: 0, type: 0, locale: 0, priceRule: ['https://x.example/price-list'], excluded: 0, noindex: 0, language: 0, thin: 0, duplicate: 0, errors: [] } });
  const dry = await trawlSite({ url: 'https://x.example/', host: 'x.example', line: 'general' }, { apply: false, crawl: fakeCrawl });
  assert(dry.pages === 1 && dry.updated === 1 && dry.unchanged === 0 && dry.priceRule.length === 1 && dry.sample[0].url === 'https://x.example/a', JSON.stringify(dry));
  const old = process.env.VOYAGE_API_KEY; delete process.env.VOYAGE_API_KEY;
  const noKey = await trawlSite({ url: 'https://x.example/', host: 'x.example', line: 'general' }, { apply: true, crawl: fakeCrawl });
  if (old !== undefined) process.env.VOYAGE_API_KEY = old;
  assert(/no embedding key/.test(noKey.skipped), 'no key, nothing written, said plainly');
});

await check('robots fetching remembers per origin and treats an HTML answer as no file', async () => {
  forgetRobots();
  let calls = 0;
  const fake = async (u) => { calls++; return { ok: true, status: 200, url: u, contentType: 'text/html', body: Buffer.from('<html>404 page</html>') }; };
  const g1 = await getRobots('https://a.example', { fetchImpl: fake });
  const g2 = await getRobots('https://a.example/', { fetchImpl: fake });
  assert(g1.length === 0 && g2.length === 0 && calls === 1, 'an HTML robots answer is no robots file, fetched once');
  const html = extractLinks('<a href="/x">x</a><base href="https://cdn.example/base/"><a href="rel">r</a>', 'https://a.example/p');
  assert(html.some(l => l.url === 'https://cdn.example/x') && html.some(l => l.url === 'https://cdn.example/base/rel'), 'a base tag governs every relative link in the document');
});

server.close();
console.log(`\n=== Web trawl gate: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
