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

  return (
    <div className="card health-card gap-10">
      <div className="eyebrow">Signal engine</div>
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
      </div>
      <div className="health-sub">
        {engine.enabled
          ? `Finding signals and pulling leads every ${engine.intervalHours} hours.`
          : 'Automatic signal finding and lead pulling is off. Manual runs still work.'}
      </div>
      {missing.length > 0 && (
        <div className="engine-warn">Missing keys on this service: {missing.join(', ')}. Runs will find nothing from those sources until they are set.</div>
      )}
      {lr && (
        <div className="muted-small">
          Last run {fmtClockDay(lr.at)}{lr.trigger ? ` (${lr.trigger})` : ''}: {lr.ok
            ? `${lr.signalsStored ?? 0} signals stored, ${lr.signalsRejected ?? 0} rejected, ${lr.matched ?? 0} matched, ${lr.leadsCreated ?? 0} leads created, ${lr.leadsUpdated ?? 0} refreshed${lr.peopleSearched != null ? `, ${lr.peopleSearched} account(s) people-searched, ${lr.peopleFound ?? 0} contacts (${lr.peopleOrbit ?? 0} in orbit)${lr.peopleStopped ? `, stopped on ${lr.peopleStopped}` : ''}` : ''}${lr.emailsResolved != null ? `, ${lr.emailsResolved} emails resolved (${lr.emailCredits ?? 0} credits)` : ''}.`
            : `failed, ${lr.error}`}
        </div>
      )}
      {note && <div className="muted-small">{note}</div>}
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

  return (
    <div className="content-pad">
      <div className="health-grid">
        <EngineCard />
        <PriceCard />
        <RangeBuilder />

        <div className="card health-card">
          <div className="eyebrow">Corpus</div>
          <div className="health-hero">{(corpus.chunks ?? 0).toLocaleString('en-GB')}</div>
          <div className="health-sub">chunks across <span className="mono-sm">{corpus.documents ?? 0}</span> documents</div>
        </div>

        <div className="card health-card gap-10">
          <div className="eyebrow">Documents by line</div>
          {byLine.length === 0 && <div className="muted-small">No line metadata yet.</div>}
          {byLine.map((l, i) => (
            <div className="line-row" key={i}>
              <span className="line-label">{lineLabel(l.line)}</span>
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
