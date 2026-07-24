import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from './api.js';
import { companyLabel } from './labels.js';

// The LinkedIn studio. The engine drafts posts from its gated signals and
// queues the decision-orbit people worth connecting with. Posts are never
// published on James's behalf: he copies and posts himself. Invites can send
// through the connected account, but only one at a time, only when a person
// clicks Send invite on a named contact, and only within the daily cap; the
// note is editable first and Mark done still records invites sent by hand.

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
  const [msg, setMsg] = useState(null);
  const dirty = body !== post.body;
  const open = post.status === 'draft';

  const run = async (fn) => { setBusy(true); try { await fn(); onChanged(); } catch { /* refresh shows truth */ } setBusy(false); };
  const save = () => run(() => action(`/api/studio/posts/${post.id}`, jsonOpts('PATCH', { body })));
  const posted = () => run(() => action(`/api/studio/posts/${post.id}/posted`, jsonOpts('POST')));
  const reject = () => run(() => action(`/api/studio/posts/${post.id}/reject`, jsonOpts('POST')));
  const publish = async () => {
    setBusy(true); setMsg(null);
    try {
      await action(`/api/studio/posts/${post.id}/post`, jsonOpts('POST'));
      setMsg('Posted through the connected account.');
      onChanged();
    } catch (e) { setMsg(String(e.message || e)); }
    setBusy(false);
  };

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
      <textarea className="ob-body" rows={8} value={body} disabled={!open || busy} onChange={e => setBody(e.target.value)} />
      <div className="muted-small">
        Added underneath automatically:{post.source ? ' the story link and' : ''} {(post.hashtags || []).join(' ')}
      </div>
      {open && (
        <div className="ob-actions">
          {dirty && <button className="ob-btn" onClick={save} disabled={busy}>Save changes</button>}
          <CopyButton text={post.preview || body} label="Copy full post" />
          <span className="ob-spacer" />
          <button className="ob-btn ghost" onClick={reject} disabled={busy}>Reject</button>
          <button className="ob-btn" onClick={posted} disabled={busy || dirty || post.flags.length > 0}
            title="For a post you published by hand: records it as posted without sending anything.">
            Mark as posted
          </button>
          <button className="ob-btn primary" onClick={publish} disabled={busy || dirty || post.flags.length > 0}
            title={post.flags.length ? 'Clear the flags by editing before posting'
              : dirty ? 'Save your edit first, so what posts is what you see'
              : 'Posts this text, with the story link and hashtags, through the connected LinkedIn account. One click, one post, capped per day.'}>
            Post to LinkedIn
          </button>
        </div>
      )}
      {msg && <div className="muted-small">{msg}</div>}
    </div>
  );
}

function ConnectCard({ person, inviteInfo, onChanged }) {
  const [note, setNote] = useState(person.note);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const act = async (path) => {
    setBusy(true); setMsg(null);
    try {
      const r = await action(`/api/studio/connects/${person.id}/${path}`, jsonOpts('POST', { note }));
      if (path === 'send-invite') {
        if (r.sent) { setMsg('Invite sent.'); onChanged(); }
        else setMsg(`Not sent: ${r.reason}.`);
      } else onChanged();
    } catch (e) { setMsg(String(e.message || e)); }
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
      <label className="ob-field">
        <span className="eyebrow">Invite note (sent with the invite, edit first)</span>
        <textarea className="ob-body" rows={3} maxLength={300} value={note} disabled={busy} onChange={e => setNote(e.target.value)} />
      </label>
      <div className="ob-actions">
        <CopyButton text={note} label="Copy note" />
        <a className="ob-btn" href={person.linkedin} target="_blank" rel="noreferrer">Open profile</a>
        <span className="ob-spacer" />
        <button className="ob-btn ghost" onClick={() => act('invited')} disabled={busy}>Mark done</button>
        <button className="ob-btn primary" onClick={() => act('send-invite')} disabled={busy || !inviteInfo?.ready}
          title={!inviteInfo?.ready ? 'Unipile is not configured on this service' : undefined}>
          Send invite
        </button>
      </div>
      {msg && <div className="ob-msg">{msg}</div>}
    </div>
  );
}

export default function Studio() {
  const [tab, setTab] = useState('draft');
  const [posts, setPosts] = useState([]);
  const [connects, setConnects] = useState([]);
  const [inviteInfo, setInviteInfo] = useState(null);
  const [state, setState] = useState('loading');
  const [note, setNote] = useState(null);
  const [genBusy, setGenBusy] = useState(false);

  const load = useCallback((t) => {
    const req = t === 'connects'
      ? apiFetch('/api/studio/connects').then(r => r.json()).then(d => {
          setConnects(d.connects || []);
          setInviteInfo({ ready: !!d.inviteReady, today: d.invitesToday ?? 0, cap: d.inviteCap ?? 0 });
        })
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
        <p className="ob-banner-sub">The engine drafts the posts and queues the people. A post publishes through the connected account only when you click Post to LinkedIn on it, one at a time, capped per day, with the story link and hashtags added underneath; copy and publish by hand still works. Invites send the same way, one click per person, note editable first. Nothing ever posts or invites on a schedule.</p>
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
      {state === 'ready' && tab === 'connects' && inviteInfo && (
        <p className="muted-note">
          {inviteInfo.ready
            ? `Invites send from James's own account, one per click, with your approval on each. ${inviteInfo.today} of ${inviteInfo.cap} used today.`
            : 'Sending is off until Unipile is configured on the service; Copy note and Mark done record invites sent by hand.'}
        </p>
      )}
      {state === 'ready' && tab === 'connects' && connects.length === 0 && (
        <p className="muted-note">No one waiting in the connect queue. People appear here as the research identifies decision makers with LinkedIn profiles.</p>
      )}
      {state === 'ready' && tab === 'connects' && connects.map(p => <ConnectCard key={p.id} person={p} inviteInfo={inviteInfo} onChanged={refresh} />)}
    </div>
  );
}
