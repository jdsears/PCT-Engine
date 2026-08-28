// The studio's pure parts. Post generation needs the database and a model, so
// it is exercised on the deploy; the note builder and its invite-length bound
// are provable here.
import { connectNote, cleanRole, companyDisplay, writePost, formatPost, hashtagsFor, renderPostText, storyComment, postSystem } from './liPosts.mjs';
import { accountForCampaign } from '../research/unipile.mjs';
import { parsePublished, isStaleStory, freshOnly, signalMaxAgeDays, postMaxAgeDays } from '../research/freshness.mjs';
import { companyFromHeadline, titleFitsCampaign, shapeEngager, analyseEngagers, sweepDue } from './postEngagers.mjs';
import { londonClock, slotFor, slotDue, POST_DAYS, SLOT_WINDOW_MINUTES } from './autopost.mjs';
import { dripWindowOpen, gapClear, emailTimingClear, dripDailyCap, DRIP_MIN_GAP_MINUTES } from './inviteDrip.mjs';
import { networkDistance, isConnected, checkDue } from './liConnection.mjs';
import { dmFlags, dmDue, dmSystem, DM_MAX_CHARS } from './liDm.mjs';
import { breakupHeld } from '../outbound/followups.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const FRESH_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const freshRead = rel => readFileSync(join(FRESH_ROOT, rel), 'utf8');
import { htmlToText, splitNewsletter, intelSenders } from './intelInbox.mjs';
import { linkedinSlug, canInvite, inviteDailyCap, inviteRefusal } from './liInvite.mjs';

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

check('an invitation already pending on LinkedIn is recorded truth, not a repeating error', () => {
  // The live refusal, frozen from James's screen: a raw 422 on every click
  // because the invite had been sent by hand outside the engine's books.
  const live = new Error('Unipile 422 on POST /api/v1/users/invite: {"status":422,"type":"errors/already_invited_recently","title":"Should delay new invitation to this recipient","detail":"An invitation has already been sent recently to this recipient. Please try again later."}');
  live.status = 422;
  const r = inviteRefusal(live);
  assert(r?.alreadyInvited === true, 'the refusal is recognised');
  assert(/already pending/.test(r.reason) && /queue will not offer them again/.test(r.reason), 'the reason reads calmly and says what happens next');
  const other = new Error('Unipile 422 on POST /api/v1/users/invite: {"type":"errors/limit_exceeded"}');
  other.status = 422;
  assert(inviteRefusal(other) === null, 'other 422s are not swallowed into the same story');
  const server = new Error('Unipile 500 on POST /api/v1/users/invite: upstream');
  server.status = 500;
  assert(inviteRefusal(server) === null && inviteRefusal(null) === null, 'nothing else matches');
  const src = readFileSync(join(FRESH_ROOT, 'src/server.mjs'), 'utf8');
  assert(/inviteRefusal\(e\)/.test(src), 'the send route consults the translation');
  assert(/recorded from LinkedIn: an invitation was already pending/.test(src), 'and records the truth so the queue moves on');
  assert(/import \{[^}]*inviteRefusal[^}]*\} from '\.\/studio\/liInvite\.mjs'/.test(src), 'the server imports what it uses');
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

