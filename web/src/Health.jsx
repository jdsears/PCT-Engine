import { useState, useEffect, useCallback } from 'react';
import { lineLabel, fmtClockDay } from './labels.js';
import { apiFetch } from './api.js';

// The signal engine card: the switch that turns automatic signal finding and
// lead pulling on or off, with the last run's numbers and the key checks. The
// state lives on the server (kv), so the toggle needs no redeploy and survives
// restarts. Nothing here touches sending: the mail kill switch is its own card.
function EngineCard() {
  const [engine, setEngine] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  const load = useCallback(() => {
    apiFetch('/api/engine/status').then(r => r.json())
      .then(setEngine).catch(() => setEngine(null));
  }, []);
  useEffect(() => { load(); }, [load]);

  const toggle = async () => {
    if (!engine || busy) return;
    setBusy(true); setNote(null);
    try {
      const res = await apiFetch('/api/engine/toggle', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !engine.enabled }),
      });
      setEngine(await res.json());
    } catch { setNote('The engine switch is not available right now.'); }
    setBusy(false);
  };

  const runNow = async () => {
    if (busy) return;
    setBusy(true); setNote(null);
    try {
      const res = await apiFetch('/api/engine/run-now', { method: 'POST' });
      const d = await res.json();
      setNote(d.started ? 'Run started. The numbers refresh when it finishes.' : `Not started: ${d.reason}.`);
      setTimeout(load, 4000);
    } catch { setNote('The run could not be started right now.'); }
    setBusy(false);
  };

  const toggleDiscover = async () => {
    if (!engine || busy) return;
    setBusy(true); setNote(null);
    try {
      const res = await apiFetch('/api/engine/autodiscover', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !engine.autoDiscover }),
      });
      setEngine(await res.json());
    } catch { setNote('The email discovery switch is not available right now.'); }
    setBusy(false);
  };

  const togglePeople = async () => {
    if (!engine || busy) return;
    setBusy(true); setNote(null);
    try {
      const res = await apiFetch('/api/engine/autopeople', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !engine.autoPeople }),
      });
      setEngine(await res.json());
    } catch { setNote('The people search switch is not available right now.'); }
    setBusy(false);
  };

  const toggleSync = async () => {
    if (!engine || busy) return;
    setBusy(true); setNote(null);
    try {
      const res = await apiFetch('/api/engine/autosync', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !engine.autoSync }),
      });
      setEngine(await res.json());
    } catch { setNote('The SharePoint sync switch is not available right now.'); }
    setBusy(false);
  };

  const toggleDrip = async () => {
    if (!engine || busy) return;
    setBusy(true); setNote(null);
    try {
      const res = await apiFetch('/api/engine/invite-drip', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !engine.inviteDrip }),
      });
      setEngine(await res.json());
    } catch { setNote('The invite drip switch is not available right now.'); }
    setBusy(false);
  };

  const toggleStudio = async () => {
    if (!engine || busy) return;
    setBusy(true); setNote(null);
    try {
      const res = await apiFetch('/api/engine/studio-autopilot', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !engine.studioAutopilot }),
      });
      setEngine(await res.json());
    } catch { setNote('The studio autopilot switch is not available right now.'); }
    setBusy(false);
  };

  if (!engine) {
    return (
      <div className="card health-card">
        <div className="eyebrow">Signal engine</div>
        <div className="muted-small">Engine status is not available right now.</div>
      </div>
    );
  }

  const missing = Object.entries(engine.keys || {}).filter(([, ok]) => !ok).map(([k]) =>
    ({ companiesHouse: 'Companies House', tavily: 'Tavily', anthropic: 'Anthropic', findymail: 'Findymail' }[k] || k));
  const lr = engine.lastRun;

  // Anything wrong or worth attention is gathered first and rendered above the
  // routine numbers, because a page that reports everything and flags nothing
  // is where sixteen sync errors sat unread in a stat line. Missing keys, a
  // failed run, sync errors, a stood-down people search: each is an amber note
  // at the top, and sync errors open to name the failing documents.
  // Acknowledged sync failures are a known condition and never take the amber
  // treatment; only what is left unacknowledged does. If the run predates the
  // detailed error list, fall back to the raw count so nothing is lost.
  const se = engine.syncErrors;
  const unackErrors = se ? se.unacknowledged : (lr?.docErrorList || []);
  const unackCount = se ? se.counts.unacknowledged : (lr?.docsErrors || 0);

  const attentions = [];
  if (missing.length > 0) {
    attentions.push({ key: 'keys', text: `Missing keys on this service: ${missing.join(', ')}. Runs find nothing from those sources until they are set.` });
  }
  if (lr && !lr.ok) {
    attentions.push({ key: 'run', text: `The last run failed: ${lr.error}` });
  }
  if (lr?.ok && unackCount > 0) {
    attentions.push({
      key: 'sync',
      text: `${unackCount} document${unackCount === 1 ? '' : 's'} failed to sync on the last run.`,
      detail: unackErrors.map(e => (typeof e === 'string' ? e : `${e.path}: ${e.message}`)),
    });
  }
  if (lr?.ok && lr.peopleStopped) {
    attentions.push({ key: 'people', text: `The people search stood down on ${lr.peopleStopped} during the last run.` });
  }
  if (engine.studioLast && engine.studioLast.ok === false && engine.studioLast.unhealthy) {
    attentions.push({ key: 'studio', text: 'The studio autopilot stood itself down on a LinkedIn account-health error. Check the account, then turn the switch back on.' });
  }
  if (engine.inviteDripLast && engine.inviteDripLast.ok === false && engine.inviteDripLast.unhealthy) {
    attentions.push({ key: 'drip', text: 'The invite drip stood itself down on a LinkedIn account-health error. Check the account, then turn the switch back on.' });
  }

  // The calm summary of what is acknowledged: one line, plain text, with the
  // full list behind a disclosure. Counted, never dropped.
  const ackGroups = se?.summary || [];
  const ackList = se?.acknowledged || [];

  return (
    <div className="card health-card gap-10">
      <div className="eyebrow">Signal engine</div>
      {attentions.length > 0 && (
        <div className="engine-attention">
          {attentions.map(a => a.detail
            ? <SyncErrors key={a.key} text={a.text} detail={a.detail} />
            : <div className="engine-warn" key={a.key}>{a.text}</div>)}
        </div>
      )}
      {ackList.length > 0 && <AcknowledgedSyncErrors groups={ackGroups} list={ackList} />}
      <div className="engine-row">
        <div className="status-big">
          <span className="status-dot" style={{ background: engine.running ? 'var(--blue)' : engine.enabled ? 'var(--teal)' : 'var(--stop-muted)' }} />
          {engine.running ? 'Running now' : engine.enabled ? 'On' : 'Off'}
        </div>
        <button className="engine-btn primary" onClick={toggle} disabled={busy}>
          {engine.enabled ? 'Turn off' : 'Turn on'}
        </button>
        <button className="engine-btn" onClick={runNow} disabled={busy || engine.running}>Run now</button>
        <button className="engine-btn" onClick={toggleDiscover} disabled={busy}>
          {engine.autoDiscover ? 'Email discovery: on' : 'Email discovery: off'}
        </button>
        <button className="engine-btn" onClick={togglePeople} disabled={busy}
          title="Finds specifiers for a small batch of unsearched named accounts each cycle, through the connected LinkedIn account. Stands itself down on any account-health error.">
          {engine.autoPeople ? 'People search: on' : 'People search: off'}
        </button>
        <button className="engine-btn" onClick={toggleSync} disabled={busy || !engine.syncConfigured}
          title={engine.syncConfigured
            ? 'Refreshes the document corpus from the configured Sales Engine folders each cycle. Documents only; price files are refused by the sync itself.'
            : 'Set SHAREPOINT_SYNC_FOLDERS on the service to name the folders first; nothing syncs without it.'}>
          {engine.autoSync ? 'SharePoint sync: on' : 'SharePoint sync: off'}
        </button>
        <button className="engine-btn" onClick={toggleStudio} disabled={busy}
          title="Publishes approved studio posts at the standing Tuesday, Wednesday and Thursday morning slots, tops up thin queues with fresh drafts, and sweeps engagement into the interest queue. Approval stays human, and any account-health error stands it down.">
          {engine.studioAutopilot ? 'Studio autopilot: on' : 'Studio autopilot: off'}
        </button>
        <button className="engine-btn" onClick={toggleDrip} disabled={busy}
          title="Releases approved connection invites one at a time through weekday working hours, spaced per account, within a cap tighter than the hand cap, a few days after any email with no reply. Approval stays human, and any account-health error stands it down. Worth James's and Andy's own yes before switching on.">
          {engine.inviteDrip ? 'Invite drip: on' : 'Invite drip: off'}
        </button>
      </div>
      <div className="health-sub">
        {engine.enabled
          ? `Finding signals and pulling leads every ${engine.intervalHours} hours.`
          : 'Automatic signal finding and lead pulling is off. Manual runs still work.'}
      </div>
      {lr?.ok && (
        <div className="muted-small">
          Last run {fmtClockDay(lr.at)}{lr.trigger ? ` (${lr.trigger})` : ''}: {lr.signalsStored ?? 0} signals stored, {lr.signalsRejected ?? 0} rejected, {lr.matched ?? 0} matched, {lr.leadsCreated ?? 0} leads created, {lr.leadsUpdated ?? 0} refreshed{lr.peopleSearched != null ? `, ${lr.peopleSearched} account(s) people-searched, ${lr.peopleFound ?? 0} contacts (${lr.peopleOrbit ?? 0} in orbit)` : ''}{lr.emailsResolved != null ? `, ${lr.emailsResolved} emails resolved (${lr.emailCredits ?? 0} credits)` : ''}{lr.docsChecked != null ? `, ${lr.docsChecked} document(s) checked, ${lr.docsUpdated ?? 0} refreshed${lr.docsRemoved ? `, ${lr.docsRemoved} withdrawn` : ''}` : ''}{lr.docsSkipped ? `, document sync skipped: ${lr.docsSkipped}` : ''}.
        </div>
      )}
      {note && <div className="muted-small">{note}</div>}
    </div>
  );
}

