import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { emptySlots, applyValue, checkConstraints, assemble } from './engine.mjs';
import { voiceGate } from '../answer.mjs';

// The conversational layer. This is the only place the model works, and it works
// only to interpret the user's words into slot values and to read intent. The
// engine in engine.mjs decides validity and assembles the code. The model never
// invents a code: every value it proposes is validated by applyValue, and an
// unlisted value is raised back to the user, not accepted.

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const MODELS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'models');

const cache = new Map();
export function loadConfig(modelId) {
  const id = String(modelId || '').toLowerCase();
  if (cache.has(id)) return cache.get(id);
  let cfg = null;
  try { cfg = JSON.parse(readFileSync(join(MODELS_DIR, `${id}.json`), 'utf8')); } catch { cfg = null; }
  cache.set(id, cfg);
  return cfg;
}
export function listModels() {
  return readdirSync(MODELS_DIR).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(join(MODELS_DIR, f), 'utf8')))
    .map(c => ({ model: c.model, displayName: c.displayName }));
}

// ---- model calls: interpretation only ----

async function callClaude(system, user) {
  const res = await fetch(CLAUDE_URL, {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 600, system, messages: [{ role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`configurator model call failed: ${res.status}`);
  const json = await res.json();
  return (json.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}

const firstJson = (text) => { const m = String(text).match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : {}; };

// Does the user want to build or select a part number, and for which model? The
// model reads intent; the engine confirms the model exists. Conservative: if
// unsure, build is false and the co-pilot offers rather than hijacks.
export async function detectIntent(message) {
  const models = listModels().map(m => m.model).join(', ');
  const system =
    'You decide whether a message is asking to build or configure a product part number, and which model. ' +
    `Known models: ${models}. Reply with JSON only: {"build": true|false, "model": "<model or null>"}. ` +
    'Only set build true when the person clearly wants to assemble or select a part or order code, not for a general question.';
  try {
    const out = firstJson(await callClaude(system, message));
    const model = out.model && loadConfig(out.model) ? String(out.model).toUpperCase() : null;
    return { build: Boolean(out.build), model };
  } catch { return { build: false, model: null }; }
}

// Map the user's words onto slot values for one config. The model returns only
// slot ids that exist, with a value it believes matches; the engine validates.
export async function parseSlots(config, message) {
  const slotLines = config.slots.map(s =>
    `${s.id} (${s.label}): ${s.options.map(o => `${o.code}=${o.label}`).join('; ')}`).join('\n');
  const system =
    `You map a request for a ${config.displayName} onto these slots. Reply with JSON only, an object of slot id to the chosen option code, label or alias, for the slots the message specifies. Omit slots the message does not mention. Do not invent values.\n\nSlots:\n${slotLines}`;
  try { return firstJson(await callClaude(system, message)); } catch { return {}; }
}

// ---- deterministic conversation over the engine ----

// Apply parsed guesses, returning the new state and what was accepted or
// rejected. A rejected value is never silently dropped.
export function applyParsed(config, state, guesses) {
  let next = { ...state };
  const accepted = [], rejected = [];
  for (const [slotId, raw] of Object.entries(guesses || {})) {
    if (!config.slots.find(s => s.id === slotId)) continue;
    const r = applyValue(config, next, slotId, raw);
    if (r.accepted) { next = r.state; accepted.push({ slot: slotId, code: r.code, label: r.label }); }
    else rejected.push({ slot: slotId, raw, label: r.label, options: r.options || [] });
  }
  return { state: next, accepted, rejected };
}

const optionList = (slot) => slot.options.map(o => `${o.label} (${o.code})`).join(', ');

// Ask for the next missing slot, options listed, so the user chooses.
export function promptFor(config, state) {
  const [slot] = emptySlots(config, state);
  if (!slot) return null;
  return voiceGate(`Which ${slot.label.toLowerCase()}? The options are: ${optionList(slot)}.`);
}

// Say plainly that a value is not an option, and list the valid ones.
export function refusalText(config, rejected) {
  return rejected.map(rej => {
    const slot = config.slots.find(s => s.id === rej.slot);
    return voiceGate(`"${rej.raw}" is not a ${slot.label.toLowerCase()} option for this model. The options are: ${optionList(slot)}.`);
  }).join('\n');
}

// Explain a constraint clash and offer to change one of the two choices.
export function constraintText(config, state, violated) {
  return violated.map(v => {
    const reason = v.reason;
    return voiceGate(`That combination is not offered: ${reason}. Tell me which of the two to change.`);
  }).join('\n');
}

// On completion: the assembled code, the decoded breakdown, and the citation.
export function completionText(config, state) {
  const built = assemble(config, state);
  if (!built.ok) return null;
  const rows = built.decode.map(d => `  ${d.code.padEnd(4)} ${d.label}: ${d.choice}`).join('\n');
  const cite = `${config.source.doc}${config.source.page ? `, page ${config.source.page}` : ''}`;
  const text = voiceGate(
    `That builds the part number ${built.code}.\n\n${rows}\n\n` +
    `This is the part number per the ordering matrix in ${cite}. Pricing is a separate step, handled later.`);
  return { code: built.code, decode: built.decode, citation: cite, text };
}

const EXIT = /\b(start again|never mind|nevermind|cancel|forget it|stop)\b/i;

// One conversational turn. convState is { model, state }. Returns the reply,
// the updated state, and whether the build is done or was exited.
export async function advance(convState, message) {
  if (EXIT.test(message)) {
    return { reply: voiceGate('No problem, I have stopped the part number build. Ask me anything else.'), done: true, exited: true };
  }
  const config = loadConfig(convState.model);
  if (!config) return { reply: voiceGate('I do not have an ordering matrix for that model yet.'), done: true };

  const guesses = await parseSlots(config, message);
  const { state, accepted, rejected } = applyParsed(config, convState.state || {}, guesses);
  convState.state = state;

  const parts = [];
  if (accepted.length) {
    parts.push(voiceGate('Noted: ' + accepted.map(a => `${config.slots.find(s => s.id === a.slot).label.toLowerCase()} ${a.code}`).join(', ') + '.'));
  }
  if (rejected.length) parts.push(refusalText(config, rejected));

  const violated = checkConstraints(config, state);
  if (violated.length) {
    parts.push(constraintText(config, state, violated));
    return { reply: parts.join('\n\n'), done: false, state };
  }

  const next = promptFor(config, state);
  if (next) { parts.push(next); return { reply: parts.join('\n\n'), done: false, state }; }

  const done = completionText(config, state);
  parts.push(done.text);
  return { reply: parts.join('\n\n'), done: true, code: done.code, decode: done.decode, citation: done.citation, state };
}
