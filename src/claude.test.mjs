// The one place the engine's model and request shape are set. Pure over
// the request it builds and the reply it reads; no network, no key.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  pass  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}: ${e.message}`); fail++; }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The module reads its overrides once, at import, so it is loaded fresh
// with the environment each check needs.
async function load(env = {}) {
  const saved = {};
  for (const k of ['CLAUDE_MODEL', 'CLAUDE_EFFORT']) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, env);
  try { return await import(`./claude.mjs?${Math.random()}`); }
  finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

console.log('The model and its request shape (one place):');

await check('the default is the current Sonnet with thinking held off, effort explicit, and the refusal fallback', async () => {
  const c = await load();
  assert(c.MODEL === 'claude-sonnet-5-5', `the default model: ${c.MODEL}`);
  const body = c.claudeBody({ maxTokens: 300, system: 'S', messages: [{ role: 'user', content: 'U' }] });
  assert(body.model === 'claude-sonnet-5-5' && body.system === 'S' && body.messages[0].content === 'U', 'model, system and messages carried');
  assert(JSON.stringify(body.thinking) === JSON.stringify({ type: 'between_tools' }), `thinking at its lowest setting, as since the move of 29 September, and nothing else in the field: ${JSON.stringify(body.thinking)}`);
  assert(body.output_config?.effort === 'high', `effort sent as the high the calls already run at: ${JSON.stringify(body.output_config)}`);
  assert(body.fallbacks === 'default' && c.claudeHeaders()['anthropic-beta'] === 'server-side-fallback-2026-07-01', 'the server-side fallback and its header travel together');
  assert(!('temperature' in body) && !('top_p' in body) && !('top_k' in body) && !('tool_choice' in body),
    'nothing the current Sonnet refuses: no sampling setting, no forced tool');
  assert(c.claudeHeaders()['anthropic-version'] === '2023-06-01' && c.claudeHeaders()['content-type'] === 'application/json', 'the standard headers');
  const bare = c.claudeBody({ maxTokens: 1200, messages: [{ role: 'user', content: 'U' }] });
  assert(!('system' in bare), 'a call with no system prompt sends none');
});

await check('a route\'s limit is scaled for the larger token count, gets room when the model will think, and stays a ceiling', async () => {
  const c = await load();
  // 200 is the parties extractor's limit, the tightest in the engine.
  assert(c.maxTokensFor(200) === Math.ceil(200 * 1.35), `thinking held off: the tokenizer scaling alone: ${c.maxTokensFor(200)}`);
  assert(c.maxTokensFor(undefined) === Math.ceil(1024 * 1.35), 'a missing limit falls back to 1024 before scaling');
  assert(c.claudeBody({ maxTokens: 700, messages: [] }).max_tokens === c.maxTokensFor(700), 'the body uses it');
  const hard = await load({ CLAUDE_EFFORT: 'xhigh' });
  const b = hard.claudeBody({ maxTokens: 700, messages: [] });
  assert(!('thinking' in b) && b.output_config.effort === 'xhigh', 'above high the lowest thinking setting is refused, so the field is left out and the model thinks');
  assert(b.max_tokens === Math.ceil(700 * 1.35) + 2000, `and then thinking gets room of its own: ${b.max_tokens}`);
});

await check('an override to an older model is sent the plain request it always took', async () => {
  const old = await load({ CLAUDE_MODEL: 'claude-sonnet-4-5' });
  const b = old.claudeBody({ maxTokens: 700, system: 'S', messages: [] });
  assert(b.model === 'claude-sonnet-4-5' && b.max_tokens === 700, 'no scaling on the older tokenizer');
  assert(!('output_config' in b) && !('fallbacks' in b) && !('thinking' in b) && !old.claudeHeaders()['anthropic-beta'], 'no effort, no thinking setting, no fallback, no beta header: each would be a 400 there');
  const s46 = await load({ CLAUDE_MODEL: 'claude-sonnet-4-6' });
  const b46 = s46.claudeBody({ maxTokens: 700, messages: [] });
  assert(b46.output_config?.effort === 'high' && !('fallbacks' in b46) && !('thinking' in b46) && b46.max_tokens === 700, 'the previous Sonnet takes effort but not the fallback or the thinking setting');
  const s5 = await load({ CLAUDE_MODEL: 'claude-sonnet-5' });
  const b5 = s5.claudeBody({ maxTokens: 700, messages: [] });
  assert(!('thinking' in b5) && b5.max_tokens === Math.ceil(700 * 1.35) + 2000, 'the lowest thinking setting belongs to the current Sonnet alone; the one before it thinks, with room');
  const haiku = await load({ CLAUDE_MODEL: 'claude-haiku-4-5' });
  assert(!('output_config' in haiku.claudeBody({ maxTokens: 10, messages: [] })), 'Haiku 4.5 takes no effort');
});

