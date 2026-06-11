import { useState } from 'react';

// The access gate as designed, now real. It posts the shared key; on success the
// server sets an httpOnly cookie and we reload so every section refetches with
// the session in place. A forced gate (shown after a 401) cannot be dismissed
// without entering; a manually opened one closes when you click away.
export default function Gate({ onClose, forced }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

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

  return (
    <div className="gate" onClick={forced ? undefined : onClose}>
      <div className="gate-col" onClick={e => e.stopPropagation()}>
        <img src="/assets/pct-logo-color.svg" alt="PCT" className="gate-logo" />
        <div className="card gate-card">
          <label htmlFor="pct-access-key" className="eyebrow">Access key</label>
          <input id="pct-access-key" type="password" autoComplete="off" value={key}
            onChange={e => { setKey(e.target.value); setError(false); }}
            onKeyDown={e => e.key === 'Enter' && submit()}
            disabled={busy} aria-invalid={error || undefined} autoFocus />
          {error && <div className="gate-error">That key was not recognised.</div>}
          <button onClick={submit} disabled={busy || !key}>{busy ? 'Checking' : 'Enter'}</button>
        </div>
        <div className="gate-note">Shared access key for the pilot. Microsoft sign in comes in a later phase.</div>
      </div>
    </div>
  );
}
