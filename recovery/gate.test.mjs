import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAudit, createDockerClient, createGate, createGateServer, validateContainer } from './gate-core.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const configuration = { project: 'resilientcloud-m2', directory: root.replace(/\/$/, ''), network: 'resilientcloud-m2_app' };
const id = 'a'.repeat(64);
const replacement = 'b'.repeat(64);
function backend(containerId = id) {
  return { Id: containerId, Config: { Env: ['INSTANCE_ID=backend-a'], Labels: {
    'com.docker.compose.project': configuration.project,
    'com.docker.compose.service': 'backend-a',
    'com.docker.compose.project.working_dir': configuration.directory,
    'io.resilientcloud.role': 'backend',
  } }, State: { Running: true, StartedAt: '2026-11-03T00:00:00Z', Health: { Status: 'healthy' } },
  NetworkSettings: { Networks: { [configuration.network]: { IPAddress: '172.22.0.2' } } } };
}
function fixture() {
  let current = backend();
  let candidates;
  const calls = [];
  const events = [];
  const docker = async (method, route) => {
    calls.push({ method, route });
    if (route.startsWith('/containers/json?')) return candidates ?? [{ Id: current.Id }];
    if (method === 'GET' && route === `/containers/${current.Id}/json`) return structuredClone(current);
    if (method === 'POST' && route === `/containers/${current.Id}/restart?t=1`) return null;
    throw new Error(`Unexpected Docker request: ${method} ${route}`);
  };
  const gate = createGate({ ...configuration, docker, audit: async event => events.push(event) });
  return { gate, calls, events, setCurrent: c => { current = c; }, setCandidates: c => { candidates = c; } };
}

test('valid backend inspection exposes only approved fields and fixed filtered Docker requests', async () => {
  const f = fixture();
  const result = await f.gate.execute({ service: 'backend-a', operation: 'inspect' });
  assert.deepEqual(Object.keys(result).sort(), ['health', 'id', 'ip', 'running', 'service', 'startedAt']);
  assert.equal(result.id, id);
  const filters = JSON.parse(new URL(`http://local${f.calls[0].route}`).searchParams.get('filters'));
  assert.deepEqual(filters.label, ['com.docker.compose.project=resilientcloud-m2', 'com.docker.compose.service=backend-a']);
  assert.equal(f.calls.length, 2);
  assert.equal(f.events[0].event, 'inspection_allowed');
});

test('foreign or stale IDs never reach Docker restart; recreation needs fresh validation', async () => {
  const f = fixture();
  await assert.rejects(f.gate.execute({ service: 'backend-a', operation: 'restart', id: replacement }), /stale_container_id/);
  assert.equal(f.calls.filter(x => x.method === 'POST').length, 0);
  f.setCurrent(backend(replacement));
  await assert.rejects(f.gate.execute({ service: 'backend-a', operation: 'restart', id }), /stale_container_id/);
  const fresh = await f.gate.execute({ service: 'backend-a', operation: 'inspect' });
  assert.equal(fresh.id, replacement);
  assert.deepEqual(await f.gate.execute({ service: 'backend-a', operation: 'restart', id: fresh.id }), {
    service: 'backend-a', id: replacement, accepted: true,
  });
  assert.deepEqual(f.calls.filter(x => x.method === 'POST'), [{ method: 'POST', route: `/containers/${replacement}/restart?t=1` }]);
  assert.deepEqual(f.events.slice(-2).map(x => x.event), ['restart_requested', 'restart_accepted']);
});

test('mismatched labels, identity, network, inspect ID and ambiguous discovery fail closed', async () => {
  const mutations = [
    c => { c.Config.Labels['com.docker.compose.project'] = 'foreign'; },
    c => { c.Config.Labels['com.docker.compose.service'] = 'gateway'; },
    c => { c.Config.Labels['com.docker.compose.project.working_dir'] = '/foreign'; },
    c => { c.Config.Labels['io.resilientcloud.role'] = 'foreign'; },
    c => { c.Config.Env = ['INSTANCE_ID=backend-b']; },
    c => { c.Config.Env.push('INSTANCE_ID=backend-a'); },
    c => { c.NetworkSettings.Networks = {}; },
    c => { c.NetworkSettings.Networks[configuration.network].IPAddress = ''; },
  ];
  for (const mutate of mutations) {
    const f = fixture(); const c = backend(); mutate(c); f.setCurrent(c);
    await assert.rejects(f.gate.execute({ service: 'backend-a', operation: 'restart', id }), /backend_validation_failed/);
    assert.equal(f.calls.filter(x => x.method === 'POST').length, 0);
  }
  assert.throws(() => validateContainer(backend(replacement), configuration, 'backend-a', id), /backend_validation_failed/);
  for (const candidates of [[], [{ Id: id }, { Id: replacement }], [{ Id: 'not-an-id' }]]) {
    const f = fixture(); f.setCandidates(candidates);
    await assert.rejects(f.gate.execute({ service: 'backend-a', operation: 'restart', id }), /backend_missing_or_ambiguous/);
    assert.equal(f.calls.length, 1);
  }
  const stopped = backend(); stopped.State.Running = false; stopped.NetworkSettings.Networks[configuration.network].IPAddress = '';
  assert.equal(validateContainer(stopped, configuration, 'backend-a', id).ip, null);
});

