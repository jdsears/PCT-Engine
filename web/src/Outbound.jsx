import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from './api.js';
import { withCampaign, CampaignChip, useCampaignList, isAll } from './CampaignSwitcher.jsx';
import { fmtClockDay, companyLabel } from './labels.js';

const FILTERS = [
  { id: 'draft', label: 'To review' },
  { id: 'approved', label: 'Approved' },
  { id: 'conversations', label: 'Conversations' },
  { id: 'replies', label: 'Replies' },
  { id: 'rejected', label: 'Rejected' },
];

const STAGE_LABELS = {
  outbound: 'awaiting reply', replied: 'replied', qualified: 'meeting booked',
  handed_off: 'handed off', closed: 'closed',
};
const CATEGORY_LABELS = {
  interested: 'interested', question: 'question', not_interested: 'not interested',
  out_of_office: 'out of office', wrong_person: 'wrong person', bounce: 'bounced', unclear: 'needs a read',
  data_question: 'asking where we got their details',
};

async function action(path, opts) {
  const res = await apiFetch(path, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || 'request failed');
  return json;
}
const jsonOpts = (method, payload) => ({
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}),
});

function DraftCard({ draft, recipients, testOn, onChanged, showChip, campaignList }) {
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [to, setTo] = useState(recipients[0] || '');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const open = draft.status === 'draft' || draft.status === 'approved';
  const dirty = subject !== draft.subject || body !== draft.body;
  const r = draft.rationale || {};
  const g = draft.grounding || null;
  const flags = draft.groundingFlags || [];

  const run = async (fn) => {
    setBusy(true); setMsg(null);
    try { await fn(); } catch (e) { setMsg(String(e.message || e)); setBusy(false); }
  };
  const save = () => run(async () => { await action(`/api/outbound/drafts/${draft.id}`, jsonOpts('PATCH', { subject, body })); onChanged(); });
  const approve = () => run(async () => { await action(`/api/outbound/drafts/${draft.id}/approve`, jsonOpts('POST')); onChanged(); });
  const reject = () => run(async () => { await action(`/api/outbound/drafts/${draft.id}/reject`, jsonOpts('POST')); onChanged(); });
  // A recipient block means the person is wrong, not the words, and a plain
  // reject regenerates a fresh draft to the same person next cycle. This
  // stands the contact down and rejects in one act, ending the loop.
  // Every recipient-class block earns the one-click exit: the fault is who
  // the email goes to, so suppressing the contact is the fix, and it also
  // ends the thread's follow-up loop at the source.
  const recipientBlock = flags.some(f => /namesake risk|stated employer differs|foreign mailbox|greeting names/.test(String(f)));
  const suppressContact = () => run(async () => { await action(`/api/outbound/drafts/${draft.id}/suppress-contact`, jsonOpts('POST')); onChanged(); });
  const confirmContact = () => run(async () => { await action(`/api/outbound/drafts/${draft.id}/confirm-contact`, jsonOpts('POST')); onChanged(); });
  // The judgement one level up from suppress: this company is not a
  // prospect on this campaign at all. Two clicks, and the server does the
  // whole close-out or refuses with its reason when a conversation is live.
  const [armRemove, setArmRemove] = useState(false);
  const removeProspect = () => {
    if (!armRemove) { setArmRemove(true); return; }
    setArmRemove(false);
    run(async () => { await action(`/api/outbound/drafts/${draft.id}/remove-prospect`, jsonOpts('POST')); onChanged(); });
  };
  const sendTest = () => run(async () => {
    const res = await action(`/api/outbound/drafts/${draft.id}/send-test`, jsonOpts('POST', { to }));
    setMsg(res.sent ? `Test sent to ${to}.` : `Not sent: ${res.reason}.`);
    setBusy(false);
  });
  const sendReal = () => run(async () => {
    const res = await action(`/api/outbound/drafts/${draft.id}/send`, jsonOpts('POST'));
    if (res.sent) { setMsg('Sent to the prospect.'); onChanged(); }
    else { setMsg(`Not sent: ${res.reason}.`); setBusy(false); }
  });

  return (
    <div className="card ob-card">
      <div className="ob-head">
        <div className="ob-co">{companyLabel(draft.company)}</div>
        <div className="ob-pills">
          {showChip && <CampaignChip campaign={draft.campaign} list={campaignList} />}
          {draft.emailType === 'followup' && <span className="pill">follow-up</span>}
          {draft.emailType === 'response' && <span className="pill">response</span>}
          {draft.score != null && <span className="pill">ICP {draft.score}</span>}
          {draft.region && <span className="pill">{draft.region}</span>}
          <span className={`pill ob-stat ob-stat-${draft.status}`}>{draft.status}</span>
          {draft.status === 'sent' && draft.sentBy && <span className="pill" title={draft.sentBy}>sent by {draft.sentBy.split('@')[0]}</span>}
          {draft.status !== 'sent' && draft.status !== 'draft' && draft.decidedBy && <span className="pill" title={draft.decidedBy}>by {draft.decidedBy.split('@')[0]}</span>}
        </div>
      </div>
      <div className="ob-to">
        {draft.contact
          ? <>To <strong>{draft.contact.name}</strong>{draft.contact.role ? `, ${draft.contact.role}` : ''}{draft.contact.email ? ` · ${draft.contact.email}` : ' · no email on file'}</>
          : <>No named contact resolved yet</>}
      </div>

      {flags.length > 0 && (
        <div className="ob-flags">
          <div className="eyebrow">Unverified claims, review before approving</div>
          {flags.map((f, i) => <div className="ob-flag-line" key={i}>{f}</div>)}
        </div>
      )}

      <div className="ob-evidence">
        <div className="eyebrow">Grounding</div>
        {draft.emailType === 'followup' && draft.thread && (
          draft.thread.length
            ? <div className="ob-ev-line"><span className="ob-ev-k">Thread</span> {draft.thread.map(t => `step ${t.step ?? '?'} sent ${fmtClockDay(t.sentAt)}${t.to ? ` to ${t.to}` : ''}`).join('; ')}</div>
            : <div className="ob-ev-line"><span className="ob-ev-k">Thread</span> No sent email is recorded on this thread; a follow-up here would be the first thing they ever receive.</div>
        )}
        {g?.openerNote && <div className={`ob-grade ob-grade-${g.openerNote.kind}`}>{g.openerNote.text}</div>}
        {g ? (
          <>
            {g.replyText
              ? <div className="ob-ev-line"><span className="ob-ev-k">Their reply</span> {String(g.replyText).slice(0, 280)}</div>
              : null}
            {g.signal
              ? <div className="ob-ev-line"><span className="ob-ev-k">Signal</span> {g.signal.text}{g.signal.source && <> · <a className="ob-ev-src" href={g.signal.source} target="_blank" rel="noreferrer">source</a></>}</div>
              : <div className="ob-ev-line muted">No signal on file</div>}
            <div className="ob-ev-line"><span className="ob-ev-k">Contact</span> {draft.contact ? `${draft.contact.name}${draft.contact.role ? ', ' + draft.contact.role : ', role unknown'}` : 'role unknown'}</div>
            {g.icpReason && <div className="ob-ev-line"><span className="ob-ev-k">ICP</span> {g.icpReason}</div>}
            {g.responseExtracts && g.responseExtracts.length > 0
              ? <div className="ob-ev-line"><span className="ob-ev-k">Corpus</span> {g.responseExtracts.map((p, i) => <span className="ob-cite" key={i}>{p.title}{p.page ? ` p${p.page}` : ''}</span>)}</div>
              : null}
            {g.product && g.product.length > 0
              ? <div className="ob-ev-line"><span className="ob-ev-k">Product facts</span> {g.product.map((p, i) => <span className="ob-cite" key={i}>{p.title}{p.page ? ` p${p.page}` : ''}</span>)}</div>
              : <div className="ob-ev-line muted">No product facts retrieved</div>}
          </>
        ) : (
          <>
            {r.reason && <div className="ob-ev-line">{r.reason}</div>}
            {r.topScoreReason && <div className="ob-ev-line muted">{r.topScoreReason}</div>}
          </>
        )}
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
            {recipientBlock && draft.contact && (
              <button className="ob-btn" onClick={confirmContact} disabled={busy}
                title="Records your confirmation that this person works at this company; the block clears here and on every future draft to them.">
                They do work here
              </button>
            )}
            {recipientBlock && draft.contact && (
              <button className="ob-btn danger" onClick={suppressContact} disabled={busy}>Not them, suppress contact</button>
            )}
            {draft.campaign && !draft.rehearsal && (
              <button className="ob-btn ghost" onClick={removeProspect} disabled={busy}>
                {armRemove ? 'Confirm: remove from campaign' : 'Not a prospect'}
              </button>
            )}
            <button className="ob-btn ghost" onClick={reject} disabled={busy}>Reject</button>
            {draft.status === 'draft' && <button className="ob-btn primary" onClick={approve} disabled={busy || dirty}>Approve</button>}
            {draft.status === 'approved' && (
              <button className="ob-btn danger" onClick={sendReal} disabled={busy}>Send to prospect</button>
            )}
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

// What the engine did with a triaged reply, in one plain sentence, so the
// card is a record and not just a category pill.
function actedLine(reply) {
  const t = reply.triage || {};
  const bits = [];
  if (t.redirected) bits.push(`Adapted: redirected to ${t.redirected}${t.redirectDrafted ? ', a referral draft is in To review' : ''}.`);
  if (t.suppressed) bits.push('The contact was suppressed.');
  if (t.responseDrafted) bits.push('A grounded response was drafted into To review.');
  if (reply.snoozedUntil && new Date(reply.snoozedUntil) > new Date()) {
    bits.push(`Snoozed until ${fmtClockDay(reply.snoozedUntil)}; the day after, the next touch drafts itself into To review.`);
  } else if (t.snoozedUntil) {
    bits.push(`Was snoozed until ${fmtClockDay(t.snoozedUntil)}; the sequence has since resumed.`);
  }
  if (!bits.length) bits.push('Left for a human read; nothing was changed automatically.');
  return bits.join(' ');
}

function ReplyCard({ reply, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [returns, setReturns] = useState('');
  const setReturn = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await action(`/api/outbound/replies/${reply.id}/snooze`, jsonOpts('POST', { returns }));
      setMsg(`Snoozed until ${fmtClockDay(r.snoozedUntil)}. The next touch drafts itself the day after they return.`);
      onChanged();
    } catch (e) { setMsg(String(e.message || e)); }
    setBusy(false);
  };
  const respond = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await action(`/api/outbound/replies/${reply.id}/respond`, jsonOpts('POST'));
      setMsg(`Response drafted${r.flags?.length ? `, ${r.flags.length} flag(s)` : ''}. It is waiting in To review.`);
      onChanged();
    } catch (e) { setMsg(String(e.message || e)); }
    setBusy(false);
  };
  // Two clicks, arm then confirm, because suppression is reversible only by
  // hand and this one closes the lead as well.
  const [armRemove, setArmRemove] = useState(false);
  const removeAndConfirm = async () => {
    setBusy(true); setMsg(null);
    try {
      await action(`/api/outbound/replies/${reply.id}/remove-and-confirm`, jsonOpts('POST'));
      setMsg('Taken off entirely, email and LinkedIn, and the confirmation is drafted in To review for you to send.');
      setArmRemove(false);
      onChanged();
    } catch (e) { setMsg(String(e.message || e)); }
    setBusy(false);
  };
  return (
    <div className="card ob-card">
      <div className="ob-head">
        <div className="ob-co">{companyLabel(reply.company) || reply.from || 'Reply'}</div>
        <div className="ob-pills">
          {reply.category && <span className="pill">{CATEGORY_LABELS[reply.category] || reply.category}{reply.confidence === 'low' ? ' (low confidence)' : ''}</span>}
          {reply.receivedAt && <span className="pill">{fmtClockDay(reply.receivedAt)}</span>}
        </div>
      </div>
      <div className="ob-to">From {reply.from || 'unknown sender'}{!reply.triagedAt ? ' · not yet triaged' : ''}</div>
      {reply.subject && <div className="ob-ev-line"><strong>{reply.subject}</strong></div>}
      {reply.snippet && <div className="ob-ev-line muted">{reply.snippet}</div>}
      {reply.triagedAt && <div className="ob-ev-line muted">{actedLine(reply)}</div>}
      {reply.category && reply.category !== 'bounce' && (
        <div className="ob-actions">
          {reply.category === 'out_of_office' && (
            <>
              <span className="eyebrow">They return on</span>
              <input className="ob-select" type="date" value={returns} disabled={busy} onChange={e => setReturns(e.target.value)} />
              <button className="ob-btn" onClick={setReturn} disabled={busy || !returns}
                title="Sets the snooze to the day after this date; the next touch then drafts itself into To review.">
                Set return date
              </button>
            </>
          )}
          <span className="ob-spacer" />
          {armRemove
            ? <button className="ob-btn danger" onClick={removeAndConfirm} disabled={busy}
                title="Suppresses them for email and LinkedIn, rejects anything open, closes the lead, and drafts the confirmation.">
                Confirm removal
              </button>
            : <button className="ob-btn ghost" onClick={() => setArmRemove(true)} disabled={busy}
                title="For someone who has asked to be taken off. Removes them everywhere and drafts the confirmation for you to send.">
                Remove and confirm
              </button>}
          <button className="ob-btn" onClick={respond} disabled={busy}>Draft a response</button>
        </div>
      )}
      {msg && <div className="ob-msg">{msg}</div>}
    </div>
  );
}

