// The second route to a company's people, proven offline: the name and role
// reader on the shapes team pages actually take, the orbit filter, the page
// picker, and the whole read against a local server standing in for a
// company site. The LinkedIn cadence rule sits beside it, because the two
// together are what John asked for on 11 September 2026: leads faster, and
// not wholly dependent on LinkedIn.
import { createServer } from 'node:http';
import { looksLikeName, looksLikeRole, extractPeople, jsonLdPeople, qualify, peoplePageLinks, findPeopleOnSite } from './sitePeople.mjs';
import { peopleSearchDue, peopleCoolingUntil, orbitWindows, peopleSearchLimit, PEOPLE_SERVED_DAYS } from './peopleDiscovery.mjs';
import { politeFetch } from '../web/fetch.mjs';
import { requireCampaign } from '../campaigns/registry.mjs';
import { sourceLine } from '../outbound/provenance.mjs';

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  pass  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}: ${e.message}`); fail++; }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const DC = requireCampaign('marwin_dc').orbitTitles;

console.log('Names and roles on a team page (pure):');

await check('a name is two to four capitalised words and nothing a heading says', async () => {
  for (const ok of ['Jane Smith', 'Nathan Willmott', "Sean O'Brien", 'Ludwig van der Berg', 'Anne-Marie Jones', 'JOHN SMITH', 'J. K. Rowling'])
    assert(looksLikeName(ok), `${ok} is a name`);
  for (const no of ['Meet The Team', 'Our People', 'Project Director', 'Jane', 'jane smith', 'Jane Smith 2024', 'Head Office', 'Data Centre Solutions', 'Read More', 'NG Bailey Limited'])
    assert(!looksLikeName(no), `${no} is not a name`);
});

await check('a role names a function, and a data centre title sits in the orbit', async () => {
  assert(looksLikeRole('Senior Project Manager') && looksLikeRole('Head of Mechanical Engineering') && looksLikeRole('Chief Executive Officer'), 'ordinary titles');
  assert(looksLikeRole('Data Design Fellow', DC), 'a campaign title counts as a role even without a role word');
  assert(!looksLikeRole('We build the future of digital infrastructure across Europe and beyond, with care.') && !looksLikeRole('Jane Smith'), 'prose and names are not roles');
});

await check('pairs read from stacked lines and from one-line forms, once each', async () => {
  const text = [
    'Meet the team', '',
    'Jane Smith', '', 'Senior Project Manager', '',
    'Tom Brown', 'Head of Building Services', '',
    'Priya Shah, Design Engineer', '',
    'Alex Green - Talent Acquisition Partner', '',
    'Sam Jones', 'Reading, Berkshire', 'Commissioning Engineer', '',
    'Jane Smith', 'Project Manager', '',
    'Our offices', 'London', '',
    'We deliver mission critical facilities.', '',
  ].join('\n');
  const people = extractPeople(text, { titles: DC });
  const get = n => people.find(p => p.name === n);
  assert(get('Jane Smith')?.role === 'Senior Project Manager', `a blank line between name and role is fine: ${JSON.stringify(people)}`);
  assert(get('Tom Brown')?.role === 'Head of Building Services' && get('Priya Shah')?.role === 'Design Engineer', 'stacked and comma forms');
  assert(get('Alex Green')?.role === 'Talent Acquisition Partner', 'the dash form reads, and orbit is decided later');
  assert(get('Sam Jones')?.role === 'Commissioning Engineer', 'a location line between name and role is stepped over');
  assert(people.filter(p => p.name === 'Jane Smith').length === 1, 'a repeated name is one person');
  assert(!people.some(p => /Our offices|London|We deliver/.test(p.name)), 'headings and prose never become people');
  const orbit = qualify(people, DC).map(p => p.name).sort();
  assert(JSON.stringify(orbit) === JSON.stringify(['Jane Smith', 'Priya Shah', 'Sam Jones', 'Tom Brown']), `the orbit keeps the specifiers and drops the recruiter: ${JSON.stringify(orbit)}`);
});

await check('schema.org Person markup is read outright, broken blocks are no evidence', async () => {
  const html = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","employee":[{"@type":"Person","name":"Ana Costa","jobTitle":"Mechanical Engineer"},{"@type":"Person","name":"Bob Lee"}]}</script>
    <script type="application/ld+json">{ not json</script>
    <script type="application/ld+json">[{"@type":["Person"],"name":"Cy Dune","jobTitle":"Project Director"}]</script>`;
  const p = jsonLdPeople(html);
  assert(p.length === 3 && p[0].role === 'Mechanical Engineer' && p[1].role === null && p[2].name === 'Cy Dune', `three people, one without a title: ${JSON.stringify(p)}`);
});

await check('people pages are picked by their words, team pages first, shallow only', async () => {
  const home = 'https://a.example/';
  const links = [
    { url: 'https://a.example/contact', text: 'Contact us' }, { url: 'https://a.example/about/leadership', text: 'Leadership' },
    { url: 'https://a.example/news/2026/01/team-day', text: 'Team day' }, { url: 'https://a.example/team', text: 'Meet the team' },
    { url: 'https://b.example/team', text: 'Team' }, { url: 'https://a.example/team.pdf', text: 'Team' },
  ];
  const picked = peoplePageLinks(links, home, { max: 3 });
  assert(picked[0] === 'https://a.example/about/leadership' || picked[0] === 'https://a.example/team', 'a team or leadership page leads');
  assert(picked.includes('https://a.example/team') && picked.includes('https://a.example/about/leadership') && picked.includes('https://a.example/contact'), 'team, leadership and contact are all read');
  assert(!picked.some(u => /news|b\.example|\.pdf/.test(u)), 'a news post, another host and a PDF are not');
});

