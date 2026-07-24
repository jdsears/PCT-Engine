import { pool } from '../src/db.mjs';
import {
  unipile, ROUTES, unipileConfigured, callsUsedToday, dailyCap,
  linkedinAccounts, accountsList, accountStatus,
} from '../src/research/unipile.mjs';

// Connectivity diagnostic for the Unipile LinkedIn lane, in the style of
// graph-check.mjs. Read-only: it lists accounts, reports health, and makes one
// minimal Sales Navigator search. Two Unipile calls in total, both logged and
// counted against the daily cap. Needs DATABASE_URL plus UNIPILE_DSN and
// UNIPILE_API_KEY in the environment.

let failed = false;
const pass = (m) => console.log('PASS ', m);
const fail = (m) => { failed = true; console.log('FAIL ', m); };

// 1. Configuration present
if (!unipileConfigured()) {
  fail('UNIPILE_DSN and UNIPILE_API_KEY are not both set. Add them to .env (and Railway) and re-run.');
  process.exit(1);
}
pass(`configuration present, DSN ${ (process.env.UNIPILE_DSN || '').replace(/^https?:\/\//, '').split(':')[0] }`);

// --post-schema: fetch the create-post contract by sending a deliberately
// empty body. A 400 cannot publish, no account is named, and Unipile's own
// error carries the endpoint's expected schema, printed here in full. This is
// how a write route gets specified precisely without writing anything. The
// call is ledgered like every other.
if (process.argv.includes('--post-schema')) {
  const res = await fetch(`${(process.env.UNIPILE_DSN || '').replace(/\/+$/, '')}/api/v1/posts`, {
    method: 'POST',
    headers: { 'X-API-KEY': process.env.UNIPILE_API_KEY, accept: 'application/json', 'content-type': 'application/json' },
    body: '{}',
  });
  const text = await res.text();
  await pool.query(
    `INSERT INTO unipile_calls (endpoint, target, outcome) VALUES ('POST /api/v1/posts', 'check: schema probe', $1)`,
    [res.ok ? 'ok' : `http_${res.status}`]);
  console.log(`\nHTTP ${res.status} from POST /api/v1/posts with an empty body. Full response:\n`);
  try { console.log(JSON.stringify(JSON.parse(text), null, 2)); } catch { console.log(text); }

  // Second probe: the corrected shape, multipart form fields with a
  // deliberately invalid account id. It can never publish, the account
  // cannot resolve, but an account-flavoured error confirms the multipart
  // contract end to end while any schema error names what is still wrong.
  const form = new FormData();
  form.append('account_id', 'probe-invalid-account');
  form.append('text', 'schema probe, never published');
  const res2 = await fetch(`${(process.env.UNIPILE_DSN || '').replace(/\/+$/, '')}/api/v1/posts`, {
    method: 'POST',
    headers: { 'X-API-KEY': process.env.UNIPILE_API_KEY, accept: 'application/json' },
    body: form,
  });
  const text2 = await res2.text();
  await pool.query(
    `INSERT INTO unipile_calls (endpoint, target, outcome) VALUES ('POST /api/v1/posts', 'check: schema probe 2', $1)`,
    [res2.ok ? 'ok' : `http_${res2.status}`]);
  console.log(`\nHTTP ${res2.status} from POST /api/v1/posts as multipart form, invalid account. Full response:\n`);
  try { console.log(JSON.stringify(JSON.parse(text2), null, 2)); } catch { console.log(text2); }
  if (/account/i.test(text2) && !/Required property|Expected object/.test(text2)) {
    console.log('\nReading: the multipart shape is accepted and only the account is refused, which is the');
    console.log('probe working as designed. The Post to LinkedIn button now speaks this contract.');
  } else {
    console.log('\nReading: the shape is still refused; the response above names what to fix next.');
  }
  console.log('\nNothing was posted: an invalid account cannot publish.');
  await pool.end();
  process.exit(0);
}