check('the post carries hashtags only; the story link is the first comment', () => {
  // John's call, 24 August 2026, after James's best-performing post: an
  // external link in the body is widely believed to cost reach, so the link
  // moved to the post's own first comment, published in the same click.
  const text = renderPostText({ body: 'A point.\n\nA second point.', hashtags: ['#datacentres', '#valves'] });
  const parts = text.split('\n\n');
  assert(parts[parts.length - 1] === '#datacentres #valves', 'hashtags close the post');
  assert(!/Story:/.test(text) && !/https?:/.test(text), 'no link ever sits in the post body');
  assert(!/[—–]/.test(text) && !/!/.test(text), 'voice rules hold in the assembled text');
  assert(storyComment('https://news.example/story') === 'Story: https://news.example/story', 'the comment is the link line');
  assert(storyComment(null) === null, 'no comment is invented when the signal has no url');
  const src = freshRead('src/studio/liPosts.mjs');
  assert(/if \(comment && linkedinPostId\)/.test(src) && /ROUTES\.commentPost/.test(src),
    'the comment posts only after the post exists, through the same account');
  assert(/catch \{ commentLink = /.test(src),
    'a failed comment never fails a publish; the link goes back for a human to paste');
  assert(/\} else if \(comment\) \{/.test(src),
    'a post published without an id also hands its link back, never loses it');
  const uni = freshRead('src/research/unipile.mjs');
  assert(/commentPost/.test(uni) && /OUR OWN just-created post/.test(uni),
    'the third write is declared with its sanction: same click, own post only');
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

console.log('\nThe post briefing follows the campaign:');

// The data centre briefing as it was before campaigns reached the Studio,
// frozen byte for byte: making the template campaign-aware must not move a
// word of the calibrated voice.
const DC_POST_SYSTEM =
  "You draft a short LinkedIn post for a UK flow control specialist commenting on data centre industry news. The post appears under his own name, so it reads like a practitioner's take, not marketing. " +
  "GROUNDING RULE: you may reference only the news story provided. Do not invent figures, projects or details beyond it. You may add one general line that the Marwin and Steriflow control valve ranges his company supplies are trusted across some of the largest data centre builds. " +
  "CONFIDENTIALITY RULE, absolute: never state or imply that any named company is a customer. The story's subject may be discussed as news; it must never read as a client reference. No customer names, ever. " +
  "VOICE: plain British English, calm, first person, three to six sentences. A practitioner's observation about what the story means for data centre cooling and flow control, then a light closing thought or question to invite comment. No em dashes or en dashes, never the word genuinely, no exclamation marks, no hashtags, no emojis, no links. " +
  "SHAPE: the first sentence stands alone as its own opening line and must carry the story's hook, since the feed folds everything after it. Then short paragraphs of one or two sentences separated by blank lines, never one solid block. " +
  "Return the post text only, no preamble and no quotation marks around it.";

check('the data centre post briefing is unchanged, byte for byte', () => {
  assert(postSystem('marwin_dc') === DC_POST_SYSTEM, 'the assembled briefing must equal the original exactly');
});

check('a pharma signal briefs as pharma commentary, never as data centre news', () => {
  const s = postSystem('pharma_steriflow');
  assert(/pharmaceutical and biotech manufacturing news/.test(s), 'the news domain is pharma');
  assert(/Steriflow sanitary valve range/.test(s), 'the track record line is the campaign\'s own');
  assert(/sterile and hygienic process control/.test(s), 'the angle is process control');
  assert(!/data centre/i.test(s), 'no data centre briefing survives in the pharma prompt');
  assert(/never state or imply that any named company is a customer/.test(s), 'confidentiality is shared, not per campaign');
});

await check('five angles, one calibrated voice: the feed stops repeating itself', async () => {
  const { POST_ANGLES } = await import('./liPosts.mjs');
  assert(POST_ANGLES.length === 5 && POST_ANGLES[0] === 'observation', 'observation remains the default and the first');
  const texts = POST_ANGLES.map(a => postSystem('marwin_dc', a));
  assert(new Set(texts).size === 5, 'every angle is a genuinely different briefing');
  for (const t of texts) {
    assert(/never state or imply that any named company is a customer/.test(t), 'confidentiality is identical in every angle');
    assert(/no hashtags, no emojis, no links/.test(t), 'the voice constants hold in every angle');
    assert(/first sentence stands alone/.test(t), 'the shape holds in every angle');
  }
  for (const a of ['question', 'detail', 'spec']) {
    assert(/Do not mention the valve ranges/.test(postSystem('marwin_dc', a)),
      `${a} posts carry no supplier line; a feed that always ends on the ranges reads as marketing`);
  }
  assert(/sharpest question/.test(postSystem('marwin_dc', 'question')), 'the question angle asks');
  assert(/most concrete figure or fact the story itself states/.test(postSystem('marwin_dc', 'detail')), 'the detail angle leads with the printed number');
  assert(/Never invent, convert or extrapolate/.test(postSystem('marwin_dc', 'detail')), 'and never invents one');
  assert(/where the sector is heading/.test(postSystem('marwin_dc', 'trend')), 'the trend angle reads the direction');
  assert(/people who will write the specification/.test(postSystem('marwin_dc', 'spec')), 'the spec angle writes to the specifiers');
  const src = readFileSync(join(FRESH_ROOT, 'src/studio/liPosts.mjs'), 'utf8');
  assert(/POST_ANGLES\[s\.id % POST_ANGLES\.length\]/.test(src), 'the signal id picks the angle, deterministic per post, varied across the feed');
});

await check('writePost briefs by the campaign it is given', async () => {
  let seenSystem = '';
  const capture = async (system) => { seenSystem = system; return 'A calm line about the story.\n\nA closing thought.'; };
  await writePost({ headline: 'Facility expands', story: 'x', operator: null, campaign: 'pharma_steriflow' }, { callModel: capture });
  assert(/pharmaceutical and biotech/.test(seenSystem), 'the pharma briefing was used');
  await writePost({ headline: 'Campus approved', story: 'x', operator: null }, { callModel: capture });
  assert(/data centre industry news/.test(seenSystem), 'the default stays data centre');
});

check('hashtags follow the campaign, with the shared earned tags on top', () => {
  const dc = hashtagsFor({ title: 'Cooling plant approved', geoScope: 'uk_project' });
  assert(dc.join(' ') === '#datacentres #flowcontrol #cooling #ukconstruction #valves', `dc tags unchanged: ${dc.join(' ')}`);
  const ph = hashtagsFor({ title: 'Sterile filling line', geoScope: 'uk_project', campaign: 'pharma_steriflow' });
  assert(ph[0] === '#pharmamanufacturing' && ph[1] === '#processcontrol', 'the pharma pair leads');
  assert(ph.includes('#ukconstruction') && ph.includes('#valves'), 'the earned and closing tags are shared');
  assert(!ph.includes('#datacentres'), 'no data centre tag on a pharma post');
});

await check('the drafting and publishing paths carry the signal campaign (static)', async () => {
  const src = readFileSync(join(FRESH_ROOT, 'src/studio/liPosts.mjs'), 'utf8');
  assert(/const campaign = s\.campaign \|\| 'marwin_dc'/.test(src), 'generation briefs each signal by its own campaign');
  assert(/grounding\?\.campaign \|\| p\.signal_campaign \|\| 'marwin_dc'/.test(src), 'publishing resolves the campaign the same way');
  const server = readFileSync(join(FRESH_ROOT, 'src/server.mjs'), 'utf8');
  assert(/p\.grounding\?\.campaign \|\| p\.signal_campaign \|\| 'marwin_dc'/.test(server), 'the posts route resolves it too');
});

console.log('\nTwo LinkedIn accounts, routed by campaign:');

await check('the campaign map decides the account, with the shared account as the floor', async () => {
  const saved = { ...process.env };
  try {
    process.env.UNIPILE_ACCOUNT_ID = 'james-account';
    process.env.UNIPILE_CAMPAIGN_ACCOUNTS = '{"pharma_steriflow":"andy-account"}';
    assert(accountForCampaign('pharma_steriflow') === 'andy-account', 'a mapped campaign uses its own account');
    assert(accountForCampaign('marwin_dc') === 'james-account', 'an unmapped campaign falls back to the shared account');
    process.env.UNIPILE_CAMPAIGN_ACCOUNTS = 'not json';
    assert(accountForCampaign('pharma_steriflow') === 'james-account', 'a malformed map falls back rather than breaking the lane');
    delete process.env.UNIPILE_CAMPAIGN_ACCOUNTS;
    assert(accountForCampaign('pharma_steriflow') === 'james-account', 'no map at all behaves as before');
  } finally {
    for (const k of ['UNIPILE_ACCOUNT_ID', 'UNIPILE_CAMPAIGN_ACCOUNTS']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
});

await check('the data centre connect note is unchanged, byte for byte', async () => {
  const note = connectNote({ full_name: 'Priya Shah', role_title: 'Project Manager' }, 'ARK DATA CENTRES LIMITED');
  assert(note === "Hi Priya, I'm the MD at PCT, supplier of the Marwin and Steriflow valve ranges used across some of the largest data centre builds. Given your Project Manager role at Ark Data Centres, I thought it worth connecting.",
    `the frozen note moved: ${note}`);
});

await check('a pharma invite note is Andy\'s: sales director, Steriflow, never the MD data centre line', async () => {
  const note = connectNote({ full_name: 'Priya Shah', role_title: 'Process Engineer' }, 'Example Biologics', 'pharma_steriflow');
  assert(/Steriflow sanitary valve range/.test(note), 'the range is the campaign\'s own');
  assert(/sales director at PCT/.test(note), 'the sender\'s real title, given by John');
  assert(!/MD at PCT/.test(note) && !/data centre/.test(note), 'no borrowed title and no borrowed sector');
  assert(note.length <= 300, 'under the invite limit');
  const long = connectNote({ full_name: 'Priya Shah', role_title: 'Director of Sterile Manufacturing Science and Technology Operations' },
    'An Extremely Long Registered Company Name For The Limit Limited', 'pharma_steriflow');
  assert(long.length <= 300, 'the short fallback keeps the limit');
});

await check('publishing, invites and engagement reads all route by campaign (static)', async () => {
  const posts = readFileSync(join(FRESH_ROOT, 'src/studio/liPosts.mjs'), 'utf8');
  assert(/accountForCampaign\(campaign\)/.test(posts), 'publishPost asks the map');
  assert(/postsPublishedToday\(accountId\)/.test(posts), 'the post cap is the account\'s own');
  const invite = readFileSync(join(FRESH_ROOT, 'src/studio/liInvite.mjs'), 'utf8');
  assert(/accountId = process\.env\.UNIPILE_ACCOUNT_ID/.test(invite) && /no LinkedIn account is configured/.test(invite), 'the invite takes an account and refuses plainly without one');
  assert(/AND account_id = \$1/.test(invite), 'the invite cap counts per account when the ledger can say');
  const engagers = readFileSync(join(FRESH_ROOT, 'src/studio/postEngagers.mjs'), 'utf8');
  assert(/accountForCampaign\(campaign\)/.test(engagers), 'engagement reads through the posting account');
  const server = readFileSync(join(FRESH_ROOT, 'src/server.mjs'), 'utf8');
  assert(/import \{[^}]*accountForCampaign[^}]*\} from '\.\/research\/unipile\.mjs'/.test(server), 'the server imports what it uses');
  assert(/getCampaign\(String\(\(req\.body \|\| \{\}\)\.campaign \|\| ''\)\)/.test(server), 'a requested campaign is validated through the registry, never free text');
  assert(/memberships \|\| \[\]\)\.filter\(id => getCampaign\(id\)\)/.test(server), 'a stray membership value can never take the connect queue down');
  const mig = readFileSync(join(FRESH_ROOT, 'src/migrations/028_unipile_accounts.sql'), 'utf8');
  assert(/ADD COLUMN IF NOT EXISTS account_id/.test(mig) && !/INSERT INTO/i.test(mig), 'the ledger column is idempotent and data free');
});

check('the studio splits by campaign, posts and connects alike', () => {
  // John's ask, 18 August 2026: James works the data centre queue and Andy
  // the pharma one, each behind the same switcher every other page uses.
  // The server filters must derive a row's campaign exactly as the mapping
  // does, and filter before the limit, so a narrow view is never starved by
  // the other campaign's fifty best.
  const srv = freshRead('src/server.mjs');
  assert(/COALESCE\(lp\.grounding->>'campaign', s\.campaign, 'marwin_dc'\) = \$/.test(srv),
    'the posts filter derives grounding first, signal second, default last, the same as the mapping');
  assert(/CASE WHEN array_length\(m\.memberships, 1\) = 1 THEN m\.memberships\[1\] ELSE 'marwin_dc' END/.test(srv),
    'the connects filter derives one registered membership or the default, the same as the mapping');
  const studio = freshRead('web/src/Studio.jsx');
  assert(/withCampaign\('\/api\/studio\/connects', campaign\)/.test(studio) && /withCampaign\(`\/api\/studio\/posts\?status=\$\{t\}`, campaign\)/.test(studio),
    'both studio fetches carry the switcher');
  assert(/\[campaign\]/.test(studio), 'a switch reloads the queue');
  const appShell = freshRead('web/src/App.jsx');
  assert(/<Studio campaign=\{campaign\} \/>/.test(appShell), 'the shell hands the studio the switcher');
});

console.log('\nThe autopilot: approval moves ahead, the slot releases (pure):');

check('slots fire Tuesday to Thursday mornings on the London wall clock, winter and summer', () => {
  // 25 August 2026 is a Tuesday; 07:41 UTC is 08:41 BST, one minute past the
  // data centre slot. 13 January 2026 is a Tuesday in GMT.
  assert(JSON.stringify(POST_DAYS) === JSON.stringify(['Tue', 'Wed', 'Thu']), 'the posting days are John\'s three');
  const bst = new Date('2026-08-25T07:41:00Z');
  assert(londonClock(bst).day === 'Tue' && londonClock(bst).minutes === 8 * 60 + 41, 'the London clock reads BST');
  assert(slotDue({ campaign: 'marwin_dc', now: bst }).due, 'the data centre slot is open at 08:41 BST');
  assert(!slotDue({ campaign: 'pharma_steriflow', now: bst }).due, 'the pharma slot is later, so the accounts never fire together');
  assert(slotDue({ campaign: 'pharma_steriflow', now: new Date('2026-08-25T08:11:00Z') }).due, 'and opens at its own time');
  assert(slotDue({ campaign: 'marwin_dc', now: new Date('2026-01-13T08:41:00Z') }).due, 'the same wall time fires in GMT');
  assert(!slotDue({ campaign: 'marwin_dc', now: new Date('2026-08-25T07:39:00Z') }).due, 'never before the slot');
  assert(!slotDue({ campaign: 'marwin_dc', now: new Date('2026-08-24T07:41:00Z') }).due, 'Monday never posts');
  assert(!slotDue({ campaign: 'marwin_dc', now: new Date('2026-08-28T07:41:00Z') }).due, 'Friday never posts');
  const lapsed = slotDue({ campaign: 'marwin_dc', now: new Date('2026-08-25T11:00:00Z') });
  assert(!lapsed.due && /lapsed/.test(lapsed.reason) && SLOT_WINDOW_MINUTES === 180,
    'a slot missed for three hours lapses rather than posting at odd hours');
  assert(!slotDue({ campaign: 'marwin_dc', now: bst, postedToday: true }).due,
    'a lane that already posted today stands down, hand-post or slot alike');
  assert(!slotDue({ campaign: 'richards_reactivation', now: bst }).due, 'a lane with no slot never auto-posts');
});

check('the slot map is env-overridable and a malformed value falls back to the defaults', () => {
  const saved = process.env.STUDIO_POST_SLOTS;
  try {
    assert(slotFor('marwin_dc') === 8 * 60 + 40 && slotFor('pharma_steriflow') === 9 * 60 + 10, 'the standing slots');
    process.env.STUDIO_POST_SLOTS = '{"marwin_dc":"10:05"}';
    assert(slotFor('marwin_dc') === 10 * 60 + 5, 'an override reads');
    assert(slotFor('pharma_steriflow') === null, 'a lane missing from the override has no slot, the safe direction');
    process.env.STUDIO_POST_SLOTS = 'not json';
    assert(slotFor('marwin_dc') === 8 * 60 + 40, 'malformed config falls back rather than silencing the lane');
  } finally {
    if (saved === undefined) delete process.env.STUDIO_POST_SLOTS; else process.env.STUDIO_POST_SLOTS = saved;
  }
});

check('engagement sweeps twice in a post\'s life and never after fourteen days', () => {
  const posted = '2026-08-20T08:00:00Z';
  const at = d => Date.parse(posted) + d * 86_400_000;
  assert(!sweepDue({ postedAt: posted, sweeps: [], now: at(1) }), 'not on day one; the early reactions are still landing');
  assert(sweepDue({ postedAt: posted, sweeps: [], now: at(2.1) }), 'the first sweep comes after two days');
  assert(!sweepDue({ postedAt: posted, sweeps: ['x'], now: at(4) }), 'once swept, it waits for day six');
  assert(sweepDue({ postedAt: posted, sweeps: ['x'], now: at(6.1) }), 'the second sweep reads the tail');
  assert(!sweepDue({ postedAt: posted, sweeps: ['x', 'y'], now: at(10) }), 'twice is the whole life');
  assert(!sweepDue({ postedAt: posted, sweeps: [], now: at(15) }), 'a finished post is never read again; every read spends the cap');
  assert(!sweepDue({ postedAt: 'garbage', sweeps: [], now: at(3) }), 'a junk date never sweeps and never throws');
});

check('approval is the sanction and the wiring holds it (static)', () => {
  const posts = freshRead('src/studio/liPosts.mjs');
  assert(/auto \? p\.status !== 'approved'/.test(posts), 'the scheduler may release only what a person approved');
  assert(/'postedVia', \$4::text/.test(posts), 'how a post published, click or schedule, is recorded');
  const ap = freshRead('src/studio/autopost.mjs');
  assert(/publishPost\(id, \{ auto: true \}\)/.test(ap), 'the slot releases through the same code the button runs, caps and flags included');
  assert(/ORDER BY lp\.updated_at ASC LIMIT 1/.test(ap), 'oldest approved first, the order a person expects');
  assert(/jsonb_array_length\(lp\.grounding->'flags'\), 0\) = 0/.test(ap), 'a flagged post never queues for a slot');
  assert(/AT TIME ZONE 'Europe\/London'/.test(ap), 'posted-today means London today, both sides of the clock change');
  assert(/instanceof AccountUnhealthy/.test(ap), 'an account-health error is surfaced, never swallowed');
  const srv = freshRead('src/server.mjs');
  assert(/=== 'on'\) await studioAutopilotOnce\('schedule'\);/.test(srv), 'the tick runs the autopilot only when the switch is on');
  assert(/await kvSet\('studio_autopilot_enabled', 'off'\)/.test(srv), 'an account-health error stands the autopilot down itself');
  assert(/LinkedIn account health stopped the studio autopilot/.test(srv), 'and tells the team why');
  assert(/only an open draft can be approved/.test(srv), 'approval takes open drafts only');
  assert(/edit it clean before approving/.test(srv), 'a flagged draft cannot be approved');
  assert(/status IN \('draft', 'approved'\)/.test(srv), 'reject and mark-posted accept queued posts too');
  const mig = freshRead('src/migrations/032_studio_autopilot.sql');
  assert(/status IN \('draft', 'approved', 'posted'\)/.test(mig), 'the one-open-post-per-signal index treats approved as open');
  const ui = freshRead('web/src/Studio.jsx');
  assert(/Nothing unapproved ever posts/.test(ui), 'the studio banner states the sanction plainly');
  assert(/Approve for the queue/.test(ui) && /Back to drafts/.test(ui), 'the approve and unapprove verbs are on the cards');
  const health = freshRead('web/src/Health.jsx');
  assert(/studio-autopilot/.test(health) && /Studio autopilot: on/.test(health), 'the Health page carries the switch');
});