// Bulk review. Two clicks each way (arm, then confirm), blocking flags are
// skipped by the server and reported, and sending stays one click per email.
function BulkBar({ count, onDone }) {
  const [arm, setArm] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = async (which) => {
    if (arm !== which) { setArm(which); return; }
    setBusy(true); setArm(null);
    try {
      const r = await action(`/api/outbound/drafts/${which}-all`, jsonOpts('POST'));
      onDone(which === 'approve'
        ? `Approved ${r.approved}. ${r.skippedBlocking ? `${r.skippedBlocking} skipped with blocking flags, fix those by hand.` : 'Nothing skipped.'} Sending remains one click per email.`
        : `Rejected ${r.rejected}. Their leads are back in the pool; the next drafting run writes them fresh.`);
    } catch (e) { onDone(String(e.message || e)); }
    setBusy(false);
  };
  return (
    <div className="ob-actions" style={{ marginBottom: 12 }}>
      <span className="ob-banner-note">{count} open draft{count === 1 ? '' : 's'}</span>
      <span className="ob-spacer" />
      <button className="ob-btn ghost" onClick={() => run('reject')} disabled={busy}>
        {arm === 'reject' ? `Confirm reject all (${count})` : 'Reject all'}
      </button>
      <button className="ob-btn" onClick={() => run('approve')} disabled={busy}>
        {arm === 'approve' ? `Confirm approve all (${count})` : 'Approve all'}
      </button>
      {arm && <button className="ob-btn ghost" onClick={() => setArm(null)} disabled={busy}>Cancel</button>}
    </div>
  );
}

