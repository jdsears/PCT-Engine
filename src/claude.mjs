// The Claude model every call in the engine makes, and the request shape
// that goes with it, in one place so the next model change is one line.
// The move to the current Sonnet (29 September 2026) set the model and held
// thinking off. John's ask of 30 September 2026, to finish that move, adds
// what the model's migration checklist still asked for: a safety decline
// handled rather than read as a reply, limits sized for the newer
// tokenizer, and effort sent explicitly. Each caller keeps its own fetch,
// error wording and reply handling.
//
// CLAUDE_MODEL overrides the default, and CLAUDE_EFFORT the effort.

export const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
export const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';

// Request fields differ by model generation, and a field a model does not
// take is a 400 on every call, so each goes only where it is taken. An
// override to an older model is sent the plain request it always accepted.
const TAKES_EFFORT = /^claude-(sonnet-(4-6|5)|opus-(4-[5-9]|5)|fable-|mythos-)/;
const TAKES_FALLBACK = /^claude-(sonnet-5-5|opus-5-5|opus-5|fable-5-1)$/;
const TAKES_BETWEEN_TOOLS = /claude-sonnet-5-5/;
const NEW_TOKENIZER = /^claude-(sonnet-5|opus-(4-[7-9]|5)|fable-|mythos-)/;
const THINKS_BY_DEFAULT = /^claude-(sonnet-5|opus-5|fable-|mythos-)/;

// Effort. high is what these calls have run at since the move, the API's
// own default, now sent explicitly so it can be tuned without a deploy.
// For classification, extraction and short drafting the guidance's
// starting point is low, quicker and cheaper; CLAUDE_EFFORT=low tries it.
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
export const EFFORT = EFFORTS.has(process.env.CLAUDE_EFFORT) ? process.env.CLAUDE_EFFORT : 'high';

// Thinking. None of these calls thought on the older Sonnet, so on the
// current one each runs at its lowest setting, between_tools: no thinking
// before the reply. That setting exists only on this model and only at
// effort high or below; above that the model thinks and the field is left
// out.
export function thinkingFor(model = MODEL, effort = EFFORT) {
  return TAKES_BETWEEN_TOOLS.test(model) && effort !== 'xhigh' && effort !== 'max' ? { type: 'between_tools' } : null;
}

// A route's max_tokens was tuned on the older Sonnet, in its tokens. The
// newer tokenizer spends about a third more tokens on the same text, so the
// limit a route asks for is scaled; when the model will think, thinking
// comes out of the same limit and gets room of its own. It is a ceiling,
// not a target: a short reply stays short and only what is generated is
// billed.
const TOKENIZER_FACTOR = 1.35;
const THINKING_ROOM = 2000;
export function maxTokensFor(limit, model = MODEL, effort = EFFORT) {
  let n = Number(limit) > 0 ? Number(limit) : 1024;
  if (NEW_TOKENIZER.test(model)) n = Math.ceil(n * TOKENIZER_FACTOR);
  if (THINKS_BY_DEFAULT.test(model) && !thinkingFor(model, effort)) n += THINKING_ROOM;
  return n;
}

export function claudeHeaders(model = MODEL) {
  const h = { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
  // A request the safety classifiers decline is re-run server-side on the
  // model Anthropic names for that kind of decline, rather than coming back
  // empty. It only acts on a decline; every other request is untouched.
  if (TAKES_FALLBACK.test(model)) h['anthropic-beta'] = 'server-side-fallback-2026-07-01';
  return h;
}

export function claudeBody({ maxTokens, system, messages }, model = MODEL) {
  const body = { model, max_tokens: maxTokensFor(maxTokens, model) };
  const thinking = thinkingFor(model);
  if (thinking) body.thinking = thinking;
  if (system) body.system = system;
  body.messages = messages;
  if (TAKES_EFFORT.test(model)) body.output_config = { effort: EFFORT };
  if (TAKES_FALLBACK.test(model)) body.fallbacks = 'default';
  return body;
}

// The reply's text, from its text blocks only; a reply can open with a
// thinking block, so nothing reads content[0]. A decline the fallback could
// not rescue is logged and read as no reply, never as whatever partial text
// came with it, so each caller's existing handling of an empty or
// unparseable reply applies. A reply cut off at max_tokens is logged so its
// limit can be revisited.
export function claudeText(json, sep = '\n') {
  if (json?.stop_reason === 'refusal') {
    console.warn(`Claude declined the request${json.stop_details?.category ? ` (${json.stop_details.category})` : ''}; read as no reply.`);
    return '';
  }
  if (json?.stop_reason === 'max_tokens') console.warn('Claude reply reached max_tokens and was cut short.');
  return (json?.content || []).filter(b => b.type === 'text').map(b => b.text).join(sep).trim();
}
