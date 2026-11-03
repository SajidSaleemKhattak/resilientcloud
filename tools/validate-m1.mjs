import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { composeArgs, docker, dockerEnvironment, inspectBackend, root } from './docker.mjs';
import { injectFault } from './fault.mjs';
import { openOutput } from './traffic.mjs';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--out')) throw new Error('Usage: npm run validate:m1 -- [--out results/unique-directory]');
const out = args[1] ?? `results/m1-${new Date().toISOString().replace(/[:.]/g, '-')}`;
if (existsSync(path.resolve(root, out))) throw new Error('Validation output directory must be new');
const { file: events } = await openOutput(`${out}/events.jsonl`);
const started = performance.now();
const report = { startedAt: new Date().toISOString(), purpose: 'Milestone 1 functional smoke validation, not repeated research trials',
  status: 'running', recoveryEnabled: false, samples: [], checks: [], scenarios: {} };
const event = async (type, details) => {
  const record = { type, timestamp: new Date().toISOString(), elapsedMs: performance.now() - started, ...details };
  await events.write(`${JSON.stringify(record)}\n`);
};
const check = async (name, details = {}) => {
  report.checks.push({ name, ...details });
  await event('check_passed', { name, ...details });
  console.log(`PASS ${name}`);
};
function compose(project, scenario, command) {
  return docker(composeArgs(project, scenario, command), { timeout: 600_000 });
}
function state(project, service = 'backend-a') {
  const c = inspectBackend(project, service);
  return { id: c.Id, running: c.State.Running, status: c.State.Status, exitCode: c.State.ExitCode,
    health: c.State.Health?.Status, startedAt: c.State.StartedAt, restartCount: c.RestartCount,
    restartPolicy: c.HostConfig.RestartPolicy.Name, ip: c.NetworkSettings.Networks[`${project}_app`]?.IPAddress };
}
async function until(description, condition, timeout = 20_000) {
  const start = performance.now();
  while (performance.now() - start < timeout) {
    if (await condition()) return;
    await sleep(200);
  }
  throw new Error(`Timed out: ${description}`);
}
function launchSample(scenario, label, port, duration = 3) {
  const filename = `${out}/${scenario}-${label}.jsonl`;
  const child = spawn(process.execPath, ['tools/traffic.mjs', '--url', `http://127.0.0.1:${port}/api`,
    '--duration', String(duration), '--rate', '10', '--concurrency', '8', '--timeout-ms', '2500',
    '--out', filename, '--label', `${scenario}-${label}`], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let errorOutput = '';
  child.stdout.resume();
  child.stderr.on('data', b => { errorOutput += b; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => {
      if (code !== 0) return reject(new Error(`Traffic exited ${code}: ${errorOutput}`));
      try {
        const records = readFileSync(path.join(root, filename), 'utf8').trim().split('\n').map(JSON.parse);
        const summary = records.at(-1);
        assert.equal(summary.type, 'summary');
        assert.ok(summary.requests > 0);
        report.samples.push({ file: filename, ...summary });
        resolve({ records, summary });
      } catch (error) { reject(error); }
    });
  });
  // Attach a handler immediately while faults run, retaining rejection for the await below.
  done.catch(() => {});
  return { done };
}
async function normalSample(scenario, label, port) {
  const sample = await launchSample(scenario, label, port).done;
  assert.equal(sample.summary.failures, 0);
  assert.equal(sample.summary.dropped, 0);
  assert.ok(sample.summary.instances['backend-a'] > 0);
  if (scenario === 'two') assert.ok(sample.summary.instances['backend-b'] > 0);
  await check(`${scenario}: ${label}`, { instances: sample.summary.instances });
}

