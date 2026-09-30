// One small request with exactly the shape every engine call sends, to
// confirm on this account that the model, the explicit effort, the thinking
// setting and the refusal fallback are all accepted. The container that
// builds the engine has no key, so this is the check that runs before a
// change to src/claude.mjs is merged. It costs a fraction of a penny.
//
//   node --env-file=.env scripts/claude-check.mjs
import { CLAUDE_URL, MODEL, claudeHeaders, claudeBody, claudeText } from '../src/claude.mjs';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set. Run it with --env-file=.env.');
  process.exit(1);
}

const headers = claudeHeaders();
const body = claudeBody({ maxTokens: 50, system: 'Reply with the single word OK.', messages: [{ role: 'user', content: 'Say OK.' }] });
console.log(`Sending: model ${body.model}, effort ${body.output_config?.effort ?? 'not sent'}, thinking ${body.thinking?.type ?? 'not sent'}, `
  + `fallback ${body.fallbacks ?? 'not sent'}${headers['anthropic-beta'] ? ` (${headers['anthropic-beta']})` : ''}, max_tokens ${body.max_tokens}.`);

const res = await fetch(CLAUDE_URL, { method: 'POST', headers, body: JSON.stringify(body) });
const text = await res.text();
if (!res.ok) {
  console.error(`Refused: HTTP ${res.status}.\n${text.slice(0, 800)}\n\nNothing is broken yet: this shape is not live until merged. Do not merge; send this output.`);
  process.exit(1);
}
const json = JSON.parse(text);
console.log(`Accepted: served by ${json.model}, stop reason ${json.stop_reason}, reply "${claudeText(json)}", ${json.usage?.input_tokens ?? '?'} tokens in, ${json.usage?.output_tokens ?? '?'} out.`);
console.log(String(json.model || '').startsWith(MODEL)
  ? 'The request shape is accepted on this account. Safe to merge.'
  : `Accepted, but served by ${json.model} rather than ${MODEL}. Send this output before merging.`);
