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

  if (!engine) {
    return (
      <div className="card health-card">
        <div className="eyebrow">Signal engine</div>
        <div className="muted-small">Engine status is not available right now.</div>
      </div>
    );
  }

  const missing = Object.entries(engine.keys || {}).filter(([, ok]) => !ok).map(([k]) =>
    ({ companiesHouse: 'Companies House', tavily: 'Tavily', anthropic: 'Anthropic' }[k] || k));
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
            ? `${lr.signalsStored ?? 0} signals stored, ${lr.signalsRejected ?? 0} rejected, ${lr.matched ?? 0} matched, ${lr.leadsCreated ?? 0} leads created, ${lr.leadsUpdated ?? 0} refreshed.`
            : `failed, ${lr.error}`}
        </div>
      )}
      {note && <div className="muted-small">{note}</div>}
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