try {
  report.runtime = {
    hostNode: process.version,
    docker: JSON.parse(docker(['info', '--format', '{"version":"{{.ServerVersion}}","architecture":"{{.Architecture}}","os":"{{.OperatingSystem}}"}'])),
    compose: docker(['compose', 'version', '--short']).trim(),
  };
  report.sourceHashes = {};
  for (const directory of ['backend', 'nginx', 'tools']) {
    for (const entry of readdirSync(path.join(root, directory), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(entry.parentPath, entry.name);
      report.sourceHashes[path.relative(root, file)] = createHash('sha256').update(readFileSync(file)).digest('hex');
    }
  }
  for (const file of ['Dockerfile', 'compose.yaml', 'compose.two.yaml', 'package.json', 'package-lock.json', 'tsconfig.json']) {
    report.sourceHashes[file] = createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex');
  }
  // Refuse to adopt or remove containers from a previous validation run.
  for (const scenario of ['one', 'two']) {
    const project = `resilientcloud-m1-${scenario}`;
    assert.equal(docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]).trim(), '',
      `${project} already exists; inspect and stop that specific project manually before rerunning`);
  }
  for (const [scenario, port] of [['one', 18081], ['two', 18082]]) {
    const project = `resilientcloud-m1-${scenario}`;
    dockerEnvironment().GATEWAY_PORT = String(port);
    let holder;
    let created = false;
    const scenarioReport = report.scenarios[scenario] = {};
    try {
      const config = JSON.parse(compose(project, scenario, ['config', '--format', 'json']));
      for (const service of Object.values(config.services)) {
        assert.equal(service.restart, 'no');
        assert.ok(!(service.volumes ?? []).some(v => String(v.source).includes('docker.sock')));
      }
      assert.equal(config.services.gateway.ports[0].host_ip, '127.0.0.1');
      assert.equal(config.services['backend-a'].ports, undefined);
      if (scenario === 'two') assert.equal(config.services['backend-b'].ports, undefined);
      assert.equal(config.networks.app.internal, true);
      assert.ok(Object.hasOwn(config.services.gateway.networks, 'edge'));
      assert.ok(!Object.hasOwn(config.services['backend-a'].networks, 'edge'));
      created = true;
      compose(project, scenario, ['up', '-d', '--build', '--wait', '--wait-timeout', '60']);
      compose(project, scenario, ['exec', '-T', 'gateway', 'nginx', '-t']);
      const gatewayId = compose(project, scenario, ['ps', '-q', 'gateway']).trim();
      const gatewayStart = JSON.parse(docker(['inspect', gatewayId]))[0].State.StartedAt;
      const backend = inspectBackend(project, 'backend-a');
      const gateway = JSON.parse(docker(['inspect', gatewayId]))[0];
      scenarioReport.images = [backend.Image, gateway.Image].map(id => {
        const image = JSON.parse(docker(['image', 'inspect', id]))[0];
        return { id: image.Id, architecture: image.Architecture, digests: image.RepoDigests };
      });
      scenarioReport.node = compose(project, scenario, ['exec', '-T', 'backend-a', 'node', '--version']).trim();
      await until('gateway ready', async () => {
        try { return (await fetch(`http://127.0.0.1:${port}/api`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
      });
      for (const pathname of ['/fault', '/admin/fault', '/ready', '/live', '/restart']) {
        assert.equal((await fetch(`http://127.0.0.1:${port}${pathname}`, { method: 'POST' })).status, 404);
      }
      assert.equal((await fetch(`http://127.0.0.1:${port}/api`, { method: 'POST' })).status, 403);
      await check(`${scenario}: isolated ports, no socket mounts, restart policies disabled, fault routes absent`);
      await normalSample(scenario, 'normal', port);

      for (const mode of ['crash', 'unhealthy']) {
        const before = state(project);
        const sample = launchSample(scenario, mode, port, 8);
        await sleep(2000);
        const fault = injectFault({ mode, service: 'backend-a', project });
        await event('fault', fault);
        await until(`${mode} observed`, () => {
          const current = state(project);
          return mode === 'crash' ? !current.running : current.running && current.health === 'unhealthy';
        });
        const observed = state(project);
        await event('backend_state', { scenario, mode, observed });
        if (mode === 'unhealthy') {
          const probe = JSON.parse(compose(project, scenario, ['exec', '-T', 'backend-a', 'node', '-e',
            "Promise.all(['/live','/ready','/api'].map(async p=>{const r=await fetch('http://127.0.0.1:3000'+p);return {path:p,status:r.status}})).then(r=>console.log(JSON.stringify(r)))"]));
          assert.deepEqual(probe.map(p => p.status), [200, 503, 503]);
          await event('direct_probe', { scenario, probe });
        } else assert.equal(observed.exitCode, 137);
        const completed = await sample.done;
        const afterFault = completed.records.filter(r => r.type === 'request' && Date.parse(r.timestamp) > Date.parse(fault.completedAt) + 100);
        assert.ok(afterFault.length >= 10);
        if (scenario === 'one') assert.ok(afterFault.every(r => !r.success));
        else assert.ok(afterFault.every(r => r.success && r.instance === 'backend-b'));
        const stillFailed = state(project);
        assert.equal(stillFailed.restartCount, 0);
        assert.equal(stillFailed.startedAt, before.startedAt);
        assert.equal(stillFailed.running, mode === 'unhealthy');
        if (mode === 'unhealthy') assert.equal(stillFailed.health, 'unhealthy');
        scenarioReport[mode] = { fault, observed, after: stillFailed, afterFaultRequests: afterFault.length };
        await check(`${scenario}: ${mode} ${scenario === 'two' ? 'failover' : 'outage'}, no automatic recovery`);
        await event('manual_restart', { scenario, mode });
        compose(project, scenario, mode === 'crash' ? ['start', 'backend-a'] : ['restart', '--no-deps', 'backend-a']);
        await until('manual restart healthy', () => state(project).health === 'healthy');
        await sleep(2500); // passive fail_timeout expiry, not a recovery measurement
        await normalSample(scenario, `after-${mode}-restart`, port);
      }

      // Keep the old address occupied by a labelled test container to guarantee an IP change.
      const before = state(project);
      const sample = launchSample(scenario, 'dns-recreate', port, 12);
      await sleep(2000);
      await event('recreate_start', { scenario, before });
      compose(project, scenario, ['rm', '-s', '-f', 'backend-a']);
      holder = docker(['run', '-d', '--name', `${project}-dns-holder`, '--restart', 'no',
        '--label', `com.docker.compose.project=${project}`, '--label', 'com.docker.compose.service=dns-holder',
        '--label', 'io.resilientcloud.role=dns-test-holder',
        '--network', `${project}_app`, '--ip', before.ip, '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges:true', '--memory', '32m', '--entrypoint', 'node',
        'resilientcloud-backend:m1', '-e', 'setInterval(()=>{},1000)']).trim();
      compose(project, scenario, ['up', '-d', '--no-deps', 'backend-a']);
      await until('recreated backend healthy', () => state(project).health === 'healthy');
      const after = state(project);
      assert.notEqual(after.id, before.id);
      assert.notEqual(after.ip, before.ip);
      await event('recreate_healthy', { scenario, after });
      await sample.done;
      await normalSample(scenario, 'after-ip-change', port);
      const currentGateway = JSON.parse(docker(['inspect', gatewayId]))[0];
      assert.equal(currentGateway.State.StartedAt, gatewayStart);
      assert.equal(currentGateway.State.Running, true);
      scenarioReport.recreation = { before, after, gatewayId, gatewayStart, gatewayRestarted: false };
      await check(`${scenario}: new container ID/IP reached without restarting Nginx`, { oldIp: before.ip, newIp: after.ip });
    } finally {
      if (created) {
        try { writeFileSync(path.join(root, out, `${scenario}-compose.log`), compose(project, scenario, ['logs', '--no-color', '--timestamps'])); }
        catch (error) { await event('log_capture_error', { message: error.message }); }
        if (holder) docker(['rm', '-f', holder]);
        compose(project, scenario, ['down', '--timeout', '10']);
      }
    }
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error.stack;
  console.error(error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await event('validation_finished', { status: report.status });
  await events.close();
  writeFileSync(path.join(root, out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Evidence: ${out}/report.json (${report.status})`);
}
