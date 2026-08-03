// The studio's pure parts. Post generation needs the database and a model, so
// it is exercised on the deploy; the note builder and its invite-length bound
// are provable here.
import { connectNote, cleanRole, companyDisplay, writePost, formatPost, hashtagsFor, renderPostText } from './liPosts.mjs';
import { parsePublished, isStaleStory, freshOnly, signalMaxAgeDays, postMaxAgeDays } from '../research/freshness.mjs';
import { companyFromHeadline, titleFitsCampaign, shapeEngager, analyseEngagers } from './postEngagers.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const FRESH_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const freshRead = rel => readFileSync(join(FRESH_ROOT, rel), 'utf8');
import { htmlToText, splitNewsletter, intelSenders } from './intelInbox.mjs';
import { linkedinSlug, canInvite, inviteDailyCap } from './liInvite.mjs';

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log(`  pass  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}: ${e.message}`); fail++; }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
async function checkAsync(name, fn) {
  try { await fn(); console.log(`  pass  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}: ${e.message}`); fail++; }
}

console.log('LinkedIn studio (the connect note):');

check('the note is personal, in voice, and under the 300 character invite limit', () => {
  const n = connectNote({ full_name: 'Darryn Power', role_title: 'Mechanical Engineering Manager' }, 'Pure Data Centres Group');
  assert(n.startsWith('Hi Darryn,'), `first name greeting: ${n}`);
  assert(n.includes("I'm the MD at PCT"), 'the note speaks as the MD');
  assert(n.includes('largest data centre builds'), 'the track record carries the weight, in its general form');
  assert(n.includes('Mechanical Engineering Manager') && n.includes('Pure Data Centres Group'), 'role and company are mentioned');
  assert(n.length <= 300, `must fit the LinkedIn invite limit, got ${n.length}`);
  assert(!/[—–!]/.test(n) && !/genuinely/i.test(n), 'house voice holds');
});

check('a headline role with company and credentials cleans to the role alone', () => {
  const messy = connectNote(
    { full_name: 'Darryn Power', role_title: 'Mechanical Engineering Manager at Pure Data Centres Group BEng, MSc, CEng, MCIBSE, IMechE.' },
    'PURE DATA CENTRES GROUP LIMITED');
  assert(messy.includes('your Mechanical Engineering Manager role at Pure Data Centres Group,'), messy);
  assert(!/MCIBSE|BEng|IMechE/.test(messy), 'credential letters are stripped');
  assert(!/LIMITED|CENTRES GROUP LIMITED/.test(messy), 'the registered suffix and shouting caps are gone');
  assert(messy.length <= 300, 'still fits the invite limit');
  assert(cleanRole('HVAC Lead Engineer BEng CEng') === 'HVAC Lead Engineer', 'space-separated credentials strip too');
  assert(cleanRole('Engineering Program Manager| Data Centres | Infrastructure') === 'Engineering Program Manager', 'pipe-separated headlines keep the role alone');
  assert(cleanRole('Mechanical Engineer – Data Centres') === 'Mechanical Engineer', 'spaced-dash segments drop');
  assert(companyDisplay('VANTAGE DATA CENTERS UK LIMITED') === 'Vantage Data Centers UK', 'registered caps read naturally');
  assert(companyDisplay('DC01 UK LIMITED') === 'DC01 UK', 'digit and short tokens keep their casing');
});

check('a missing role falls back plainly, and an absurdly long role still fits the limit', () => {
  const plain = connectNote({ full_name: 'Lee Neville', role_title: null }, 'Briggs & Forrester');
  assert(plain.includes('your work at Briggs & Forrester'), plain);
  const long = connectNote({ full_name: 'A B', role_title: 'x'.repeat(400) }, 'Some Company');
  assert(long.length <= 300, `fallback must fit the limit, got ${long.length}`);
});

console.log('\nThe intel inbox (splitting and guardrails, injected model):');