check('interest is gathered and sorted automatically, acted on by a person (static)', () => {
  const pe = freshRead('src/studio/postEngagers.mjs');
  assert(/ON CONFLICT \(li_post_id, person_key\) DO UPDATE/.test(pe), 'a person lands once per post, refreshed never duplicated');
  assert(/status = EXCLUDED/.test(pe) === false, 'a refresh never touches a decision someone has made');
  assert(/instanceof CapReached/.test(pe) && /instanceof AccountUnhealthy/.test(pe), 'the sweep stops cleanly on the cap and surfaces account health');
  const srv = freshRead('src/server.mjs');
  assert(/d\.status <> 'new'/.test(srv), 'a person decided anywhere in the campaign never queues again');
  assert(/api\/studio\/interest\/:id\/(contact|propose|dismiss)/.test(srv), 'the three verbs are all human endpoints');
  const mig = freshRead('src/migrations/032_studio_autopilot.sql');
  assert(/CREATE TABLE IF NOT EXISTS post_engagers/.test(mig), 'the interest table ships in the migration');
  // The standing rule survives the autopilot: engagement informs targeting,
  // never wording. Nothing in the draft or grounding layers may read it.
  const dg = freshRead('src/outbound/draft.mjs') + freshRead('src/outbound/grounding.mjs');
  assert(!/post_engagers|engag|liked/i.test(dg), 'engagement never enters draft grounding or wording');
});

