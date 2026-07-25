import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The single reader of the models directory. Pure filesystem, no model calls
// and no imports from the answer layer, so the pricing tier can decode part
// numbers without pulling the conversational stack into a cycle.

const MODELS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'models');

const byId = new Map();
export function loadConfig(modelId) {
  const id = String(modelId || '').toLowerCase();
  if (byId.has(id)) return byId.get(id);
  let cfg = null;
  try { cfg = JSON.parse(readFileSync(join(MODELS_DIR, `${id}.json`), 'utf8')); } catch { cfg = null; }
  byId.set(id, cfg);
  return cfg;
}

let all = null;
export function allConfigs() {
  if (all) return all;
  all = readdirSync(MODELS_DIR).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(join(MODELS_DIR, f), 'utf8')));
  return all;
}

export function listModels() {
  return allConfigs().map(c => ({ model: c.model, displayName: c.displayName }));
}
