import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from './api.js';
import { companyLabel } from './labels.js';

// The LinkedIn studio. The engine drafts posts from its gated signals and
// queues the decision-orbit people worth connecting with; a human copies and
// acts from their own LinkedIn account, then marks it done. Nothing here posts
// or sends an invite, by design: the lane stays read-only.

const TABS = [
  { id: 'draft', label: 'Post drafts' },
  { id: 'posted', label: 'Posted' },
  { id: 'connects', label: 'Connect queue' },
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

function CopyButton({ text, label = 'Copy' }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 2000); }
    catch { /* the browser refused; the text is still selectable by hand */ }
  };
  return <button className="ob-btn" onClick={copy}>{done ? 'Copied' : label}</button>;
}

function PostCard({ post, onChanged }) {
  const [body, setBody] = useState(post.body);
  const [busy, setBusy] = useState(false);
  const dirty = body !== post.body;
  const open = post.status === 'draft';

  const run = async (fn) => { setBusy(true); try { await fn(); onChanged(); } catch { /* refresh shows truth */ } setBusy(false); };
  const save = () => run(() => action(`/api/studio/posts/${post.id}`, jsonOpts('PATCH', { body })));
  const posted = () => run(() => action(`/api/studio/posts/${post.id}/posted`, jsonOpts('POST')));
  const reject = () => run(() => action(`/api/studio/posts/${post.id}/reject`, jsonOpts('POST')));

  return (
    <div className="card ob-card">
      <div className="ob-head">
        <div className="ob-co">{post.topic || 'Post'}</div>
        {post.source && <a className="ob-ev-src" href={post.source} target="_blank" rel="noreferrer">source story</a>}
      </div>
      {post.flags.length > 0 && (
        <div className="ob-flags">
          <div className="eyebrow">Review before posting</div>
          {post.flags.map((f, i) => <div className="ob-flag-line" key={i}>{f}</div>)}
        </div>
      )}
      <textarea className="ob-body" rows={6} value={body} disabled={!open || busy} onChange={e => setBody(e.target.value)} />
      {open && (
        <div className="ob-actions">
          {dirty && <button className="ob-btn" onClick={save} disabled={busy}>Save changes</button>}
          <CopyButton text={body} label="Copy post" />
          <span className="ob-spacer" />
          <button className="ob-btn ghost" onClick={reject} disabled={busy}>Reject</button>
          <button className="ob-btn primary" onClick={posted} disabled={busy || dirty || post.flags.length > 0}
            title={post.flags.length ? 'Clear the flags by editing before marking posted' : undefined}>
            Mark as posted
          </button>
        </div>
      )}
    </div>
  );
}

function ConnectCard({ person, onChanged }) {
  const [busy, setBusy] = useState(false);
  const invited = async () => {
    setBusy(true);
    try { await action(`/api/studio/connects/${person.id}/invited`, jsonOpts('POST', { note: person.note })); onChanged(); }
    catch { /* refresh shows truth */ }
    setBusy(false);
  };
  return (
    <div className="card ob-card">
      <div className="ob-head">
        <div className="ob-co">{person.name}</div>
        <div className="ob-pills">
          {person.score != null && <span className="pill">ICP {person.score}</span>}
          <span className="pill">{companyLabel(person.company)}</span>
        </div>
      </div>
      <div className="ob-to">{person.role || 'Role not recorded'}</div>
      <div className="ob-evidence">
        <div className="eyebrow">Suggested note (edit as you like when sending)</div>
        <div className="ob-ev-line">{person.note}</div>
      </div>
      <div className="ob-actions">
        <CopyButton text={person.note} label="Copy note" />
        <a className="ob-btn" href={person.linkedin} target="_blank" rel="noreferrer">Open profile</a>
        <span className="ob-spacer" />
        <button className="ob-btn primary" onClick={invited} disabled={busy}>Mark invited</button>
      </div>
    </div>
  );
}

export default function Studio() {
  const [tab, setTab] = useState('draft');
  const [posts, setPosts] = useState([]);
  const [connects, setConnects] = useState([]);
  const [state, setState] = useState('loading');
  const [note, setNote] = useState(null);
  const [genBusy, setGenBusy] = useState(false);

  const load = useCallback((t) => {
    const req = t === 'connects'
      ? apiFetch('/api/studio/connects').then(r => r.json()).then(d => setConnects(d.connects || []))
      : apiFetch(`/api/studio/posts?status=${t}`).then(r => r.json()).then(d => setPosts(d.posts || []));
    req.then(() => setState('ready')).catch(() => setState('error'));
  }, []);
  useEffect(() => { load(tab); }, [tab, load]);
  const refresh = () => load(tab);

  const generate = async () => {
    setGenBusy(true); setNote(null);
    try {
      const r = await action('/api/studio/posts/generate', jsonOpts('POST', { limit: 3 }));
      setNote(`Drafted ${r.drafted} post(s) from the latest signals${r.flagged ? `, ${r.flagged} flagged for review` : ''}${r.failed ? `, ${r.failed} failed` : ''}. ${r.considered === 0 ? 'No unused signals right now; the engine will find more.' : ''}`);
      refresh();
    } catch (e) { setNote(String(e.message || 'Generation is not available right now.')); }
    setGenBusy(false);
  };

  return (
    <div className="content-pad outbound-queue">
      <div className="card ob-banner">
        <p className="ob-banner-sub">The engine drafts the posts and queues the people; you post and connect from your own LinkedIn account, then mark each done here. Nothing is ever posted or sent on your behalf.</p>
        <div className="ob-banner-controls">
          <button className="ob-btn primary" onClick={generate} disabled={genBusy}>{genBusy ? 'Drafting now' : 'Draft posts from this week'}</button>
        </div>
        {note && <p className="ob-banner-sub">{note}</p>}
      </div>

      <div className="ob-tabs">
        {TABS.map(t => (
          <button key={t.id} className={`ob-tab${tab === t.id ? ' active' : ''}`} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      {state === 'loading' && <p className="muted-note">Loading the studio.</p>}
      {state === 'error' && <p className="muted-note">The studio is not available right now.</p>}
      {state === 'ready' && tab !== 'connects' && posts.length === 0 && (
        <p className="muted-note">{tab === 'draft' ? 'No post drafts yet. Draft posts from this week to get started.' : 'Nothing marked posted yet.'}</p>
      )}
      {state === 'ready' && tab !== 'connects' && posts.map(p => <PostCard key={p.id} post={p} onChanged={refresh} />)}
      {state === 'ready' && tab === 'connects' && connects.length === 0 && (
        <p className="muted-note">No one waiting in the connect queue. People appear here as the research identifies decision makers with LinkedIn profiles.</p>
      )}
      {state === 'ready' && tab === 'connects' && connects.map(p => <ConnectCard key={p.id} person={p} onChanged={refresh} />)}
    </div>
  );
}