await (async () => {
  await checkAsync('newsletter HTML strips to readable text and the splitter returns clean items', async () => {
    const text = htmlToText('<style>a{}</style><p>Meta&nbsp;targets <b>14GW</b> of AI infrastructure&#39;s buildout</p><script>x()</script>');
    assert(text.includes('Meta targets 14GW') && !text.includes('<') && !text.includes('x()'), text);
    const fake = async () => JSON.stringify({ items: [
      { headline: 'Scotland proposes data centre pause', summary: 'Planning pressure on 24 projects.', operator: null },
      { headline: 'Meta targets 14GW', summary: 'A larger AI buildout.', operator: 'Meta' },
    ] });
    const items = await splitNewsletter('FW: newsletter', text, { callModel: fake });
    assert(items.length === 2 && items[1].operator === 'Meta', JSON.stringify(items));
  });

  await checkAsync('a commentary post exempts the story subject but flags any other operator', async () => {
    const fake = async () => 'Meta moving to 14GW says something about where cooling demand goes next. Worth watching how the supply chain responds.';
    const clean = await writePost({ headline: 'Meta targets 14GW', story: 'buildout', operator: 'Meta' }, { callModel: fake });
    assert(clean.flags.length === 0, `the story subject is news, not a flag: ${JSON.stringify(clean.flags)}`);
    const strayFake = async () => 'Meta moving to 14GW, and we supply Google on similar builds.';
    const stray = await writePost({ headline: 'Meta targets 14GW', story: 'buildout', operator: 'Meta' }, { callModel: strayFake });
    assert(stray.flags.length > 0, 'another operator must flag');
  });

  await checkAsync('the intel senders default to TEAM_EMAILS and an empty pair turns the inbox off', async () => {
    delete process.env.INTEL_SENDERS;
    delete process.env.TEAM_EMAILS;
    assert(intelSenders().length === 0, 'no lists at all means off');
    process.env.TEAM_EMAILS = 'Team@Example.com';
    assert(intelSenders().includes('team@example.com'), 'the team list is the default');
    process.env.INTEL_SENDERS = 'James@PCTflow.com';
    assert(intelSenders().length === 1 && intelSenders()[0] === 'james@pctflow.com', 'a specific list overrides, lower-cased');
    delete process.env.INTEL_SENDERS;
    delete process.env.TEAM_EMAILS;
  });
})();

console.log('\nThe sanctioned invite (eligibility and the profile slug, pure):');

check('only an eligible decision maker can be invited, once', () => {
  const base = { suppressed: false, li_invited_at: null, linkedin_url: 'https://www.linkedin.com/in/darryn-power-123/' };
  assert(canInvite(base).ok, 'a clean contact is eligible');
  assert(!canInvite({ ...base, suppressed: true }).ok, 'suppressed never invites');
  assert(!canInvite({ ...base, li_invited_at: '2026-07-13' }).ok, 'never twice');
  assert(!canInvite({ ...base, linkedin_url: 'https://example.com/nope' }).ok, 'needs a real profile URL');
  assert(!canInvite(null).ok, 'a missing contact refuses');
});

check('the profile slug parses from the usual URL shapes', () => {
  assert(linkedinSlug('https://www.linkedin.com/in/darryn-power-123/') === 'darryn-power-123');
  assert(linkedinSlug('http://linkedin.com/in/lee%20neville?trk=x') === 'lee neville');
  assert(linkedinSlug('https://www.linkedin.com/company/pct/') === null, 'company pages are not people');
  assert(inviteDailyCap() >= 1, 'the invite cap is always at least one');
});

console.log('\nPost shape, story link and hashtags (pure):');

check('a solid block becomes a hook line then short paragraphs', () => {
  const block = 'Slough is getting another 40MW hall. That is a lot of chilled water to move. Control valve selection decides how well it moves. The ranges we supply are trusted across some of the largest builds. What are others seeing on spec?';
  const shaped = formatPost(block);
  const paras = shaped.split('\n\n');
  assert(paras[0] === 'Slough is getting another 40MW hall.', 'the first sentence stands alone as the hook');
  assert(paras.every(p => (p.match(/[.?]/g) || []).length <= 2), 'no paragraph carries more than two sentences');
  assert(formatPost(shaped) === shaped, 'an already shaped post passes through unchanged');
  assert(formatPost('One line only.') === 'One line only.', 'a single sentence stays a single line');
});