function ConversationCard({ convo, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [items, setItems] = useState(null);
  const [kind, setKind] = useState('video');

  const act = async (fn, done) => {
    setBusy(true); setMsg(null);
    try { await fn(); if (done) setMsg(done); onChanged(); } catch (e) { setMsg(String(e.message || e)); }
    setBusy(false);
  };
  const meeting = () => act(() => action(`/api/outbound/leads/${convo.leadId}/meeting`, jsonOpts('POST', { kind })), 'Meeting recorded, the team has been told.');
  const designIn = () => act(() => action(`/api/outbound/leads/${convo.leadId}/design-in`, jsonOpts('POST', {})), 'Design-in recorded, the team has been told.');
  const handoff = () => act(() => action(`/api/outbound/leads/${convo.leadId}/handoff`, jsonOpts('POST')), 'Handed off. The pack email is with the team.');
  const suppress = () => act(() => action(`/api/outbound/leads/${convo.leadId}/suppress`, jsonOpts('POST')), 'Closed and suppressed.');
  const toggleThread = async () => {
    if (items) { setItems(null); return; }
    setExpandedItems(new Set());
    try { const r = await action(`/api/outbound/conversations/${convo.leadId}`); setItems(r.items || []); }
    catch { setItems([]); }
  };
  const [expandedItems, setExpandedItems] = useState(() => new Set());
  const toggleItem = (i) => setExpandedItems(prev => {
    const n = new Set(prev);
    if (n.has(i)) n.delete(i); else n.add(i);
    return n;
  });

  const c = convo.contact;
  const live = convo.stage !== 'handed_off' && convo.stage !== 'closed';
  return (
    <div className="card ob-card">
      <div className="ob-head">
        <div className="ob-co">{companyLabel(convo.company)}</div>
        <div className="ob-pills">
          {convo.score != null && <span className="pill">ICP {convo.score}</span>}
          {convo.lastCategory && <span className="pill">{CATEGORY_LABELS[convo.lastCategory] || convo.lastCategory}</span>}
          <span className={`pill ob-stat ob-stat-${convo.stage}`}>{STAGE_LABELS[convo.stage] || convo.stage}</span>
        </div>
      </div>
      <div className="ob-to">
        {c
          ? <><strong>{c.name}</strong>{c.role ? `, ${c.role}` : ''}{c.email ? ` · ${c.email}` : ''}{c.bounced ? ' · address bounced' : ''}{c.suppressed ? ' · suppressed' : ''}{c.liInvited ? ' · LinkedIn invited' : ''}</>
          : 'No named contact'}
      </div>
      <div className="ob-ev-line muted">
        {convo.sent} sent, {convo.replies} received.
        {convo.lastReplyAt ? ` Last reply ${fmtClockDay(convo.lastReplyAt)}.` : convo.lastSentAt ? ` Last sent ${fmtClockDay(convo.lastSentAt)}.` : ''}
        {convo.openDraft ? ' A draft is waiting in To review.' : ''}
        {convo.snoozedUntil && new Date(convo.snoozedUntil) > new Date() ? ` Snoozed until ${fmtClockDay(convo.snoozedUntil)} (away reply).` : ''}
        {convo.meeting ? ` Meeting: ${convo.meeting.kind === 'f2f' ? 'face to face' : 'video'}${convo.meeting.at ? ', ' + fmtClockDay(convo.meeting.at) : ''}.` : ''}
        {convo.designIn ? ` Specified on design, ${fmtClockDay(convo.designIn.at)}.` : ''}
      </div>
      <div className="ob-actions">
        <button className="ob-btn" onClick={toggleThread} disabled={busy}>{items ? 'Hide thread' : 'Show thread'}</button>
        <span className="ob-spacer" />
        {live && convo.stage !== 'qualified' && (
          <>
            <select className="ob-select" value={kind} disabled={busy} onChange={e => setKind(e.target.value)}>
              <option value="video">video</option>
              <option value="f2f">face to face</option>
            </select>
            <button className="ob-btn primary" onClick={meeting} disabled={busy}>Meeting booked</button>
          </>
        )}
        {live && !convo.designIn && (
          <button className="ob-btn" onClick={designIn} disabled={busy}
            title="Marwin has been written into the project's design. A win in its own right; records it and tells the team.">
            Specified on design
          </button>
        )}
        {convo.stage === 'qualified' && <button className="ob-btn primary" onClick={handoff} disabled={busy}>Hand off</button>}
        {live && <button className="ob-btn ghost" onClick={suppress} disabled={busy} title="Close the lead and never contact this person again">Stop</button>}
      </div>
      {items && (
        <div className="ob-evidence">
          {items.length === 0 && <div className="ob-ev-line muted">Nothing on the thread yet.</div>}
          {/* Each email in full, with its audit line: recipient, who
              approved, who sent. John's catch: the names were recorded on
              every draft but shown nowhere. */}
          {items.map((it, i) => (
            <div className="ob-ev-line" key={i}>
              <div>
                <span className="ob-ev-k">
                  {it.kind === 'sent' ? `sent ${it.emailType === 'cold_open' ? 'opener' : it.emailType}${it.step ? ` step ${it.step}` : ''}` : it.kind === 'reply' ? (CATEGORY_LABELS[it.category] || 'reply') : `${it.status} ${it.emailType}`}
                </span>
                {it.at ? fmtClockDay(it.at) : ''}
                {it.kind === 'reply' ? (it.from ? ` · from ${it.from}` : '') : (it.to ? ` · to ${it.to}` : '')}
                {it.kind === 'sent' && (it.decidedBy || it.sentBy)
                  ? ` · ${it.decidedBy ? `approved by ${it.decidedBy}` : ''}${it.decidedBy && it.sentBy ? ', ' : ''}${it.sentBy ? `sent by ${it.sentBy}` : ''}`
                  : ''}
              </div>
              {expandedItems.has(i)
                ? <div style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{it.subject ? `Subject: ${it.subject}\n\n` : ''}{it.body || ''}</div>
                : <div className="muted-small" style={{ marginTop: 2 }}>{(it.body || '').slice(0, 180)}{(it.body || '').length > 180 ? '...' : ''}</div>}
              <button className="ob-btn ghost" style={{ marginTop: 4 }} onClick={() => toggleItem(i)} disabled={busy}>
                {expandedItems.has(i) ? 'Collapse' : 'Read in full'}
              </button>
            </div>
          ))}
        </div>
      )}
      {msg && <div className="ob-msg">{msg}</div>}
    </div>
  );
}

export default function Outbound({ campaign }) {
  const campaignList = useCampaignList();
  const [status, setStatus] = useState(null);
  const [filter, setFilter] = useState('draft');
  const [drafts, setDrafts] = useState(null);
  const [replies, setReplies] = useState([]);
  const [convos, setConvos] = useState([]);
  const [state, setState] = useState('loading');

  const loadStatus = useCallback(() => {
    apiFetch('/api/outbound/status').then(r => r.json()).then(setStatus).catch(() => setStatus({ killSwitch: 'unknown' }));
  }, []);
  // setState only inside the async callbacks, never synchronously in the effect:
  // the previous list stays until the new one arrives, matching the other views.
  const loadDrafts = useCallback((f) => {
    apiFetch(withCampaign(`/api/outbound/drafts?status=${f}`, campaign)).then(r => r.json())
      .then(d => { setDrafts(d.drafts || []); setState('ready'); })
      .catch(() => setState('error'));
  }, [campaign]);
  const loadReplies = useCallback(() => {
    apiFetch(withCampaign('/api/outbound/replies', campaign)).then(r => r.json())
      .then(d => { setReplies(d.replies || []); setState('ready'); })
      .catch(() => setState('error'));
  }, [campaign]);
  const loadConvos = useCallback(() => {
    apiFetch(withCampaign('/api/outbound/conversations', campaign)).then(r => r.json())
      .then(d => { setConvos(d.conversations || []); setState('ready'); })
      .catch(() => setState('error'));
  }, [campaign]);

  useEffect(() => { loadStatus(); }, [loadStatus]);
  useEffect(() => {
    if (filter === 'replies') loadReplies();
    else if (filter === 'conversations') loadConvos();
    else loadDrafts(filter);
  }, [filter, campaign, loadDrafts, loadReplies, loadConvos]);
  const refresh = () => {
    loadStatus();
    if (filter === 'replies') loadReplies();
    else if (filter === 'conversations') loadConvos();
    else loadDrafts(filter);
  };

  const killOn = status?.killSwitch !== 'off';
  // A campaign chip appears only when the queue is showing every campaign.
  const showChips = isAll(campaign) && campaignList.length > 1;
  const testOn = status?.testSends === 'on';
  const recipients = status?.testRecipients || [];
  const counts = status?.counts || {};
  const drafting = status?.drafting || {};
  const convoCfg = status?.conversation || {};

  const [genNote, setGenNote] = useState(null);
  const [genBusy, setGenBusy] = useState(false);
  const generate = async () => {
    if (genBusy) return;
    setGenBusy(true); setGenNote(null);
    try {
      const r = await apiFetch('/api/outbound/generate', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ limit: 10 }),
      });
      const d = await r.json();
      if (d.started) {
        setGenNote('Drafting started. New drafts appear in To review as the run finishes, usually within a minute or two.');
        setTimeout(refresh, 20000);
        setTimeout(refresh, 75000);
      } else setGenNote(`Not started: ${d.reason}.`);
    } catch { setGenNote('Drafting could not be started right now.'); }
    setGenBusy(false);
  };
  const toggle = (path, key, current) => async () => {
    try {
      await apiFetch(`/api/outbound/${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !current }),
      });
      loadStatus();
    } catch { setGenNote(`The ${key} switch is not available right now.`); }
  };

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
        <p className="ob-banner-sub">Drafts queue here for approval and nothing reaches a prospect without a person. With reply capture on, replies are read, classified and flagged to the team within minutes; follow-ups draft themselves when a thread goes quiet, and a spent sequence rotates to the company's next specifier after a rest. Sends carry the signature of {convoCfg.sender || 'the PCT sales team'} with a plain opt-out line.</p>
        <div className="ob-banner-controls">
          <button className="ob-btn primary" onClick={generate} disabled={genBusy || drafting.running}>
            {drafting.running ? 'Drafting now' : 'Generate drafts'}
          </button>
          <button className="ob-btn" onClick={toggle('autodraft', 'auto-draft', drafting.autoDraft)}>
            {drafting.autoDraft ? 'Auto-draft: on' : 'Auto-draft: off'}
          </button>
          <button className="ob-btn" onClick={toggle('replycapture', 'reply capture', convoCfg.replyCapture)}>
            {convoCfg.replyCapture ? 'Reply capture: on' : 'Reply capture: off'}
          </button>
          <button className="ob-btn" onClick={toggle('followups', 'follow-ups', convoCfg.followups)}>
            {convoCfg.followups ? `Follow-ups: on (day ${String(convoCfg.followupDays || '4,7').split(',').join(', day ')})` : 'Follow-ups: off'}
          </button>
          {drafting.lastRun && (
            <span className="ob-banner-note">
              Last drafting run {fmtClockDay(drafting.lastRun.at)}{drafting.lastRun.trigger ? ` (${drafting.lastRun.trigger})` : ''}: {drafting.lastRun.ok
                ? `${drafting.lastRun.drafted ?? 0} drafted, ${drafting.lastRun.flagged ?? 0} flagged, ${drafting.lastRun.failed ?? 0} failed${drafting.lastRun.waitingContact ? `, ${drafting.lastRun.waitingContact} lead(s) waiting on contact discovery` : ''}.`
                : `failed, ${drafting.lastRun.error}`}
            </span>
          )}
        </div>
        {convoCfg.replyCapture && (
          <p className="ob-banner-sub">
            {convoCfg.lastReplies
              ? `Reply capture last ran ${fmtClockDay(convoCfg.lastReplies.at)}: ${convoCfg.lastReplies.ok
                  ? `${convoCfg.lastReplies.scanned ?? 0} scanned, ${convoCfg.lastReplies.matched ?? 0} matched, ${convoCfg.lastReplies.recorded ?? 0} new${convoCfg.lastReplies.triage ? `, ${convoCfg.lastReplies.triage.triaged ?? 0} triaged` : ''}.`
                  : `failed, ${convoCfg.lastReplies.error}`}`
              : 'Reply capture has not run yet; the next five-minute tick is the first.'}
          </p>
        )}
        {genNote && <p className="ob-banner-sub">{genNote}</p>}
      </div>

      <div className="ob-tabs">
        {FILTERS.map(f => (
          <button key={f.id} className={`ob-tab${filter === f.id ? ' active' : ''}`} onClick={() => setFilter(f.id)}>
            {f.label}{counts[f.id] != null ? ` (${counts[f.id]})` : ''}
          </button>
        ))}
      </div>

      {state === 'ready' && filter === 'draft' && drafts && drafts.length > 1 && (
        <BulkBar count={drafts.filter(d => !d.rehearsal).length} onDone={(m) => { setGenNote(m); refresh(); }} />
      )}
      {state === 'loading' && <p className="muted-note">Loading drafts.</p>}
      {state === 'error' && <p className="muted-note">Drafts are not available right now.</p>}
      {state === 'ready' && filter === 'replies' && (
        replies.length === 0
          ? <p className="muted-note">No replies captured yet. With reply capture on, prospect replies are recorded, classified and flagged to the team.</p>
          : replies.map(r => <ReplyCard key={r.id} reply={r} onChanged={refresh} />)
      )}
      {state === 'ready' && filter === 'conversations' && (
        convos.length === 0
          ? <p className="muted-note">No conversations yet. A lead appears here once its first email has been sent.</p>
          : convos.filter(c => !c.rehearsal).map(c => <ConversationCard key={c.leadId} convo={c} onChanged={refresh} />)
      )}
      {state === 'ready' && filter !== 'replies' && filter !== 'conversations' && drafts && drafts.length === 0 && (
        <p className="muted-note">
          {filter === 'draft'
            ? 'No drafts to review yet. Run the drafter to generate first-touch emails for researched leads.'
            : `No ${filter} drafts yet.`}
        </p>
      )}
      {state === 'ready' && filter !== 'replies' && filter !== 'conversations' && drafts && drafts.filter(d => !d.rehearsal).map(d => (
        <DraftCard key={d.id} draft={d} recipients={recipients} testOn={testOn} onChanged={refresh}
          showChip={showChips} campaignList={campaignList} />
      ))}
    </div>
  );
}
