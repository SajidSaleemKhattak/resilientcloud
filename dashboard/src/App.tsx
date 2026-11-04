import { useEffect, useState, type ReactNode } from 'react';
import { parseEvents, parseExperiments, parseSnapshot, percent, range, readiness, seconds, stateLabels, stateTones, type Backend, type Experiments, type Incident, type Snapshot, type Tone, type Trial } from './model';
import { useResource, type Resource } from './useResource';

function Icon({ name, size = 20 }: { name: 'cloud' | 'grid' | 'chart' | 'layers' | 'lock' | 'arrow' | 'server' | 'activity' | 'clock' | 'external' | 'shield'; size?: number }) {
  const paths: Record<string, ReactNode> = {
    cloud: <><path d="M7 18a5 5 0 0 1-1-9.9 6.5 6.5 0 0 1 12.3-1.6A5.8 5.8 0 0 1 18 18h-5" /><path d="m9 14 4 4-4 4" /></>,
    grid: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
    chart: <><path d="M4 3v17h17M8 15v-4m5 4V6m5 9v-7" /></>,
    layers: <><path d="m3 7 9-5 9 5-9 5-9-5Zm0 5 9 5 9-5M3 17l9 5 9-5" /></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V6a4 4 0 0 1 8 0v4m-4 5v2" /></>,
    arrow: <><path d="M4 12h16m-5-5 5 5-5 5" /></>,
    server: <><rect x="3" y="3" width="18" height="7" rx="2" /><rect x="3" y="14" width="18" height="7" rx="2" /><path d="M7 6.5h.01M7 17.5h.01M11 6.5h6m-6 11h6" /></>,
    activity: <path d="M2 12h5l3-8 4 16 3-8h5" />,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 6v6l4 2" /></>,
    external: <><path d="M14 3h7v7m0-7L11 13M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4" /></>,
    shield: <><path d="m12 2 8 3v6c0 5-8 11-8 11S4 16 4 11V5l8-3Z" /><path d="m8 11 3 3 5-6" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge ${tone}`}><span className="status-dot" />{children}</span>;
}
function Time({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="muted">Not observed</span>;
  return <time dateTime={value} title={new Date(value).toISOString()}>{new Date(value).toLocaleTimeString('en-GB', { timeZone: 'UTC', hour12: false })} <span className="muted">UTC</span></time>;
}
function Label({ children }: { children: ReactNode }) { return <span className="eyebrow">{children}</span>; }
function Empty({ title, children }: { title: string; children: ReactNode }) {
  return <div className="empty"><span className="empty-icon"><Icon name="activity" size={25} /></span><h3>{title}</h3><p>{children}</p></div>;
}

function BackendCard({ name, backend, snapshot, connected, stale }: { name: string; backend?: Backend; snapshot: Snapshot | null; connected: boolean; stale: boolean }) {
  const ready = readiness(backend, connected, stale);
  const historical = !connected || stale || backend?.stale;
  const state = backend?.state ?? 'unknown';
  return <article className={`backend-card card ${ready.tone}`} aria-label={name}>
    <div className="card-heading"><div className="identity"><span className="service-icon"><Icon name="server" /></span><div><h3>{name}</h3><span className="small muted">Node.js / Express</span></div></div><Badge tone={ready.tone}>{ready.label}</Badge></div>
    <dl className="backend-details">
      <div><dt>Controller state{historical && backend ? ' · last known' : ''}</dt><dd><span className={`state-text ${historical ? 'neutral' : stateTones[state]}`}>{stateLabels[state]}</span></dd></div>
      <div><dt>Restart attempts</dt><dd>{backend?.attempts ?? '—'} <span className="muted">/ {snapshot?.config.maxAttempts ?? '—'} per incident</span></dd></div>
      <div><dt>Last readiness probe</dt><dd><Time value={backend?.lastProbe?.timestamp} /></dd></div>
      <div><dt>Consecutive failures</dt><dd>{backend?.failures ?? '—'} <span className="muted">/ {snapshot?.config.failureThreshold ?? '—'} to confirm</span></dd></div>
    </dl>
    <div className="instance-footer"><span className="small muted">Container</span><code title={backend?.containerId ?? undefined}>{backend?.containerId?.slice(0, 12) ?? 'Not observed'}</code></div>
    {state === 'exhausted' && <div className="instance-alert">Restart budget exhausted. Manual intervention is required.</div>}
    {!backend && <div className="instance-note">No observation for this instance. It may not be configured in this scenario.</div>}
    {backend?.lastProbe?.reason && !backend.lastProbe.ok && <div className="instance-note">Last probe: <code>{backend.lastProbe.reason.replaceAll('_', ' ')}</code></div>}
  </article>;
}

const eventTitles: Record<string, string> = {
  controller_started: 'Controller started', state_changed: 'State changed', failure_confirmed: 'Failure confirmed',
  restart_requested: 'Restart requested', restart_accepted: 'Restart accepted · not yet verified', restart_error: 'Restart request failed',
  recovery_verified: 'Readiness verified', exhausted: 'Restart budget exhausted', target_changed: 'Backend identity changed',
};
function eventTitle(event: Incident) {
  if (event.type === 'state_changed') return `${event.previous?.replaceAll('_', ' ') ?? 'unknown'} → ${event.state?.replaceAll('_', ' ') ?? 'unknown'}`;
  return eventTitles[event.type] ?? event.type.replaceAll('_', ' ');
}
function IncidentTimeline() {
  const feed = useResource('/events', parseEvents);
  const [expanded, setExpanded] = useState(false);
  const events = feed.data?.events ?? [];
  return <section className="card timeline-section" aria-labelledby="timeline-title">
    <div className="section-top"><div><Label>Controller journal</Label><h2 id="timeline-title">Incident timeline</h2></div><span className="small muted">Newest first · recorded events</span></div>
    {feed.error && <div className="inline-alert" role="status">Incident journal disconnected. {events.length > 0 ? 'Showing previously received events.' : 'No events are available.'}</div>}
    {feed.loading ? <Empty title="Loading the incident journal">Waiting for recorded controller events.</Empty> : events.length === 0 ? <Empty title={feed.error ? 'Journal unavailable' : 'No recorded incidents'}>Events appear here only when reported by the controller. Readiness probes are omitted from this timeline.</Empty> : <ol className="timeline">
      {events.slice(0, expanded ? 100 : 8).map((event, index) => <li key={`${event.runId}-${event.elapsedMs}-${event.type}-${index}`}>
        <span className={`timeline-dot ${event.type === 'exhausted' || event.type === 'restart_error' ? 'danger' : event.type === 'recovery_verified' ? 'good' : 'info'}`} />
        <div className="timeline-content"><div><strong>{eventTitle(event)}</strong>{event.service && <code className="event-service">{event.service}</code>}</div>{event.reason && <p>{event.reason.replaceAll('_', ' ')}</p>}</div>
        <Time value={event.timestamp} />
      </li>)}
    </ol>}
    {events.length > 8 && <button className="text-button" onClick={() => setExpanded(!expanded)}>{expanded ? 'Show fewer events' : `Show ${Math.min(events.length, 100)} recorded events`} <span aria-hidden="true">↗</span></button>}
    {feed.data?.truncated && <p className="small muted timeline-note">Showing the latest bounded journal window. Older events remain in the persisted journal.</p>}
  </section>;
}

function Overview({ status, clock }: { status: Resource<Snapshot>; clock: number }) {
  const snapshot = status.data;
  const connected = !!snapshot && !status.error;
  const elapsed = status.receivedAt === null ? 0 : Math.max(0, clock - status.receivedAt);
  const stale = !!snapshot && (snapshot.stale || snapshot.ageMs + elapsed > 5000);
  const ready = ['backend-a', 'backend-b'].filter(name => readiness(snapshot?.backends[name], connected, stale).label === 'Ready').length;
  const observed = ['backend-a', 'backend-b'].filter(name => snapshot?.backends[name]).length;
  const observation = status.loading ? 'Connecting' : !connected ? 'Disconnected' : stale ? 'Stale telemetry' : 'Live telemetry';
  const observationTone = status.loading || !connected ? 'neutral' : stale ? 'warning' : 'good';
  return <>
    <div className="page-heading"><div><Label>Local infrastructure / overview</Label><h1>System overview<span className="heading-dot">.</span></h1><p>Readiness, recovery, and the events behind each transition.</p></div><Badge tone={observationTone}>{observation}</Badge></div>
    {(status.error || stale) && <div className={`notice ${status.error ? 'warning' : 'neutral'}`} role="status"><Icon name="clock" /><div><strong>{status.error ? 'The status service is disconnected.' : 'Telemetry is stale.'}</strong><span>{status.error ? 'Current readiness is unknown. Last-known observations remain labelled below; polling continues automatically.' : 'These observations are older than five seconds. They do not confirm current readiness.'}</span></div></div>}
    <div className="metrics-grid">
      <div className="metric-card"><div className="metric-label">Observed readiness <Icon name="server" size={17} /></div><div className="metric-value">{connected && !stale ? ready : '—'}<span> / {observed || 2}</span></div><div className="metric-caption">{!connected || stale ? 'Waiting for current observations' : observed ? `${ready} of ${observed} monitored instances ready` : 'No instance observations yet'}</div></div>
      <div className="metric-card"><div className="metric-label">Automatic recovery <Icon name="shield" size={17} /></div><div className="metric-value word">{snapshot ? snapshot.recoveryEnabled ? 'Enabled' : 'Disabled' : 'Unknown'}</div><div className="metric-caption">{(!connected || stale) && snapshot ? 'Last-known controller configuration' : 'Controller policy · Docker restart policy off'}</div></div>
      <div className="metric-card"><div className="metric-label">Latest snapshot <Icon name="clock" size={17} /></div><div className="metric-value word timestamp"><Time value={snapshot?.updatedAt} /></div><div className="metric-caption">Read-only polling every 2 seconds</div></div>
    </div>
    <section className="card routing-section" aria-labelledby="routing-title">
      <div className="section-top"><div><Label>Two different responsibilities</Label><h2 id="routing-title">Keep traffic moving. Restore the instance.</h2></div><span className="diagram-badge">Single host</span></div>
      <div className="routing-grid"><div className="routing-explainer"><span className="number-tag">01</span><div><h3>Traffic failover</h3><p>Nginx can send eligible requests to a surviving backend. A successful request does not prove the failed instance recovered.</p><span className="subtle-tag">Passive checks · GET retries</span></div></div><div className="routing-explainer"><span className="number-tag recovery-number">02</span><div><h3>Backend recovery</h3><p>The controller confirms repeated probe failures, requests a bounded restart, then verifies readiness before declaring recovery.</p><span className="subtle-tag">Active probes · verified readiness</span></div></div></div>
      <div className="topology" aria-label="Configured topology, not a live traffic measurement"><span className="topology-node client">Client</span><Icon name="arrow" size={17} /><span className="topology-node gateway"><Icon name="layers" size={15} />Nginx gateway</span><Icon name="arrow" size={17} /><span className="topology-backends"><span>backend-a</span><span>backend-b <small>when configured</small></span></span><p>Configured request path<br /><strong>Live traffic volume is not measured here.</strong></p></div>
    </section>
    <div className="section-label"><h2>Backend instances</h2><span className="small muted">Private network · readiness observations</span></div>
    <div className="backend-grid">{['backend-a', 'backend-b'].map(name => <BackendCard key={name} name={name} backend={snapshot?.backends[name]} snapshot={snapshot} connected={connected} stale={stale} />)}</div>
    <IncidentTimeline />
  </>;
}

const scenarios = { A: { title: 'One backend', detail: 'Recovery off', color: 'scenario-a' }, B: { title: 'Two backends', detail: 'Recovery off', color: 'scenario-b' }, C: { title: 'Two backends', detail: 'Recovery on', color: 'scenario-c' } };
const faultLabels = { crash: 'Process crash', unhealthy: 'Unhealthy but running', control: 'No-fault control' };

function RateChart({ trials, postFault }: { trials: Trial[]; postFault: boolean }) {
  return <div className="rate-chart"><div className="chart-title"><h3>{postFault ? 'Post-fault success' : 'Whole-trial success'}</h3><span className="small muted">Each mark is one trial</span></div>
    <div className="chart-axis"><span>0%</span><span>50%</span><span>100%</span></div>
    {(['A', 'B', 'C'] as const).map(config => {
      const group = trials.filter(trial => trial.configuration === config && trial.valid);
      const rates = group.map(trial => postFault ? trial.postFault?.successRate ?? null : trial.whole.successRate);
      return <div key={config} className="chart-row"><span className={`scenario-token ${scenarios[config].color}`}>{config}</span><div className="chart-track" aria-hidden="true">{rates.map((value, index) => value !== null && <span key={index} className={`trial-mark ${scenarios[config].color}`} style={{ left: `${Math.max(0, Math.min(100, value * 100))}%`, top: `${7 + index * 7}px` }} title={`Trial ${group[index].repetition}: ${percent(value)}`} />)}</div><span className="chart-range">{range(rates, percent)}</span></div>;
    })}
  </div>;
}

function ExperimentResults({ summary }: { summary: Experiments }) {
  const [fault, setFault] = useState<Trial['fault']>('crash');
  const trials = summary.trials.filter(trial => trial.fault === fault);
  const skipped = summary.trials.reduce((sum, trial) => sum + trial.whole.skipped, 0);
  const rawSkipped = summary.trials.every(trial => trial.rawSkipped !== null) ? summary.trials.reduce((sum, trial) => sum + (trial.rawSkipped ?? 0), 0) : null;
  return <>
    <div className="notice saved-note"><Icon name="chart" /><div><strong>Saved evidence · {new Date(summary.generatedAt).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' })}</strong><span>{summary.trials.length} recorded trials. These results are independent of the live system above. Matrix status: {summary.status}.</span></div><a href="/experiments/summary.json" download className="download-link">Download JSON <Icon name="external" size={14} /></a></div>
    <div className="scenario-grid">{(['A', 'B', 'C'] as const).map(key => <div className="scenario-card card" key={key}><span className={`scenario-token ${scenarios[key].color}`}>{key}</span><div><h3>{scenarios[key].title}</h3><p>{scenarios[key].detail}</p></div></div>)}</div>
    <section className="card experiment-chart-section"><div className="section-top"><div><Label>Measured request outcomes</Label><h2>Three configurations. One workload.</h2></div><div className="segmented" aria-label="Fault type">{(['crash', 'unhealthy', 'control'] as const).map(value => <button key={value} aria-pressed={fault === value} onClick={() => setFault(value)}>{value === 'crash' ? 'Crash' : value === 'unhealthy' ? 'Unhealthy' : 'Control'}</button>)}</div></div>
      <div className="protocol"><span><strong>{summary.protocol.rate}</strong> requests/s</span><span><strong>{summary.protocol.baselineSeconds}s</strong> baseline</span><span><strong>{summary.protocol.observationSeconds}s</strong> observation</span><span><strong>{summary.protocol.repetitions}</strong> repetitions</span></div>
      {trials.length ? <div className={`charts-grid ${fault === 'control' ? 'one-chart' : ''}`}><RateChart trials={trials} postFault={false} />{fault !== 'control' && <RateChart trials={trials} postFault />}</div> : <Empty title="No trials for this fault">The saved summary does not contain this experiment yet.</Empty>}
      <p className="chart-note">Success rates use requests actually issued. {skipped.toLocaleString()} scheduled requests were skipped inside analysis windows. {rawSkipped === null ? 'Guard-window skipped counts are not supplied in this summary.' : `${rawSkipped.toLocaleString()} were skipped across all raw traffic, including guards.`} Charts and ranges include valid trials only; all individual values remain below. Three repetitions do not support strong statistical claims.</p>
    </section>
    <section className="card trial-section"><div className="section-top"><div><Label>{faultLabels[fault]}</Label><h2>Every trial, kept visible</h2></div><span className="small muted">Durations from fault-command start</span></div>
      <div className="table-scroll" tabIndex={0} role="region" aria-label="Individual experiment trials"><table><thead><tr><th>Trial</th><th>Whole trial</th><th>Post fault</th><th>Failures</th><th>Skipped</th><th>p95 latency</th><th>Detection</th><th>Recovery</th></tr></thead><tbody>{trials.map(trial => <tr key={trial.id}><th><span className={`scenario-token small-token ${scenarios[trial.configuration].color}`}>{trial.configuration}</span><span>{trial.id}</span>{!trial.valid && <span className="invalid-tag">Invalid</span>}</th><td>{percent(trial.whole.successRate)}<small>{trial.whole.successes}/{trial.whole.requests}</small></td><td>{trial.postFault ? <>{percent(trial.postFault.successRate)}<small>{trial.postFault.successes}/{trial.postFault.requests}</small></> : 'Not applicable'}</td><td>{trial.whole.failures}</td><td>{trial.whole.skipped}</td><td>{trial.whole.latencyMs.p95 === null ? '—' : `${trial.whole.latencyMs.p95.toFixed(2)} ms`}</td><td>{fault === 'control' ? 'Not applicable' : seconds(trial.detectionMs)}</td><td>{fault === 'control' ? 'Not applicable' : seconds(trial.recoveryMs)}</td></tr>)}</tbody></table></div>
      <div className="measurement-notes"><p><strong>Detection</strong> ends at the controller’s confirmed failure after consecutive failed probes. <strong>Recovery</strong> ends only after the controller verifies readiness; restart acceptance alone does not count. “Not observed” means no recovery was recorded within the window.</p><p>Post-fault rates use requests launched at or after fault-command start. Latency includes failed requests and timeouts; p95 is the nearest-rank percentile. Clock calibration, raw requests, probes, and event journals are retained with the experiment evidence.</p></div>
    </section>
  </>;
}

function ExperimentsView() {
  const summary = useResource('/experiments/summary.json', parseExperiments, 0);
  return <><div className="page-heading"><div><Label>Saved experiments / comparison</Label><h1>Evidence, not assumptions<span className="heading-dot">.</span></h1><p>Fresh trials. Identical workloads. Every outcome accounted for.</p></div><Badge tone="info">Saved results</Badge></div>
    {summary.loading ? <section className="card"><Empty title="Loading saved experiments">Reading the recorded experiment summary.</Empty></section> : summary.error ? <section className="card"><Empty title="No saved results available">The experiment summary could not be loaded. Run the experiment matrix and copy its saved summary to this dashboard. No sample data is substituted.</Empty><p className="error-detail">{summary.error}</p></section> : summary.data?.trials.length ? <ExperimentResults summary={summary.data} /> : <section className="card"><Empty title="No recorded trials yet">The summary is available but contains no trials. Live telemetry remains separate from experiment results.</Empty></section>}
  </>;
}

function Method() {
  return <><div className="page-heading"><div><Label>Architecture / interpretation</Label><h1>Know what the signals mean<span className="heading-dot">.</span></h1><p>A small, inspectable prototype with explicit boundaries.</p></div><Badge>Read-only by design</Badge></div><div className="method-grid">
    <section className="card method-card"><Icon name="layers" /><h2>Routing is not recovery</h2><p>Nginx retries eligible GET requests against a surviving instance. This is traffic failover: it can preserve responses while the other backend remains failed.</p><p>The controller independently probes readiness, requires consecutive failures, requests a bounded restart through a private gate, and verifies readiness afterward.</p></section>
    <section className="card method-card"><Icon name="lock" /><h2>Observation, without control</h2><p>This interface reads status and event records. It has no Docker socket, recovery command channel, restart buttons, or fault controls.</p><p>The private gate limits container inspection and restart to validated project backends. All Docker restart policies remain disabled.</p></section>
    <section className="card method-card"><Icon name="activity" /><h2>Readiness has limits</h2><p>A process can be running and still fail readiness. A fresh successful probe is an observation at a point in time, not a guarantee about every request.</p><p>Stale or disconnected telemetry cannot establish current readiness. An exhausted recovery budget requires deliberate manual intervention.</p></section>
    <section className="card method-card"><Icon name="chart" /><h2>Small experiments, honest claims</h2><p>Configurations A, B, and C share a workload and detection settings. Raw requests, skipped slots, and failed attempts remain part of the evidence.</p><p>Three repetitions show individual outcomes and ranges. They do not establish production reliability, zero downtime, or statistical significance.</p></section>
  </div></>;
}

export default function App() {
  const initial = () => ['experiments', 'method'].includes(window.location.hash.slice(1)) ? window.location.hash.slice(1) : 'overview';
  const [page, setPage] = useState(initial);
  const status = useResource('/status', parseSnapshot);
  const [clock, setClock] = useState(performance.now());
  useEffect(() => { const timer = setInterval(() => setClock(performance.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => { const update = () => setPage(initial()); window.addEventListener('hashchange', update); return () => window.removeEventListener('hashchange', update); }, []);
  return <div className="app-shell">
    <a className="skip-link" href="#main">Skip to content</a>
    <aside className="sidebar"><a className="brand" href="#overview" aria-label="ResilientCloud home"><span className="brand-mark"><Icon name="cloud" size={29} /></span><span>Resilient<span className="brand-light">Cloud</span><small>INFRASTRUCTURE LAB</small></span></a>
      <div className="workspace"><span className="workspace-avatar">R</span><div><strong>Local prototype</strong><span>Single-host environment</span></div><Icon name="lock" size={13} /></div>
      <Label>Workspace</Label><nav aria-label="Main navigation">{([{ key: 'overview', label: 'Live overview', icon: 'grid' }, { key: 'experiments', label: 'Saved experiments', icon: 'chart' }, { key: 'method', label: 'How it works', icon: 'layers' }] as const).map(item => <a key={item.key} href={`#${item.key}`} className={page === item.key ? 'active' : ''} aria-current={page === item.key ? 'page' : undefined}><Icon name={item.icon} size={18} />{item.label}{page === item.key && <span className="nav-marker" />}</a>)}</nav>
      <div className="sidebar-bottom"><div className="readonly-note"><Icon name="lock" size={18} /><div><strong>Observation only</strong><p>No infrastructure controls are exposed here.</p></div></div><div className="sidebar-footer"><span className="version-dot" />ResilientCloud<span>Prototype / 03</span></div></div>
    </aside>
    <div className="main-shell"><header className="topbar"><span className="breadcrumb">Workspace <span>/</span> <strong>{page === 'overview' ? 'Live overview' : page === 'experiments' ? 'Saved experiments' : 'How it works'}</strong></span><span className="read-only-chip"><Icon name="lock" size={13} />Read-only</span></header>
      <main id="main" tabIndex={-1}>{page === 'overview' ? <Overview status={status} clock={clock} /> : page === 'experiments' ? <ExperimentsView /> : <Method />}
        <footer className="limitation"><Icon name="shield" size={18} /><p><strong>One host, one failure domain.</strong> This prototype does not protect against host, Docker VM, power, or host-network failure.</p><span>ResilientCloud</span></footer>
      </main>
    </div>
  </div>;
}
