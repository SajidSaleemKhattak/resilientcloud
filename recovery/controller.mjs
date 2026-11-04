import http from 'node:http';
import net from 'node:net';
import { mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

export const SERVICES = ['backend-a', 'backend-b'];
const STATES = ['healthy', 'suspected_failure', 'recovering', 'cooldown', 'exhausted'];

export function loadConfig(env = process.env) {
  function integer(name, fallback, min, max) {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
    return value;
  }
  if (env.RECOVERY_ENABLED !== undefined && !['true', 'false'].includes(env.RECOVERY_ENABLED)) throw new Error('Invalid RECOVERY_ENABLED');
  const monitored = env.MONITORED_SERVICES ?? 'backend-a,backend-b';
  if (!['backend-a', 'backend-a,backend-b'].includes(monitored)) throw new Error('Invalid MONITORED_SERVICES');
  return {
    services: monitored.split(','),
    intervalMs: integer('PROBE_INTERVAL_MS', 500, 50, 60_000),
    probeTimeoutMs: integer('PROBE_TIMEOUT_MS', 300, 20, 10_000),
    failureThreshold: integer('FAILURE_THRESHOLD', 3, 2, 100),
    maxAttempts: integer('MAX_RESTART_ATTEMPTS', 2, 1, 10),
    verifyTimeoutMs: integer('VERIFY_TIMEOUT_MS', 4000, 100, 60_000),
    verifySuccesses: integer('VERIFY_SUCCESSES', 2, 2, 20),
    cooldownMs: integer('COOLDOWN_MS', 2000, 100, 300_000),
    gateTimeoutMs: integer('GATE_TIMEOUT_MS', 14000, 100, 30_000),
    recoveryEnabled: env.RECOVERY_ENABLED !== 'false',
    gateSocket: env.GATE_SOCKET ?? '/run/gate/gate.sock',
    dataDir: env.DATA_DIR ?? '/data',
  };
}

/** Bounded complete response, with no redirect, retry, or caller-supplied Docker path. */
export function requestJson(options, { timeoutMs, body } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    let timer;
    const finish = (error, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ ...options, agent: false, headers: {
      accept: 'application/json', ...(encoded === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) }),
    } }, res => {
      let text = '';
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 8192) { finish(new Error('response_too_large')); req.destroy(); return; }
        text += chunk.toString();
      });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(text); } catch { finish(new Error('invalid_json')); return; }
        finish(null, { status: res.statusCode, body: json });
      });
      res.on('aborted', () => finish(new Error('response_aborted')));
      res.on('error', finish);
    });
    timer = setTimeout(() => { finish(new Error('timeout')); req.destroy(); }, timeoutMs);
    req.on('error', finish);
    req.end(encoded);
  });
}

export async function gateRequest(config, service, id) {
  if (!SERVICES.includes(service) || (id !== undefined && !/^[a-f0-9]{64}$/.test(id))) throw new Error('invalid_gate_target');
  const result = await requestJson({ socketPath: config.gateSocket,
    method: id === undefined ? 'GET' : 'POST',
    path: `/v1/backends/${service}${id === undefined ? '' : '/restart'}`,
  }, { timeoutMs: config.gateTimeoutMs, ...(id === undefined ? {} : { body: { id } }) });
  if (result.status !== (id === undefined ? 200 : 202)) {
    const error = new Error(`gate_http_${result.status}`);
    error.status = result.status;
    throw error;
  }
  if (id === undefined) {
    const b = result.body;
    if (b.service !== service || !/^[a-f0-9]{64}$/.test(b.id) || typeof b.running !== 'boolean'
      || (b.running && !net.isIP(b.ip))) throw new Error('invalid_gate_response');
  } else if (result.body.id !== id) throw new Error('invalid_restart_response');
  return result.body;
}

export async function probeReadiness(service, target, config, request = requestJson) {
  const start = performance.now();
  if (!target?.running || !net.isIP(target.ip)) return { ok: false, reason: 'not_running', status: null, latencyMs: 0 };
  try {
    const r = await request({ hostname: target.ip, port: 3000, path: '/ready', method: 'GET' }, { timeoutMs: config.probeTimeoutMs });
    const ok = r.status === 200 && r.body.instance === service && r.body.ready === true;
    return { ok, reason: ok ? null : 'readiness_failed', status: r.status, instance: r.body.instance ?? null, latencyMs: performance.now() - start };
  } catch (error) { return { ok: false, reason: error.message, status: null, latencyMs: performance.now() - start }; }
}

