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
if (args.length && (args.length !== 2 || args[0] !== '--out')) throw new Error('Usage: npm run validate:m2 -- [--out results/new-directory]');
const out = args[1] ?? `results/milestone-2/run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
if (existsSync(path.resolve(root, out))) throw new Error('Validation output directory must be new');
const { file: events } = await openOutput(`${out}/events.jsonl`);
const started = performance.now();
const report = { startedAt: new Date().toISOString(), status: 'running', checks: [], samples: [], scenarios: {},
  purpose: 'Milestone 2 functional validation with real measurements, not repeated research trials',
  timingDefinitions: {
    faultInjection: 'Host UTC immediately before the fault command; command completion is recorded separately.',
    detectionMs: 'Controller failure_confirmed Linux monotonic time mapped to runner performance.now using a timed clock sample, minus fault-command monotonic start.',
    recoveryMs: 'Controller recovery_verified monotonic time mapped to runner clock, minus fault start. This requires readiness, not Docker restart acceptance. UTC is retained for audit only.',
    readinessAfterConfirmationMs: 'Controller monotonic recovery_verified elapsedMs minus failure_confirmed elapsedMs within the same runId.',
    uncertainty: 'Cross-process timing uncertainty is at least half the clock-sample command round-trip. Probe cadence, fault command duration and scheduler delay also affect detection. Values are smoke observations, not guarantees.',
  },
};
const pendingSamples = new Set();
const event = async (type, details = {}) => events.writeFile(`${JSON.stringify({ type, timestamp: new Date().toISOString(), elapsedMs: performance.now() - started, ...details })}\n`);
const check = async (name, details = {}) => { report.checks.push({ name, ...details }); await event('check_passed', { name, ...details }); console.log(`PASS ${name}`); };
const compose = (project, command, persistent = false) => docker(composeArgs(project, 'recovery', [
  ...(persistent ? ['-f', path.join(root, 'compose.persistent-test.yaml')] : []), ...command,
]), { timeout: 600_000 });
const container = (project, service) => JSON.parse(docker(['inspect', compose(project, ['ps', '-aq', service]).trim()]))[0];
function state(project, service = 'backend-a') {
  const c = inspectBackend(project, service);
  return { id: c.Id, running: c.State.Running, status: c.State.Status, exitCode: c.State.ExitCode,
    health: c.State.Health?.Status, startedAt: c.State.StartedAt, restartCount: c.RestartCount,
    restartPolicy: c.HostConfig.RestartPolicy.Name, ip: c.NetworkSettings.Networks[`${project}_app`]?.IPAddress };
}
async function until(label, condition, timeout = 30_000, interval = 100) {
  const start = performance.now();
  while (performance.now() - start < timeout) { const result = await condition(); if (result) return result; await sleep(interval); }
  throw new Error(`Timed out: ${label}`);
}
async function status(port) {
  const response = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error(`Status HTTP ${response.status}`);
  return response.json();
}
async function ready(port) {
  return until('both backends healthy in controller snapshot', async () => {
    try { const s = await status(port); return !s.stale && Object.values(s.backends).every(b => b.state === 'healthy') && s; }
    catch { return false; }
  });
}
function sample(project, label, port, duration = 10) {
  const filename = `${out}/${project}-${label}.jsonl`;
  const child = spawn(process.execPath, ['tools/traffic.mjs', '--url', `http://127.0.0.1:${port}/api`,
    '--duration', String(duration), '--rate', '10', '--concurrency', '8', '--timeout-ms', '2500',
    '--out', filename, '--label', `${project}-${label}`], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume();
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => {
      if (code !== 0) return reject(new Error(`Traffic ${label} failed: ${stderr}`));
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
  pendingSamples.add(done);
  done.then(() => pendingSamples.delete(done), () => pendingSamples.delete(done));
  return done;
}
function assertSiblingTraffic(completed, since, untilTime = Infinity) {
  const requests = completed.records.filter(r => r.type === 'request' && Date.parse(r.timestamp) > Date.parse(since) && Date.parse(r.timestamp) < untilTime);
  assert.ok(requests.length >= 3, 'Need actual traffic during the fault');
  const siblingResponses = requests.filter(r => r.instance === 'backend-b');
  assert.ok(siblingResponses.length >= 3, 'Sibling must actually serve requests during recovery');
  assert.ok(siblingResponses.every(r => r.success), 'Sibling responses must remain healthy');
  // Passive failover/DNS changes can still expose failures from the failed peer.
  // Preserve and report those outcomes; sibling availability is checked separately.
  assert.equal(completed.summary.dropped, 0);
}
const gateCode = `
const http=require('node:http');
const specs=JSON.parse(process.argv[1]);
function request(spec){return new Promise((resolve,reject)=>{
 const body=spec.body===undefined?undefined:JSON.stringify(spec.body);
 const req=http.request({socketPath:'/run/gate/gate.sock',method:spec.method,path:spec.path,headers:body===undefined?{}:{'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{
 let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:text?JSON.parse(text):null}));});
 const timer=setTimeout(()=>req.destroy(new Error('deadline')),5000);req.on('close',()=>clearTimeout(timer));req.on('error',reject);req.end(body);
});}
(async()=>{const output=[];for(const spec of specs){const attempts=[];for(let i=0;i<10;i++){const r=await request(spec);attempts.push(r);if(r.body?.error!=='backend_busy')break;await new Promise(r=>setTimeout(r,100));}output.push({request:spec,...attempts.at(-1),attempts});}console.log(JSON.stringify(output));})().catch(e=>{console.error(e.message);process.exitCode=1});`;
function gate(project, requests) {
  return JSON.parse(compose(project, ['exec', '-T', 'controller', 'node', '-e', gateCode, JSON.stringify(requests)]));
}
async function clockSample(project) {
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const before = performance.now();
    const remote = JSON.parse(compose(project, ['exec', '-T', 'controller', 'node', '-e', 'console.log(JSON.stringify({utc:Date.now(),monotonic:Number(process.hrtime.bigint())/1e6}))']).trim());
    const after = performance.now();
    samples.push({ hostBefore: before, containerNow: remote.monotonic, containerUtc: remote.utc, hostAfter: after,
      offsetMs: remote.monotonic - (before + after) / 2, uncertaintyMs: (after - before) / 2 });
  }
  return { ...[...samples].sort((a, b) => a.uncertaintyMs - b.uncertaintyMs)[0], samples };
}
function evidence(project, service, source, destination) {
  const id = compose(project, ['ps', '-aq', service]).trim();
  if (!id) throw new Error(`Cannot capture ${service}: missing container`);
  docker(['cp', `${id}:${source}`, path.join(root, out, destination)]);
}
function readEvents(filename) {
  return readFileSync(path.join(root, out, filename), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}
function deriveTimings(scenario, controllerEvents) {
  for (const fault of scenario.faults) {
    const calibration = fault.clock ?? scenario.clock;
    const offset = calibration.offsetMs;
    const mappingDriftMs = fault.clockAfter ? fault.clockAfter.offsetMs - offset : null;
    const stableClock = mappingDriftMs === null || Math.abs(mappingDriftMs)
      <= calibration.uncertaintyMs + fault.clockAfter.uncertaintyMs + 100;
    const start = fault.monotonicMs;
    const confirmed = controllerEvents.find(e => e.type === 'failure_confirmed' && e.service === 'backend-a' && e.monotonicMs - offset >= start);
    const verified = controllerEvents.find(e => e.type === 'recovery_verified' && e.service === 'backend-a' && e.monotonicMs - offset >= start);
    // Restrict event association to this fault's recorded observation interval.
    const end = fault.observationEndMonotonicMs ?? performance.now();
    const detection = confirmed && confirmed.monotonicMs - offset <= end ? confirmed : null;
    const recovery = verified && verified.monotonicMs - offset <= end ? verified : null;
    fault.measurement = {
      detectionMs: detection ? detection.monotonicMs - offset - start : null,
      recoveryMs: recovery ? recovery.monotonicMs - offset - start : null,
      readinessAfterConfirmationMs: detection && recovery && detection.runId === recovery.runId ? recovery.elapsedMs - detection.elapsedMs : null,
      clockUncertaintyMs: calibration.uncertaintyMs,
      mappingDriftMs, stableClock,
      failureConfirmedEvent: detection,
      recoveryVerifiedEvent: recovery,
      recoveryObserved: Boolean(recovery),
    };
    const siblingProbes = controllerEvents.filter(e => e.type === 'probe' && e.service === 'backend-b'
      && e.monotonicMs - offset >= start && e.monotonicMs - offset <= end);
    fault.measurement.siblingProbes = siblingProbes.length;
    fault.measurement.siblingFailedProbes = siblingProbes.filter(e => !e.ok).length;
    if (fault.observationEndedAt) {
      assert.ok(stableClock, 'Host/VM monotonic mapping changed during fault; timings are not reliable');
      assert.ok(siblingProbes.length > 0 && siblingProbes.every(e => e.ok), 'Healthy sibling probes failed during fault');
      if (fault.expectRecovery) assert.ok(recovery && detection, `Missing measured detection/recovery for ${fault.label}`);
      if (fault.expectNoRecovery) assert.equal(recovery, null, `Unexpected recovery for ${fault.label}`);
    }
  }
}

try {
  report.runtime = { hostNode: process.version, docker: docker(['info', '--format', '{{.ServerVersion}} {{.Architecture}}']).trim(), compose: docker(['compose', 'version', '--short']).trim() };
  report.sourceHashes = {};
  for (const directory of ['backend', 'nginx', 'tools', 'recovery']) {
    for (const entry of readdirSync(path.join(root, directory), { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) { const file = path.join(entry.parentPath, entry.name); report.sourceHashes[path.relative(root, file)] = createHash('sha256').update(readFileSync(file)).digest('hex'); }
    }
  }
  for (const file of ['Dockerfile', 'compose.yaml', 'compose.two.yaml', 'compose.recovery.yaml', 'compose.persistent-test.yaml', 'package.json', 'package-lock.json', 'tsconfig.json']) {
    report.sourceHashes[file] = createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex');
  }
  for (const project of ['resilientcloud-m2', 'resilientcloud-m2-disabled']) {
    assert.equal(docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]).trim(), '', `Existing ${project} containers; refusing to adopt them`);
    assert.equal(docker(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]).trim(), '', `Existing ${project} volumes; preserve/inspect them before rerunning`);
  }

  for (const [project, port, enabled] of [['resilientcloud-m2', 18083, true], ['resilientcloud-m2-disabled', 18084, false]]) {
    Object.assign(dockerEnvironment(), { GATEWAY_PORT: String(port), RECOVERY_ENABLED: String(enabled) });
    const scenario = report.scenarios[project] = { recoveryEnabled: enabled, faults: [] };
    const helpers = new Set();
    let created = false;
    try {
      const configuration = JSON.parse(compose(project, ['config', '--format', 'json']));
      for (const [name, service] of Object.entries(configuration.services)) {
        assert.equal(service.restart, 'no', `${name} restart policy`);
        if (name !== 'gate') assert.ok(!(service.volumes ?? []).some(v => v.target.includes('docker.sock')));
        if (name !== 'gateway') assert.equal(service.ports, undefined);
      }
      assert.equal(configuration.services.gate.network_mode, 'none');
      assert.deepEqual(Object.keys(configuration.services.controller.networks), ['app']);
      assert.deepEqual(Object.keys(configuration.services.status.networks), ['status-read']);
      assert.ok(configuration.services.status.volumes.every(v => v.read_only));
      assert.equal(configuration.services.gateway.ports[0].host_ip, '127.0.0.1');
      created = true;
      compose(project, ['up', '-d', '--build', '--wait', '--wait-timeout', '60']);
      compose(project, ['exec', '-T', 'gateway', 'nginx', '-t']);
      const initial = await ready(port);
      assert.equal(initial.recoveryEnabled, enabled);
      scenario.clock = await clockSample(project);
      scenario.config = initial.config;
      scenario.runtime = {};
      for (const service of ['backend-a', 'backend-b', 'gate', 'controller', 'status', 'gateway']) {
        const c = container(project, service);
        scenario.runtime[service] = { id: c.Id, image: c.Image, networks: Object.keys(c.NetworkSettings.Networks),
          mounts: c.Mounts.map(m => ({ type: m.Type, destination: m.Destination, writable: m.RW })), ports: c.NetworkSettings.Ports,
          restartPolicy: c.HostConfig.RestartPolicy.Name, startedAt: c.State.StartedAt };
        assert.equal(c.HostConfig.RestartPolicy.Name, 'no');
        if (service !== 'gate') assert.ok(!c.Mounts.some(m => m.Destination.includes('docker.sock')));
      }
      const isolation = JSON.parse(compose(project, ['exec', '-T', 'status', 'node', '-e',
        "const fs=require('node:fs');const net=require('node:net');const s=net.connect({host:'backend-a',port:3000});let done=false;function finish(reached){if(done)return;done=true;s.destroy();console.log(JSON.stringify({reachedBackend:reached,dockerSocket:fs.existsSync('/var/run/docker.sock'),gateSocket:fs.existsSync('/run/gate/gate.sock')}));}s.on('connect',()=>finish(true));s.on('error',()=>finish(false));setTimeout(()=>finish(false),500).unref();"]));
      assert.deepEqual(isolation, { reachedBackend: false, dockerSocket: false, gateSocket: false });
      await check(`${project}: runtime isolation and disabled Docker restart policies`, { isolation });
      const publicBefore = state(project);
      for (const pathname of ['/fault', '/restart', '/recovery', '/v1/backends/backend-a/restart', '/containers/json']) {
        for (const method of ['GET', 'POST']) assert.equal((await fetch(`http://127.0.0.1:${port}${pathname}`, { method, signal: AbortSignal.timeout(2000) })).status, 404);
      }
      assert.equal((await fetch(`http://127.0.0.1:${port}/status`, { method: 'POST', signal: AbortSignal.timeout(2000) })).status, 403);
      assert.equal((await fetch(`http://127.0.0.1:${port}/api`, { method: 'POST', signal: AbortSignal.timeout(2000) })).status, 403);
      assert.equal(state(project).startedAt, publicBefore.startedAt);
      await check(`${project}: public routes cannot trigger faults or recovery`);
      const normal = await sample(project, 'normal', port, 3);
      assert.equal(normal.summary.failures, 0);
      assert.ok(normal.summary.instances['backend-a'] > 0 && normal.summary.instances['backend-b'] > 0);
      await check(`${project}: normal routing`, { instances: normal.summary.instances });

      for (const mode of ['crash', 'unhealthy']) {
        await ready(port);
        const previousVerifiedAt = (await status(port)).backends['backend-a'].recoveryVerifiedAt;
        const before = state(project);
        const siblingBefore = state(project, 'backend-b');
        const traffic = sample(project, mode, port, 10);
        await sleep(1500);
        const faultClock = await clockSample(project);
        const fault = { ...injectFault({ mode, service: 'backend-a', project }), clock: faultClock, label: mode, expectRecovery: enabled, expectNoRecovery: !enabled };
        scenario.faults.push(fault);
        await event('fault', { project, ...fault });
        const observed = state(project);
        if (mode === 'crash') { assert.equal(observed.running, false); assert.equal(observed.exitCode, 137); }
        else {
          assert.equal(observed.running, true);
          const direct = JSON.parse(compose(project, ['exec', '-T', 'backend-a', 'node', '-e',
            "Promise.all(['/live','/ready','/api'].map(async p=>{const r=await fetch('http://127.0.0.1:3000'+p);return {path:p,status:r.status}})).then(r=>console.log(JSON.stringify(r)))"]));
          assert.deepEqual(direct.map(p => p.status), [200, 503, 503]);
          await event('direct_fault_probe', { project, mode, direct });
        }
        fault.observed = observed;
        if (enabled) {
          fault.verifiedSnapshot = await until(`${mode} verified by readiness`, async () => {
            const s = await status(port);
            return s.backends['backend-a'].recoveryVerifiedAt && s.backends['backend-a'].recoveryVerifiedAt !== previousVerifiedAt && s;
          });
          fault.verifiedObservedAt = new Date().toISOString();
          assert.notEqual(state(project).startedAt, before.startedAt);
          await ready(port);
        } else {
          await sleep(4500);
          const still = state(project);
          assert.equal(still.startedAt, before.startedAt);
          assert.equal(still.running, mode === 'unhealthy');
          assert.equal((await status(port)).backends['backend-a'].attempts, 0);
        }
        const completed = await traffic;
        assertSiblingTraffic(completed, fault.completedAt, enabled
          ? Date.parse(fault.verifiedObservedAt)
          : Infinity);
        assert.equal(state(project, 'backend-b').startedAt, siblingBefore.startedAt);
        fault.observationEndedAt = new Date().toISOString();
        fault.observationEndMonotonicMs = performance.now();
        fault.clockAfter = await clockSample(project);
        await check(`${project}: ${mode} ${enabled ? 'readiness-verified recovery' : 'remains failed with recovery disabled'}; sibling serves traffic`);
        if (!enabled) { compose(project, mode === 'crash' ? ['start', 'backend-a'] : ['restart', '--no-deps', 'backend-a']); await ready(port); }
      }

      if (enabled) {
        const before = state(project);
        const transientClock = await clockSample(project);
        const traffic = sample(project, 'transient', port, 5);
        const fault = { type: 'fault', label: 'transient', clock: transientClock, timestamp: new Date().toISOString(), monotonicMs: performance.now(), mode: 'SIGSTOP_then_SIGCONT', expectNoRecovery: true };
        scenario.faults.push(fault);
        docker(['kill', '--signal', 'SIGSTOP', before.id]);
        try {
          fault.suspectedSnapshot = await until('first transient failed probe', async () => {
            const s = await status(port); return s.backends['backend-a'].failures >= 1 && s;
          }, 3000, 25);
          assert.ok(fault.suspectedSnapshot.backends['backend-a'].failures < scenario.config.failureThreshold);
        } finally { docker(['kill', '--signal', 'SIGCONT', before.id]); }
        fault.completedAt = new Date().toISOString();
        await event('fault', { project, ...fault });
        await ready(port);
        await traffic;
        assert.equal(state(project).startedAt, before.startedAt);
        assert.equal((await status(port)).backends['backend-a'].attempts, 0);
        fault.observationEndedAt = new Date().toISOString();
        fault.observationEndMonotonicMs = performance.now();
        fault.clockAfter = await clockSample(project);
        await check(`${project}: transient below failure threshold causes no restart`);

        const old = state(project);
        compose(project, ['up', '-d', '--no-deps', '--force-recreate', 'backend-a']);
        const replacement = state(project);
        assert.notEqual(replacement.id, old.id);
        await ready(port);
        const replacementGate = gate(project, [{ method: 'GET', path: '/v1/backends/backend-a' },
          { method: 'POST', path: '/v1/backends/backend-a/restart', body: { id: old.id } }]);
        assert.equal(replacementGate[0].status, 200);
        assert.equal(replacementGate[0].body.id, replacement.id);
        assert.equal(replacementGate[1].status, 409);
        assert.equal(replacementGate[1].body.error, 'stale_container_id');
        await event('gate_recreation_checks', { project, before: old, replacement, responses: replacementGate });
        const previousVerifiedAt = (await status(port)).backends['backend-a'].recoveryVerifiedAt;
        const recreatedClock = await clockSample(project);
        const recreatedFault = { ...injectFault({ mode: 'unhealthy', service: 'backend-a', project }), clock: recreatedClock, label: 'recreated-backend', expectRecovery: true };
        scenario.faults.push(recreatedFault);
        await event('fault', { project, ...recreatedFault });
        await until('replacement recovered', async () => {
          const value = (await status(port)).backends['backend-a'].recoveryVerifiedAt;
          return value && value !== previousVerifiedAt;
        });
        await ready(port);
        recreatedFault.observationEndedAt = new Date().toISOString();
        recreatedFault.observationEndMonotonicMs = performance.now();
        recreatedFault.clockAfter = await clockSample(project);
        await check(`${project}: legitimate recreation revalidated, stale ID rejected, replacement recovered`);

        const persistentClock = await clockSample(project);
        const persistent = { type: 'fault', label: 'persistent', clock: persistentClock, timestamp: new Date().toISOString(), monotonicMs: performance.now(), mode: 'START_UNHEALTHY', expectNoRecovery: true };
        scenario.faults.push(persistent);
        const sibling = state(project, 'backend-b');
        const persistentTraffic = sample(project, 'persistent', port, 20);
        compose(project, ['up', '-d', '--no-deps', '--force-recreate', 'backend-a'], true);
        persistent.completedAt = new Date().toISOString();
        await event('fault', { project, ...persistent });
        const exhausted = await until('persistent fault exhausts attempts', async () => {
          const s = await status(port); return s.backends['backend-a'].state === 'exhausted' && s;
        }, 30000);
        assert.equal(exhausted.backends['backend-a'].attempts, scenario.config.maxAttempts);
        assert.equal(exhausted.backends['backend-a'].manualIntervention, true);
        persistent.exhaustedSnapshot = exhausted;
        const exhaustedState = state(project);
        await sleep(2500);
        assert.equal(state(project).startedAt, exhaustedState.startedAt);
        compose(project, ['restart', '--no-deps', 'controller']);
        await until('controller checkpoint resumed', async () => {
          const s = await status(port); return s.runId !== exhausted.runId && s;
        });
        await sleep(2500);
        const resumed = await status(port);
        assert.equal(resumed.backends['backend-a'].state, 'exhausted');
        assert.equal(resumed.backends['backend-a'].attempts, scenario.config.maxAttempts);
        assert.equal(state(project).startedAt, exhaustedState.startedAt);
        assert.equal(state(project, 'backend-b').startedAt, sibling.startedAt);
        const completed = await persistentTraffic;
        assertSiblingTraffic(completed, persistent.completedAt);
        persistent.observationEndedAt = new Date().toISOString();
        persistent.observationEndMonotonicMs = performance.now();
        persistent.clockAfter = await clockSample(project);
        await check(`${project}: persistent failure bounded at ${scenario.config.maxAttempts} attempts; exhausted budget survives controller restart`);

        // Negative gate tests run after exhaustion, so operator-created fixtures cannot trigger recovery.
        const gatewayId = container(project, 'gateway').Id;
        const foreignId = docker(['run', '-d', '--name', `${project}-foreign-fixture`, '--restart', 'no', '--network', 'none',
          '--label', 'com.docker.compose.project=resilientcloud-m2-foreign', '--label', 'com.docker.compose.service=foreign-fixture',
          '--label', 'io.resilientcloud.role=validation-fixture', '--read-only', '--cap-drop', 'ALL', '--entrypoint', 'node',
          'resilientcloud-backend:m1', '-e', 'setInterval(()=>{},1000)']).trim();
        helpers.add(foreignId);
        const foreignBefore = JSON.parse(docker(['inspect', foreignId]))[0].State.StartedAt;
        const targetsBefore = [state(project), state(project, 'backend-b')];
        const attempts = gate(project, [
          { method: 'POST', path: '/v1/backends/backend-a/restart', body: { id: gatewayId } },
          { method: 'POST', path: '/v1/backends/backend-a/restart', body: { id: foreignId } },
          { method: 'POST', path: '/containers/create', body: {} },
          { method: 'DELETE', path: `/containers/${targetsBefore[0].id}` },
          { method: 'POST', path: `/containers/${targetsBefore[0].id}/exec`, body: {} },
          { method: 'GET', path: '/v1/backends/backend-a?all=true' },
          { method: 'GET', path: '/v1/backends/gateway' },
          { method: 'POST', path: '/v1/backends/backend-a/restart', body: { id: targetsBefore[0].id, command: 'exec' } },
        ]);
        assert.ok(attempts.every(r => r.status >= 400 && r.status < 500));
        assert.equal(JSON.parse(docker(['inspect', foreignId]))[0].State.StartedAt, foreignBefore);
        assert.equal(state(project).startedAt, targetsBefore[0].startedAt);
        assert.equal(state(project, 'backend-b').startedAt, targetsBefore[1].startedAt);
        await event('gate_negative_checks', { project, responses: attempts });
        await check(`${project}: gate rejects foreign targets, gateway, unauthorized operations and extra fields`);

        compose(project, ['rm', '-s', '-f', 'backend-a']);
        const mismatched = docker(['run', '-d', '--name', `${project}-mismatched-fixture`, '--restart', 'no', '--network', `${project}_app`,
          '--label', `com.docker.compose.project=${project}`, '--label', 'com.docker.compose.service=backend-a',
          '--label', `com.docker.compose.project.working_dir=${root}`, '--label', 'io.resilientcloud.role=wrong-role',
          '--env', 'INSTANCE_ID=backend-a', '--read-only', '--cap-drop', 'ALL', '--entrypoint', 'node',
          'resilientcloud-backend:m1', '-e', 'setInterval(()=>{},1000)']).trim();
        helpers.add(mismatched);
        const mismatchResult = gate(project, [{ method: 'GET', path: '/v1/backends/backend-a' },
          { method: 'POST', path: '/v1/backends/backend-a/restart', body: { id: mismatched } }]);
        assert.ok(mismatchResult.every(r => r.status === 403 && r.body.error === 'backend_validation_failed'));
        await event('gate_mismatched_label_checks', { project, responses: mismatchResult });
        await check(`${project}: gate fails closed for mismatched backend labels`);
        docker(['rm', '-f', mismatched]); helpers.delete(mismatched);
        compose(project, ['stop', '--timeout', '10', 'controller']);
        await sleep(5500);
        assert.equal((await status(port)).stale, true);
        await check(`${project}: read-only status explicitly becomes stale when controller stops`);
      }
    } finally {
      await Promise.allSettled([...pendingSamples]);
      if (created) {
        let evidenceSaved = false;
        // Stop writers before copying complete event journals; no backend owns this data.
        try { compose(project, ['stop', '--timeout', '10', 'controller', 'gate']); } catch (error) { await event('stop_error', { project, error: error.message }); }
        try {
          evidence(project, 'controller', '/data/controller.events.jsonl', `${project}-controller.events.jsonl`);
          evidence(project, 'controller', '/data/status.json', `${project}-status.json`);
          evidence(project, 'gate', '/audit/gate.events.jsonl', `${project}-gate.events.jsonl`);
          writeFileSync(path.join(root, out, `${project}-compose.log`), compose(project, ['logs', '--no-color', '--timestamps']));
          scenario.controllerEventsFile = `${project}-controller.events.jsonl`;
          scenario.gateEventsFile = `${project}-gate.events.jsonl`;
          evidenceSaved = true;
          if (scenario.clock) deriveTimings(scenario, readEvents(scenario.controllerEventsFile));
        } catch (error) { await event('evidence_error', { project, error: error.message }); throw error; }
        finally {
          for (const id of helpers) docker(['rm', '-f', id]);
          // Preflight proved these resources were created by this run. Never erase
          // the only remaining journal if export failed; next run will refuse it.
          compose(project, ['down', ...(evidenceSaved ? ['--volumes'] : []), '--timeout', '10']);
          if (!evidenceSaved) await event('volumes_preserved', { project, reason: 'evidence_export_incomplete' });
        }
      }
    }
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.stack; console.error(error); process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await event('validation_finished', { status: report.status });
  await events.close();
  writeFileSync(path.join(root, out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Evidence: ${out}/report.json (${report.status})`);
}