check('the propose-company verb reviews, never registers (static)', () => {
  const srv = freshRead('src/server.mjs');
  const fn = srv.slice(srv.indexOf('async function proposeEngagerCompany'), srv.indexOf("app.post('/api/studio/engagers/propose"));
  assert(fn.length > 100, 'the shared propose helper exists');
  assert(/INSERT INTO party_reviews/.test(fn), 'the proposal lands in the review queue');
  assert(/ON CONFLICT \(name_norm, campaign\) DO NOTHING/.test(fn), 'a name already reviewed is never re-proposed');
  assert(!/INSERT INTO companies/i.test(fn), 'the verb never creates an account itself; confirming at review does that');
  assert(/already on the register as/.test(fn), 'a name the matcher can place is redirected to add-as-contact');
  assert(/'post_engagement', evidence/.test(fn), 'provenance and evidence travel with the proposal');
  assert(/hasColumn\('party_reviews', 'source'\)/.test(fn), 'the insert asks the schema first, so deploy order cannot break it');
  const rq = freshRead('web/src/ReviewQueue.jsx');
  assert(/From post engagement/.test(rq), 'the reviewer sees who engaged before deciding');
});

console.log('\nThe invite drip: approval ahead, released like a person (pure):');

check('the drip works weekday working hours on the London wall clock', () => {
  assert(dripWindowOpen(new Date('2026-08-24T09:00:00Z')), 'Monday 10:00 BST is a working hour');
  assert(!dripWindowOpen(new Date('2026-08-24T08:00:00Z')), 'Monday 09:00 BST is before the window');
  assert(!dripWindowOpen(new Date('2026-08-24T16:00:00Z')), 'Monday 17:00 BST is after the window');
  assert(dripWindowOpen(new Date('2026-08-28T10:00:00Z')), 'Friday drips');
  assert(!dripWindowOpen(new Date('2026-08-29T10:00:00Z')) && !dripWindowOpen(new Date('2026-08-30T10:00:00Z')),
    'the weekend never drips');
  assert(dripWindowOpen(new Date('2026-01-13T10:00:00Z')), 'the same wall time works in GMT');
  const now = Date.parse('2026-08-24T10:00:00Z');
  assert(!gapClear({ now, lastInviteAt: new Date(now - 40 * 60_000).toISOString() }), 'forty minutes is inside the gap');
  assert(gapClear({ now, lastInviteAt: new Date(now - 50 * 60_000).toISOString() }), 'fifty minutes clears it');
  assert(gapClear({ now, lastInviteAt: null }) && gapClear({ now, lastInviteAt: 'garbage' }), 'an unknown last time never blocks');
  assert(DRIP_MIN_GAP_MINUTES >= 30 && dripDailyCap() >= 1, 'the pace is bounded by construction');
});