// 2. List connected accounts. Distinguishes a bad key from a bad DSN.
let accounts = null;
try {
  accounts = await unipile(ROUTES.listAccounts, { target: 'check: list accounts' });
  pass(`accounts listed: ${accountsList(accounts).length} connected`);
} catch (e) {
  const msg = String(e.message || e);
  if (/unreachable|ENOTFOUND|ECONNREFUSED|certificate|fetch failed/i.test(msg)) {
    fail(`cannot reach the DSN. Check UNIPILE_DSN, it should look like https://apiXX.unipile.com:13XXX. (${msg.slice(0, 140)})`);
  } else if (/401/.test(msg)) {
    fail('the DSN answered but rejected the key (401). Check UNIPILE_API_KEY.');
  } else if (/403/.test(msg)) {
    fail('the DSN answered but refused access (403). The key may belong to a different Unipile workspace than this DSN.');
  } else if (/migrate/.test(msg)) {
    fail(msg);
  } else {
    fail(`accounts call failed: ${msg.slice(0, 200)}`);
  }
  await pool.end();
  process.exit(1);
}

// 3. Find the LinkedIn account and report its health.
const linked = linkedinAccounts(accounts);
if (linked.length === 0) {
  fail('no LinkedIn account is connected to this Unipile workspace.');
  console.log('\nSend James this ask, it is one click:');
  console.log('  1. Open the Unipile dashboard and choose Connect an account, LinkedIn.');
  console.log('  2. Sign in with the James account. LinkedIn may ask for a verification code.');
  console.log('  3. Tell John when it shows as connected, then John re-runs this check.');
  await pool.end();
  process.exit(1);
}
let healthy = null;
for (const a of linked) {
  const status = accountStatus(a);
  const line = `LinkedIn account "${a.name || a.id}": provider LINKEDIN, status ${status}, account_id ${a.id}`;
  if (status === 'OK') { pass(line); healthy = healthy || a; }
  else {
    fail(line);
    if (/CREDENTIALS/i.test(status)) console.log('   The saved sign-in has expired. James reconnects from the Unipile dashboard.');
    else if (/CHECKPOINT/i.test(status)) console.log('   LinkedIn is asking for a verification step. James opens the Unipile dashboard and completes it.');
    else if (/CONNECTING/i.test(status)) console.log('   Still connecting. Wait a minute and re-run this check.');
    else console.log('   See the account page in the Unipile dashboard for the exact state.');
  }
}
if (!healthy) { await pool.end(); process.exit(1); }

console.log(`\nSet this in Railway and .env, then the lane is live:\n  UNIPILE_ACCOUNT_ID=${healthy.id}\n`);

// 4. One minimal Sales Navigator search to confirm reachability, then stop.
try {
  const res = await unipile(ROUTES.search, {
    query: { account_id: healthy.id, limit: '1' },
    body: { api: 'sales_navigator', category: 'people', keywords: '"Ark Data Centres"' },
    target: 'check: minimal sales navigator search',
  });
  const items = Array.isArray(res?.items) ? res.items : [];
  pass(`sales navigator search reachable, ${items.length} result${items.length === 1 ? '' : 's'} returned`);
} catch (e) {
  const msg = String(e.message || e);
  if (/sales.?nav|premium|subscription|upsell/i.test(msg)) {
    fail('the search endpoint answered but Sales Navigator is not active on this account. The lane needs the Sales Navigator subscription on the James account.');
  } else {
    fail(`sales navigator search failed: ${msg.slice(0, 200)}`);
  }
}

const used = await callsUsedToday();
console.log(`\nUnipile calls used today: ${used} of ${dailyCap()} (UTC day). Every call is logged in unipile_calls.`);
console.log(failed ? 'Resolve the failures above, then re-run.' : 'All Unipile read checks passed.');
await pool.end();
process.exit(failed ? 1 : 0);