console.log('\nThe whole read, against a local site:');

const page = (title, body) => `<html lang="en"><head><title>${title}</title></head><body><nav><a href="/">Home</a> <a href="/about/team">Meet the team</a> <a href="/contact">Contact</a></nav><main>${body}</main></body></html>`;
const routes = {
  '/robots.txt': ['text/plain', 'User-agent: *\nDisallow: /private/\n'],
  '/': ['text/html', page('Acme DC', '<h1>Acme Data Centres</h1><p>We design and build data centres across the UK for operators who need certainty.</p>')],
  '/about/team': ['text/html', page('Team', '<h1>Our team</h1><div><h3>Jane Smith</h3><p>Senior Project Manager</p></div><div><h3>Tom Brown</h3><p>Head of Building Services</p></div><div><h3>Alex Green</h3><p>Talent Acquisition Partner</p></div><div><h3>Sam Jones</h3><p>Finance Director</p></div>')],
  '/contact': ['text/html', page('Contact', '<h1>Contact us</h1><p>Acme House, 1 Mill Lane, Reading RG1 4AB</p><p>Priya Shah, Design Engineer</p>')],
};
const seen = [];
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  seen.push(url.pathname);
  const r = routes[url.pathname];
  if (!r) { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('<p>gone</p>'); }
  res.writeHead(200, { 'content-type': r[0] });
  res.end(r[1]);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `127.0.0.1:${server.address().port}`;
const local = (u, o) => politeFetch(u.replace('https://', 'http://'), o);

await check('the front page, the team page and the contact page yield the specifiers and nobody else', async () => {
  const r = await findPeopleOnSite(base, { titles: DC, fetchImpl: local, delayMs: 5 });
  assert(!r.unreachable && r.pages.length === 3, `three pages read: ${JSON.stringify(r.pages)}`);
  const names = r.people.map(p => p.name).sort();
  assert(JSON.stringify(names) === JSON.stringify(['Jane Smith', 'Priya Shah', 'Tom Brown']), `the orbit: ${JSON.stringify(r.people)}`);
  assert(r.people.find(p => p.name === 'Priya Shah').url.endsWith('/contact'), 'each person carries the page that named them');
  assert(r.found === 5 && r.unqualified.some(p => p.name === 'Alex Green') && r.unqualified.some(p => p.name === 'Sam Jones'), 'the recruiter and the finance director are found and left out, and listed');
  assert(seen.filter(p => p !== '/robots.txt').length <= 5, `a light read: ${seen.join(', ')}`);
  const gone = await findPeopleOnSite('127.0.0.1:1', { fetchImpl: (u, o) => local(u, { ...o, timeoutMs: 800 }) });
  assert(gone.unreachable === true && gone.people.length === 0, 'a dead site is unreachable, not an error');
});

server.close();

console.log('\nThe LinkedIn cadence (pure):');

await check('an account with nobody in orbit comes back in days, a served one rests a month, and the windows run out', async () => {
  const now = Date.parse('2026-09-11T09:00:00Z');
  const daysAgo = d => new Date(now - d * 86_400_000).toISOString();
  assert(peopleSearchDue({ now }), 'never searched is due');
  assert(!peopleSearchDue({ lastAt: daysAgo(3), now, retryDays: 5 }) && peopleSearchDue({ lastAt: daysAgo(6), now, retryDays: 5 }), 'nobody found: back after the retry days');
  assert(!peopleSearchDue({ lastAt: daysAgo(20), orbitFound: true, now }) && peopleSearchDue({ lastAt: daysAgo(31), orbitFound: true, now }), 'served: the thirty days stand');
  assert(!peopleSearchDue({ lastAt: daysAgo(6), priorSearches: 5, windows: 5, now, retryDays: 5 }), 'every window asked: the thirty days stand');
  assert(peopleSearchDue({ lastAt: daysAgo(6), priorSearches: 1, windows: 5, now, retryDays: 5 }), 'windows left: the retry days stand');
  assert(peopleSearchDue({ lastAt: 'garbage', now }), 'a junk date is treated as never searched');
  // The 20 August pass on the data centre accounts in John's screenshot: due
  // again on the 25th under the new rule, not the 19th of September.
  const until = peopleCoolingUntil({ lastAt: '2026-08-20T10:00:00Z', priorSearches: 1, windows: orbitWindows(DC), retryDays: 5 });
  assert(until === null, 'the 20 August pass is long since eligible again');
  assert(orbitWindows(DC) >= 4 && orbitWindows([]) >= 4 && orbitWindows(['a']) === 1, 'windows come from the campaign vocabulary or the shared titles');
  assert(peopleSearchLimit() >= 6 && PEOPLE_SERVED_DAYS === 30, 'the default batch is six accounts a cycle');
  assert(/team page on your company's own website/.test(sourceLine('website')), 'a person from a website is told so, straight, if they ask');
});

console.log(`\n=== Site people gate: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