check('the drip times itself around the email sequence and parks on any reply', () => {
  const now = Date.parse('2026-08-24T10:00:00Z');
  const daysAgo = d => new Date(now - d * 86_400_000).toISOString();
  assert(!emailTimingClear({ now, lastEmailAt: daysAgo(2), replied: false, afterDays: 3 }),
    'two days after email one is too soon; the touch lands between emails, not on top of them');
  assert(emailTimingClear({ now, lastEmailAt: daysAgo(3.5), replied: false, afterDays: 3 }), 'three and a half days is clear');
  assert(!emailTimingClear({ now, lastEmailAt: daysAgo(10), replied: true, afterDays: 3 }),
    'a reply parks the invite for a human, however old the email');
  assert(emailTimingClear({ now, lastEmailAt: null, replied: false }), 'a contact never emailed is clear immediately');
  assert(emailTimingClear({ now, lastEmailAt: 'garbage', replied: false }), 'a junk date never blocks and never throws');
});

check('every invite rests on a recorded sanction, and the wiring holds it (static)', () => {
  const drip = freshRead('src/studio/inviteDrip.mjs');
  assert(/auto \? 'ct\.in_decision_orbit AND ct\.linkedin_url IS NOT NULL' : 'ct\.li_invite_approved_at IS NOT NULL'/.test(drip),
    'approvals mode releases only stamped contacts; automatic mode widens to the eligible queue and nothing else');
  assert(/AND ct\.li_invited_at IS NULL/.test(drip), 'nobody is ever invited twice, in either mode');
  assert(/li_invite_skipped_at IS NULL/.test(drip), 'a skipped contact never drips, in either mode');
  assert(/x\.li_invite_approved_at \|\| recipientMismatch\(/.test(drip),
    'an unapproved automatic pick is screened by the recipient nets; a wrong-company note can never send');
  assert(/\(ct\.li_invite_approved_at IS NULL\) ASC/.test(drip) && /c\.icp_score DESC NULLS LAST/.test(drip),
    'approved people jump the queue, then best accounts first');
  assert(/'invite drip \(auto\)' : 'invite drip'/.test(drip), 'provenance says whether a person or the standing sanction picked');
  assert(/NOT ct\.suppressed AND NOT ct\.rehearsal/.test(drip), 'suppressed and rehearsal contacts never drip');
  assert(/canInvite\(x\)\.ok && emailTimingClear\(/.test(drip), 'eligibility and email timing gate every release');
  assert(/sendConnectionInvite\(pick, note, \{ accountId \}\)/.test(drip), 'the release goes through the same send path the button uses');
  assert(/array_agg\(cc\.campaign ORDER BY cc\.campaign\)/.test(drip), 'the lane derives through the membership rule');
  assert(/instanceof AccountUnhealthy/.test(drip) && /out\.unhealthy = /.test(drip), 'an account-health error is surfaced, never swallowed');
  assert(/already pending on LinkedIn, recorded/.test(drip), 'a pending invitation is recorded truth, exactly as the button records it');
  const srv = freshRead('src/server.mjs');
  assert(/invite_drip_enabled'\)\) === 'on'\) await inviteDripOnce\('schedule'\);/.test(srv), 'the tick runs the drip only when its own switch is on');
  assert(/await kvSet\('invite_drip_enabled', 'off'\)/.test(srv) && /LinkedIn account health stopped the invite drip/.test(srv),
    'an account-health error stands the drip down and tells the team');
  assert(/an invite note is required; it is frozen at approval/.test(srv), 'approval freezes a real note, never an empty one');
  assert(/li_invite_approved_at = now\(\), li_invite_approved_by = \$3, li_invite_note = \$2/.test(srv),
    'approval stamps who and freezes the note in one write');
  assert(/li_invite_approved_at = NULL, li_invite_approved_by = NULL/.test(srv), 'unapproval backs out cleanly, nothing sends');
  const mig = freshRead('src/migrations/033_invite_drip.sql');
  assert(/li_invite_approved_at/.test(mig) && /li_invite_approved_by/.test(mig), 'the approval columns ship in migration 033');
  const srv2 = freshRead('src/server.mjs');
  assert(/kvGet\('invite_drip_auto'\)\) === 'on';/.test(srv2), 'the runner reads the selection mode from its own switch');
  assert(/api\/studio\/connects\/:id\/skip-invite/.test(srv2) && /li_invite_skipped_at = now\(\), li_invite_skipped_by/.test(srv2),
    'the Skip veto is an endpoint that records who vetoed and clears any approval');
  assert(/li_invited_at IS NULL\$\{withSkip \? ' AND ct\.li_invite_skipped_at IS NULL' : ''\}/.test(srv2),
    'skipped contacts leave the connect queue too');
  const mig2 = freshRead('src/migrations/034_invite_skip.sql');
  assert(/li_invite_skipped_at/.test(mig2) && /li_invite_skipped_by/.test(mig2), 'the veto columns ship in migration 034');
  const ui = freshRead('web/src/Studio.jsx');
  assert(/Approve for the drip/.test(ui) && /Unapprove/.test(ui), 'the approve and unapprove verbs are on the connect cards');
  assert(/Not for LinkedIn/.test(ui), 'the veto is on every card');
  assert(/every invite and message rests on a recorded sanction/.test(ui), 'the banner states the widened sanction');
  const health = freshRead('web/src/Health.jsx');
  assert(/invite-drip/.test(health) && /Invite drip: on/.test(health), 'the Health page carries the switch, separate from the autopilot');
  assert(/Invite selection: automatic/.test(health) && /invite-drip-auto/.test(health), 'and the selection mode beside it');
  const inv = freshRead('src/studio/liInvite.mjs');
  assert(/its own tighter caps \(inviteDrip\.mjs\)/.test(inv) && /standing automatic-selection sanction/.test(inv),
    'the invite doctrine names all three sanctions');
});


console.log('\nThe LinkedIn stage: accept, message, then the break-up:');

check('a degree is read defensively and never guessed into a false accept', () => {
  for (const v of ['FIRST_DEGREE', 'DISTANCE_1', 'first', '1st', 1, '1']) {
    assert(networkDistance({ network_distance: v }) === 1, `first degree from ${v}`);
  }
  assert(networkDistance({ distance: 'DISTANCE_2' }) === 2 && networkDistance({ relationship: 'THIRD' }) === 3, 'other degrees read too');
  assert(networkDistance({}) === null && networkDistance(null) === null, 'an absent degree is unknown');
  assert(networkDistance({ network_distance: 'MYSTERY' }) === null, 'an unrecognised value is unknown, never a guess');
  assert(!isConnected({ network_distance: 'MYSTERY' }) && !isConnected({}) && !isConnected({ distance: 2 }),
    'only a real first degree counts as connected; a false accept would message into the void');
  assert(isConnected({ networkDistance: 'DISTANCE_1' }), 'the camel-case spelling is read too');
});

check('the connection sweep knocks politely and gives up honestly', () => {
  const now = Date.parse('2026-08-24T10:00:00Z');
  const ago = d => new Date(now - d * 86_400_000).toISOString();
  assert(checkDue({ invitedAt: ago(1), now }), 'a fresh invitation is checked');
  assert(!checkDue({ invitedAt: ago(1), connectedAt: ago(0.5), now }), 'a known connection is never re-checked');
  assert(!checkDue({ invitedAt: ago(1), checkedAt: new Date(now - 3600_000).toISOString(), now }), 'not twice in an hour');
  assert(checkDue({ invitedAt: ago(3), checkedAt: ago(1), now }), 'a day later it asks again');
  assert(!checkDue({ invitedAt: ago(40), now, windowDays: 21 }), 'past the window silence is the answer and the asking stops');
  assert(!checkDue({ invitedAt: 'garbage', now }), 'a junk date never sweeps and never throws');
});

check('one message, honest about the emails, and short enough to be a message', () => {
  const s = dmSystem('marwin_dc', 'Craig Downs');
  assert(/Craig Downs/.test(s) && /Never pretend the emails did not happen/.test(s),
    'the message names the colleague who wrote and never pretends otherwise');
  assert(/never complain/.test(s), 'an unanswered email is not a debt, and the message never treats it as one');
  assert(/no links/.test(s) && /no emojis/.test(s) && /never the word genuinely/.test(s), 'the voice rules travel');
  assert(!/data centre/i.test(dmSystem('pharma_steriflow')), 'a pharma message carries no data centre positioning');
  const contact = { name: 'Priya Shah', role: 'Project Manager', email: 'priya@ark.example' };
  const company = { name: 'ARK DATA CENTRES LIMITED', domain: 'ark.example' };
  assert(dmFlags('Hi Priya, a short note about the Slough project.', { contact, company }).length === 0, 'a clean message passes');
  assert(dmFlags('Hi there, a short note.', { contact, company })
    .some(f => /never uses Priya/.test(f)), 'a message that never uses their name reads as a broadcast and blocks');
  assert(dmFlags(`Hi Priya, ${'x'.repeat(DM_MAX_CHARS)}`, { contact, company })
    .some(f => /characters/.test(f)), 'an email in the wrong place blocks');
  assert(dmFlags('Hi Priya, see https://example.com for more.', { contact, company })
    .some(f => /link/.test(f)), 'a first message with a link reads as a pitch and blocks');
  assert(dmFlags('Hi Priya, a note.', { contact: { name: 'Priya Shah', role: 'Engineer at Somewhere Else' }, company })
    .some(f => /stated employer differs/.test(f)), 'recipient truth applies to a message exactly as to an email');
});

check('the message is due only after acceptance, and never once they have replied', () => {
  const now = Date.parse('2026-08-24T10:00:00Z');
  const ago = d => new Date(now - d * 86_400_000).toISOString();
  assert(dmDue({ connectedAt: ago(1), lastEmailAt: ago(5), now, afterDays: 3 }), 'connected, emailed, silent: the message is due');
  assert(!dmDue({ connectedAt: null, lastEmailAt: ago(5), now }), 'no acceptance, no message; it could not arrive anyway');
  assert(!dmDue({ connectedAt: ago(1), lastEmailAt: ago(1), now, afterDays: 3 }), 'the last email needs room to breathe first');
  assert(!dmDue({ connectedAt: ago(1), lastEmailAt: ago(5), replied: true, now }), 'a reply ends the machine\'s initiative here too');
  assert(!dmDue({ connectedAt: ago(1), lastEmailAt: ago(5), dmSentAt: ago(2), now }), 'one message, never a second');
  assert(dmDue({ connectedAt: ago(1), lastEmailAt: null, now }), 'never emailed is clear immediately');
});

check('the break-up waits for the LinkedIn stage, but never forever', () => {
  const now = Date.parse('2026-08-24T10:00:00Z');
  const ago = d => new Date(now - d * 86_400_000).toISOString();
  const due = new Date(now - 86_400_000).toISOString();
  assert(!breakupHeld({ finalTouch: false, dueAt: due, now, connectedAt: ago(1) }),
    'an ordinary follow-up is never held; only the final touch waits');
  assert(breakupHeld({ finalTouch: true, dueAt: due, now, connectedAt: ago(1) }),
    'connected and not yet messaged: the message is next, so the break-up waits');
  assert(breakupHeld({ finalTouch: true, dueAt: due, now, invitedAt: ago(3) }),
    'invited and undecided: they may still accept');
  assert(!breakupHeld({ finalTouch: true, dueAt: due, now, invitedAt: ago(30), connectionWindowDays: 21 }),
    'past the window silence is the answer and the sequence finishes');
  assert(breakupHeld({ finalTouch: true, dueAt: due, now, connectedAt: ago(9), dmSentAt: ago(2), afterDmDays: 5 }),
    'a message just sent gets room to be answered');
  assert(!breakupHeld({ finalTouch: true, dueAt: due, now, connectedAt: ago(20), dmSentAt: ago(8), afterDmDays: 5 }),
    'once the message has had its week the break-up goes');
  assert(!breakupHeld({ finalTouch: true, dueAt: ago(40), now, connectedAt: ago(1), maxHoldDays: 12 }),
    'nothing is held past the hold window; a lead stuck forever is worse than a late break-up');
  assert(!breakupHeld({ finalTouch: true, dueAt: due, now }), 'never invited means LinkedIn has no turn to take');
});

check('the message stage is wired, sanctioned and capped with the invites (static)', () => {
  const dm = freshRead('src/studio/liDm.mjs');
  assert(/ct\.li_connected_at IS NOT NULL/.test(dm), 'only an accepted connection is ever drafted a message');
  assert(/l\.stage NOT IN \('replied', 'handed_off', 'closed'\)/.test(dm), 'a live or finished conversation is left alone');
  assert(/NOT EXISTS \(SELECT 1 FROM li_messages m WHERE m\.contact_id = ct\.id AND m\.status <> 'rejected'\)/.test(dm),
    'one message per person, never a sequence');
  assert(/attendees_ids: \[providerId\]/.test(dm) && /ROUTES\.sendMessage/.test(dm), 'the send resolves the profile and opens one chat');
  const uni = freshRead('src/research/unipile.mjs');
  assert(/sendMessage: \{ method: 'POST'/.test(uni) && /fourth write/.test(uni), 'the fourth write is declared with its sanction');
  const drip = freshRead('src/studio/inviteDrip.mjs');
  assert(/dripActionsToday/.test(drip) && /'POST \/api\/v1\/users\/invite', 'POST \/api\/v1\/chats'/.test(drip),
    'invitations and messages share one daily cap, because they share one profile');
  assert(/COALESCE\(jsonb_array_length\(m\.flags\), 0\) = 0/.test(drip), 'a flagged message never sends, in either mode');
  assert(/const msg = await releaseMessage\(/.test(drip), 'the drip releases messages as well as invitations');
  const fu = freshRead('src/outbound/followups.mjs');
  assert(/breakupHeld\(\{/.test(fu) && /finalTouch: r\.sequence_step \+ 1 >= finalStep/.test(fu),
    'the sweeper asks the gate before the final touch');
  assert(/campaign === 'rehearsal'\) return true/.test(fu), 'the rehearsal lane never waits on a real acceptance');
  const srv = freshRead('src/server.mjs');
  assert(/sweepConnectionsOnce/.test(srv) && /generateDms/.test(srv), 'the tick learns acceptances and drafts what is due');
  assert(/only a draft message can be approved/.test(srv) && /carries a blocking flag/.test(srv), 'approval refuses a flagged message');
  const mig = freshRead('src/migrations/035_linkedin_stage.sql');
  assert(/li_connected_at/.test(mig) && /CREATE TABLE IF NOT EXISTS li_messages/.test(mig), 'the stage ships in migration 035');
  const ui = freshRead('web/src/Studio.jsx');
  assert(/MessageCard/.test(ui) && /Messages/.test(ui), 'the studio carries the message queue');
});

console.log(`\n=== Studio gate: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
