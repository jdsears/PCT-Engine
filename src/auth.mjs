import crypto from 'node:crypto';

// Individual Microsoft sign-in, the phase the access gate promised.
//
// The shared key was the pilot's gate: one secret, no names. With Andy
// joining John and James the engine needs to know who is at the wheel, so
// sign-in moves to Microsoft accounts: the standard authorisation code flow
// with PKCE against the company tenant, using the same app registration the
// engine already holds for Graph mail. Identity is read from Graph /me with
// the token Microsoft has just issued, never from anything the browser
// asserts, and only addresses on the allowlist get a session.
//
// Configuration, all environment: the existing MS_TENANT_ID, MS_CLIENT_ID
// and MS_CLIENT_SECRET, plus AUTH_ALLOWED_USERS, a comma-separated list of
// the permitted addresses. AUTH_REDIRECT_URI pins the callback when the
// derived one is wrong. Until AUTH_ALLOWED_USERS is set nothing changes:
// the routes refuse plainly, the shared key keeps working, and a service
// with neither configured stays open exactly as before. Sessions are a
// signed cookie, thirty days, no server-side store.

const SESSION_COOKIE = 'pct_user';
const STATE_COOKIE = 'pct_auth_state';
const SESSION_DAYS = 30;

export function allowedUsers() {
  return new Set(String(process.env.AUTH_ALLOWED_USERS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
}

export function msSigninConfigured() {
  return Boolean(process.env.MS_TENANT_ID && process.env.MS_CLIENT_ID
    && process.env.MS_CLIENT_SECRET && allowedUsers().size);
}

// The cookie-signing key. Its own env when set; otherwise derived from the
// client secret, which already lives only on the server, so sign-in needs no
// new secret to roll out. Rotating either signs everyone out, nothing more.
export function sessionSecret() {
  if (process.env.AUTH_SESSION_SECRET) return process.env.AUTH_SESSION_SECRET;
  return crypto.createHash('sha256').update(`pct-session|${process.env.MS_CLIENT_SECRET || ''}`).digest('hex');
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const hmac = (body, secret) => crypto.createHmac('sha256', String(secret)).update(body).digest('base64url');

// A signed, expiring value: payload to cookie text and back. Tampering,
// truncation or expiry all come back as null, never an error.
export function signPayload(payload, secret, { now = Date.now(), maxAgeMs } = {}) {
  const body = b64url(JSON.stringify({ ...payload, x: now + maxAgeMs }));
  return `${body}.${hmac(body, secret)}`;
}

export function verifyPayload(value, secret, { now = Date.now() } = {}) {
  const s = String(value || '');
  const dot = s.lastIndexOf('.');
  if (dot === -1) return null;
  const body = s.slice(0, dot), mac = s.slice(dot + 1);
  const expect = hmac(body, secret);
  const a = Buffer.from(mac), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof p.x !== 'number' || p.x < now) return null;
    return p;
  } catch { return null; }
}

// May this identity in? Graph gives a mail address and a user principal
// name; a guest account's UPN encodes the home address with an underscore
// and an #EXT# marker, so that form is folded back before matching. The
// allowlist is addresses, compared lowercase.
export function isAllowed({ mail, userPrincipalName } = {}, allow = allowedUsers()) {
  if (!allow.size) return false;
  const candidates = [];
  if (mail) candidates.push(String(mail).toLowerCase());
  const upn = String(userPrincipalName || '').toLowerCase();
  if (upn) {
    candidates.push(upn);
    const ext = upn.split('#ext#')[0];
    if (ext && ext !== upn) {
      const i = ext.lastIndexOf('_');
      if (i > 0) candidates.push(`${ext.slice(0, i)}@${ext.slice(i + 1)}`);
    }
  }
  return candidates.some(c => allow.has(c));
}

export function buildAuthorizeUrl({ tenant, clientId, redirectUri, state, challenge }) {
  const q = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: 'openid profile email User.Read',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize?${q}`;
}

function callbackUri(req) {
  if (process.env.AUTH_REDIRECT_URI) return process.env.AUTH_REDIRECT_URI;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}/auth/callback`;
}

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i !== -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// The signed-in user on a request, or null. This is the only reader of the
// session cookie; the server's access check calls it.
export function verifiedUser(req) {
  if (!msSigninConfigured()) return null;
  const p = verifyPayload(readCookie(req, SESSION_COOKIE), sessionSecret());
  return p ? { email: p.e, name: p.n || null } : null;
}

const cookieOpts = () => ({
  httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/',
});

// A calm full-page message for the browser-redirect flow, where JSON would
// strand the person on raw text with no way back.
const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; color: #1a2b49;">
<h1 style="font-size: 1.2rem;">${title}</h1><p>${body}</p><p><a href="/">Back to the PCT Engine</a></p></body>`;

export function registerAuthRoutes(app) {
  app.get('/auth/login', (req, res) => {
    if (!msSigninConfigured()) {
      return res.status(404).type('html').send(page('Sign in is not configured',
        'Microsoft sign in has not been configured on this service yet. The shared access key still works.'));
    }
    const state = crypto.randomBytes(16).toString('hex');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    res.cookie(STATE_COOKIE, signPayload({ s: state, v: verifier }, sessionSecret(), { maxAgeMs: 10 * 60 * 1000 }),
      { ...cookieOpts(), maxAge: 10 * 60 * 1000 });
    res.redirect(buildAuthorizeUrl({
      tenant: process.env.MS_TENANT_ID, clientId: process.env.MS_CLIENT_ID,
      redirectUri: callbackUri(req), state, challenge,
    }));
  });

  app.get('/auth/callback', async (req, res) => {
    try {
      if (!msSigninConfigured()) return res.status(404).type('html').send(page('Sign in is not configured', 'Microsoft sign in has not been configured on this service yet.'));
      const st = verifyPayload(readCookie(req, STATE_COOKIE), sessionSecret());
      res.clearCookie(STATE_COOKIE, cookieOpts());
      // The state ties this callback to the login this browser started: it
      // must equal the value inside the signed cookie. The signature is the
      // security; the comparison is just equality.
      const returnedState = String(req.query.state || '');
      if (!st || !returnedState || returnedState !== st.s) {
        return res.status(400).type('html').send(page('Sign in did not complete', 'The sign in attempt could not be verified. Please try again.'));
      }
      if (req.query.error || !req.query.code) {
        return res.status(400).type('html').send(page('Sign in did not complete', 'Microsoft did not complete the sign in. Please try again.'));
      }
      // The code becomes a token server-to-server, then identity is read from
      // Graph with that token. Nothing the browser sent is trusted as identity.
      const tokenRes = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(process.env.MS_TENANT_ID)}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: process.env.MS_CLIENT_ID,
          client_secret: process.env.MS_CLIENT_SECRET,
          grant_type: 'authorization_code',
          code: String(req.query.code),
          redirect_uri: callbackUri(req),
          code_verifier: String(st.v),
        }),
      });
      if (!tokenRes.ok) {
        console.error('[auth] token exchange failed:', tokenRes.status, (await tokenRes.text()).slice(0, 200));
        return res.status(502).type('html').send(page('Sign in did not complete', 'The sign in could not be completed. Please try again.'));
      }
      const tokens = await tokenRes.json();
      const meRes = await fetch('https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName', {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      });
      if (!meRes.ok) {
        console.error('[auth] graph /me failed:', meRes.status);
        return res.status(502).type('html').send(page('Sign in did not complete', 'Your identity could not be read. Please try again.'));
      }
      const me = await meRes.json();
      if (!isAllowed(me)) {
        console.warn(`[auth] refused: ${me.mail || me.userPrincipalName} is not on the access list`);
        return res.status(403).type('html').send(page('This account is not on the access list',
          'You signed in successfully, but this account has not been given access to the PCT Engine. Ask John to add your address.'));
      }
      const email = String(me.mail || me.userPrincipalName).toLowerCase();
      res.cookie(SESSION_COOKIE,
        signPayload({ e: email, n: me.displayName || null }, sessionSecret(), { maxAgeMs: SESSION_DAYS * 24 * 60 * 60 * 1000 }),
        { ...cookieOpts(), maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000 });
      console.log(`[auth] signed in: ${email}`);
      res.redirect('/');
    } catch (e) {
      console.error('[auth] callback failed:', e.message);
      res.status(500).type('html').send(page('Sign in did not complete', 'Something went wrong during sign in. Please try again.'));
    }
  });

  app.post('/auth/logout', (req, res) => {
    res.clearCookie(SESSION_COOKIE, cookieOpts());
    res.json({ ok: true });
  });
}
