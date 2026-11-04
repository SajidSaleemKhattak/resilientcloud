export type Tone = 'good' | 'warning' | 'danger' | 'info' | 'neutral';
export type ControllerState = 'healthy' | 'suspected_failure' | 'recovering' | 'cooldown' | 'exhausted' | 'unknown';
export type Backend = {
  state: ControllerState; attempts: number | null; failures: number | null;
  containerId: string | null; manualIntervention: boolean;
  lastProbe: { ok: boolean | null; timestamp: string | null; latencyMs: number | null; reason: string | null } | null;
  stale: boolean; observationAgeMs: number | null;
};
export type Snapshot = {
  updatedAt: string; recoveryEnabled: boolean; stale: boolean; ageMs: number;
  backends: Record<string, Backend>; config: { maxAttempts: number | null; failureThreshold: number | null; intervalMs: number | null };
};
export type Incident = { type: string; timestamp: string; service?: string; state?: string; previous?: string; reason?: string; attempts?: number; runId?: string; elapsedMs?: number };
export type IncidentFeed = { events: Incident[]; truncated: boolean };
export type Metrics = { requests: number; successes: number; failures: number; successRate: number | null; skipped: number; scheduled: number; latencyMs: { p50: number | null; p95: number | null } };
export type Trial = { id: string; configuration: 'A' | 'B' | 'C'; fault: 'crash' | 'unhealthy' | 'control'; repetition: number; valid: boolean; whole: Metrics; postFault: Metrics | null; detectionMs: number | null; recoveryMs: number | null; recoveryObserved: boolean; clockUncertaintyMs: number | null; rawSkipped: number | null; evidencePath: string };
export type Experiments = { schemaVersion: 1; generatedAt: string; status: string; protocol: { baselineSeconds: number; observationSeconds: number; rate: number; concurrency: number; timeoutMs: number; repetitions: number }; trials: Trial[] };

const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const numeric = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const text = (v: unknown) => typeof v === 'string' ? v : null;
const date = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null;
const states = new Set(['healthy', 'suspected_failure', 'recovering', 'cooldown', 'exhausted']);

export function parseSnapshot(input: unknown): Snapshot {
  const v = object(input);
  if (v.available !== true || !date(v.updatedAt) || typeof v.recoveryEnabled !== 'boolean' || !v.backends || Array.isArray(v.backends) || typeof v.backends !== 'object') throw new Error('Status telemetry is unavailable or invalid.');
  const backends: Record<string, Backend> = {};
  for (const [name, raw] of Object.entries(object(v.backends))) {
    const b = object(raw); const p = object(b.lastProbe);
    backends[name] = {
      state: states.has(String(b.state)) ? b.state as ControllerState : 'unknown',
      attempts: numeric(b.attempts), failures: numeric(b.failures), containerId: text(b.containerId),
      manualIntervention: b.manualIntervention === true, stale: b.stale !== false,
      observationAgeMs: numeric(b.observationAgeMs),
      lastProbe: b.lastProbe ? { ok: typeof p.ok === 'boolean' ? p.ok : null, timestamp: date(p.timestamp), latencyMs: numeric(p.latencyMs), reason: text(p.reason) } : null,
    };
  }
  const config = object(v.config);
  return { updatedAt: v.updatedAt as string, recoveryEnabled: v.recoveryEnabled, stale: v.stale !== false,
    ageMs: numeric(v.ageMs) ?? Infinity, backends,
    config: { maxAttempts: numeric(config.maxAttempts), failureThreshold: numeric(config.failureThreshold), intervalMs: numeric(config.intervalMs) } };
}

export function parseEvents(input: unknown): IncidentFeed {
  const v = object(input);
  if (v.available !== true || !Array.isArray(v.events)) throw new Error('The incident journal is unavailable.');
  const events = v.events.map(raw => {
    const e = object(raw);
    if (!text(e.type) || !date(e.timestamp)) throw new Error('The incident journal contains an invalid event.');
    return { type: e.type as string, timestamp: e.timestamp as string,
      service: text(e.service) ?? undefined, state: text(e.state) ?? undefined, previous: text(e.previous) ?? undefined,
      reason: text(e.reason) ?? undefined, attempts: numeric(e.attempts) ?? undefined,
      runId: text(e.runId) ?? undefined, elapsedMs: numeric(e.elapsedMs) ?? undefined };
  });
  // Preserve journal order: UTC can move when the Docker VM clock synchronizes.
  return { events, truncated: v.truncated === true };
}

