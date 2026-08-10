import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from './api.js';
import { withCampaign, CampaignChip, useCampaignList, isAll } from './CampaignSwitcher.jsx';

// The review queue: what the engine discovered and refuses to act on alone.
// It lives inside Accounts because its output is accounts and its actions edit
// the register. Two kinds of row: a proposal (an unknown party on a gated UK
// project signal, with read-only Companies House candidates and a resolved
// domain) and an ambiguity (a printed name the register holds several
// plausible matches for). Confirm, merge and dismiss are the only ways a
// discovery enters or is kept out of the register, and all three are here.

async function act(path, body) {
  const res = await apiFetch(path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || 'request failed');
  return json;
}

function ProposalRow({ r, accounts, onDone }) {
  // Default to the single CH candidate when there is exactly one; several mean
  // the human picks, none means confirm on the printed name alone.
  const [entity, setEntity] = useState(r.chCandidates.length === 1 ? r.chCandidates[0].chNumber : '');
  // James's APT case: the right entity existed but was never suggested. The
  // reviewer can enter the number; the server verifies it against Companies
  // House and takes the registered name from the register, never the typing.
  const [manualNumber, setManualNumber] = useState('');
  const [mergeTarget, setMergeTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const run = fn => async () => {
    setBusy(true); setErr(null);
    try { await fn(); onDone(); } catch (e) { setErr(String(e.message)); setBusy(false); }
  };
  const chosen = r.chCandidates.find(c => c.chNumber === entity) || null;

  return (
    <div className="rq-row">
      <div className="rq-main">
        <div className="rq-name">{r.name}</div>
        <div className="rq-meta">
          <span className="pill">{r.party === 'contractor' ? 'Contractor' : 'Operator'}</span>
          {r.domain && <span className="rq-domain">{r.domain}</span>}
        </div>
        {r.signal && (
          <div className="rq-signal">
            From: {r.signal.url
              ? <a href={r.signal.url} target="_blank" rel="noreferrer">{r.signal.title}</a>
              : r.signal.title}
          </div>
        )}
        <select className="rq-select" value={entity} onChange={e => setEntity(e.target.value)}
          aria-label="Companies House entity">
          <option value="">{r.chCandidates.length ? 'Companies House entity, pick to confirm against' : 'No Companies House suggestion; confirm as printed'}</option>
          {r.chCandidates.map(c => (
            <option key={c.chNumber} value={c.chNumber}>
              {c.name} ({c.chNumber}{c.status && c.status !== 'active' ? `, ${c.status}` : ''})
            </option>
          ))}
          <option value="__manual">None of these: enter the company number yourself</option>
        </select>
        {entity === '__manual' && (
          <input className="rq-select" placeholder="Companies House number, for example 07053790"
            value={manualNumber} onChange={e => setManualNumber(e.target.value)}
            aria-label="Companies House number, verified before it is stored" />
        )}
        <select className="rq-select" value={mergeTarget} onChange={e => setMergeTarget(e.target.value)}
          aria-label="Merge into an existing account">
          <option value="">Or merge into an existing account (an alias miss)</option>
          {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        {err && <div className="rq-err">{err}</div>}
      </div>
      <div className="rq-actions">
        <button className="ob-btn primary" disabled={busy || !!mergeTarget || (entity === '__manual' && !manualNumber.trim())}
          onClick={run(() => act(`/api/reviews/${r.id}/confirm`,
            entity === '__manual' ? { chNumber: manualNumber.trim() }
              : chosen ? { chNumber: chosen.chNumber, registeredName: chosen.name } : {}))}>
          Confirm{entity === '__manual' ? ' against that number' : chosen ? '' : ' as printed'}
        </button>
        <button className="ob-btn" disabled={busy || !mergeTarget}
          onClick={run(() => act(`/api/reviews/${r.id}/merge`, { companyId: Number(mergeTarget) }))}>
          Merge
        </button>
        <button className="ob-btn ghost" disabled={busy}
          onClick={run(() => act(`/api/reviews/${r.id}/dismiss`))}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

function AmbiguousRow({ r, onDone }) {
  const [pick, setPick] = useState(r.accountCandidates.length === 1 ? String(r.accountCandidates[0].id) : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const run = fn => async () => {
    setBusy(true); setErr(null);
    try { await fn(); onDone(); } catch (e) { setErr(String(e.message)); setBusy(false); }
  };
  return (
    <div className="rq-row">
      <div className="rq-main">
        <div className="rq-name">{r.name}</div>
        <div className="rq-meta"><span className="pill">Ambiguous</span>
          <span className="rq-domain">matches {r.accountCandidates.length} accounts</span></div>
        {r.signal && <div className="rq-signal">From: {r.signal.url
          ? <a href={r.signal.url} target="_blank" rel="noreferrer">{r.signal.title}</a> : r.signal.title}</div>}
        <select className="rq-select" value={pick} onChange={e => setPick(e.target.value)}
          aria-label="Resolve to an account">
          <option value="">Which account is this?</option>
          {r.accountCandidates.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        {err && <div className="rq-err">{err}</div>}
      </div>
      <div className="rq-actions">
        <button className="ob-btn primary" disabled={busy || !pick}
          onClick={run(() => act(`/api/reviews/${r.id}/merge`, { companyId: Number(pick) }))}>
          Resolve
        </button>
        <button className="ob-btn" disabled={busy}
          onClick={run(() => act(`/api/reviews/${r.id}/distinct`))}
          title="None of these accounts. The name becomes a proposal for a new one.">
          None of these
        </button>
        <button className="ob-btn ghost" disabled={busy}
          onClick={run(() => act(`/api/reviews/${r.id}/dismiss`))}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

export default function ReviewQueue({ campaign, accounts, onChanged }) {
  const [data, setData] = useState(null);
  const campaignList = useCampaignList();

  const load = useCallback(() => {
    apiFetch(withCampaign('/api/reviews', campaign))
      .then(r => (r.ok ? r.json() : null))
      .then(d => setData(d))
      .catch(() => setData(null));
  }, [campaign]);
  useEffect(() => { load(); }, [load]);

  const done = () => { load(); onChanged?.(); };

  // Nothing pending and nothing counted is the quiet norm; the section stays
  // out of the way rather than announcing an empty queue.
  if (!data || (data.reviews.length === 0 && data.unmatched.length === 0)) return null;

  const showChips = isAll(campaign) && campaignList.length > 1;

  return (
    <div className="card rq-card">
      <div className="rq-head">
        <div className="eyebrow">Review queue</div>
        <div className="rq-count">{data.reviews.length} awaiting a decision</div>
      </div>
      {data.reviews.length > 0 && (
        <p className="rq-intro">Companies the engine found in gated signals and will not add or link by itself. Confirming creates the account and seeds it into the campaign; merging records the alias so the matcher learns it; dismissing is remembered.</p>
      )}
      <div className="rq-list">
        {data.reviews.map(r => (
          <div key={r.id}>
            {showChips && <CampaignChip campaign={r.campaign} list={campaignList} />}
            {r.kind === 'proposal'
              ? <ProposalRow r={r} accounts={accounts} onDone={done} />
              : <AmbiguousRow r={r} onDone={done} />}
          </div>
        ))}
      </div>
      {data.unmatched.length > 0 && (
        <div className="rq-unmatched">
          <div className="eyebrow">Unmatched names, by frequency</div>
          <div className="rq-tags">
            {data.unmatched.map((u, i) => (
              <span className="rq-tag" key={i} title={`last seen ${u.lastSeen ? new Date(u.lastSeen).toLocaleDateString() : ''}`}>
                {u.name} <b>&#215;{u.n}</b>
              </span>
            ))}
          </div>
          <p className="rq-caption">Every party name the matcher could not place, counted. The most frequent is the next alias worth adding.</p>
        </div>
      )}
    </div>
  );
}
