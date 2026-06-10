import { useState, useEffect } from 'react';

// Friendly labels for the line and application keys the answer layer detects.
const LINE_LABELS = {
  marwin: 'Marwin', steriflow: 'Steriflow', steriflow_fb: 'Steriflow F&B',
  jordan: 'Jordan', low_flow: 'Low flow', hexvalve: 'Hex Valve',
  bestobell_steam: 'Bestobell', equilibar: 'Equilibar', data_centre: 'Data centre',
  general: 'General',
};
const lineLabel = k =>
  LINE_LABELS[k] || (k ? k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, ' ') : 'General');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDay = dt => `${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]}`;

// A grounded answer cites a source; a decline cites none. We never log who asked,
// so the "when" on a gap is the only time we surface, and only ever relative.
function fmtWhen(ts) {
  if (!ts) return '';
  const then = new Date(ts);
  const days = Math.floor((Date.now() - then.getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return fmtDay(then);
}

// Zero-fill the daily counts to thirty points so the sparkline always reads as a
// month, not a jagged few. Maps counts across the baseline (4..316) of the 320x56
// viewBox, with the most recent day carrying the marker dot.
function buildSpark(daily) {
  const map = new Map((daily || []).map(d => [d.day, d.n]));
  const today = new Date();
  const series = [];
  for (let i = 29; i >= 0; i--) {
    const dt = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    series.push({ dt, n: map.get(dt.toISOString().slice(0, 10)) || 0 });
  }
  const max = Math.max(1, ...series.map(d => d.n));
  const X0 = 4, X1 = 316, YB = 50, YT = 6;
  const pts = series.map((d, i) => [
    X0 + (X1 - X0) * (i / (series.length - 1)),
    YB - (d.n / max) * (YB - YT),
  ]);
  const last = pts[pts.length - 1];
  return {
    points: pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' '),
    cx: last[0].toFixed(1), cy: last[1].toFixed(1),
    left: fmtDay(series[0].dt), right: fmtDay(series[series.length - 1].dt),
  };
}

function Head({ children }) {
  return (
    <div className="ins-head">
      <div className="ins-eyebrow">{children}</div>
      <div className="ins-rule" />
    </div>
  );
}

export default function Insights() {
  const [state, setState] = useState('loading');
  const [data, setData] = useState(null);

  useEffect(() => {
    let live = true;
    Promise.all([
      fetch('/api/insights/summary?days=30').then(r => r.json()),
      fetch('/api/insights/gaps?days=90').then(r => r.json()),
      fetch('/api/insights/top-docs?days=90').then(r => r.json()),
    ])
      .then(([summary, gaps, docs]) => { if (live) { setData({ summary, gaps, docs }); setState('ready'); } })
      .catch(() => { if (live) setState('error'); });
    return () => { live = false; };
  }, []);

  if (state === 'loading') {
    return <div className="insights"><div className="insights-inner"><p className="ins-note">Loading insights.</p></div></div>;
  }
  if (state === 'error') {
    return <div className="insights"><div className="insights-inner"><p className="ins-note">Insights are not available right now.</p></div></div>;
  }

  const { summary, gaps, docs } = data;
  const questions = summary.questions || 0;
  const declined = summary.declined || 0;
  const young = questions < 10;

  const rate = questions ? Math.round(((questions - declined) / questions) * 100) : 0;
  const declPct = questions ? 100 - rate : 0;
  const rateLabel = questions ? `${rate}%` : '—';
  const typical = summary.avgLatencyMs == null ? '—' : `${(summary.avgLatencyMs / 1000).toFixed(1)}s`;

  const spark = buildSpark(summary.daily);

  const demand = (summary.lines || [])
    .filter(l => l.n > 0)
    .slice(0, 8)
    .map(l => ({ label: lineLabel(l.line), count: l.n }));
  const dMax = Math.max(1, ...demand.map(d => d.count));

  const gapRows = (gaps.gaps || []).slice(0, 12)
    .map(g => ({ q: g.question, times: g.repeats || 1, when: fmtWhen(g.last_asked) }));

  const docRows = (docs.docs || []).slice(0, 5)
    .map(d => ({ label: d.title || 'Untitled', count: d.citations }));
  const cMax = Math.max(1, ...docRows.map(d => d.count));

  return (
    <div className="insights">
      <div className="insights-inner">
        {young && <p className="ins-note">Early days. These build as the team uses the co-pilot.</p>}

        {/* Reading cards */}
        <div className="ins-section ins-section--cards">
          <Head>This month</Head>
          <div className="ins-cards">
            <div className="ins-card ins-card--spark">
              <div className="ins-card-figure">
                <div className="ins-hero">{questions}</div>
                <div className="ins-cap">Questions asked</div>
              </div>
              <div className="ins-spark">
                <svg viewBox="0 0 320 56" className="ins-spark-svg" aria-hidden="true">
                  <line x1="4" y1="50" x2="316" y2="50" stroke="var(--ins-line)" strokeWidth="1" />
                  <polyline points={spark.points} fill="none" stroke="var(--pct-dark)" strokeWidth="1.5"
                    vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
                  <circle cx={spark.cx} cy={spark.cy} r="3" fill="var(--ins-blue)" />
                </svg>
                <div className="ins-spark-dates"><span>{spark.left}</span><span>{spark.right}</span></div>
              </div>
            </div>

            <div className="ins-card ins-card--rate">
              <div className="ins-hero">{rateLabel}</div>
              <div className="ins-cap">Answer rate</div>
              <div className="ins-gauge" aria-hidden="true">
                <div className="ins-gauge-rail" />
                <div className="ins-gauge-teal" style={{ width: `${rate}%` }} />
                <div className="ins-gauge-amber" style={{ width: `${declPct}%` }} />
                <div className="ins-gauge-tick" style={{ left: `${rate}%` }} />
              </div>
              <div className="ins-scale"><span>0</span><span>100</span></div>
              <div className="ins-legend"><span className="ins-legend-sw" />Declined {declined}</div>
            </div>

            <div className="ins-card ins-card--reply">
              <div className="ins-hero">{typical}</div>
              <div className="ins-cap">Typical reply</div>
            </div>
          </div>
        </div>

        {/* Demand by line */}
        <div className="ins-section">
          <Head>What the team asks about</Head>
          <div className="ins-bars">
            {demand.map((d, i) => (
              <div className="ins-bar" key={i}>
                <div className="ins-bar-label">{d.label}</div>
                <div className="ins-bar-track"><span className="ins-bar-fill" style={{ width: `${(d.count / dMax) * 100}%` }} /></div>
                <div className="ins-bar-count">{d.count}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Knowledge gaps */}
        <div className="ins-section">
          <Head>Knowledge gaps</Head>
          <div className="ins-gaps">
            {gapRows.map((g, i) => (
              <div className="ins-gap" key={i}>
                <span className="ins-gap-tick" />
                <div className="ins-gap-q">
                  &#8220;{g.q}&#8221;
                  {g.times > 1 && <span className="ins-gap-times">&#215;{g.times}</span>}
                </div>
                {g.when && <span className="ins-gap-when">{g.when}</span>}
              </div>
            ))}
          </div>
          <p className="ins-caption">Questions the documents could not answer. Each one is a candidate for the knowledge capture work.</p>
        </div>

        {/* Most cited documents */}
        <div className="ins-section">
          <Head>Most cited documents</Head>
          <div className="ins-bars">
            {docRows.map((d, i) => (
              <div className="ins-bar" key={i}>
                <div className="ins-bar-label ins-bar-label--doc">{d.label}</div>
                <div className="ins-bar-track"><span className="ins-bar-fill" style={{ width: `${(d.count / cMax) * 100}%` }} /></div>
                <div className="ins-bar-count">{d.count}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Engine metrics */}
        <div className="ins-section">
          <Head>Engine metrics</Head>
          <p className="ins-note">Reply rates, deliverability and pipeline timing arrive with the outbound stage.</p>
        </div>
      </div>
    </div>
  );
}
