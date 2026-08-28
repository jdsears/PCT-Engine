import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from './api.js';
import { companyLabel } from './labels.js';
import { withCampaign } from './CampaignSwitcher.jsx';

// The LinkedIn studio. The engine drafts posts from its gated signals, a
// person approves each one, and since 24 August 2026 the autopilot releases
// approved posts at the standing Tuesday, Wednesday and Thursday morning
// slots, one per lane per day, story link as the first comment. Post now
// still publishes immediately on a click. Invites release through the drip
// in weekday working hours, spaced and capped tighter than the hand cap,
// timed around the emails: from the approved list, or, under the standing
// sanction of 24 August 2026, selected automatically from the whole queue,
// screened by the recipient nets, best accounts first, Skip as the veto.
// After two unanswered emails, a person who accepted an invitation gets one
// message from that same account, drafted here and released the same way.
// Nothing unapproved ever posts, and every invite and message rests on a
// recorded sanction.

const TABS = [
  { id: 'draft', label: 'Post drafts' },
  { id: 'approved', label: 'Approved queue' },
  { id: 'posted', label: 'Posted' },
  { id: 'interest', label: 'Interest' },
  { id: 'connects', label: 'Connect queue' },
  { id: 'messages', label: 'Messages' },
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
  const queued = post.status === 'approved';

  // A refused action must say why. This used to swallow the server's reason,
  // and a reject that failed looked like a button doing nothing, which is how
  // "it won't let me reject" reached John with no reason attached.
  const run = async (fn) => {
    setBusy(true); setMsg(null);
    try { await fn(); onChanged(); }
    catch (e) { setMsg(String(e.message || e)); }
    setBusy(false);
  };
  const save = () => run(() => action(`/api/studio/posts/${post.id}`, jsonOpts('PATCH', { body })));
  const posted = () => run(() => action(`/api/studio/posts/${post.id}/posted`, jsonOpts('POST')));
  const reject = () => run(() => action(`/api/studio/posts/${post.id}/reject`, jsonOpts('POST')));
  const approve = () => run(() => action(`/api/studio/posts/${post.id}/approve`, jsonOpts('POST')));
  const unapprove = () => run(() => action(`/api/studio/posts/${post.id}/unapprove`, jsonOpts('POST')));
  const publish = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await action(`/api/studio/posts/${post.id}/post`, jsonOpts('POST'));
      setMsg(r.commented
        ? 'Posted, and the story link went up as the first comment.'
        : r.commentLink
          ? `Posted. The story comment could not be added; paste it yourself: ${r.commentLink}`
          : 'Posted through the connected account.');
      onChanged();
    } catch (e) { setMsg(String(e.message || e)); }
    setBusy(false);
  };

  return (
    <div className="card ob-card">
      <div className="ob-head">
        <div className="ob-co">{post.topic || 'Post'}</div>
        {post.source && <a className="ob-ev-src" href={post.source} target="_blank" rel="noreferrer">source story</a>}
        {/* The story's own date, beside the link, so age is visible before a
            post goes out; a source that states no date says so plainly. */}
        <span className="muted-small">{post.storyDate ? `story date ${String(post.storyDate).slice(0, 10)}` : 'story date not stated by the source'}</span>
      </div>
      {post.flags.length > 0 && (
        <div className="ob-flags">
          <div className="eyebrow">Review before posting</div>
          {post.flags.map((f, i) => <div className="ob-flag-line" key={i}>{f}</div>)}
        </div>
      )}
      <textarea className="ob-body" rows={8} value={body} disabled={!open || busy} onChange={e => setBody(e.target.value)} />
      <div className="muted-small">
        Hashtags publish with the post: {(post.hashtags || []).join(' ')}{post.source ? '. The story link posts as the first comment automatically, in the same click.' : ''}
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
          <button className="ob-btn" onClick={publish} disabled={busy || dirty || post.flags.length > 0}
            title={post.flags.length ? 'Clear the flags by editing before posting'
              : dirty ? 'Save your edit first, so what posts is what you see'
              : 'Posts this text immediately, with the hashtags and the story link as the first comment, through the connected LinkedIn account.'}>
            Post now
          </button>
          <button className="ob-btn primary" onClick={approve} disabled={busy || dirty || post.flags.length > 0}
            title={post.flags.length ? 'Clear the flags by editing before approving'
              : dirty ? 'Save your edit first, so what queues is what you see'
              : 'Approves this text into the queue. The next open slot (Tuesday, Wednesday or Thursday morning) posts it exactly as approved.'}>
            Approve for the queue
          </button>
        </div>
      )}
      {queued && (
        <div className="ob-actions">
          <span className="muted-small">Approved and queued. The next open slot posts it, oldest first, one per day.</span>
          <span className="ob-spacer" />
          <button className="ob-btn ghost" onClick={reject} disabled={busy}>Reject</button>
          <button className="ob-btn" onClick={unapprove} disabled={busy}
            title="Returns the post to the drafts for editing. Nothing is lost.">
            Back to drafts
          </button>
          <button className="ob-btn primary" onClick={publish} disabled={busy}
            title="Posts it now rather than waiting for the slot.">
            Post now
          </button>
        </div>
      )}
      {post.status === 'posted' && <Engagers postId={post.id} />}
      {msg && <div className="muted-small">{msg}</div>}
    </div>
  );
}