test('unsupported operation and target rejected before Docker; audit failure prevents restart', async () => {
  const f = fixture();
  for (const input of [{ service: 'gateway', operation: 'restart', id }, { service: 'backend-a', operation: 'exec', id }]) {
    await assert.rejects(f.gate.execute(input), /unauthorized_operation/);
  }
  assert.equal(f.calls.length, 0);
  const calls = [];
  const gate = createGate({ ...configuration, audit: async () => { throw new Error('disk full'); }, docker: async (method, route) => {
    calls.push({ method, route });
    return route.startsWith('/containers/json?') ? [{ Id: id }] : backend();
  } });
  await assert.rejects(gate.execute({ service: 'backend-a', operation: 'restart', id }), /disk full/);
  assert.equal(calls.filter(x => x.method === 'POST').length, 0);
});

test('per-service operation lock prevents overlapping restart decisions', async () => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const gate = createGate({ ...configuration, audit: async () => {}, docker: async (method, route) => {
    if (route.startsWith('/containers/json?')) { await waiting; return [{ Id: id }]; }
    return method === 'GET' ? backend() : null;
  } });
  const first = gate.execute({ service: 'backend-a', operation: 'restart', id });
  await assert.rejects(gate.execute({ service: 'backend-a', operation: 'restart', id }), /backend_busy/);
  release(); await first;
});

async function socketDirectory(t) {
  const parent = path.join(root, '.cache', 'test');
  await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(path.join(parent, 'gate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function listen(t, server, socket) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
}
function request(socketPath, method, route, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ socketPath, method, path: route, headers: {
      ...(text ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) } : {}), ...extraHeaders,
    } }, res => {
      const chunks = []; res.on('data', b => chunks.push(b));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.once('error', reject); req.end(text);
  });
}

test('real Unix HTTP gate rejects raw Docker operations, URL tricks, bodies and public mutation paths', async t => {
  const dir = await socketDirectory(t); const socket = path.join(dir, 'g.sock');
  const f = fixture(); const server = createGateServer(f.gate); await listen(t, server, socket);
  assert.equal(typeof server.address(), 'string');
  assert.equal((await request(socket, 'GET', '/v1/backends/backend-a')).status, 200);
  for (const [method, route, body] of [
    ['GET', '/containers/json'], ['POST', '/containers/create', {}],
    ['DELETE', `/containers/${id}`], ['POST', `/containers/${id}/exec`, {}],
    ['POST', '/v1/backends/backend-a'], ['HEAD', '/v1/backends/backend-a'],
    ['GET', '/v1/backends/backend-a?extra=1'], ['GET', '/v1/backends/%62ackend-a'],
    ['GET', 'http://attacker/v1/backends/backend-a'], ['POST', '/restart'],
    ['POST', '/v1/backends/backend-b/restart', { id, command: 'exec' }],
    ['POST', '/v1/backends/backend-a/restart', { id: 'backend-a' }],
  ]) assert.ok((await request(socket, method, route, body)).status >= 400, `${method} ${route}`);
  assert.equal(f.calls.filter(x => x.method === 'POST').length, 0);
  assert.equal((await request(socket, 'GET', '/v1/backends/backend-a', { id })).status, 400);
  assert.equal((await request(socket, 'POST', '/v1/backends/backend-a/restart', { id })).status, 202);
  assert.equal(f.calls.filter(x => x.method === 'POST').length, 1);
  assert.ok(f.events.some(e => e.event === 'request_rejected'));
});

test('Docker socket transport enforces absolute timeout, response bound and HTTP errors', async t => {
  const dir = await socketDirectory(t); const socket = path.join(dir, 'd.sock');
  const received = [];
  const server = http.createServer((req, res) => {
    received.push(req.url);
    if (req.url.endsWith('/slow')) return;
    if (req.url.endsWith('/large')) return res.end('x'.repeat(2000));
    if (req.url.endsWith('/error')) { res.writeHead(500); return res.end('{}'); }
    res.end('{"ok":true}');
  });
  await listen(t, server, socket);
  const client = createDockerClient({ socketPath: socket, timeoutMs: 40, maxBytes: 1000 });
  assert.deepEqual(await client('GET', '/ok'), { ok: true });
  await assert.rejects(client('GET', '/slow'), /docker_timeout/);
  await assert.rejects(client('GET', '/large'), /docker_response_too_large/);
  await assert.rejects(client('GET', '/error'), /docker_operation_failed/);
  assert.ok(received.every(p => p.startsWith('/v1.53/')));
});

test('audit records survive writer recreation and remain valid timestamped JSONL', async t => {
  const dir = await socketDirectory(t); const filename = path.join(dir, 'audit.jsonl');
  const first = await createAudit(filename, { consoleOutput: false });
  await Promise.all([first({ event: 'first' }), first({ event: 'second' })]);
  const next = await createAudit(filename, { consoleOutput: false });
  await next({ event: 'third' });
  const records = (await readFile(filename, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.map(e => e.event), ['first', 'second', 'third']);
  assert.ok(records.every(e => Number.isFinite(Date.parse(e.timestamp)) && e.elapsedMs >= 0));
});
