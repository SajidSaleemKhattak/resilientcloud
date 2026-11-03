import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RecoveryController, PersistentStore, loadConfig, requestJson, probeReadiness } from './controller.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
class MemoryStore {
  saved = null;
  events = [];
  async load() { return structuredClone(this.saved); }
  async save(snapshot, event) { this.saved = structuredClone(snapshot); this.events.push(structuredClone(event)); }
}

function fixture(overrides = {}) {
  let time = 1_000_000;
  let wallOffset = 0;
  let healthy = true;
  let currentId = 'a'.repeat(64);
  let start = 'started-1';
  let inspectError;
  let restartError;
  const store = new MemoryStore();
  const calls = [];
  const config = { ...loadConfig({}), ...overrides };
  const dependencies = {
    config, store, now: () => time + wallOffset, monotonic: () => time,
    inspect: async service => {
      if (inspectError) throw new Error(inspectError);
      return { service, id: currentId, ip: '127.0.0.1', running: true, startedAt: start };
    },
    restart: async (service, id) => {
      calls.push({ service, id });
      assert.equal(store.saved.backends[service].attempts, calls.length, 'attempt budget is persisted before mutation');
      assert.equal(store.events.at(-1).type, 'restart_requested', 'intent is persisted before mutation');
      if (restartError) throw new Error(restartError);
      return { id, accepted: true };
    },
    probe: async () => ({ ok: healthy, reason: healthy ? null : 'readiness_failed', status: healthy ? 200 : 503, latencyMs: 1 }),
  };
  const controller = new RecoveryController(dependencies);
  return { controller, config, store, calls, dependencies,
    setWallOffset: ms => { wallOffset = ms; },
    setHealthy: v => { healthy = v; }, setId: v => { currentId = v; }, setStart: v => { start = v; },
    setInspectError: v => { inspectError = v; }, setRestartError: v => { restartError = v; },
    advance: (ms = config.intervalMs) => { time += ms; },
    state: () => controller.snapshot().backends['backend-a'],
    step: async () => { await controller.step('backend-a'); time += config.intervalMs; },
  };
}

test('threshold requires consecutive failures and transient readiness failure never restarts', async () => {
  const f = fixture();
  await f.controller.initialize();
  await f.step();
  assert.equal(f.state().state, 'healthy');
  f.setHealthy(false);
  await f.step(); await f.step();
  assert.equal(f.state().state, 'suspected_failure');
  assert.equal(f.state().failures, 2);
  assert.equal(f.calls.length, 0);
  f.setHealthy(true);
  await f.step();
  assert.equal(f.state().state, 'healthy');
  assert.equal(f.state().failures, 0);
  f.setHealthy(false);
  await f.step(); await f.step();
  assert.equal(f.calls.length, 0);
});

test('Docker acceptance alone cannot establish recovery; repeated readiness and stable cooldown are required', async () => {
  const f = fixture();
  await f.controller.initialize();
  f.setHealthy(false);
  await f.step(); await f.step(); await f.step();
  assert.equal(f.calls.length, 1);
  assert.equal(f.state().state, 'recovering');
  assert.equal(f.state().recoveryVerifiedAt, null);
  assert.ok(!f.store.events.some(e => e.type === 'recovery_verified'));
  f.setHealthy(true);
  await f.step();
  assert.equal(f.state().state, 'recovering');
  await f.step();
  assert.equal(f.state().state, 'cooldown');
  assert.equal(f.state().attempts, 1);
  assert.equal(f.store.events.filter(e => e.type === 'recovery_verified').length, 1);
  await f.step(); await f.step(); await f.step();
  assert.equal(f.state().attempts, 1);
  await f.step();
  assert.equal(f.state().state, 'healthy');
  assert.equal(f.state().attempts, 0);
});

test('persistent failure exhausts exactly the configured attempts and stays latched even if readiness returns', async () => {
  const f = fixture({ verifyTimeoutMs: 1000, cooldownMs: 500 });
  await f.controller.initialize();
  f.setHealthy(false);
  for (let i = 0; i < 20; i++) await f.step();
  assert.equal(f.calls.length, 2);
  assert.equal(f.state().state, 'exhausted');
  assert.equal(f.state().manualIntervention, true);
  f.setHealthy(true);
  for (let i = 0; i < 10; i++) await f.step();
  assert.equal(f.calls.length, 2);
  assert.equal(f.state().state, 'exhausted');
  assert.equal(f.state().attempts, 2);
});