// Who engaged with a published post, on one click: each row analysed, orbit
// fit and register match, strongest prospects first. Adding one as a contact
// is the only action, and only on a matched account; everyone else is Sales
// Navigator material, which the row says.
function Engagers({ postId }) {
  const [state, setState] = useState('idle');
  const [data, setData] = useState(null);
  const [notes, setNotes] = useState({});

  const load = async () => {
    setState('loading');
    try {
      const r = await apiFetch(`/api/studio/posts/${postId}/engagers`);
      const d = await r.json();
      setData(d); setState('ready');
    } catch { setState('error'); }
  };

  const addContact = async (i, e) => {
    try {
      const r = await action('/api/studio/engagers/contact', jsonOpts('POST', {
        companyId: e.matchedCompanyId, name: e.name, roleTitle: e.role,
        linkedinUrl: e.profileUrl, campaign: data.campaign,
      }));
      setNotes(n => ({ ...n, [i]: r.created ? `added to ${e.matchedCompanyName}${r.inOrbit ? ', in the decision orbit' : ''}` : r.note }));
    } catch (err) { setNotes(n => ({ ...n, [i]: String(err.message || err) })); }
  };

  // An unmatched company whose people engage goes to the review queue, where
  // confirming it is what creates the account. The engine never adds it alone.
  const propose = async (i, e) => {
    try {
      const r = await action('/api/studio/engagers/propose', jsonOpts('POST', {
        companyName: e.company, campaign: data.campaign,
        engager: { name: e.name, headline: e.headline || e.role || null }, postId,
      }));
      setNotes(n => ({ ...n, [i]: r.note }));
    } catch (err) { setNotes(n => ({ ...n, [i]: String(err.message || err) })); }
  };

  if (state === 'idle') {
    return <div><button className="ob-btn" onClick={load}
      title="Reads who reacted to this post through the connected account. One call, counted against the daily cap.">Who engaged</button></div>;
  }
  if (state === 'loading') return <div className="muted-small">Reading reactions.</div>;
  if (state === 'error') return <div className="muted-small">Engagement is not available right now.</div>;
  if (!data.ok) return <div className="muted-small">{data.reason}</div>;
  if (!data.engagers.length) {
    return <div className="muted-small">No reactions yet{data.raw > 0 ? ` (${data.unparsed} could not be read)` : ''}.</div>;
  }
  return (
    <div className="eng-list">
      <div className="eyebrow">Engagement, strongest prospects first</div>
      {data.engagers.map((e, i) => (
        <div className="eng-row" key={i}>
          <div className="eng-main">
            <span className="eng-name">{e.profileUrl
              ? <a href={e.profileUrl} target="_blank" rel="noreferrer">{e.name}</a> : e.name}</span>
            {e.role && <span className="muted-small">{e.role}</span>}
            {e.company && <span className="muted-small">{e.company}</span>}
          </div>
          <div className="eng-side">
            {e.orbitFit && <span className="pill">Orbit fit</span>}
            {e.matchedCompanyName && <span className="pill">{e.matchedCompanyName}</span>}
            {e.matchedCompanyId
              ? <button className="ob-btn" onClick={() => addContact(i, e)}>Add as contact</button>
              : e.company
                ? <button className="ob-btn" onClick={() => propose(i, e)}
                    title="Sends the company to the review queue with this engagement as evidence. Confirming it there is what creates the account.">
                    Propose company
                  </button>
                : <span className="muted-small">No company in the headline</span>}
          </div>
          {notes[i] && <div className="muted-small eng-note">{notes[i]}</div>}
        </div>
      ))}
      {data.unparsed > 0 && <div className="muted-small">{data.unparsed} reaction(s) could not be read into a name and were not shown.</div>}
    </div>
  );
}

