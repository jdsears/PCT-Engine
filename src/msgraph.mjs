// App-only Microsoft Graph client. Client credentials flow, token cached until near expiry.
let cached = { token: null, exp: 0 };

export async function graphToken() {
  if (cached.token && Date.now() < cached.exp - 60_000) return cached.token;
  const res = await fetch(`https://login.microsoftonline.com/${process.env.MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.MS_CLIENT_ID,
      client_secret: process.env.MS_CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) throw new Error(`Token request failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  cached = { token: json.access_token, exp: Date.now() + json.expires_in * 1000 };
  return cached.token;
}

export async function graph(path, opts = {}) {
  const token = await graphToken();
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  });
  return res;
}

// Convenience JSON wrapper that surfaces Graph's error body on failure.
export async function graphJson(path, opts = {}) {
  const res = await graph(path, opts);
  const body = await res.text();
  if (!res.ok) { const e = new Error(`Graph ${res.status} on ${path}: ${body}`); e.status = res.status; throw e; }
  return body ? JSON.parse(body) : null;
}
