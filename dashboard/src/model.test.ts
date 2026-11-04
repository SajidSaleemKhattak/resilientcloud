import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSnapshot, parseEvents, parseExperiments, readiness, range, seconds, percent } from './model.ts';

// Deliberate unit fixtures. They are never bundled into the dashboard or saved evidence.
const timestamp = '2026-11-04T00:00:00.000Z';
function snapshot() {
  return { available: true, updatedAt: timestamp, stale: false, ageMs: 5, recoveryEnabled: true,
    config: { maxAttempts: 2, failureThreshold: 3, intervalMs: 500 }, backends: {
      'backend-a': { state: 'healthy', attempts: 0, failures: 0, containerId: 'a'.repeat(64), stale: false, observationAgeMs: 5,
        lastProbe: { ok: true, timestamp, latencyMs: 1, reason: null } },
    } };
}
function summary() {
  const metrics = { requests: 10, successes: 8, failures: 2, successRate: .8, skipped: 1, scheduled: 11, latencyMs: { p50: 2, p95: 1000 } };
  return { schemaVersion: 1, generatedAt: timestamp, status: 'passed',
    protocol: { baselineSeconds: 15, observationSeconds: 60, rate: 10, concurrency: 8, timeoutMs: 2500, repetitions: 3 },
    trials: [{ id: 'test-fixture-A-crash-1', configuration: 'A', fault: 'crash', repetition: 1, valid: true,
      whole: metrics, postFault: metrics, recoveryObserved: false, detectionMs: 1200, recoveryMs: null, rawWorkload: { dropped: 2 } }] };
}

test('fresh observations retain instance identity and readiness without inventing absent backends', () => {
  const value = parseSnapshot(snapshot());
  assert.equal(value.backends['backend-a'].containerId, 'a'.repeat(64));
  assert.equal(readiness(value.backends['backend-a'], true, false).label, 'Ready');
  assert.equal(value.backends['backend-b'], undefined);
  assert.equal(readiness(undefined, true, false).label, 'Unknown');
});

test('stale, disconnected and missing probes cannot assert readiness', () => {
  const value = parseSnapshot(snapshot());
  const backend = value.backends['backend-a'];
  assert.equal(readiness(backend, false, false).label, 'Unknown');
  assert.equal(readiness(backend, true, true).label, 'Stale');
  assert.equal(readiness({ ...backend, stale: true }, true, false).label, 'Stale');
  assert.equal(readiness({ ...backend, lastProbe: null }, true, false).label, 'Unknown');
  assert.equal(readiness({ ...backend, lastProbe: { ...backend.lastProbe!, ok: false } }, true, false).label, 'Not ready');
});

test('unknown controller states remain unknown; exhausted state and spent attempts stay visible', () => {
  const input = snapshot();
  input.backends['backend-a'].state = 'unexpected';
  assert.equal(parseSnapshot(input).backends['backend-a'].state, 'unknown');
  input.backends['backend-a'].state = 'exhausted';
  input.backends['backend-a'].attempts = 2;
  assert.equal(parseSnapshot(input).backends['backend-a'].state, 'exhausted');
  assert.equal(parseSnapshot(input).backends['backend-a'].attempts, 2);
});

test('invalid and unavailable status is rejected rather than replaced with samples', () => {
  for (const input of [null, {}, { ...snapshot(), available: false }, { ...snapshot(), updatedAt: 'invalid' }, { ...snapshot(), backends: [] }]) {
    assert.throws(() => parseSnapshot(input), /unavailable or invalid/);
  }
  assert.deepEqual(parseSnapshot({ ...snapshot(), backends: {} }).backends, {});
});

test('timeline preserves journal order across UTC clock changes and allows an empty journal', () => {
  const events = [{ type: 'recovery_verified', timestamp, runId: 'run' }, { type: 'failure_confirmed', timestamp: '2026-11-04T00:00:20Z', runId: 'run' }];
  const parsed = parseEvents({ available: true, events, truncated: true });
  assert.deepEqual(parsed.events.map(({ type, timestamp, runId }) => ({ type, timestamp, runId })), events);
  assert.equal(parsed.truncated, true);
  assert.deepEqual(parseEvents({ available: true, events: [] }).events, []);
  assert.throws(() => parseEvents({ available: false, events: [] }), /unavailable/);
  assert.throws(() => parseEvents({ available: true, events: [{ type: 'probe', timestamp: 'bad' }] }), /invalid event/);
});

test('saved outcomes preserve absent recovery, measured timing, and skipped raw slots', () => {
  const parsed = parseExperiments(summary());
  assert.equal(parsed.trials[0].recoveryMs, null);
  assert.equal(parsed.trials[0].rawSkipped, 2);
  assert.equal(seconds(parsed.trials[0].recoveryMs), 'Not observed');
  assert.equal(seconds(parsed.trials[0].detectionMs), '1.200 s');
  assert.equal(percent(parsed.trials[0].whole.successRate), '80.00%');
  assert.equal(range([null, 1000, 2000], seconds), '1.000 s – 2.000 s');
  assert.equal(range([null], seconds), 'Not observed');
});

test('saved summaries reject fabricated rates, inconsistent counts and missing verification timings', () => {
  const badRate = summary(); badRate.trials[0].whole.successRate = .99;
  assert.throws(() => parseExperiments(badRate), /disagrees/);
  const badCount = summary(); badCount.trials[0].whole.failures = 0;
  assert.throws(() => parseExperiments(badCount), /invalid/);
  const unverified = summary(); unverified.trials[0].recoveryObserved = true;
  assert.throws(() => parseExperiments(unverified), /missing its measured duration/);
  const empty = summary(); empty.trials = [];
  assert.deepEqual(parseExperiments(empty).trials, []);
});
