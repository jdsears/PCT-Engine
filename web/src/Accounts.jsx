import { useState, useEffect } from 'react';
import { TYPE_LABELS, fmtClockDay, fmtMonthYear, companyLabel } from './labels.js';
import { CloseIcon } from './icons.jsx';
import { apiFetch } from './api.js';
import { withCampaign, CampaignChip, useCampaignList, isAll } from './CampaignSwitcher.jsx';
import ReviewQueue from './ReviewQueue.jsx';

const typeLabel = t => TYPE_LABELS[t] || '—';

// James's ask: click a header, the table orders by that column, click again
// to flip. Text columns start ascending, counts and the score start
// descending, and an account with nothing in the column sinks to the bottom
// whichever way the sort runs, because absence is not a value.
const SORT_COLS = [
  { id: 'name', label: 'Company', defDir: 'asc', get: c => c.name || '' },
  { id: 'type', label: 'Type', defDir: 'asc', get: c => (TYPE_LABELS[c.type] || '') },
  { id: 'region', label: 'Region', defDir: 'asc', get: c => c.region || '' },
  { id: 'domain', label: 'Domain', defDir: 'asc', get: c => c.domain || '' },
  { id: 'chNumber', label: 'CH number', defDir: 'asc', get: c => c.chNumber || '' },
  { id: 'score', label: 'ICP score', defDir: 'desc', get: c => c.score },
  { id: 'people', label: 'People', defDir: 'desc', get: c => c.people ?? 0 },
  { id: 'signals', label: 'Signals', defDir: 'desc', get: c => c.signals ?? 0 },
];

function sortCompanies(list, sortId, dir) {
  const col = SORT_COLS.find(s => s.id === sortId) || SORT_COLS.find(s => s.id === 'score');
  return [...list].sort((a, b) => {
    const av = col.get(a), bv = col.get(b);
    const aAbsent = av == null || av === '';
    const bAbsent = bv == null || bv === '';
    if (aAbsent !== bAbsent) return aAbsent ? 1 : -1;
    let cmp = (typeof av === 'number' && typeof bv === 'number')
      ? av - bv
      : String(av).localeCompare(String(bv), 'en', { sensitivity: 'base' });
    if (cmp === 0) cmp = String(a.name || '').localeCompare(String(b.name || ''));
    return dir === 'asc' ? cmp : -cmp;
  });
}

// Add an account by hand, James's ask when CyrusOne was nowhere to be found.
// With a company number the server verifies it against Companies House and
// the registered name wins; a name alone enters unmatched, honestly. A
// company already on the register is pointed at, never duplicated.
function AddAccount({ campaign, campaignList, onAdded }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [chNumber, setChNumber] = useState('');
  const [type, setType] = useState('');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const chosenCampaign = target || (!isAll(campaign) && campaign) || campaignList[0]?.id || '';

  const submit = async () => {
    setBusy(true); setMsg(null);
    try {
      const res = await apiFetch('/api/accounts', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, chNumber: chNumber || null, type: type || null, campaign: chosenCampaign }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg(json.error || 'could not add the account'); setBusy(false); return; }
      setMsg(json.note || `${json.name || name} added to the register.`);
      setName(''); setChNumber(''); setType('');
      onAdded();
    } catch (e) { setMsg(String(e.message || e)); }
    setBusy(false);
  };

  if (!open) {
    return <button className="ob-btn add-account-toggle" onClick={() => setOpen(true)}>Add an account</button>;
  }
  return (
    <div className="card add-account">
      <div className="eyebrow">Add an account</div>
      <div className="add-account-fields">
        <input placeholder="Company name" value={name} onChange={e => setName(e.target.value)} aria-label="Company name" />
        <input placeholder="Companies House number, optional" value={chNumber} onChange={e => setChNumber(e.target.value)}
          aria-label="Companies House number, verified before it is stored" />
        <select value={type} onChange={e => setType(e.target.value)} aria-label="Company type">
          <option value="">Type, optional</option>
          {Object.entries(TYPE_LABELS).filter(([k]) => k !== 'other').map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select value={chosenCampaign} onChange={e => setTarget(e.target.value)} aria-label="Campaign">
          {campaignList.map(c => <option key={c.id} value={c.id}>{c.displayName || c.id}</option>)}
        </select>
        <button className="ob-btn primary" onClick={submit} disabled={busy || (!name.trim() && !chNumber.trim())}>
          {busy ? 'Checking' : 'Add'}
        </button>
        <button className="ob-btn ghost" onClick={() => { setOpen(false); setMsg(null); }} disabled={busy}>Close</button>
      </div>
      {msg && <div className="muted-note">{msg}</div>}
    </div>
  );
}