test('disabled recovery probes and confirms failures without issuing a restart', async () => {
  const f = fixture({ recoveryEnabled: false });
  await f.controller.initialize();
  f.setHealthy(false);
  for (let i = 0; i < 12; i++) await f.step();
  assert.equal(f.calls.length, 0);
  assert.equal(f.state().attempts, 0);
  assert.equal(f.state().state, 'suspected_failure');
  assert.equal(f.store.events.filter(e => e.type === 'failure_confirmed').length, 1);
});

test('flapping during cooldown does not reset the incident budget', async () => {
  const f = fixture({ cooldownMs: 1000, verifyTimeoutMs: 1000 });
  await f.controller.initialize();
  f.setHealthy(false);
  await f.step(); await f.step(); await f.step();
  f.setHealthy(true);
  await f.step(); await f.step();
  assert.equal(f.state().state, 'cooldown');
  f.setHealthy(false);
  await f.step();
  f.setHealthy(true);
  await f.step();
  assert.equal(f.state().attempts, 1);
  f.setHealthy(false);
  await f.step(); await f.step(); await f.step();
  assert.equal(f.calls.length, 2);
  assert.equal(f.state().attempts, 2);
});

test('checkpoint resumes an in-flight consumed attempt without blindly restarting again', async () => {
  const f = fixture({ verifyTimeoutMs: 1000, cooldownMs: 500 });
  await f.controller.initialize();
  f.setHealthy(false);
  await f.step(); await f.step(); await f.step();
  const resumed = new RecoveryController(f.dependencies);
  await resumed.initialize();
  await resumed.step('backend-a');
  assert.equal(f.calls.length, 1);
  assert.equal(resumed.snapshot().backends['backend-a'].attempts, 1);
  f.advance(1000);
  await resumed.step('backend-a');
  f.advance(1000);
  await resumed.step('backend-a');
  assert.equal(f.calls.length, 2);
});

test('ambiguous restart timeout is verified before another bounded attempt; stale replacement is revalidated', async () => {
  const f = fixture();
  await f.controller.initialize();
  f.setHealthy(false);
  f.setRestartError('gate_http_409');
  await f.step(); await f.step(); await f.step();
  assert.equal(f.calls.length, 1);
  assert.equal(f.state().restartOutcome, 'unknown_or_rejected');
  f.setId('b'.repeat(64));
  f.setHealthy(true);
  await f.step(); await f.step();
  assert.equal(f.state().state, 'cooldown');
  assert.equal(f.state().containerId, 'b'.repeat(64));
  assert.equal(f.calls.length, 1);
  const recovery = f.store.events.find(e => e.type === 'recovery_verified');
  assert.equal(recovery.targetId, 'a'.repeat(64));
  assert.equal(recovery.currentId, 'b'.repeat(64));
  assert.equal(recovery.restartOutcome, 'unknown_or_rejected');
});

test('inspection failure cannot cause an unvalidated restart; persistence failure prevents Docker mutation', async () => {
  const f = fixture();
  await f.controller.initialize();
  f.setInspectError('gate_http_403');
  for (let i = 0; i < 5; i++) await f.step();
  assert.equal(f.calls.length, 0);
  f.setInspectError(null);
  f.setHealthy(false);
  f.store.save = async () => { throw new Error('disk_full'); };
  await assert.rejects(f.step(), /disk_full/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.step(), /persistence_failed/);
});

test('verification refuses identity changing while readiness response is in flight', async () => {
  const f = fixture();
  await f.controller.initialize();
  f.setHealthy(false);
  await f.step(); await f.step(); await f.step();
  f.setHealthy(true);
  const originalProbe = f.controller.probe;
  f.controller.probe = async (...args) => { const result = await originalProbe(...args); f.setStart(`new-${Math.random()}`); return result; };
  await f.step(); await f.step();
  assert.equal(f.state().state, 'recovering');
  assert.equal(f.state().verificationSuccesses, 0);
  assert.equal(f.state().lastProbe.reason, 'identity_changed_during_verification');
});

test('malformed persisted state fails closed and missing checkpoint with existing journal cannot reset budgets', async () => {
  const f = fixture();
  f.store.saved = { schemaVersion: 1, backends: {} };
  await assert.rejects(f.controller.initialize(), /invalid_checkpoint/);
  assert.equal(f.calls.length, 0);
  const base = path.join(root, '.cache/controller-tests');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'journal-'));
  await writeFile(path.join(directory, 'controller.events.jsonl'), '{}\n');
  await assert.rejects(new PersistentStore(directory).load(), /checkpoint_missing/);
});