await check('effort is the environment\'s when it names a real level, and high otherwise', async () => {
  const low = await load({ CLAUDE_EFFORT: 'low' });
  assert(low.claudeBody({ maxTokens: 10, messages: [] }).output_config.effort === 'low' && low.claudeBody({ maxTokens: 10, messages: [] }).thinking?.type === 'between_tools', 'a named level is used, and thinking stays held off at it');
  assert((await load({ CLAUDE_EFFORT: 'loud' })).EFFORT === 'high', 'a typo falls back to high, never to a 400');
});

await check('the reply is read from its text blocks, and a decline reads as no reply', async () => {
  const c = await load();
  const warned = [];
  const orig = console.warn;
  console.warn = m => warned.push(m);
  try {
    const thinkingFirst = { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: ' {"ok": true} ' }] };
    assert(c.claudeText(thinkingFirst) === '{"ok": true}', 'a reply that opens with a thinking block still reads its text');
    assert(c.claudeText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }, '') === 'ab' && c.claudeText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }) === 'a\nb', 'the joiner is the caller\'s');
    assert(c.claudeText({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [{ type: 'text', text: 'partial' }] }) === '', 'a decline the fallback could not rescue is no reply, never a partial one');
    assert(warned.some(w => /declined the request \(cyber\)/.test(w)), 'and it is logged with its category');
    assert(c.claudeText({ stop_reason: 'max_tokens', content: [{ type: 'text', text: 'cut' }] }) === 'cut' && warned.some(w => /max_tokens/.test(w)), 'a reply cut short is kept and logged');
    assert(c.claudeText(null) === '' && c.claudeText({}) === '', 'nothing to read is an empty reply');
  } finally { console.warn = orig; }
});

await check('every Claude call in the engine goes through the one module (static)', async () => {
  const files = [];
  const walk = d => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) { if (n !== 'node_modules') walk(p); } else if (p.endsWith('.mjs')) files.push(p); } };
  for (const d of ['src', 'scripts', 'ingestion']) walk(join(ROOT, d));
  const own = files.filter(p => !p.endsWith('claude.mjs') && !p.endsWith('.test.mjs'));
  const stray = own.filter(p => { const s = readFileSync(p, 'utf8'); return /api\.anthropic\.com|'anthropic-version'|claude-(sonnet|opus|haiku|fable)-\d|CLAUDE_MODEL|claudeParams/.test(s); });
  assert(stray.length === 0, `these set their own model or endpoint: ${stray.map(p => p.slice(ROOT.length + 1)).join(', ')}`);
  const callers = own.filter(p => /claudeBody\(/.test(readFileSync(p, 'utf8')) && !p.endsWith('claude-check.mjs'));
  assert(callers.length === 13, `thirteen call sites build their request here: ${callers.length}`);
  assert(callers.every(p => /claudeText\(json/.test(readFileSync(p, 'utf8'))), 'and every one reads its reply through claudeText');
  const env = readFileSync(join(ROOT, '.env.example'), 'utf8');
  assert(/CLAUDE_MODEL=/.test(env) && /CLAUDE_EFFORT=/.test(env) && !/claude-sonnet-4/.test(env), 'the example environment documents both overrides and no retired default');
});

console.log(`\n=== Claude request gate: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
