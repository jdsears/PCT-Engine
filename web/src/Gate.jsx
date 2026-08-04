import { useState, useEffect } from 'react';

// The access gate. Microsoft sign in is the way in for named users, John,
// James and Andy; the pilot's shared key stays alongside while the sign-in
// is being rolled out, and disappears from here the day the key is removed
// from the service. A forced gate (shown after a 401) cannot be dismissed
// without entering; a manually opened one closes when you click away, and
// for a signed-in person it shows who they are and offers sign out.
export default function Gate({ onClose, forced }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [status, setStatus] = useState(null);

  useEffect(() => {
    fetch('/api/access/status').then(r => r.json()).then(setStatus).catch(() => setStatus({}));
  }, []);

  async function submit() {
    if (busy || !key) return;
    setBusy(true);
    setError(false);
    try {
      const res = await fetch('/api/access', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      if (res.ok) { window.location.reload(); return; }
    } catch { /* fall through to the error state */ }
    setError(true);
    setBusy(false);
  }

  async function signOut() {
    try { await fetch('/auth/logout', { method: 'POST' }); } catch { /* reload shows the truth */ }
    window.location.reload();
  }

  const microsoft = status?.microsoft;
  const sharedKey = status?.sharedKey ?? true;
  const user = status?.user;

  return (
    <div className="gate" onClick={forced ? undefined : onClose}>
      <div className="gate-col" onClick={e => e.stopPropagation()}>
        <img src="/assets/pct-logo-color.svg" alt="PCT" className="gate-logo" />
        <div className="card gate-card">
          {user ? (
            <>
              <div className="eyebrow">Signed in</div>
              <div className="gate-user">{user.name || user.email}</div>
              <div className="gate-note-inline">{user.email}</div>
              <button onClick={signOut}>Sign out</button>
            </>
          ) : (
            <>
              {microsoft && (
                <button className="gate-ms" onClick={() => { window.location.href = '/auth/login'; }}>
                  Sign in with Microsoft
                </button>
              )}
              {microsoft && sharedKey && <div className="gate-note-inline">or use the shared key</div>}
              {sharedKey && (
                <>
                  <label htmlFor="pct-access-key" className="eyebrow">Access key</label>
                  <input id="pct-access-key" type="password" autoComplete="off" value={key}
                    onChange={e => { setKey(e.target.value); setError(false); }}
                    onKeyDown={e => e.key === 'Enter' && submit()}
                    disabled={busy} aria-invalid={error || undefined} autoFocus={!microsoft} />
                  {error && <div className="gate-error">That key was not recognised.</div>}
                  <button onClick={submit} disabled={busy || !key}>{busy ? 'Checking' : 'Enter'}</button>
                </>
              )}
            </>
          )}
        </div>
        <div className="gate-note">
          {microsoft
            ? 'Sign in with your Microsoft account. Access is limited to named PCT Engine users.'
            : 'Shared access key for the pilot. Microsoft sign in comes in a later phase.'}
        </div>
      </div>
    </div>
  );
}