/** Atomic checkpoints plus fsynced append-only events. Persistence failure stops actions. */
export class PersistentStore {
  constructor(directory) { this.directory = directory; this.queue = Promise.resolve(); }
  async load() {
    await mkdir(this.directory, { recursive: true });
    try { return JSON.parse(await readFile(path.join(this.directory, 'status.json'), 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try {
        if ((await stat(path.join(this.directory, 'controller.events.jsonl'))).size > 0) throw new Error('checkpoint_missing_with_existing_journal');
      } catch (journalError) { if (journalError.code !== 'ENOENT') throw journalError; }
      return null;
    }
  }
  save(snapshot, event) {
    const saved = JSON.stringify(snapshot);
    const line = `${JSON.stringify(event)}\n`;
    this.queue = this.queue.then(async () => {
      const temporary = path.join(this.directory, `.status-${process.pid}.tmp`);
      const file = await open(temporary, 'w', 0o640);
      try { await file.writeFile(`${saved}\n`); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path.join(this.directory, 'status.json'));
      const directory = await open(this.directory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      const journal = await open(path.join(this.directory, 'controller.events.jsonl'), 'a', 0o640);
      try { await journal.writeFile(line); await journal.sync(); } finally { await journal.close(); }
    });
    return this.queue;
  }
}

function initialBackend() {
  return { state: 'suspected_failure', failures: 0, attempts: 0, manualIntervention: false,
    containerId: null, lastProbe: null, lastReadyAt: null, failureConfirmedAt: null,
    recoveryVerifiedAt: null, verificationSuccesses: 0, verificationDeadline: null,
    attemptTargetId: null, restartOutcome: null, cooldownUntil: null, stableSince: null };
}

export class RecoveryController {
  constructor({ config, store, inspect, restart, probe, now = Date.now, monotonic = () => performance.now(), runId = randomUUID() }) {
    this.config = config;
    this.services = config.services ?? SERVICES;
    if (!['backend-a', 'backend-a,backend-b'].includes(this.services.join(','))) throw new Error('invalid_monitored_services');
    this.store = store;
    this.inspect = inspect ?? ((service, timeoutMs = config.gateTimeoutMs) => gateRequest({ ...config, gateTimeoutMs: timeoutMs }, service));
    this.restart = restart ?? ((service, id) => gateRequest(config, service, id));
    this.probe = probe ?? ((service, target, timeoutMs = config.probeTimeoutMs) => probeReadiness(service, target, { ...config, probeTimeoutMs: timeoutMs }));
    this.wall = now;
    this.monotonic = monotonic;
    this.started = monotonic();
    this.epochAtStart = now();
    // Policy durations must not shorten/extend when Docker synchronizes its UTC clock.
    this.now = () => this.epochAtStart + this.monotonic() - this.started;
    this.runId = runId;
    this.backends = {};
    this.locks = new Set();
    this.failed = false;
  }
  snapshot() {
    return structuredClone({ schemaVersion: 1, updatedAt: new Date(this.wall()).toISOString(), runId: this.runId,
      recoveryEnabled: this.config.recoveryEnabled,
      monitoredServices: this.services,
      config: { intervalMs: this.config.intervalMs, probeTimeoutMs: this.config.probeTimeoutMs,
        failureThreshold: this.config.failureThreshold, maxAttempts: this.config.maxAttempts,
        verifyTimeoutMs: this.config.verifyTimeoutMs, verifySuccesses: this.config.verifySuccesses, cooldownMs: this.config.cooldownMs },
      backends: this.backends });
  }
  async record(type, service, details = {}) {
    const b = service ? this.backends[service] : undefined;
    const event = { type, timestamp: new Date(this.wall()).toISOString(), elapsedMs: this.monotonic() - this.started,
      monotonicMs: Number(process.hrtime.bigint()) / 1e6, runId: this.runId,
      ...(service ? { service, state: b.state, failures: b.failures, attempts: b.attempts, containerId: b.containerId } : {}), ...details };
    try { await this.store.save(this.snapshot(), event); }
    catch (error) { this.failed = true; throw error; }
    return event;
  }
  async initialize() {
    const saved = await this.store.load();
    if (saved) {
      if (saved.schemaVersion !== 1 || !saved.backends) throw new Error('invalid_checkpoint');
      if (Object.keys(saved.backends).sort().join(',') !== this.services.join(',')) throw new Error('invalid_checkpoint_service_set_changed');
      for (const service of this.services) {
        const b = saved.backends[service];
        if (!b || !STATES.includes(b.state) || !Number.isInteger(b.attempts) || b.attempts < 0
          || !Number.isInteger(b.failures) || b.failures < 0 || typeof b.manualIntervention !== 'boolean'
          || (b.state === 'recovering' && (!Number.isFinite(b.verificationDeadline) || b.attempts < 1))
          || (b.state === 'cooldown' && !Number.isFinite(b.cooldownUntil))) throw new Error('invalid_checkpoint');
        this.backends[service] = { ...initialBackend(), ...b };
        // Never reuse a successful probe from before a controller restart.
        this.backends[service].verificationSuccesses = 0;
        this.backends[service].stableSince = null;
        // New process = new monotonic origin. Retain charged attempts and start
        // a fresh bounded verification/cooldown window, never another blind restart.
        if (b.state === 'recovering') this.backends[service].verificationDeadline = this.now() + this.config.verifyTimeoutMs;
        if (b.state === 'cooldown') this.backends[service].cooldownUntil = this.now() + this.config.cooldownMs;
      }
    } else for (const service of this.services) this.backends[service] = initialBackend();
    await this.record('controller_started', undefined, { resumed: Boolean(saved), recoveryEnabled: this.config.recoveryEnabled });
  }
  async transition(service, next, reason) {
    const b = this.backends[service];
    const previous = b.state;
    b.state = next;
    b.manualIntervention = next === 'exhausted';
    await this.record('state_changed', service, { previous, reason });
  }
  async exhaust(service, reason) {
    await this.transition(service, 'exhausted', reason);
    await this.record('exhausted', service, { reason, manualIntervention: true });
  }
  async act(service, target) {
    const b = this.backends[service];
    if (!this.config.recoveryEnabled || !target || this.failed) return;
    if (b.attempts >= this.config.maxAttempts) { await this.exhaust(service, 'attempt_limit'); return; }
    b.attempts++;
    b.attemptTargetId = target.id;
    b.verificationSuccesses = 0;
    b.verificationDeadline = this.now() + this.config.gateTimeoutMs + this.config.verifyTimeoutMs;
    b.restartOutcome = 'pending';
    b.stableSince = null;
    await this.transition(service, 'recovering', 'restart_attempt');
    // Both charged budget and intent are durable before any Docker mutation.
    await this.record('restart_requested', service, { targetId: target.id });
    try {
      await this.restart(service, target.id);
      b.restartOutcome = 'accepted';
      b.verificationDeadline = this.now() + this.config.verifyTimeoutMs;
      await this.record('restart_accepted', service, { targetId: target.id, recoveryVerified: false });
    } catch (error) {
      if (this.failed) throw error;
      b.restartOutcome = 'unknown_or_rejected';
      b.verificationDeadline = this.now() + this.config.verifyTimeoutMs;
      await this.record('restart_error', service, { targetId: target.id, error: error.message, recoveryVerified: false });
    }
  }
  async step(service) {
    if (!this.services.includes(service)) throw new Error('invalid_service');
    if (this.failed) throw new Error('persistence_failed');
    if (this.locks.has(service)) throw new Error('overlapping_service_step');
    this.locks.add(service);
    try { await this.stepUnlocked(service); }
    finally { this.locks.delete(service); }
  }
  async stepUnlocked(service) {
    const b = this.backends[service];
    const remaining = limit => b.state === 'recovering'
      ? Math.max(1, Math.min(limit, b.verificationDeadline - this.now())) : limit;
    if (b.state === 'recovering' && this.now() >= b.verificationDeadline) {
      await this.verificationFailed(service);
      return;
    }
    let target;
    let result;
    try {
      target = await this.inspect(service, remaining(this.config.gateTimeoutMs));
      if (b.containerId !== target.id) {
        const previousId = b.containerId;
        b.containerId = target.id;
        b.verificationSuccesses = 0;
        b.stableSince = null;
        await this.record('container_revalidated', service, { previousId, currentId: target.id });
      }
      result = await this.probe(service, target, remaining(this.config.probeTimeoutMs));
      if (result.ok && b.state === 'recovering') {
        const current = await this.inspect(service, remaining(this.config.gateTimeoutMs));
        if (current.id !== target.id || current.startedAt !== target.startedAt || !current.running) {
          result = { ...result, ok: false, reason: 'identity_changed_during_verification' };
        }
      }
    } catch (error) {
      if (this.failed) throw error;
      target = undefined;
      result = { ok: false, reason: `inspection_error:${error.message}`, status: null, latencyMs: null };
    }
    b.lastProbe = { ...result, timestamp: new Date(this.wall()).toISOString() };
    if (result.ok) { b.lastReadyAt = b.lastProbe.timestamp; b.failures = 0; }
    else b.failures++;
    await this.record('probe', service, result);
    if (b.state === 'exhausted') return;

    if (b.state === 'recovering') {
      b.verificationSuccesses = result.ok ? b.verificationSuccesses + 1 : 0;
      if (this.now() >= b.verificationDeadline) {
        await this.verificationFailed(service);
      } else if (b.verificationSuccesses >= this.config.verifySuccesses) {
        b.recoveryVerifiedAt = new Date(this.wall()).toISOString();
        b.cooldownUntil = this.now() + this.config.cooldownMs;
        b.stableSince = this.now();
        await this.transition(service, 'cooldown', 'readiness_verified');
        await this.record('recovery_verified', service, { targetId: b.attemptTargetId, currentId: b.containerId,
          restartOutcome: b.restartOutcome, verificationSuccesses: b.verificationSuccesses,
          failureConfirmedAt: b.failureConfirmedAt, readinessVerifiedAt: b.recoveryVerifiedAt });
      }
      return;
    }

    if (b.state === 'cooldown') {
      b.stableSince = result.ok ? (b.stableSince ?? this.now()) : null;
      if (result.ok && this.now() >= b.cooldownUntil && this.now() - b.stableSince >= this.config.cooldownMs) {
        const usedAttempts = b.attempts;
        b.attempts = 0;
        b.failureConfirmedAt = null;
        b.cooldownUntil = null;
        b.stableSince = null;
        await this.transition(service, 'healthy', 'stable_readiness');
        await this.record('incident_cleared', service, { usedAttempts });
      } else if (!result.ok && this.now() >= b.cooldownUntil && b.failures >= this.config.failureThreshold) {
        await this.act(service, target);
      }
      return;
    }

    if (result.ok) {
      if (b.attempts > 0) {
        b.cooldownUntil = this.now() + this.config.cooldownMs;
        b.stableSince = this.now();
        await this.transition(service, 'cooldown', 'readiness_returned');
      } else {
        b.failureConfirmedAt = null;
        if (b.state !== 'healthy') await this.transition(service, 'healthy', 'readiness_observed');
      }
      return;
    }
    if (b.state !== 'suspected_failure') await this.transition(service, 'suspected_failure', 'probe_failed');
    if (b.failures >= this.config.failureThreshold) {
      if (!b.failureConfirmedAt) {
        b.failureConfirmedAt = new Date(this.wall()).toISOString();
        await this.record('failure_confirmed', service, { recoveryEnabled: this.config.recoveryEnabled });
      }
      await this.act(service, target);
    }
  }
  async verificationFailed(service) {
    const b = this.backends[service];
    await this.record('recovery_unverified', service, { reason: 'verification_timeout' });
    if (b.attempts >= this.config.maxAttempts) await this.exhaust(service, 'readiness_not_restored');
    else {
      b.cooldownUntil = this.now() + this.config.cooldownMs;
      b.stableSince = null;
      await this.transition(service, 'cooldown', 'verification_timeout');
    }
  }
  async run({ signal } = {}) {
    const stopped = new AbortController();
    signal?.addEventListener('abort', () => stopped.abort(), { once: true });
    if (signal?.aborted) return;
    try {
      await Promise.all(this.services.map(async service => {
        while (!stopped.signal.aborted) {
          const start = this.monotonic();
          await this.step(service);
          await sleep(Math.max(1, this.config.intervalMs - (this.monotonic() - start)), undefined, { signal: stopped.signal });
        }
      }));
    } catch (error) {
      stopped.abort();
      if (error.name !== 'AbortError') throw error;
    }
  }
}

export async function main() {
  const config = loadConfig();
  const controller = new RecoveryController({ config, store: new PersistentStore(config.dataDir) });
  const stopped = new AbortController();
  process.on('SIGTERM', () => stopped.abort());
  process.on('SIGINT', () => stopped.abort());
  await controller.initialize();
  await controller.run({ signal: stopped.signal });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(JSON.stringify({ type: 'controller_fatal', timestamp: new Date().toISOString(), error: error.message })); process.exitCode = 1; });
}