check('hashtags are curated, never invented: the base pair, cooling and UK when earned', () => {
  const base = hashtagsFor({ title: 'New planning approval', body: 'x', geoScope: 'expansion_watch' });
  assert(JSON.stringify(base) === JSON.stringify(['#datacentres', '#flowcontrol', '#valves']), 'the standing set');
  const cool = hashtagsFor({ title: 'Liquid cooling retrofit', body: 'x', geoScope: 'uk_project' });
  assert(cool.includes('#cooling') && cool.includes('#ukconstruction'), 'cooling and UK tags when the story earns them');
  assert(cool.every(t => /^#[a-z]+$/.test(t)), 'every tag is a plain lowercase hashtag');
});

check('the full post text puts the story link then the hashtags at the bottom', () => {
  const text = renderPostText({ body: 'A point.\n\nA second point.', sourceUrl: 'https://news.example/story', hashtags: ['#datacentres', '#valves'] });
  const parts = text.split('\n\n');
  assert(parts[parts.length - 1] === '#datacentres #valves', 'hashtags close the post');
  assert(parts[parts.length - 2] === 'Story: https://news.example/story', 'the story link sits above them');
  assert(!/[—–]/.test(text) && !/!/.test(text), 'voice rules hold in the assembled text');
  const noLink = renderPostText({ body: 'A point.', sourceUrl: null, hashtags: ['#valves'] });
  assert(!/Story:/.test(noLink), 'no link line is invented when the signal has no url');
});

console.log('\nStory freshness, the three-year-old post that started it:');

await check('a story is stale on evidence only, never on a guess', async () => {
  const now = Date.parse('2026-07-30T12:00:00Z');
  assert(isStaleStory('2023-06-14', { now }), 'a three-year-old printed date is stale');
  assert(!isStaleStory('2026-07-01', { now }), 'a recent date is fresh');
  assert(!isStaleStory(null, { now }) && !isStaleStory('', { now }), 'no date is unknown, not stale');
  assert(!isStaleStory('not a date', { now }), 'junk is unknown, not stale, and never an error');
  assert(parsePublished('Tue, 14 May 2024 09:00:00 GMT') !== null, 'RFC dates parse');
  assert(!isStaleStory('2026-03-01', { now, maxAgeDays: 200 }), 'the window is configurable');
  // Two windows, per John: signals may be old because builds run for years, a
  // post must be current because a feed is a claim about now. The Feb 2025
  // story that reached LinkedIn sits exactly between them: a valid signal, an
  // invalid post.
  assert(signalMaxAgeDays() === 730, 'signals default to two years');
  assert(postMaxAgeDays() === 30, 'posts default to thirty days');
  const feb25 = '2025-02-15';
  assert(!isStaleStory(feb25, { now, maxAgeDays: signalMaxAgeDays() }), 'the Feb 2025 story is still a valid signal');
  assert(isStaleStory(feb25, { now, maxAgeDays: postMaxAgeDays() }), 'and is refused as a post');
});

await check('the filter keeps undated stories and drops evidenced-stale ones', async () => {
  const now = Date.parse('2026-07-30T12:00:00Z');
  const rows = [
    { t: 'fresh', published: '2026-07-20' },
    { t: 'ancient', published: '2023-05-01' },
    { t: 'undated', published: null },
  ];
  const kept = freshOnly(rows, r => r.published, { now }).map(r => r.t);
  assert(JSON.stringify(kept) === JSON.stringify(['fresh', 'undated']),
    'the three-year-old story is the only one dropped');
});

await check('every consumer reads the published date (static)', async () => {
  assert(/postMaxAgeDays/.test(freshRead('src/studio/liPosts.mjs')), 'the studio filters on the POST window, not the signal one');
  assert(/freshOnly/.test(freshRead('src/outbound/grounding.mjs')), 'the cold-open signal pick filters');
  assert(/isStaleStory/.test(freshRead('src/research/newsResearch.mjs')), 'the sweep drops evidenced-stale stories');
  assert(/publishedAt/.test(freshRead('src/studio/liPosts.mjs')), 'the story date travels with the post');
  assert(/storyDate/.test(freshRead('web/src/Studio.jsx')), 'and the Studio shows it, or says it is not stated');
});

console.log('\nPost engagement, the likes made useful:');

await check('a headline yields its company, and never by guesswork', async () => {
  assert(companyFromHeadline('Project Manager (Data Centres) at Ark Data Centres | DC builds') === 'Ark Data Centres',
    'the company follows " at " and stops at the first separator');
  assert(companyFromHeadline('Director at Larsen & Toubro') === 'Larsen & Toubro', 'an ampersand company survives');
  assert(companyFromHeadline('Head of Cooling, Battersea Power Station redevelopment') === null,
    'Battersea does not split on its inner at; no " at ", no company');
  assert(companyFromHeadline('') === null && companyFromHeadline(null) === null, 'empty is null');
});

await check('orbit fit uses the campaign vocabulary with the shared exclusions', async () => {
  assert(titleFitsCampaign('Project Manager (Data Centres)', 'marwin_dc'), 'the exact live case fits the DC orbit');
  assert(titleFitsCampaign('Validation Engineer', 'pharma_steriflow'), 'validation fits the pharma orbit');
  assert(!titleFitsCampaign('Marketing Director', 'marwin_dc'), 'marketing does not specify valves');
  assert(!titleFitsCampaign('Project management student', 'marwin_dc'), 'the shared exclusions refuse first');
  assert(!titleFitsCampaign('Project Manager', 'no_such_campaign'), 'an unknown campaign fits nothing');
});

await check('a reaction item shapes defensively, nested or flat, and no name is dropped honestly', async () => {
  const nested = shapeEngager({ author: { name: 'Richard Stern', headline: 'Project Manager (Data Centres) at Ark Data Centres', public_identifier: 'richard-stern' }, value: 'LIKE' });
  assert(nested.name === 'Richard Stern' && nested.role === 'Project Manager (Data Centres)', 'nested author parses');
  assert(nested.company === 'Ark Data Centres' && nested.profileUrl?.includes('/in/richard-stern'), 'company and profile derive');
  const flat = shapeEngager({ first_name: 'Dena', last_name: 'Ali', headline: 'Design Director at Ark Data Centres' });
  assert(flat.name === 'Dena Ali', 'flat first and last names join');
  assert(shapeEngager({ value: 'LIKE' }) === null, 'an item with no name is dropped, never invented');
});

await check('the analysis ranks orbit-fit matched engagers first and counts what it could not read', async () => {
  const register = [{ id: 2, name: 'ARK DATA CENTRES LIMITED' }];
  const { engagers, unparsed } = analyseEngagers([
    { author: { name: 'Nobody Relevant', headline: 'Poet' } },
    { author: { name: 'Richard Stern', headline: 'Project Manager (Data Centres) at Ark Data Centres' } },
    { value: 'LIKE' },
  ], { register, campaign: 'marwin_dc' });
  assert(unparsed === 1, 'the nameless reaction is counted, not shown');
  assert(engagers[0].name === 'Richard Stern', 'the strongest prospect leads');
  assert(engagers[0].orbitFit && engagers[0].matchedCompanyId === 2, 'orbit fit and the register match both land');
  assert(engagers[1].orbitFit === false && engagers[1].matchedCompanyId === null, 'the poet is listed honestly, unbadged');
});

await check('the lane stays read-mostly and the wiring holds (static)', async () => {
  const client = freshRead('src/research/unipile.mjs');
  assert(/listPostReactions: \{ method: 'GET'/.test(client), 'reactions are a GET, not a third write');
  const posts = freshRead('src/studio/liPosts.mjs');
  assert(/linkedinPostId/.test(posts), 'publishing stores the post id so engagement can be read back');
  const server = freshRead('src/server.mjs');
  assert(/engagers\/contact/.test(server) && /post_engagement/.test(server), 'the add-as-contact action marks its source');
  assert(/ON CONFLICT \(linkedin_url\) DO NOTHING/.test(server), 'and a known profile is never duplicated');
  const dg = freshRead('src/outbound/draft.mjs') + freshRead('src/outbound/grounding.mjs');
  assert(!/engag|liked/i.test(dg), 'engagement never enters draft grounding: targeting, not wording');
});

console.log(`\n=== Studio gate: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
