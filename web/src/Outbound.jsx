import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from './api.js';

const FILTERS = [
  { id: 'draft', label: 'To review' },
  { id: 'approved', label: 'Approved' },
  { id: 'rejected', label: 'Rejected' },
];

async function action(path, opts) {
  const res = await apiFetch(path, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || 'request failed');
  return json;
}
const jsonOpts = (method, payload) => ({
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}),
});

function DraftCard({ draft, recipients, testOn, onChanged }) {
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [to, setTo] = useState(recipients[0] || '');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const open = draft.status === 'draft' || draft.status === 'approved';
  const dirty = subject !== draft.subject || body !== draft.body;
  const r = draft.rationale || {};

  const run = async (fn) => {
    setBusy(true); setMsg(null);
    try { await fn(); } catch (e) { setMsg(String(e.message || e)); setBusy(false); }
  };
  const save = () => run(async () => { await action(`/api/outbound/drafts/${draft.id}`, jsonOpts('PATCH', { subject, body })); onChanged(); });
  const approve = () => run(async () => { await action(`/api/outbound/drafts/${draft.id}/approve`, jsonOpts('POST')); onChanged(); });
  const reject = () => run(async () => { await action(`/api/outbound/drafts/${draft.id}/reject`, jsonOpts('POST')); onChanged(); });
  const sendTest = () => run(async () => {
    const res = await action(`/api/outbound/drafts/${draft.id}/send-test`, jsonOpts('POST', { to }));
    setMsg(res.sent ? `Test sent to ${to}.` : `Not sent: ${res.reason}.`);
    setBusy(false);
  });

  return (
    <div className="card ob-card">
      <div className="ob-head">
        <div className="ob-co">{draft.company}</div>
        <div className="ob-pills">
          {draft.score != null && <span className="pill">ICP {draft.score}</span>}
          {draft.region && <span className="pill">{draft.region}</span>}
          <span className={`pill ob-stat ob-stat-${draft.status}`}>{draft.status}</span>
        </div>
      </div>
      <div className="ob-to">
        {draft.contact
          ? <>To <strong>{draft.contact.name}</strong>{draft.contact.role ? `, ${draft.contact.role}` : ''}{draft.contact.email ? ` · ${draft.contact.email}` : ' · no email on file'}</>
          : <>No named contact resolved yet</>}
      </div>

      <div className="ob-evidence">
        <div className="eyebrow">Why this lead</div>
        {r.reason && <div className="ob-ev-line">{r.reason}</div>}
        {r.topScoreReason && <div className="ob-ev-line muted">{r.topScoreReason}</div>}
      </div>

      <label className="ob-field">
        <span className="eyebrow">Subject</span>
        <input className="ob-input" value={subject} disabled={!open || busy} onChange={e => setSubject(e.target.value)} />
      </label>
      <label className="ob-field">
        <span className="eyebrow">Body</span>
        <textarea className="ob-body" rows={8} value={body} disabled={!open || busy} onChange={e => setBody(e.target.value)} />
      </label>

      {open && (
        <>
          <div className="ob-actions">
            {dirty && <button className="ob-btn" onClick={save} disabled={busy}>Save changes</button>}
            <span className="ob-spacer" />
            <button className="ob-btn ghost" onClick={reject} disabled={busy}>Reject</button>
            {draft.status === 'draft' && <button className="ob-btn primary" onClick={approve} disabled={busy || dirty}>Approve</button>}
            {draft.status === 'approved' && <span className="ob-approved">Approved</span>}
          </div>
          <div className="ob-test">
            <span className="eyebrow">Send a test</span>
            <select className="ob-select" value={to} disabled={!testOn || !recipients.length || busy} onChange={e => setTo(e.target.value)}>
              {recipients.length ? recipients.map(a => <option key={a} value={a}>{a}</option>) : <option value="">no internal recipients set</option>}
            </select>
            <button className="ob-btn" onClick={sendTest} disabled={!testOn || !to || busy}>Send test</button>
            {!testOn && <span className="ob-test-off">test sends are off</span>}
          </div>
        </>
      )}
      {msg && <div className="ob-msg">{msg}</div>}
    </div>
  );
}

export default function Outbound() {
  const [status, setStatus] = useState(null);
  const [filter, setFilter] = useState('draft');
  const [drafts, setDrafts] = useState(null);
  const [state, setState] = useState('loading');

  const loadStatus = useCallback(() => {
    apiFetch('/api/outbound/status').then(r => r.json()).then(setStatus).catch(() => setStatus({ killSwitch: 'unknown' }));
  }, []);
  // setState only inside the async callbacks, never synchronously in the effect:
  // the previous list stays until the new one arrives, matching the other views.
  const loadDrafts = useCallback((f) => {
    apiFetch(`/api/outbound/drafts?status=${f}`).then(r => r.json())
      .then(d => { setDrafts(d.drafts || []); setState('ready'); })
      .catch(() => setState('error'));
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);
  useEffect(() => { loadDrafts(filter); }, [filter, loadDrafts]);
  const refresh = () => { loadStatus(); loadDrafts(filter); };

  const killOn = status?.killSwitch !== 'off';
  const testOn = status?.testSends === 'on';
  const recipients = status?.testRecipients || [];
  const counts = status?.counts || {};

  return (
    <div className="content-pad outbound-queue">
      <div className="card ob-banner">
        <div className="ob-banner-row">
          <div className="kill-status">
            <span className="kill-dot" style={killOn ? undefined : { background: 'var(--teal)' }} />
            {status == null ? 'Checking' : killOn ? 'Production sending off' : 'Production sending ON'}
          </div>
          <div className="ob-banner-note">
            {testOn
              ? `Test sends on, to ${recipients.length} internal address${recipients.length === 1 ? '' : 'es'} only.`
              : 'Test sends off.'}
          </div>
        </div>
        <p className="ob-banner-sub">Drafts queue here for approval. Nothing reaches a prospect: the kill switch governs real sends, and tests go to internal mailboxes only.</p>
      </div>

      <div className="ob-tabs">
        {FILTERS.map(f => (
          <button key={f.id} className={`ob-tab${filter === f.id ? ' active' : ''}`} onClick={() => setFilter(f.id)}>
            {f.label}{counts[f.id] != null ? ` (${counts[f.id]})` : ''}
          </button>
        ))}
      </div>

      {state === 'loading' && <p className="muted-note">Loading drafts.</p>}
      {state === 'error' && <p className="muted-note">Drafts are not available right now.</p>}
      {state === 'ready' && drafts.length === 0 && (
        <p className="muted-note">
          {filter === 'draft'
            ? 'No drafts to review yet. Run the drafter to generate first-touch emails for researched leads.'
            : `No ${filter} drafts yet.`}
        </p>
      )}
      {state === 'ready' && drafts.map(d => (
        <DraftCard key={d.id} draft={d} recipients={recipients} testOn={testOn} onChanged={refresh} />
      ))}
    </div>
  );
}
