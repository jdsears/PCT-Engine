import { useState, useEffect } from 'react';
import { lineLabel, fmtDay } from './labels.js';
import { apiFetch } from './api.js';
import { useCampaignList, isAll } from './CampaignSwitcher.jsx';

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
// month. Geometry matches the design: x from 4 to 316, baseline y 49, rise 38.
function buildSpark(daily) {
  const map = new Map((daily || []).map(d => [d.day, d.n]));
  const today = new Date();
  const series = [];
  for (let i = 29; i >= 0; i--) {
    const dt = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    series.push({ dt, n: map.get(dt.toISOString().slice(0, 10)) || 0 });
  }
  const max = Math.max(1, ...series.map(d => d.n));
  const pts = series.map((d, i) => [
    4 + i * (312 / (series.length - 1)),
    49 - (d.n / max) * 38,
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
      <div className="eyebrow">{children}</div>
      <div className="rule" />
    </div>
  );
}

// One campaign's month, read as figures rather than a table: what is on its
// register, what its sweep found, what reached the funnel, what is waiting to be
// reviewed and what has gone out.
function CampaignFigures({ c }) {
  const quiet = !c.accounts && !c.signals.swept && !c.leads && !c.drafts.inReview && !c.drafts.sent;
  return (
    <>
      <div className="ins-cards">
        <div className="ins-card ins-card--stat">
          <div className="ins-hero">{c.accounts}</div>
          <div className="eyebrow">Accounts on the register</div>
        </div>
        <div className="ins-card ins-card--stat">
          <div className="ins-hero">{c.signals.passed} / {c.signals.swept}</div>
          <div className="eyebrow">Signals past the gate</div>
        </div>
        <div className="ins-card ins-card--stat">
          <div className="ins-hero">{c.leads}</div>
          <div className="eyebrow">Leads in the funnel</div>
        </div>
        <div className="ins-card ins-card--stat">
          <div className="ins-hero">{c.drafts.inReview}</div>
          <div className="eyebrow">Drafts in review</div>
        </div>
        <div className="ins-card ins-card--stat">
          <div className="ins-hero">{c.drafts.sent}</div>
          <div className="eyebrow">Sent</div>
        </div>
      </div>
      {(c.staleLeads > 0 || c.openReviews > 0) && (
        <p className="ins-caption">
          {c.staleLeads > 0 ? `${c.staleLeads} lead${c.staleLeads === 1 ? '' : 's'} gone stale, held out of new drafting. ` : ''}
          {c.openReviews > 0 ? `${c.openReviews} discovered compan${c.openReviews === 1 ? 'y' : 'ies'} awaiting review in Accounts.` : ''}
        </p>
      )}
      {quiet && (
        <p className="ins-caption">
          Nothing recorded for this campaign yet. Figures appear once it has been seeded and its first sweep has run.
        </p>
      )}
    </>
  );
}

export default function Insights({ campaign }) {
  const [state, setState] = useState('loading');
  const [data, setData] = useState(null);
  const campaignList = useCampaignList();

  useEffect(() => {
    let live = true;
    Promise.all([
      apiFetch('/api/insights/summary?days=30').then(r => r.json()),
      apiFetch('/api/insights/gaps?days=90').then(r => r.json()),
      apiFetch('/api/insights/top-docs?days=90').then(r => r.json()),
      apiFetch('/api/insights/campaigns?days=30').then(r => (r.ok ? r.json() : { campaigns: [] })).catch(() => ({ campaigns: [] })),
    ])
      .then(([summary, gaps, docs, camp]) => { if (live) { setData({ summary, gaps, docs, camp }); setState('ready'); } })
      .catch(() => { if (live) setState('error'); });
    return () => { live = false; };
  }, []);

  if (state === 'loading') {
    return <div className="content-pad"><p className="muted-note">Loading insights.</p></div>;
  }
  if (state === 'error') {
    return <div className="content-pad"><p className="muted-note">Insights are not available right now.</p></div>;
  }

  const { summary, gaps, docs, camp } = data;
  const allCampaigns = camp?.campaigns || [];
  const scoped = !isAll(campaign);
  const shown = scoped ? allCampaigns.filter(c => c.id === campaign) : allCampaigns;
  const showCampaigns = allCampaigns.length > 1 || scoped;
  const questions = summary.questions || 0;
  const declined = summary.declined || 0;
  const young = questions < 10;

  const rate = questions ? Math.round(((questions - declined) / questions) * 100) : 0;
  const declPct = questions ? 100 - rate : 0;
  const rateLabel = questions ? `${rate}%` : '—';
  const typical = summary.avgLatencyMs == null ? '—' : `${(summary.avgLatencyMs / 1000).toFixed(1)}s`;

  const spark = buildSpark(summary.daily);
  const fb = summary.feedback || { up: 0, down: 0 };
  const channels = (summary.byChannel || []).filter(c => c.n > 0);

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
    <div className="content-pad">
      <div className="insights-col">
        {/* Two zones, labelled, so the distinction is structure rather than a
            caveat sentence a reader might miss. The first answers to the
            switcher; the second reads the query log, which has no campaign. */}
        {showCampaigns && (
          <section className="ins-zone">
            <div className="ins-zone-head">
              <div className="ins-zone-title">Campaign funnel</div>
              <div className="ins-zone-sub">{scoped ? 'This campaign, last 30 days. Scoped to the switcher.' : 'Last 30 days, one block per campaign. Scoped to the switcher.'}</div>
            </div>
            {shown.length === 0 ? (
              <p className="muted-note">This campaign is registered but has no activity recorded yet.</p>
            ) : scoped ? (
              <CampaignFigures c={shown[0]} />
            ) : (
              <div className="ins-campaigns">
                {shown.map(c => (
                  <div className="ins-campaign" key={c.id}>
                    <div className="ins-campaign-head">
                      <span className="ins-campaign-name">{c.displayName}</span>
                      {c.status && c.status !== 'active' && <span className="pill">{c.status}</span>}
                    </div>
                    <div className="ins-campaign-figs">
                      <span><b>{c.accounts}</b> accounts</span>
                      <span><b>{c.signals.passed}</b> of {c.signals.swept} signals past the gate</span>
                      <span><b>{c.leads}</b> leads</span>
                      {c.staleLeads > 0 && <span><b>{c.staleLeads}</b> stale</span>}
                      <span><b>{c.drafts.inReview}</b> in review</span>
                      {c.openReviews > 0 && <span><b>{c.openReviews}</b> to review</span>}
                      <span><b>{c.drafts.sent}</b> sent</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        <section className="ins-zone">
          <div className="ins-zone-head">
            <div className="ins-zone-title">Co-pilot usage, whole engine</div>
            <div className="ins-zone-sub">Every question the team asks the co-pilot, across all campaigns. Not scoped by the switcher, because a question is not asked on behalf of a campaign.</div>
          </div>

          {young && <p className="muted-note">Early days. These build as the team uses the co-pilot.</p>}

          {/* Reading cards */}
          <div className="ins-section ins-section--cards">
            <Head>This month</Head>
            <div className="ins-cards">
            <div className="ins-card ins-card--spark">
              <div className="ins-card-figure">
                <div className="ins-hero">{questions}</div>
                <div className="eyebrow">Questions asked</div>
              </div>
              <div className="ins-spark">
                <svg viewBox="0 0 320 56" className="ins-spark-svg" aria-hidden="true">
                  <line x1="4" y1="50" x2="316" y2="50" stroke="var(--line)" strokeWidth="1" />
                  <polyline points={spark.points} fill="none" stroke="var(--navy)" strokeWidth="1.5"
                    vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
                  <circle cx={spark.cx} cy={spark.cy} r="3" fill="var(--blue)" />
                </svg>
                <div className="ins-spark-dates"><span>{spark.left}</span><span>{spark.right}</span></div>
              </div>
            </div>

            <div className="ins-card ins-card--rate">
              <div className="ins-hero">{rateLabel}</div>
              <div className="eyebrow">Answer rate</div>
              <div className="ins-gauge" aria-hidden="true">
                <div className="ins-gauge-rail" />
                <div className="ins-gauge-teal" style={{ width: `${rate}%` }} />
                <div className="ins-gauge-amber" style={{ width: `${declPct}%` }} />
                <div className="ins-gauge-tick" style={{ left: `${rate}%` }} />
              </div>
              <div className="ins-scale"><span>0</span><span>100</span></div>
              <div className="ins-legend"><span className="ins-legend-sw" />Declined {declPct}%</div>
            </div>

            <div className="ins-card ins-card--reply">
              <div className="ins-hero">{typical}</div>
              <div className="eyebrow">Typical reply</div>
            </div>
          </div>
          {(fb.up + fb.down > 0 || channels.length > 0) && (
            <p className="ins-caption">
              {fb.up + fb.down > 0 ? `Feedback: ${fb.up} helpful, ${fb.down} not helpful. ` : ''}
              {channels.length > 0 ? 'Asked from ' + channels.map(c => `${c.channel === 'teams' ? 'Teams' : 'the web app'} ${c.n}`).join(', ') + '.' : ''}
            </p>
          )}
        </div>

        {/* Demand by line */}
        <div className="ins-section">
          <Head>What the team asks about</Head>
          <div className="ins-bars">
            {demand.map((d, i) => (
              <div className="ins-bar" key={i}>
                <div className="ins-bar-label">{d.label}</div>
                <div className="ins-bar-track"><span className="ins-bar-fill" style={{ width: `${Math.round((d.count / dMax) * 100)}%` }} /></div>
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
                  &#8220;{g.q}&#8221; <span className="ins-gap-times">&#215;{g.times}</span>
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
                <div className="ins-bar-track"><span className="ins-bar-fill" style={{ width: `${Math.round((d.count / cMax) * 100)}%` }} /></div>
                <div className="ins-bar-count">{d.count}</div>
              </div>
            ))}
          </div>
        </div>

          {/* Engine metrics */}
          <div className="ins-section">
            <Head>Engine metrics</Head>
            <p className="muted-note">Reply rates, deliverability and pipeline timing arrive with the outbound stage.</p>
          </div>
        </section>
      </div>
    </div>
  );
}