function metrics(raw: unknown): Metrics {
  const v = object(raw); const latency = object(v.latencyMs);
  for (const key of ['requests', 'successes', 'failures', 'skipped', 'scheduled']) {
    if (!Number.isInteger(v[key]) || Number(v[key]) < 0) throw new Error('Experiment request counts are invalid.');
  }
  const rate = numeric(v.successRate);
  if ((v.successRate !== null && rate === null) || (rate !== null && rate > 1) || Number(v.successes) + Number(v.failures) !== v.requests) throw new Error('Experiment success rate is invalid.');
  const expectedRate = Number(v.requests) ? Number(v.successes) / Number(v.requests) : null;
  if (expectedRate === null ? rate !== null : rate === null || Math.abs(expectedRate - rate) > 1e-10) throw new Error('Experiment rate disagrees with request outcomes.');
  return { requests: v.requests as number, successes: v.successes as number, failures: v.failures as number,
    skipped: v.skipped as number, scheduled: v.scheduled as number, successRate: rate,
    latencyMs: { p50: numeric(latency.p50), p95: numeric(latency.p95) } };
}

export function parseExperiments(input: unknown): Experiments {
  const v = object(input); const p = object(v.protocol);
  if (v.schemaVersion !== 1 || !date(v.generatedAt) || !Array.isArray(v.trials) || !['passed', 'failed', 'running'].includes(String(v.status))) throw new Error('The saved experiment summary is invalid.');
  for (const field of ['baselineSeconds', 'observationSeconds', 'rate', 'concurrency', 'timeoutMs', 'repetitions']) if (numeric(p[field]) === null) throw new Error('The saved experiment protocol is incomplete.');
  const trials = v.trials.map(raw => {
    const t = object(raw);
    if (!text(t.id) || !['A', 'B', 'C'].includes(String(t.configuration)) || !['crash', 'unhealthy', 'control'].includes(String(t.fault)) || !Number.isInteger(t.repetition) || typeof t.valid !== 'boolean' || typeof t.recoveryObserved !== 'boolean') throw new Error('A saved trial is invalid.');
    const recoveryMs = numeric(t.recoveryMs);
    if (t.recoveryObserved && recoveryMs === null) throw new Error('A recovered trial is missing its measured duration.');
    return { id: t.id as string, configuration: t.configuration as Trial['configuration'], fault: t.fault as Trial['fault'], repetition: t.repetition as number,
      valid: t.valid, whole: metrics(t.whole), postFault: t.postFault === null ? null : metrics(t.postFault),
      detectionMs: numeric(t.detectionMs), recoveryMs: t.recoveryObserved ? recoveryMs : null, recoveryObserved: t.recoveryObserved,
      clockUncertaintyMs: numeric(t.clockUncertaintyMs), rawSkipped: numeric(object(t.rawWorkload).dropped), evidencePath: text(t.evidencePath) ?? '' };
  });
  return { schemaVersion: 1, generatedAt: v.generatedAt as string, status: v.status as string, protocol: p as Experiments['protocol'], trials };
}

export function readiness(backend: Backend | undefined, connected: boolean, stale: boolean): { label: string; tone: Tone } {
  if (!connected) return { label: 'Unknown', tone: 'neutral' };
  if (!backend || backend.lastProbe?.ok === null || !backend.lastProbe) return { label: 'Unknown', tone: 'neutral' };
  if (stale || backend.stale) return { label: 'Stale', tone: 'warning' };
  return backend.lastProbe.ok ? { label: 'Ready', tone: 'good' } : { label: 'Not ready', tone: 'danger' };
}

export const stateLabels: Record<ControllerState, string> = { healthy: 'Healthy', suspected_failure: 'Suspected failure', recovering: 'Recovering', cooldown: 'Cooldown', exhausted: 'Exhausted', unknown: 'Unknown' };
export const stateTones: Record<ControllerState, Tone> = { healthy: 'good', suspected_failure: 'warning', recovering: 'info', cooldown: 'info', exhausted: 'danger', unknown: 'neutral' };
export const percent = (v: number | null) => v === null ? '—' : `${(v * 100).toFixed(2)}%`;
export const seconds = (v: number | null) => v === null ? 'Not observed' : `${(v / 1000).toFixed(3)} s`;
export function range(values: (number | null)[], formatter: (n: number | null) => string): string {
  const numbers = values.filter((v): v is number => v !== null);
  if (!numbers.length) return 'Not observed';
  const low = Math.min(...numbers); const high = Math.max(...numbers);
  return low === high ? formatter(low) : `${formatter(low)} – ${formatter(high)}`;
}
