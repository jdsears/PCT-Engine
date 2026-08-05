// Microsoft sign-in, the parts a gate can prove without Microsoft: the
// signed session survives a round trip and nothing else, the allowlist
// matches the shapes Graph actually returns including guest accounts, the
// authorize URL carries the flow's protections, and the server keeps its
// gate covering the data routes with identity never taken from the browser.
import {
  signPayload, verifyPayload, isAllowed, buildAuthorizeUrl,
  msSigninConfigured, allowedUsers, sessionSecret,
} from './auth.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => readFileSync(join(ROOT, rel), 'utf8');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log(`  pass  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}: ${e.message}`); fail++; }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

console.log('Sessions:');

const SECRET = 'test-secret';

check('a session survives a round trip and carries its identity', () => {
  const v = signPayload({ e: 'andy@example.com', n: 'Andy' }, SECRET, { now: 1000, maxAgeMs: 60_000 });
  const p = verifyPayload(v, SECRET, { now: 30_000 });
  assert(p && p.e === 'andy@example.com' && p.n === 'Andy', 'identity intact');
});

check('tampering, the wrong secret, truncation and expiry all come back null', () => {
  const v = signPayload({ e: 'andy@example.com' }, SECRET, { now: 1000, maxAgeMs: 60_000 });
  assert(verifyPayload(v.slice(0, -2) + 'xx', SECRET, { now: 2000 }) === null, 'a doctored signature fails');
  const [body] = v.split('.');
  const other = signPayload({ e: 'mallory@example.com' }, SECRET, { now: 1000, maxAgeMs: 60_000 });
  assert(verifyPayload(`${body}.${other.split('.')[1]}`, SECRET, { now: 2000 }) === null, 'a swapped body fails');
  assert(verifyPayload(v, 'other-secret', { now: 2000 }) === null, 'the wrong secret fails');
  assert(verifyPayload(v.slice(0, 10), SECRET, { now: 2000 }) === null, 'truncation fails');
  assert(verifyPayload(v, SECRET, { now: 61_001 }) === null, 'an expired session fails');
  assert(verifyPayload(null, SECRET) === null && verifyPayload('', SECRET) === null, 'absence is null, never an error');
});

console.log('\nThe allowlist:');

const ALLOW = new Set(['john@moonbootscapital.io', 'james.kybird@pctflow.com']);

check('a member is allowed by mail, case blind, and a stranger is not', () => {
  assert(isAllowed({ mail: 'James.Kybird@PCTflow.com' }, ALLOW), 'mail matches case blind');
  assert(isAllowed({ mail: null, userPrincipalName: 'james.kybird@pctflow.com' }, ALLOW), 'the UPN matches when mail is empty');
  assert(!isAllowed({ mail: 'someone@else.com', userPrincipalName: 'someone@else.com' }, ALLOW), 'a stranger is refused');
  assert(!isAllowed({}, ALLOW), 'no identity is refused');
  assert(!isAllowed({ mail: 'john@moonbootscapital.io' }, new Set()), 'an empty allowlist refuses everyone');
});

check('a guest account matches through its home address', () => {
  const guest = { mail: null, userPrincipalName: 'john_moonbootscapital.io#EXT#@pctflow.onmicrosoft.com' };
  assert(isAllowed(guest, ALLOW), 'the guest UPN folds back to the listed address');
});

console.log('\nThe flow:');

check('the authorize URL carries PKCE, state and the delegated scopes', () => {
  const url = buildAuthorizeUrl({ tenant: 'tenant-id', clientId: 'client-id', redirectUri: 'https://example.test/auth/callback', state: 'st123', challenge: 'ch456' });
  assert(url.startsWith('https://login.microsoftonline.com/tenant-id/oauth2/v2.0/authorize?'), 'the tenant endpoint');
  for (const part of ['client_id=client-id', 'response_type=code', 'state=st123', 'code_challenge=ch456', 'code_challenge_method=S256', 'scope=openid+profile+email+User.Read']) {
    assert(url.includes(part), `carries ${part}`);
  }
  assert(url.includes(encodeURIComponent('https://example.test/auth/callback')), 'the redirect is pinned');
});

check('sign-in reports unconfigured until every piece is set', () => {
  const saved = { ...process.env };
  try {
    delete process.env.AUTH_ALLOWED_USERS;
    process.env.MS_TENANT_ID = 't'; process.env.MS_CLIENT_ID = 'c'; process.env.MS_CLIENT_SECRET = 's';
    assert(!msSigninConfigured(), 'no allowlist, not configured');
    process.env.AUTH_ALLOWED_USERS = ' John@moonbootscapital.io , andy@pctflow.com ';
    assert(msSigninConfigured(), 'all pieces present');
    assert(allowedUsers().has('john@moonbootscapital.io') && allowedUsers().size === 2, 'the list parses trimmed and lowered');
    delete process.env.MS_CLIENT_SECRET;
    assert(!msSigninConfigured(), 'a missing secret unconfigures it');
  } finally {
    for (const k of ['MS_TENANT_ID', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'AUTH_ALLOWED_USERS']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
});

check('the session secret needs no new configuration, and its own env wins', () => {
  const saved = { ...process.env };
  try {
    delete process.env.AUTH_SESSION_SECRET;
    process.env.MS_CLIENT_SECRET = 'abc';
    const derived = sessionSecret();
    assert(derived && derived.length === 64, 'derived from the client secret');
    process.env.AUTH_SESSION_SECRET = 'explicit';
    assert(sessionSecret() === 'explicit', 'the explicit secret wins');
  } finally {
    for (const k of ['AUTH_SESSION_SECRET', 'MS_CLIENT_SECRET']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
});

console.log('\nThe server keeps its shape (static):');

check('identity comes from Graph with the exchanged token, never from the browser', () => {
  const src = read('src/auth.mjs');
  assert(/graph\.microsoft\.com\/v1\.0\/me/.test(src), 'the callback reads /me');
  assert(/grant_type: 'authorization_code'/.test(src) && /code_verifier/.test(src), 'code exchange with PKCE');
  assert(!/req\.(query|body)\.(email|mail|user|upn)/i.test(src), 'no identity is read from the request');
});

check('the gate still covers the data routes and the bot stays exempt', () => {
  const server = read('src/server.mjs');
  assert(/app\.use\(\['\/api', '\/ask', '\/search'\]/.test(server), 'the gate middleware stands');
  const bot = server.indexOf("app.post('/api/teams/messages'");
  const gate = server.indexOf("app.use(['/api', '/ask', '/search']");
  assert(bot !== -1 && gate !== -1 && bot < gate, 'the bot endpoint registers before the gate, exempt by design');
  assert(/verifiedUser\(req\)/.test(server), 'a Microsoft session grants access');
  assert(/registerAuthRoutes\(app\)/.test(server), 'the sign-in routes are registered');
});

console.log(`\n=== Auth gate: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
