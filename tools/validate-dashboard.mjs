import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { composeArgs, docker, dockerEnvironment, inspectBackend, root } from './docker.mjs';
import { injectFault } from './fault.mjs';
import { openOutput } from './traffic.mjs';
import { runBounded } from './ci-smoke.mjs';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--out') throw new Error('Usage: node tools/validate-dashboard.mjs --out results/new-directory');
const out = args[1];
if (existsSync(path.resolve(root, out))) throw new Error('Dashboard evidence directory must be new');
const { file: journal } = await openOutput(`${out}/events.jsonl`);
const directory = path.resolve(root, out);
const project = 'resilientcloud-m3-ui';
const url = 'http://127.0.0.1:18086';
const report = { status: 'running', startedAt: new Date().toISOString(), url, checks: [] };
Object.assign(dockerEnvironment(), { GATEWAY_PORT: '18086', RECOVERY_ENABLED: 'true' });
const compose = args => docker(composeArgs(project, 'dashboard', args), { timeout: 600_000 });
const save = (name, value) => writeFileSync(path.join(directory, name), `${JSON.stringify(value, null, 2)}\n`);
const event = async (type, details = {}) => journal.writeFile(`${JSON.stringify({ type, timestamp: new Date().toISOString(), ...details })}\n`);
async function status() {
  const response = await fetch(`${url}/status`, { signal: AbortSignal.timeout(2500) });
  assert.equal(response.status, 200);
  return response.json();
}
async function waitFor(predicate, label, timeout = 20000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    try { const value = await predicate(); if (value) return value; } catch { /* Allow bounded startup/transition. */ }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function browser(expected) {
  process.env.LIVE_DASHBOARD_URL = url;
  process.env.EXPECT_LIVE_STATE = expected;
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(root, '.cache/playwright');
  process.env.LIVE_ARTIFACT_DIR = path.join(directory, `browser-${expected}`);
  const result = await runBounded(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', 'tests/live.spec.ts'], {
    cwd: path.join(root, 'dashboard'), logFile: path.join(directory, `browser-${expected}.log`), timeoutMs: 120000,
  });
  assert.equal(result.code, 0, `Browser ${expected}: see captured log`);
  assert.equal(result.timedOut, false);
  report.checks.push(`Browser: actual ${expected} telemetry, desktop and mobile`);
}

let created = false;
let exported = false;
try {
  for (const [kind, query] of [['containers', ['ps', '-aq']], ['volumes', ['volume', 'ls', '-q']], ['networks', ['network', 'ls', '-q']]]) {
    assert.equal(docker([...query, '--filter', `label=com.docker.compose.project=${project}`]).trim(), '', `Refusing existing ${kind} for ${project}`);
  }
  assert.ok(existsSync(path.join(root, 'dashboard/dist/index.html')), 'Build the dashboard first');
  created = true;
  compose(['up', '-d', '--build', '--wait', '--wait-timeout', '60']);
  await waitFor(async () => {
    const s = await status();
    return !s.stale && ['backend-a', 'backend-b'].every(name => s.backends[name]?.state === 'healthy' && s.backends[name]?.lastProbe?.ok);
  }, 'healthy controller observations');
  const services = JSON.parse(docker(['inspect', ...compose(['ps', '-aq']).trim().split(/\s+/)]));
  report.runtime = services.map(c => ({ service: c.Config.Labels['com.docker.compose.service'], id: c.Id,
    image: c.Image, mounts: c.Mounts.map(m => ({ target: m.Destination, writable: m.RW })), networks: Object.keys(c.NetworkSettings.Networks), restart: c.HostConfig.RestartPolicy.Name }));
  for (const c of services) {
    const service = c.Config.Labels['com.docker.compose.service'];
    assert.equal(c.HostConfig.RestartPolicy.Name, 'no');
    if (service !== 'gate') assert.ok(!c.Mounts.some(m => m.Destination.includes('docker.sock')));
    if (service === 'status') {
      assert.ok(!c.Mounts.some(m => m.Destination.includes('/run/gate')));
      assert.ok(c.Mounts.every(m => !m.RW));
      assert.deepEqual(Object.keys(c.NetworkSettings.Networks), [`${project}_status-read`]);
    }
    if (service === 'gateway') assert.ok(c.Mounts.every(m => !m.RW));
  }
  report.checks.push('Read-only dashboard/status mounts; socket isolation; Docker restart policies disabled');
  for (const endpoint of ['/', '/favicon.svg', '/status', '/events', '/experiments/summary.json', '/api']) {
    const response = await fetch(url + endpoint, { signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200, `${endpoint} loads`);
  }
  const before = inspectBackend(project, 'backend-a').State.StartedAt;
  for (const endpoint of ['/fault', '/restart', '/ready', '/live', '/v1/backends/backend-a/restart']) {
    for (const method of ['GET', 'POST']) assert.equal((await fetch(url + endpoint, { method })).status, 404);
  }
  for (const endpoint of ['/', '/status', '/events', '/experiments/summary.json', '/api']) {
    for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await fetch(url + endpoint, { method })).status, 403);
  }
  assert.equal(inspectBackend(project, 'backend-a').State.StartedAt, before);
  report.checks.push('Dashboard/assets/status/events/saved evidence load; public fault/recovery/write routes denied');
  const fault = injectFault({ mode: 'unhealthy', project, service: 'backend-a' });
  await event('local_fault', fault);
  await waitFor(async () => {
    const s = await status();
    return s.backends['backend-a'].recoveryVerifiedAt && s.backends['backend-a'].state === 'healthy' ? s : false;
  }, 'readiness-verified recovery and stable cooldown');
  save('healthy-status.json', await status());
  const history = await (await fetch(`${url}/events`)).json();
  assert.ok(history.events.some(e => e.type === 'failure_confirmed'));
  assert.ok(history.events.some(e => e.type === 'recovery_verified'));
  save('healthy-events.json', history);
  await browser('healthy');
  compose(['stop', 'controller']);
  await waitFor(async () => (await status()).stale, 'actual stale telemetry');
  save('stale-status.json', await status());
  await browser('stale');
  compose(['stop', 'status']);
  await waitFor(async () => (await fetch(`${url}/status`)).status >= 500, 'actual status disconnect');
  await browser('disconnected');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.stack; process.exitCode = 1;
} finally {
  if (created) {
    try {
      writeFileSync(path.join(directory, 'compose.log'), compose(['logs', '--no-color', '--timestamps']));
      for (const [service, source, name] of [['controller', '/data/controller.events.jsonl', 'controller.events.jsonl'],
        ['controller', '/data/status.json', 'status.json'], ['gate', '/audit/gate.events.jsonl', 'gate.events.jsonl']]) {
        const id = compose(['ps', '-aq', service]).trim();
        assert.match(id, /^[a-f0-9]{64}$/);
        docker(['cp', `${id}:${source}`, path.join(directory, name)]);
      }
      exported = true;
    } catch (error) { report.exportError = error.stack; report.status = 'failed'; process.exitCode = 1; }
    // Only this fresh project, only after its persistent evidence was exported.
    if (exported) {
      try { compose(['down', '--volumes']); }
      catch (error) { report.cleanupError = error.stack; report.status = 'failed'; process.exitCode = 1; }
    }
  }
  report.finishedAt = new Date().toISOString();
  save('report.json', report);
  await event('finished', { status: report.status, exported });
  await journal.close();
  console.log(JSON.stringify(report, null, 2));
}
