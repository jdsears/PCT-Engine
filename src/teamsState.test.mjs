// The Teams conversation store, exercised with an injected clock. This is what
// lets a Teams chat keep its thread and carry a part-number build across turns
// while persisting nothing.
import { createConversationStore } from './teamsState.mjs';

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log(`  pass  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}: ${e.message}`); fail++; }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

console.log('Teams conversation state (in-memory, TTL, nothing persisted):');

check('a conversation keeps its history and build state across turns', () => {
  const s = createConversationStore();
  assert(s.get('c1').history.length === 0, 'a fresh conversation starts empty');
  s.remember('c1', 'build a CV3000 part number', { answer: 'Which one?', configState: { offered: true, offeredModel: 'CV3000' } });
  const c = s.get('c1');
  assert(c.history.length === 2, 'the turn is remembered');
  assert(c.configState?.offeredModel === 'CV3000', 'the build state carries to the next turn');
});

check('conversations are isolated from each other', () => {
  const s = createConversationStore();
  s.remember('c1', 'q', { answer: 'a', configState: { active: true } });
  assert(s.get('c2').history.length === 0 && s.get('c2').configState === null, 'another conversation sees nothing');
});

check('state expires after the TTL and a build ending clears its state', () => {
  let t = 1_000_000;
  const s = createConversationStore({ ttlMs: 60_000, now: () => t });
  s.remember('c1', 'q', { answer: 'a', configState: { active: true } });
  t += 61_000;
  assert(s.get('c1').configState === null && s.get('c1').history.length === 0, 'expired state is gone');
  s.remember('c2', 'q', { answer: 'a', configState: { active: true } });
  s.remember('c2', 'cancel', { answer: 'Stopped.', configState: null });
  assert(s.get('c2').configState === null, 'a finished build leaves no state');
});

check('history is capped and the oldest conversation is evicted at the cap', () => {
  let t = 1_000_000;
  const s = createConversationStore({ maxTurns: 4, maxConversations: 2, now: () => t });
  for (let i = 0; i < 5; i++) s.remember('c1', `q${i}`, { answer: `a${i}`, configState: null });
  assert(s.get('c1').history.length === 4, 'history holds only the recent turns');
  assert(s.get('c1').history[0].text === 'q3', 'the oldest turns fall off');
  t += 1; s.remember('c2', 'q', { answer: 'a', configState: null });
  t += 1; s.remember('c3', 'q', { answer: 'a', configState: null });
  assert(s.size() === 2, 'the store holds at most the cap');
  assert(s.get('c1').history.length === 0, 'the oldest-touched conversation was evicted');
});

check('a missing conversation id is a safe no-op', () => {
  const s = createConversationStore();
  s.remember(null, 'q', { answer: 'a', configState: { active: true } });
  assert(s.size() === 0, 'nothing is stored without an id');
  assert(s.get(null).history.length === 0, 'and nothing is returned');
});

console.log(`\n=== Teams state gate: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