// The interest queue: everything the automatic sweeps gathered across the
// lane's posts, strongest prospects first, each row decided once by a person.
// Add as contact needs a matched account; propose sends an unknown company to
// the review queue with the engagement as evidence; dismiss is remembered.
function InterestQueue({ campaign }) {
  const [data, setData] = useState(null);
  const [state, setState] = useState('loading');
  const [notes, setNotes] = useState({});

  const load = useCallback(() => {
    setState('loading');
    apiFetch(withCampaign('/api/studio/interest', campaign)).then(r => r.json())
      .then(d => { setData(d); setState('ready'); })
      .catch(() => setState('error'));
  }, [campaign]);
  useEffect(() => { load(); }, [load]);

  const act = async (row, verb) => {
    try {
      const r = await action(`/api/studio/interest/${row.id}/${verb}`, jsonOpts('POST'));
      if (r.note) setNotes(n => ({ ...n, [row.id]: r.note }));
      if (verb !== 'propose' || r.proposed) setTimeout(load, 1200);
      if (verb === 'propose' && r.matched) load();
    } catch (e) { setNotes(n => ({ ...n, [row.id]: String(e.message || e) })); }
  };

  if (state === 'loading') return <p className="muted-note">Loading the interest queue.</p>;
  if (state === 'error') return <p className="muted-note">The interest queue is not available right now.</p>;
  if (data?.migrationPending) return <p className="muted-note">The interest queue arrives with the next migration.</p>;
  if (!data?.interest?.length) {
    return <p className="muted-note">Nothing waiting. The autopilot reads each published post's reactions a couple of days after it goes up and sorts them here.</p>;
  }
  return (
    <div className="eng-list">
      <div className="eyebrow">Interest, strongest prospects first</div>
      {data.interest.map(e => (
        <div className="eng-row" key={e.id}>
          <div className="eng-main">
            <span className="eng-name">{e.profileUrl
              ? <a href={e.profileUrl} target="_blank" rel="noreferrer">{e.name}</a> : e.name}</span>
            {e.role && <span className="muted-small">{e.role}</span>}
            {e.company && <span className="muted-small">{e.company}</span>}
            <span className="muted-small">engaged with: {e.postTopic}</span>
          </div>
          <div className="eng-side">
            {e.orbitFit && <span className="pill">Orbit fit</span>}
            {e.matchedCompanyName && <span className="pill">{e.matchedCompanyName}</span>}
            {e.matchedCompanyId
              ? <button className="ob-btn" onClick={() => act(e, 'contact')}>Add as contact</button>
              : e.company
                ? <button className="ob-btn" onClick={() => act(e, 'propose')}
                    title="Sends the company to the review queue with this engagement as evidence.">
                    Propose company
                  </button>
                : null}
            <button className="ob-btn ghost" onClick={() => act(e, 'dismiss')}
              title="Remembered: this person will not queue again on this campaign.">
              Dismiss
            </button>
          </div>
          {notes[e.id] && <div className="muted-small eng-note">{notes[e.id]}</div>}
        </div>
      ))}
    </div>
  );
}

