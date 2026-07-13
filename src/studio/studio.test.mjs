// The studio's pure parts. Post generation needs the database and a model, so
// it is exercised on the deploy; the note builder and its invite-length bound
// are provable here.
import { connectNote, writePost } from './liPosts.mjs';
import { htmlToText, splitNewsletter, intelSenders } from './intelInbox.mjs';

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
  assert(n.includes('Mechanical Engineering Manager') && n.includes('Pure Data Centres Group'), 'role and company are mentioned');
  assert(n.length <= 300, `must fit the LinkedIn invite limit, got ${n.length}`);
  assert(!/[—–!]/.test(n) && !/genuinely/i.test(n), 'house voice holds');
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

console.log(`\n=== Studio gate: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
