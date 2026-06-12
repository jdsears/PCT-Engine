import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Builds pct-copilot-teams.zip at the repo root: manifest.json with the bot id
// injected, plus the two committed icons, zipped flat as Teams requires. The
// icons are committed PNGs, so this needs only Node and the zip command, no
// browser. Run it after the bot is registered, with the app id to hand:
//
//   TEAMS_BOT_APP_ID=<the bot app id> node scripts/build-teams-package.mjs
//   node scripts/build-teams-package.mjs <the bot app id>

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const id = (process.env.TEAMS_BOT_APP_ID || process.argv[2] || '').trim();
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!GUID.test(id)) {
  console.error('Set the bot app id (a GUID from the registration), then re-run:');
  console.error('  TEAMS_BOT_APP_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx node scripts/build-teams-package.mjs');
  process.exit(1);
}

const template = readFileSync(join(ROOT, 'teams', 'manifest.template.json'), 'utf8');
const manifest = template.replaceAll('__BOT_APP_ID__', id);
JSON.parse(manifest); // fail loudly if the substitution broke the JSON

const build = mkdtempSync(join(tmpdir(), 'pct-teams-'));
writeFileSync(join(build, 'manifest.json'), manifest);
for (const icon of ['color.png', 'outline.png']) {
  writeFileSync(join(build, icon), readFileSync(join(ROOT, 'teams', 'icons', icon)));
}

const out = join(ROOT, 'pct-copilot-teams.zip');
rmSync(out, { force: true });
execFileSync('zip', ['-j', '-X', out,
  join(build, 'manifest.json'), join(build, 'color.png'), join(build, 'outline.png')], { stdio: 'ignore' });
rmSync(build, { recursive: true, force: true });

console.log(`Built ${out}`);
console.log(`  bot id: ${id}`);
console.log('  contents: manifest.json, color.png (192x192), outline.png (32x32)');
console.log('Upload this zip in Teams admin centre, per JAMES_TEAMS_STEPS.md.');