// Sync errors, counted at the top and openable to name the failing documents,
// because the count alone is what let them go unread. Each row is a document
// and its error, so a reader can tell a datasheet that failed to extract from
// an image-only PDF that never had text.
function SyncErrors({ text, detail }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="engine-warn">
      <button className="sync-err-toggle" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        {text} {open ? 'Hide' : 'Show'} the {detail.length} named.
      </button>
      {open && (
        <ul className="sync-err-list">
          {detail.map((e, i) => <li key={i} className="mono-sm">{e}</li>)}
        </ul>
      )}
    </div>
  );
}

// Acknowledged sync failures: a known condition, so calm text rather than
// amber, one line summarising the classes with the full list behind a
// disclosure. Counted and inspectable, never silently dropped, and anything
// unacknowledged is still in the amber block above this.
function AcknowledgedSyncErrors({ groups, list }) {
  const [open, setOpen] = useState(false);
  const phrase = groups.map(g => `${g.count} ${g.summary}${g.count === 1 ? '' : 's'}`).join(', ');
  return (
    <div className="muted-small ack-block">
      {list.length} document{list.length === 1 ? ' is a known exception' : 's are known exceptions'}: {phrase}.{' '}
      <button className="sync-err-toggle" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        {open ? 'Hide' : 'Show'} them
      </button>
      {open && (
        <ul className="sync-err-list">
          {list.map((e, i) => (
            <li key={i}>
              <span className="mono-sm">{e.path}</span>
              <div className="ack-reason">{e.reason}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// The campaigns view, read only. One row per registered campaign: name, status,
// last sweep, and the cumulative state behind it. Not a control surface; status
// is set in the campaign definition and changed by a reviewed edit, which the
// footer says so a reader does not hunt for a toggle that is not here. A
// campaign with nothing behind it shows honest zeroes.
function CampaignsCard() {
  const [d, setD] = useState(null);
  useEffect(() => {
    apiFetch('/api/health/campaigns').then(r => (r.ok ? r.json() : null)).then(setD).catch(() => setD(null));
  }, []);
  if (!d || !(d.campaigns || []).length) return null;
  return (
    <div className="card health-card gap-10">
      <div className="eyebrow">Campaigns</div>
      <div className="camp-table">
        {d.campaigns.map(c => (
          <div className="camp-row" key={c.id}>
            <div className="camp-id">
              <span className="camp-name">{c.displayName}</span>
              <span className={`camp-status camp-status--${c.status}`}>{c.status}</span>
            </div>
            <div className="camp-figs">
              <span><b>{c.accounts}</b> accounts</span>
              <span><b>{c.signalsPassed}</b> signals</span>
              <span><b>{c.leads}</b> leads</span>
              <span><b>{c.drafts}</b> drafts</span>
            </div>
            <div className="camp-swept">
              {c.lastSweptAt ? `swept ${fmtClockDay(c.lastSweptAt)}` : (c.status === 'active' ? 'not yet swept' : 'manual, swept by hand')}
            </div>
          </div>
        ))}
      </div>
      <div className="muted-small">
        Status is set in the campaign definition and changed by a reviewed edit, not from this screen. An active campaign sweeps on the engine cycle; a manual one is run by hand.
      </div>
    </div>
  );
}

// The price lookup switch: the lists load from the ingest script, and the
// co-pilot's price card appears only when this is on. It stays off until a
// sample of stored prices has been checked against what would be quoted.
function PriceCard() {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    apiFetch('/api/price/status').then(r => r.json()).then(setStatus).catch(() => setStatus(null));
  }, []);
  useEffect(() => { load(); }, [load]);
  const toggle = async () => {
    if (!status || busy) return;
    setBusy(true);
    try {
      await apiFetch('/api/price/toggle', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !status.enabled }),
      });
      load();
    } catch { /* the reload shows truth */ }
    setBusy(false);
  };
  if (!status) return null;
  const lines = Object.entries(status.lines || {}).map(([l, n]) => `${l} ${n}`).join(', ');
  return (
    <div className="card health-card gap-10">
      <div className="eyebrow">Price lookup</div>
      <div className="muted-small">
        {status.migrationPending
          ? 'The prices table is not created yet; run npm run migrate.'
          : status.parts > 0
            ? `${status.parts} part numbers loaded (${lines}), sell prices only, cost columns never ingested.`
            : 'No prices loaded yet. Load them with scripts/ingest-prices.mjs from a machine with .env.'}
      </div>
      <div>
        <button className="ob-btn" onClick={toggle} disabled={busy || status.parts === 0}>
          {status.enabled ? 'Co-pilot price card: on' : 'Co-pilot price card: off'}
        </button>
      </div>
      {status.parts > 0 && !status.enabled && (
        <div className="muted-small">Flip it on once James has checked a sample of loaded prices against what he would quote.</div>
      )}
    </div>
  );
}

// Stage one of builders for every Marwin range: pick through the priced
// book, model then size then material then package, and land on a stored
// part number with its guide prices. The choices only ever come from the
// book, so the builder cannot assemble a code that does not exist. Ranges
// with ordering matrices in hand (CV3000, CV4700) keep their full slot
// builders in the co-pilot chat.
function RangeBuilder() {
  const [ranges, setRanges] = useState(null);
  const [series, setSeries] = useState('');
  const [tree, setTree] = useState(null);
  const [model, setModel] = useState('');
  const [size, setSize] = useState('');
  const [mat, setMat] = useState('');
  const [pkg, setPkg] = useState('');
  useEffect(() => {
    apiFetch('/api/marwin/ranges').then(r => (r.ok ? r.json() : null))
      .then(d => setRanges(d?.ranges || [])).catch(() => setRanges([]));
  }, []);
  useEffect(() => {
    setTree(null); setModel(''); setSize(''); setMat(''); setPkg('');
    if (!series) return;
    apiFetch(`/api/marwin/range/${encodeURIComponent(series)}`).then(r => r.json())
      .then(setTree).catch(() => setTree(null));
  }, [series]);
  if (!ranges || ranges.length === 0) return null;

  const eModel = model || (tree?.models?.length === 1 ? tree.models[0].model : '');
  const mNode = tree?.models?.find(m => m.model === eModel) || null;
  const eSize = size || (mNode?.sizes?.length === 1 ? mNode.sizes[0].size : '');
  const sNode = mNode?.sizes?.find(s => s.size === eSize) || null;
  const eMat = mat || (sNode?.materials?.length === 1 ? (sNode.materials[0].material || 'none') : '');
  const matNode = sNode?.materials?.find(x => (x.material || 'none') === eMat) || null;
  const ePkg = pkg || (matNode?.packages?.length === 1 ? matNode.packages[0].part : '');
  const chosen = matNode?.packages?.find(p => p.part === ePkg) || null;

  return (
    <div className="card health-card gap-10">
      <div className="eyebrow">Marwin range builder</div>
      <div className="muted-small">Every choice comes from the priced book, so it can only build parts that exist. Prices are guide prices at the calculator's standard settings.</div>
      <select className="ob-select" value={series} onChange={e => setSeries(e.target.value)}>
        <option value="">Choose a range ({ranges.length} loaded)</option>
        {ranges.map(r => <option key={r.series} value={r.series}>{r.series} series ({r.parts} parts)</option>)}
      </select>
      {tree && (
        <select className="ob-select" value={eModel} onChange={e => { setModel(e.target.value); setSize(''); setMat(''); setPkg(''); }}>
          <option value="">Model</option>
          {tree.models.map(m => <option key={m.model} value={m.model}>{m.model}</option>)}
        </select>
      )}
      {mNode && (
        <select className="ob-select" value={eSize} onChange={e => { setSize(e.target.value); setMat(''); setPkg(''); }}>
          <option value="">Size</option>
          {mNode.sizes.map(s => <option key={s.size} value={s.size}>{s.size}</option>)}
        </select>
      )}
      {sNode && (
        <select className="ob-select" value={eMat} onChange={e => { setMat(e.target.value); setPkg(''); }}>
          <option value="">Material</option>
          {sNode.materials.map(x => (
            <option key={x.material || 'none'} value={x.material || 'none'}>{x.materialLabel || 'as listed'}</option>
          ))}
        </select>
      )}
      {matNode && (
        <select className="ob-select" value={ePkg} onChange={e => setPkg(e.target.value)}>
          <option value="">Configuration</option>
          {matNode.packages.map(p => <option key={p.part} value={p.part}>{p.label}</option>)}
        </select>
      )}
      {chosen && (
        <div className="muted-small">
          <div className="mono-sm">{chosen.part}</div>
          <div>£{Number(chosen.prices.GBP).toLocaleString('en-GB')}, €{Number(chosen.prices.EUR).toLocaleString('en-GB')}, ${Number(chosen.prices.USD).toLocaleString('en-GB')}</div>
          <div>{chosen.description}</div>
          <div>Guide price; the final margin is set per customer at quote through the calculator.</div>
        </div>
      )}
    </div>
  );
}

// What the SharePoint sync holds: the recently refreshed documents with
// their lines, and the honest instruction that the site itself is where you
// add or update a document to teach the co-pilot. Upload happens there, in
// SharePoint's own UI, because the engine's access is read-only by design.
function SharePointDocsCard() {
  const [d, setD] = useState(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    apiFetch('/api/sharepoint/docs').then(r => (r.ok ? r.json() : null)).then(setD).catch(() => setD(null));
  }, []);
  if (!d || d.migrationPending) return null;
  if (!d.configured && !(d.totals?.docs > 0)) return null;
  // A directory listing is not a health signal. The count and last sync are,
  // and the few most recently changed documents are worth a glance; the rest
  // sit behind a disclosure rather than filling the card with twenty links.
  const docs = d.docs || [];
  const recent = docs.slice(0, 3);
  const rest = docs.slice(3);
  const docLink = doc => doc.url
    ? <a href={doc.url} target="_blank" rel="noreferrer">{doc.name}</a>
    : doc.name;
  return (
    <div className="card health-card gap-10">
      <div className="eyebrow">SharePoint documents</div>
      {d.totals.docs > 0 ? (
        <>
          <div className="health-hero">{d.totals.docs.toLocaleString('en-GB')}</div>
          <div className="health-sub">
            documents synced, {d.totals.chunks.toLocaleString('en-GB')} chunks, last sync {d.totals.lastSync ? fmtClockDay(d.totals.lastSync) : 'unknown'}.
            {d.enabled ? '' : ' The sync switch is off; the cycle is not refreshing them.'}
          </div>
          {recent.length > 0 && (
            <div className="muted-small">
              <div className="camp-swept">Most recently changed</div>
              {recent.map(doc => (
                <div key={doc.path}>{docLink(doc)} <span className="sp-line">({lineLabel(doc.line)}, {fmtClockDay(doc.syncedAt)})</span></div>
              ))}
            </div>
          )}
          {rest.length > 0 && (
            <div className="muted-small">
              <button className="sync-err-toggle" onClick={() => setOpen(o => !o)} aria-expanded={open}>
                {open ? 'Hide' : 'Show'} {rest.length} more
              </button>
              {open && rest.map(doc => (
                <div key={doc.path}>{docLink(doc)} <span className="sp-line">({lineLabel(doc.line)}, {fmtClockDay(doc.syncedAt)})</span></div>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="muted-small">
          Nothing synced yet. {d.enabled ? 'The next engine cycle (or Run now) does the first sync.' : 'Turn SharePoint sync on from the Signal engine card.'}
        </div>
      )}
      <div className="muted-small">
        Add or update documents on the site itself and the engine picks them up each cycle; removing one there withdraws it here.
        {d.siteUrl && <> <a href={d.siteUrl} target="_blank" rel="noreferrer">Open the Sales Engine site</a>.</>}
      </div>
    </div>
  );
}

export default function Health() {
  const [data, setData] = useState(null);
  const [state, setState] = useState('loading');
  useEffect(() => {
    let live = true;
    apiFetch('/api/health/cards').then(r => r.json())
      .then(d => { if (live) { setData(d); setState('ready'); } })
      .catch(() => { if (live) setState('error'); });
    return () => { live = false; };
  }, []);

  if (state === 'loading') return <div className="content-pad"><p className="muted-note">Loading health.</p></div>;
  if (state === 'error') return <div className="content-pad"><p className="muted-note">Health is not available right now.</p></div>;

  const { corpus, database, graph, killSwitch } = data;
  const byLine = corpus.byLine || [];
  const maxDocs = Math.max(1, ...byLine.map(l => l.docs));
  const checked = graph.checkedAt ? fmtClockDay(graph.checkedAt).split(' · ')[0] : null;
  // The corpus is every source; the SharePoint card counts only the sync's
  // own subset. Naming the split here stops a reader subtracting one from the
  // other and concluding documents were lost.
  const spDocs = corpus.sharepointDocuments ?? null;
  const otherDocs = spDocs != null ? Math.max(0, (corpus.documents ?? 0) - spDocs) : null;

  return (
    <div className="content-pad">
      <div className="health-grid">
        <EngineCard />
        <CampaignsCard />
        <PriceCard />
        <RangeBuilder />
        <SharePointDocsCard />

        <div className="card health-card">
          <div className="eyebrow">Corpus</div>
          <div className="health-hero">{(corpus.chunks ?? 0).toLocaleString('en-GB')}</div>
          <div className="health-sub">chunks across <span className="mono-sm">{corpus.documents ?? 0}</span> documents, every source.</div>
          {spDocs != null && (
            <div className="muted-small">
              {spDocs.toLocaleString('en-GB')} from the SharePoint sync, {otherDocs.toLocaleString('en-GB')} from earlier ingests. The SharePoint card counts the first group only.
            </div>
          )}
        </div>

        <div className="card health-card gap-10">
          <div className="eyebrow">Documents by line</div>
          {byLine.length === 0 && <div className="muted-small">No line metadata yet.</div>}
          {byLine.map((l, i) => (
            <div className="line-row" key={i}>
              <span className="line-label">{l.line === 'untagged' ? 'Untagged' : lineLabel(l.line)}</span>
              <span className="meter"><span style={{ width: `${Math.round((l.docs / maxDocs) * 100)}%` }} /></span>
              <span className="line-count">{l.docs}</span>
            </div>
          ))}
        </div>

        <div className="card health-card">
          <div className="eyebrow">Last ingestion</div>
          <div className="health-time">{corpus.lastIngestedAt ? fmtClockDay(corpus.lastIngestedAt) : '—'}</div>
          {corpus.lastIngestedAt
            ? <div className="status-line teal"><span className="status-dot" />Completed</div>
            : <div className="muted-small">No ingestion recorded yet</div>}
        </div>

        <div className="card health-card">
          <div className="eyebrow">Graph connection</div>
          {graph.configured ? (
            graph.connected ? (
              <>
                <div className="status-big"><span className="status-dot teal-bg" />Connected</div>
                <div className="health-sub">Token valid{checked && <> · checked <span className="mono-sm">{checked}</span></>}</div>
              </>
            ) : (
              <>
                <div className="status-big"><span className="status-dot amber-bg" />Not connected</div>
                <div className="health-sub">Token request failed{checked && <> · checked <span className="mono-sm">{checked}</span></>}</div>
              </>
            )
          ) : (
            <>
              <div className="status-big"><span className="status-dot grey-bg" />Not configured</div>
              <div className="health-sub">No Graph credentials in this environment</div>
            </>
          )}
        </div>

        <div className="card health-card">
          <div className="eyebrow">Database</div>
          <div className="status-big"><span className="status-dot teal-bg" />Healthy</div>
          <div className="health-sub">{database.engine}{database.pgvector && <> · pgvector <span className="mono-sm">{database.pgvector}</span></>}{database.sizeMB != null && <> · <span className="mono-sm">{database.sizeMB} MB</span></>}</div>
        </div>

        <div className="card health-card">
          <div className="eyebrow">Kill switch</div>
          <div className="status-big"><span className="status-dot" style={killSwitch === 'on' ? { background: 'var(--navy)' } : { background: 'var(--teal)' }} />{killSwitch === 'on' ? 'Sending disabled' : 'Sending enabled'}</div>
          <div className="health-sub">{killSwitch === 'on' ? 'Outbound will not send while this is on' : 'The kill switch is off'}</div>
        </div>
      </div>
    </div>
  );
}