// The CRM relationship, when the customer list has been imported: an existing
// customer at its grade, or a named prospect. Absent means the engine has no
// record either way, so nothing is shown rather than something guessed.
const customerLabel = s => (s === 'prospect' ? 'Prospect' : s ? `Customer ${String(s).toUpperCase()}` : null);

function ScoreBar({ score, wide }) {
  return (
    <span className={`score-bar${wide ? ' wide' : ''}`}>
      <span style={{ width: `${Math.max(0, Math.min(100, score ?? 0))}%` }} />
    </span>
  );
}

// Amend the account's own facts: the 4D case, renamed on Companies House, and
// Echelon's wrongly resolved domain. The server verifies a number before
// anything is stored and keeps the old name as an alias.
function AmendAccount({ id, detail, onSaved }) {
  const [open, setOpen] = useState(false);
  const [domain, setDomain] = useState('');
  const [chNumber, setChNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const save = async () => {
    setBusy(true); setMsg(null);
    const body = {};
    if (domain.trim()) body.domain = domain.trim();
    if (chNumber.trim()) body.chNumber = chNumber.trim();
    try {
      const res = await apiFetch(`/api/accounts/${id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg(json.error || 'could not amend the account'); setBusy(false); return; }
      setMsg(json.note || 'Saved.');
      setDomain(''); setChNumber('');
      onSaved();
    } catch (e) { setMsg(String(e.message || e)); }
    setBusy(false);
  };

  if (!open) {
    return <button className="ob-btn amend-toggle" onClick={() => setOpen(true)}>Amend this account</button>;
  }
  return (
    <div className="panel-block">
      <div className="eyebrow">Amend this account</div>
      <div className="add-account-fields">
        <input placeholder={detail.domain ? `Domain, currently ${detail.domain}` : 'Domain, none on file'}
          value={domain} onChange={e => setDomain(e.target.value)} aria-label="Domain" />
        <input placeholder={detail.chNumber ? `Companies House number, currently ${detail.chNumber}` : 'Companies House number, unmatched'}
          value={chNumber} onChange={e => setChNumber(e.target.value)}
          aria-label="Companies House number, verified before it is stored" />
        <button className="ob-btn primary" onClick={save} disabled={busy || (!domain.trim() && !chNumber.trim())}>
          {busy ? 'Checking' : 'Save'}
        </button>
        <button className="ob-btn ghost" onClick={() => { setOpen(false); setMsg(null); }} disabled={busy}>Close</button>
      </div>
      <div className="muted-small">A company number is checked against Companies House and the registered name takes over, with the old name kept as an alias. Only what you fill in changes.</div>
      {msg && <div className="muted-note">{msg}</div>}
    </div>
  );
}

// Add a person James's way: found on LinkedIn, chosen deliberately for this
// account, so they enter the decision orbit directly. Behind a toggle, the
// same as amending, so the panel reads as a record first and an editor only
// when asked.
function AddPerson({ id, onSaved }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [linkedin, setLinkedin] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const res = await apiFetch(`/api/accounts/${id}/contacts`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, roleTitle: role || null, linkedinUrl: linkedin || null }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg(json.error || 'could not add the person'); setBusy(false); return; }
      setMsg(json.note || `${name} added to the decision makers.`);
      setName(''); setRole(''); setLinkedin('');
      onSaved();
    } catch (e) { setMsg(String(e.message || e)); }
    setBusy(false);
  };

  if (!open) {
    return <button className="ob-btn ghost add-person-toggle" onClick={() => setOpen(true)}>Add a person</button>;
  }
  return (
    <div className="add-person">
      <div className="add-account-fields">
        <input placeholder="Name" value={name} onChange={e => setName(e.target.value)} aria-label="Person's name" />
        <input placeholder="Role, optional" value={role} onChange={e => setRole(e.target.value)} aria-label="Role" />
        <input placeholder="LinkedIn URL, optional" value={linkedin} onChange={e => setLinkedin(e.target.value)} aria-label="LinkedIn URL" />
        <button className="ob-btn" onClick={save} disabled={busy || !name.trim()}>{busy ? 'Adding' : 'Add person'}</button>
        <button className="ob-btn ghost" onClick={() => { setOpen(false); setMsg(null); }} disabled={busy}>Close</button>
      </div>
      {msg && <div className="muted-note">{msg}</div>}
    </div>
  );
}

// The empty decision-makers state tells the truth about this account's own
// search history rather than shrugging: never searched and where it sits in
// the queue, searched and found nobody with when the next pass comes, or the
// automatic search being off, which is the one state that needs a human.
const shortDate = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
function peopleSearchCopy(ps) {
  if (!ps) return 'None found for this account yet. The LinkedIn lane fills these in small, capped batches.';
  if (!ps.attempts) {
    if (!ps.autoSearch) return 'Never searched, and the automatic people search is switched off. Turn it on from the Health page, or run the enrich script, and this account joins the queue.';
    if (ps.queuePosition != null) return `Never searched yet. Position ${ps.queuePosition} in the automatic search queue, which works blocked accounts first.`;
    return 'Never searched yet. It joins the automatic queue on the next cycle.';
  }
  const last = ps.lastAt ? ` The last pass was ${shortDate(ps.lastAt)}.` : '';
  if (ps.coolingUntil) return `Searched ${ps.attempts} time${ps.attempts === 1 ? '' : 's'} and nobody has qualified yet.${last} It stands down until ${shortDate(ps.coolingUntil)}, and the next pass asks a fresh set of roles.`;
  return `Searched ${ps.attempts} time${ps.attempts === 1 ? '' : 's'}, nobody qualified yet, and it is eligible again${ps.queuePosition != null ? `, position ${ps.queuePosition} in the queue` : ''}.${last}`;
}

// The panel's campaign row with the one verb it lacked: remove from this
// campaign. Two clicks (arm, then confirm), the company stays on the
// register, the census never re-proposes it, and a live conversation is
// refused by the server with its reason shown.
function CampaignMemberships({ id, memberships, onChanged }) {
  const campaignList = useCampaignList();
  const [arm, setArm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  if (!memberships || memberships.length === 0) return null;
  const label = (m) => campaignList.find(c => c.id === m)?.displayName || m;
  const remove = async (m) => {
    if (arm !== m) { setArm(m); return; }
    setBusy(true); setNote(null); setArm(null);
    try {
      const res = await apiFetch(`/api/accounts/${id}/remove-from-campaign`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ campaign: m }),
      });
      const d = await res.json();
      if (!res.ok) { setNote(d.error || 'Could not remove.'); }
      else { setNote(`Removed from ${label(m)}: ${d.draftsRejected} draft(s) rejected, ${d.leadsClosed} lead(s) closed. The census will not re-propose it.`); onChanged(); }
    } catch (e) { setNote(String(e.message || e)); }
    setBusy(false);
  };
  return (
    <div className="panel-block">
      <div className="eyebrow">Campaigns</div>
      {memberships.map(m => (
        <div className="director-row" key={m}>
          <span className="director-name">{label(m)}</span>
          <button className="ob-btn ghost" onClick={() => remove(m)} disabled={busy}>
            {arm === m ? 'Confirm: not a prospect' : 'Remove'}
          </button>
        </div>
      ))}
      <div className="muted-small">Removing ends prospecting on that campaign only. The company stays on the register.</div>
      {note && <div className="muted-small">{note}</div>}
    </div>
  );
}

function DetailPanel({ id, isMobile, onClose, onChanged }) {
  const [detail, setDetail] = useState(null);
  const [state, setState] = useState('loading');
  const [reload, setReload] = useState(0);
  const changed = () => { setReload(n => n + 1); if (onChanged) onChanged(); };
  useEffect(() => {
    let live = true;
    setState('loading');
    apiFetch(`/api/accounts/${id}`)
      .then(r => r.json())
      .then(d => { if (live) { setDetail(d); setState('ready'); } })
      .catch(() => { if (live) setState('error'); });
    return () => { live = false; };
  }, [id, reload]);

  return (
    <>
      <div className="panel-overlay" onClick={onClose} />
      <div className="panel" style={{ width: isMobile ? '100%' : 440 }}>
        {state !== 'ready' ? (
          <div className="panel-body"><p className="muted-note">{state === 'error' ? 'This account is not available right now.' : 'Loading.'}</p></div>
        ) : (
          <>
            <div className="panel-head">
              <div className="panel-id">
                <div className="panel-name">{companyLabel(detail.name)}</div>
                <div className="panel-pills">
                  <span className="pill">{typeLabel(detail.type)}</span>
                  {detail.region && <span className="pill">{detail.region}</span>}
                  {detail.customerStatus && <span className="pill">{customerLabel(detail.customerStatus)}</span>}
                  <span className={`panel-ch${detail.chNumber ? '' : ' missing'}`}>{detail.chNumber || 'Unmatched'}</span>
                </div>
              </div>
              <button className="panel-close" aria-label="Close detail panel" onClick={onClose}><CloseIcon /></button>
            </div>
            <div className="panel-body">
              <div className="panel-block">
                <div className="panel-block-head">
                  <div className="eyebrow">ICP breakdown</div>
                  <div className="panel-score">{detail.score ?? '—'} / 100</div>
                </div>
                {detail.icp.map((r, i) => (
                  <div className="icp-row" key={i} title={r.reason || undefined}>
                    <span className="icp-label">{r.label}</span>
                    <span className="meter"><span style={{ width: `${r.points == null ? 0 : Math.round((r.points / r.max) * 100)}%` }} /></span>
                    <span className="icp-val">{r.points == null ? '—' : `${r.points} / ${r.max}`}</span>
                  </div>
                ))}
                <div className="panel-foot-note">Every score is explainable. These rows are the audit trail.</div>
              </div>
              <div className="panel-block">
                <div className="eyebrow">Decision makers</div>
                {(detail.people || []).length === 0 && (
                  <div className="muted-small">{peopleSearchCopy(detail.peopleSearch)}</div>
                )}
                {(detail.people || []).map((p, i) => (
                  <div className="person-row" key={i}>
                    <span className="person-name">{p.name}</span>
                    <span className="person-meta">
                      {p.role && <span>{p.role}</span>}
                      {p.email
                        ? <a className="person-link" href={`mailto:${p.email}`}>{p.email}</a>
                        : <span>no email on file</span>}
                      {p.linkedin && <a className="person-link" href={p.linkedin} target="_blank" rel="noreferrer">LinkedIn</a>}
                    </span>
                  </div>
                ))}
                <AddPerson id={id} onSaved={changed} />
              </div>
              <div className="panel-block">
                <div className="eyebrow">Recent signals</div>
                {detail.recentSignals.length === 0 && <div className="muted-small">No signals for this account yet.</div>}
                {detail.recentSignals.map((s, i) => (
                  <div className="panel-signal" key={i}>
                    <div className="panel-signal-title">{s.title}</div>
                    <div className="panel-signal-time">{fmtClockDay(s.observedAt)}</div>
                  </div>
                ))}
              </div>
              <div className="panel-block">
                <div className="eyebrow">Directors</div>
                {detail.directors.length === 0 && <div className="muted-small">No register contacts pulled yet.</div>}
                {detail.directors.map((d, i) => (
                  <div className="director-row" key={i}>
                    <span className="director-name">{d.name}</span>
                    {d.appointed && <span className="director-since">Appointed {fmtMonthYear(d.appointed)}</span>}
                  </div>
                ))}
              </div>
              <CampaignMemberships id={id} memberships={detail.memberships} onChanged={changed} />
              <AmendAccount id={id} detail={detail} onSaved={changed} />
            </div>
          </>
        )}
      </div>
    </>
  );
}

export default function Accounts({ isMobile, focusCompanyId, onFocusConsumed, campaign }) {
  const [companies, setCompanies] = useState(null);
  const [state, setState] = useState('loading');
  const [selected, setSelected] = useState(null);
  const [sort, setSort] = useState('score');
  const [dir, setDir] = useState('desc');
  const campaignList = useCampaignList();

  const clickSort = (col) => {
    if (sort === col.id) setDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSort(col.id); setDir(col.defDir); }
  };

  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    let live = true;
    apiFetch(withCampaign('/api/accounts', campaign))
      .then(r => r.json())
      .then(d => { if (live) { setCompanies(d.companies || []); setState('ready'); } })
      .catch(() => { if (live) setState('error'); });
    return () => { live = false; };
  }, [campaign, reloads]);

  // A jump from Signals lands here with the company already chosen.
  useEffect(() => {
    if (focusCompanyId != null) { setSelected(focusCompanyId); onFocusConsumed(); }
  }, [focusCompanyId, onFocusConsumed]);

  if (state === 'loading') return <div className="content-pad"><p className="muted-note">Loading accounts.</p></div>;
  if (state === 'error') return <div className="content-pad"><p className="muted-note">Accounts are not available right now.</p></div>;

  // A company can belong to more than one campaign and still be one account, so
  // the mixed view marks every membership rather than picking one.
  const showChips = isAll(campaign) && campaignList.length > 1;
  const chips = c => (showChips ? (c.campaigns || []) : []).map(id => (
    <CampaignChip key={id} campaign={id} list={campaignList} />
  ));

  const queue = (
    <ReviewQueue campaign={campaign} accounts={companies}
      onChanged={() => setReloads(n => n + 1)} />
  );
  const addForm = (
    <AddAccount campaign={campaign} campaignList={campaignList}
      onAdded={() => setReloads(n => n + 1)} />
  );

  if (companies.length === 0) {
    return (
      <div className="content-pad">
        {queue}
        {addForm}
        <p className="muted-note">
          No named accounts on this campaign's register yet. Accounts appear once the campaign has been seeded, a sweep has matched a company to it, or a proposal above is confirmed.
        </p>
      </div>
    );
  }

  const shown = sortCompanies(companies, sort, dir);
  const marker = (id) => (sort === id ? (dir === 'asc' ? ' ↑' : ' ↓') : '');

  return (
    <div className="content-pad">
      {queue}
      <div className="acc-toolbar">
        <div className="muted-small">{companies.length} named account{companies.length === 1 ? '' : 's'}{!isAll(campaign) ? ' on this campaign' : ''}</div>
        {addForm}
      </div>
      {!isMobile ? (
        <div className="card accounts-table">
          <div className="acc-grid acc-head">
            {SORT_COLS.map(col => (
              <button key={col.id} className={`eyebrow acc-sort${['people', 'signals'].includes(col.id) ? ' right' : ''}`}
                onClick={() => clickSort(col)}
                aria-label={`Sort by ${col.label.toLowerCase()}`}>
                {col.label}{marker(col.id)}
              </button>
            ))}
          </div>
          {shown.map(c => (
            <button className="acc-grid acc-row" key={c.id} onClick={() => setSelected(c.id)}>
              <div className="acc-name">{companyLabel(c.name)}{chips(c)}{c.customerStatus && <span className="pill">{customerLabel(c.customerStatus)}</span>}</div>
              <div className="acc-dim">{typeLabel(c.type)}</div>
              <div className="acc-dim">{c.region || '—'}</div>
              <div className={`acc-flagged${c.domain ? '' : ' missing'}`}>
                <span className="flag-dot" style={{ opacity: c.domain ? 0 : 1 }} />
                <span className="acc-ellipsis">{c.domain || 'No domain'}</span>
              </div>
              <div className={`acc-flagged mono${c.chNumber ? ' navy' : ' missing'}`}>
                <span className="flag-dot" style={{ opacity: c.chNumber ? 0 : 1 }} />
                <span>{c.chNumber || 'Unmatched'}</span>
              </div>
              <div className="acc-score">
                <ScoreBar score={c.score} />
                <span className="acc-score-num">{c.score ?? '—'}</span>
              </div>
              <div className="acc-signals">{c.people ?? 0}</div>
              <div className="acc-signals">{c.signals}</div>
            </button>
          ))}
        </div>
      ) : (
        <div className="acc-cards">
          <div className="tool-group acc-sort-pills" role="group" aria-label="Sort accounts">
            {SORT_COLS.filter(col => ['name', 'region', 'score', 'people', 'signals'].includes(col.id)).map(col => (
              <button key={col.id} className={`filter-pill${sort === col.id ? ' active' : ''}`}
                onClick={() => clickSort(col)}>
                {col.label}{marker(col.id)}
              </button>
            ))}
          </div>
          {shown.map(c => (
            <button className="acc-card" key={c.id} onClick={() => setSelected(c.id)}>
              <div className="acc-card-top">
                <div className="acc-card-name">{companyLabel(c.name)}</div>
                <span className="acc-card-score">{c.score ?? '—'}</span>
              </div>
              <ScoreBar score={c.score} wide />
              <div className="acc-card-meta">
                <span className="pill">{typeLabel(c.type)}</span>
                {c.region && <span className="pill">{c.region}</span>}
                {c.customerStatus && <span className="pill">{customerLabel(c.customerStatus)}</span>}
                {chips(c)}
                <span className="acc-card-signals">{c.people ?? 0} people · {c.signals} signals</span>
                {(!c.domain || !c.chNumber) && (
                  <span className="acc-card-flag"><span className="flag-dot" />{!c.domain ? 'No domain' : 'CH unmatched'}</span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
      {selected != null && <DetailPanel id={selected} isMobile={isMobile} onClose={() => setSelected(null)}
        onChanged={() => setReloads(n => n + 1)} />}
    </div>
  );
}
