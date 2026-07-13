// The studio's pure parts. Post generation needs the database and a model, so
// it is exercised on the deploy; the note builder and its invite-length bound
// are provable here.
import { connectNote } from './liPosts.mjs';

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log(`  pass  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}: ${e.message}`); fail++; }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

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

console.log(`\n=== Studio gate: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