test('persistent store serializes complete events and atomic status checkpoints', async () => {
  const base = path.join(root, '.cache/controller-tests');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'store-'));
  const store = new PersistentStore(directory);
  assert.equal(await store.load(), null);
  await Promise.all(Array.from({ length: 10 }, (_, i) => store.save({ schemaVersion: 1, i }, { type: 'test', i })));
  assert.equal((await store.load()).i, 9);
  const records = (await readFile(path.join(directory, 'controller.events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.map(r => r.i), Array.from({ length: 10 }, (_, i) => i));
});

test('readiness validates HTTP status, backend identity and ready boolean, never just reachable process', async () => {
  const target = { running: true, ip: '127.0.0.1' };
  const config = loadConfig({});
  for (const [status, body, expected] of [[200, { instance: 'backend-a', ready: true }, true],
    [200, { instance: 'backend-b', ready: true }, false], [200, { instance: 'backend-a', alive: true }, false],
    [503, { instance: 'backend-a', ready: true }, false], [302, { instance: 'backend-a', ready: true }, false]]) {
    const result = await probeReadiness('backend-a', target, config, async () => ({ status, body }));
    assert.equal(result.ok, expected);
  }
});

test('HTTP helper has an absolute full-body timeout and response-size bound', async t => {
  const server = http.createServer((req, res) => {
    if (req.url === '/large') res.end('x'.repeat(9000));
    else { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const options = { hostname: '127.0.0.1', port: server.address().port, method: 'GET' };
  const start = performance.now();
  await assert.rejects(requestJson({ ...options, path: '/slow' }, { timeoutMs: 50 }), /timeout/);
  assert.ok(performance.now() - start < 1000);
  await assert.rejects(requestJson({ ...options, path: '/large' }, { timeoutMs: 100 }), /response_too_large/);
});

test('configuration rejects unsafe or unbounded controls', () => {
  for (const env of [{ RECOVERY_ENABLED: 'yes' }, { FAILURE_THRESHOLD: '1' }, { MAX_RESTART_ATTEMPTS: 'Infinity' },
    { VERIFY_SUCCESSES: '1' }, { PROBE_TIMEOUT_MS: '0' }, { PROBE_INTERVAL_MS: '-1' }]) assert.throws(() => loadConfig(env));
});

test('verification caps I/O to remaining budget and rejects readiness completing after the deadline', async () => {
  const f = fixture({ verifyTimeoutMs: 1000, maxAttempts: 1 });
  await f.controller.initialize();
  f.setHealthy(false);
  await f.step(); await f.step(); await f.step();
  f.setHealthy(true);
  const originalInspect = f.controller.inspect;
  const budgets = [];
  f.controller.inspect = async (service, timeoutMs) => { budgets.push(timeoutMs); return originalInspect(service); };
  f.controller.probe = async (_service, _target, timeoutMs) => {
    budgets.push(timeoutMs);
    f.advance(600); // Response comes after the remaining500ms budget, despite being healthy.
    return { ok: true, status: 200 };
  };
  await f.step();
  assert.ok(budgets.every(ms => ms > 0 && ms <= 500));
  assert.equal(f.state().state, 'exhausted');
  assert.equal(f.store.events.filter(e => e.type === 'recovery_verified').length, 0);
  assert.equal(f.calls.length, 1);
});

test('wall-clock jumps cannot expire or extend the monotonic verification budget', async () => {
  const f = fixture({ verifyTimeoutMs: 1000, maxAttempts: 1 });
  await f.controller.initialize();
  f.setHealthy(false);
  await f.step(); await f.step(); await f.step();
  f.setWallOffset(60_000);
  await f.step();
  assert.equal(f.state().state, 'recovering');
  f.setWallOffset(-60_000);
  await f.step();
  assert.equal(f.state().state, 'exhausted');
  assert.equal(f.calls.length, 1);
});

test('wall-clock jumps cannot skip the stable cooldown', async () => {
  const f = fixture();
  await f.controller.initialize();
  f.setHealthy(false);
  await f.step(); await f.step(); await f.step();
  f.setHealthy(true);
  await f.step(); await f.step();
  f.setWallOffset(60_000);
  await f.step();
  assert.equal(f.state().state, 'cooldown');
  assert.equal(f.state().attempts, 1);
  f.setWallOffset(-60_000);
  await f.step(); await f.step(); await f.step();
  assert.equal(f.state().state, 'healthy');
  assert.equal(f.state().attempts, 0);
});
