// Shared request settings for the Claude Messages API calls.
//
// Sonnet 5.5 thinks by default (adaptive thinking) and refuses
// thinking: { type: 'disabled' } with a 400. Every call here ran without
// thinking on the older Sonnet, so to keep latency, cost and output close to
// before we ask for 'between_tools', the lowest setting: no up-front thinking,
// and with no tools the reply is text only. Older models do not know that
// value, so it is sent only when CLAUDE_MODEL points at Sonnet 5.5 (the
// default) and left off for any override naming another model.

export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5-5';

export function thinkingParams(model) {
  return /sonnet-5-5/.test(String(model || '')) ? { thinking: { type: 'between_tools' } } : {};
}