// One message, to someone who accepted the invitation and has not replied to
// two emails. Editable until approved, blocked while it carries a flag, and
// released by the drip inside the same pace and caps as the invites.
function MessageCard({ message, onChanged }) {
  const [body, setBody] = useState(message.body);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const dirty = body !== message.body;
  const open = message.status === 'draft';
  const run = async (fn) => {
    setBusy(true); setMsg(null);
    try { await fn(); onChanged(); }
    catch (e) { setMsg(String(e.message || e)); }
    setBusy(false);
  };
  return (
    <div className="card ob-card">
      <div className="ob-head">
        <div className="ob-co">{message.name}</div>
        <div className="ob-pills">
          <span className="pill">{companyLabel(message.company)}</span>
          {message.status === 'approved' && <span className="pill">Approved for the drip</span>}
        </div>
      </div>
      <div className="ob-to">{message.role || 'Role not recorded'}{message.linkedin
        ? <> · <a href={message.linkedin} target="_blank" rel="noreferrer">profile</a></> : null}</div>
      {message.flags.length > 0 && (
        <div className="ob-flags">
          <div className="eyebrow">Review before sending</div>
          {message.flags.map((f, i) => <div className="ob-flag-line" key={i}>{f}</div>)}
        </div>
      )}
      <textarea className="ob-body" rows={5} value={body} disabled={!open || busy}
        onChange={e => setBody(e.target.value)} />
      <div className="muted-small">
        {message.status === 'sent'
          ? `Sent ${message.sentAt ? new Date(message.sentAt).toLocaleDateString() : ''}${message.sentBy ? ` by ${message.sentBy}` : ''}.`
          : 'Sends from this campaign\'s own LinkedIn account, in a weekday working-hours slot, within the same daily cap as the invites.'}
      </div>
      {open && (
        <div className="ob-actions">
          {dirty && <button className="ob-btn" onClick={() => run(() => action(`/api/studio/messages/${message.id}`, jsonOpts('PATCH', { body })))} disabled={busy}>Save changes</button>}
          <span className="ob-spacer" />
          <button className="ob-btn ghost" onClick={() => run(() => action(`/api/studio/messages/${message.id}/reject`, jsonOpts('POST')))} disabled={busy}>Reject</button>
          <button className="ob-btn primary" onClick={() => run(() => action(`/api/studio/messages/${message.id}/approve`, jsonOpts('POST')))}
            disabled={busy || dirty || message.flags.length > 0}
            title={message.flags.length ? 'Clear the flags by editing first'
              : dirty ? 'Save your edit first, so what sends is what you see'
              : 'Approves this message. The drip sends it in the next working-hours slot.'}>
            Approve
          </button>
        </div>
      )}
      {message.status === 'approved' && (
        <div className="ob-actions">
          <span className="muted-small">Waiting for the next slot.</span>
          <span className="ob-spacer" />
          <button className="ob-btn ghost" onClick={() => run(() => action(`/api/studio/messages/${message.id}/reject`, jsonOpts('POST')))} disabled={busy}>Reject</button>
        </div>
      )}
      {msg && <div className="ob-msg">{msg}</div>}
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
  const queued = !!person.approvedAt;
  return (
    <div className="card ob-card">
      <div className="ob-head">
        <div className="ob-co">{person.name}</div>
        <div className="ob-pills">
          {person.score != null && <span className="pill">ICP {person.score}</span>}
          <span className="pill">{companyLabel(person.company)}</span>
          {queued && <span className="pill">Approved for the drip</span>}
        </div>
      </div>
      <div className="ob-to">{person.role || 'Role not recorded'}</div>
      <label className="ob-field">
        <span className="eyebrow">{queued ? 'Invite note, frozen at approval' : 'Invite note (sent with the invite, edit first)'}</span>
        <textarea className="ob-body" rows={3} maxLength={300} value={note} disabled={busy || queued} onChange={e => setNote(e.target.value)} />
      </label>
      {queued ? (
        <div className="ob-actions">
          <span className="muted-small">The drip releases it in a weekday working-hours slot, spaced and capped, timed around any emails to this person.</span>
          <span className="ob-spacer" />
          <button className="ob-btn" onClick={() => act('unapprove-invite')} disabled={busy}
            title="Returns the person to the ordinary queue. Nothing sends.">
            Unapprove
          </button>
          <button className="ob-btn primary" onClick={() => act('send-invite')} disabled={busy || !inviteInfo?.ready}
            title={!inviteInfo?.ready ? 'Unipile is not configured on this service' : 'Sends it now rather than waiting for the drip.'}>
            Send now
          </button>
        </div>
      ) : (
        <div className="ob-actions">
          <CopyButton text={note} label="Copy note" />
          <a className="ob-btn" href={person.linkedin} target="_blank" rel="noreferrer">Open profile</a>
          <span className="ob-spacer" />
          <button className="ob-btn ghost" onClick={() => act('skip-invite')} disabled={busy}
            title="Never invite this person on LinkedIn, in any mode. Email is untouched. Recorded, permanent, and the queue stops offering them.">
            Not for LinkedIn
          </button>
          <button className="ob-btn ghost" onClick={() => act('invited')} disabled={busy}>Mark done</button>
          <button className="ob-btn" onClick={() => act('approve-invite')} disabled={busy}
            title="Approves this person's invite with this exact note. The drip releases approved invites one at a time, weekdays, working hours, within tight caps, a few days after any email with no reply.">
            Approve for the drip
          </button>
          <button className="ob-btn primary" onClick={() => act('send-invite')} disabled={busy || !inviteInfo?.ready}
            title={!inviteInfo?.ready ? 'Unipile is not configured on this service' : undefined}>
            Send invite
          </button>
        </div>
      )}
      {msg && <div className="ob-msg">{msg}</div>}
    </div>
  );
}

export default function Studio({ campaign }) {
  const [tab, setTab] = useState('draft');
  const [posts, setPosts] = useState([]);
  const [connects, setConnects] = useState([]);
  const [messages, setMessages] = useState([]);
  const [inviteInfo, setInviteInfo] = useState(null);
  const [state, setState] = useState('loading');
  const [note, setNote] = useState(null);
  const [genBusy, setGenBusy] = useState(false);

  // The studio follows the app's campaign switcher like every other page,
  // John's ask of 18 August 2026, so James works the data centre posts and
  // connects while Andy works pharma, each seeing only their own queue.
  const load = useCallback((t) => {
    // The interest tab loads itself inside its component; the shell only has
    // to stand out of the way.
    if (t === 'interest') { setState('ready'); return; }
    const req = t === 'messages'
      ? apiFetch(withCampaign('/api/studio/messages', campaign)).then(r => r.json()).then(d => setMessages(d.messages || []))
      : t === 'connects'
      ? apiFetch(withCampaign('/api/studio/connects', campaign)).then(r => r.json()).then(d => {
          setConnects(d.connects || []);
          setInviteInfo({ ready: !!d.inviteReady, today: d.invitesToday ?? 0, cap: d.inviteCap ?? 0, dripOn: !!d.dripOn, dripAuto: !!d.dripAuto });
        })
      : apiFetch(withCampaign(`/api/studio/posts?status=${t}`, campaign)).then(r => r.json()).then(d => setPosts(d.posts || []));
    req.then(() => setState('ready')).catch(() => setState('error'));
  }, [campaign]);
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
        <p className="ob-banner-sub">The engine drafts the posts and queues the people; you approve each post you want published. Approved posts go out by themselves on Tuesday, Wednesday and Thursday mornings, one per campaign per day, hashtags in the post and the story link as its first comment, and Post now still publishes immediately. Nothing unapproved ever posts. Invites release through the drip, a few per weekday through working hours, timed around the emails: from the approved list, or from the whole queue when automatic selection is on, screened and best accounts first, with Skip as the veto. After two unanswered emails, someone who accepted an invitation gets one message from this account, drafted here and released the same way. Nothing unapproved ever posts, and every invite and message rests on a recorded sanction.</p>
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
      {state === 'ready' && tab === 'interest' && <InterestQueue campaign={campaign} />}
      {state === 'ready' && tab === 'messages' && messages.length === 0 && (
        <p className="muted-note">No messages waiting. One is drafted for each person who accepts an invitation and has still not replied to the emails.</p>
      )}
      {state === 'ready' && tab === 'messages' && messages.map(m => <MessageCard key={m.id} message={m} onChanged={refresh} />)}
      {state === 'ready' && !['connects', 'interest', 'messages'].includes(tab) && posts.length === 0 && (
        <p className="muted-note">{tab === 'draft' ? 'No post drafts yet. Draft posts from this week to get started.'
          : tab === 'approved' ? 'Nothing approved and waiting. Approve a draft and the next open slot posts it.'
          : 'Nothing marked posted yet.'}</p>
      )}
      {state === 'ready' && !['connects', 'interest', 'messages'].includes(tab) && posts.map(p => <PostCard key={p.id} post={p} onChanged={refresh} />)}
      {state === 'ready' && tab === 'connects' && inviteInfo && (
        <p className="muted-note">
          {inviteInfo.ready
            ? `Invites send through each campaign's own connected account${inviteInfo.dripOn ? (inviteInfo.dripAuto ? '. The drip selects automatically from this queue, best accounts first; Skip anyone you would rather not connect with' : '. The drip releases the people you approve') : '. The drip is off; the Health page turns it on'}. ${inviteInfo.today} of ${inviteInfo.cap} used today.`
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
