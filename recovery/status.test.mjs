import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStatusServer, readRecentEvents } from './status.mjs';

test('status is read-only, handles missing data, and labels stale snapshots', async t => {
  const cache = fileURLToPath(new URL('../.cache/tests/', import.meta.url));
  await mkdir(cache, { recursive: true });
  const dir = await mkdtemp(path.join(cache, 'status-'));
  const server = createStatusServer({ dataDir: dir, now: () => 10000 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true }); });
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${url}/status`)).status, 503);
  await writeFile(path.join(dir, 'status.json'), JSON.stringify({ updatedAt: new Date(0).toISOString(), backends: {} }));
  const stale = await (await fetch(`${url}/status`)).json();
  assert.equal(stale.stale, true);
  await writeFile(path.join(dir, 'status.json'), JSON.stringify({ updatedAt: new Date(9000).toISOString(), backends: {} }));
  assert.equal((await (await fetch(`${url}/status`)).json()).stale, false);
  await writeFile(path.join(dir, 'status.json'), JSON.stringify({ updatedAt: new Date(9000).toISOString(), backends: {
    'backend-a': { state: 'healthy', lastProbe: { timestamp: new Date(0).toISOString() } },
    'backend-b': { state: 'healthy', lastProbe: { timestamp: new Date(9000).toISOString() } },
  } }));
  const partiallyStale = await (await fetch(`${url}/status`)).json();
  assert.equal(partiallyStale.stale, false);
  assert.equal(partiallyStale.backends['backend-a'].stale, true);
  assert.equal(partiallyStale.backends['backend-b'].stale, false);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.equal((await fetch(`${url}/status`, { method })).status, 405);
  for (const endpoint of ['/restart', '/v1/backends/backend-a/restart', '/status?command=restart']) {
    assert.equal((await fetch(url + endpoint, { method: 'POST' })).status, 404);
  }
  assert.equal((await fetch(`${url}/events`)).status, 503);
  await writeFile(path.join(dir, 'controller.events.jsonl'), '');
  assert.deepEqual((await (await fetch(`${url}/events`)).json()).events, []);
  const event = { type: 'recovery_verified', timestamp: new Date(9000).toISOString(), runId: 'actual-run', service: 'backend-a' };
  await writeFile(path.join(dir, 'controller.events.jsonl'), `${JSON.stringify(event)}\n`);
  assert.deepEqual((await (await fetch(`${url}/events`)).json()).events, [event]);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD']) {
    assert.equal((await fetch(`${url}/events`, { method })).status, 405);
  }
  assert.equal((await fetch(`${url}/events?limit=999999`)).status, 404);
  await writeFile(path.join(dir, 'controller.events.jsonl'), 'corrupted complete line\n');
  assert.equal((await fetch(`${url}/events`)).status, 503);
});

test('incident history bounds bytes and count, filters probes and omits partial writes', async t => {
  const cache = fileURLToPath(new URL('../.cache/tests/', import.meta.url));
  await mkdir(cache, { recursive: true });
  const dir = await mkdtemp(path.join(cache, 'events-'));
  t.after(() => rm(dir, { recursive: true }));
  const incidents = Array.from({ length: 110 }, (_, i) => ({ type: 'state_changed', timestamp: new Date(i * 1000).toISOString(), runId: 'run', index: i }));
  const probe = { type: 'probe', timestamp: new Date().toISOString(), runId: 'run' };
  await writeFile(path.join(dir, 'controller.events.jsonl'), incidents.map(e => JSON.stringify(e) + '\n').join('') + JSON.stringify(probe) + '\n' + '{"type":"restart');
  const bounded = await readRecentEvents(dir);
  assert.equal(bounded.events.length, 100);
  assert.equal(bounded.events[0].index, 109);
  assert.equal(bounded.events.at(-1).index, 10);
  assert.equal(bounded.truncated, true);
  const tail = await readRecentEvents(dir, { maxBytes: 512 });
  assert.ok(tail.events.length > 0 && tail.events.length < 10);
  assert.equal(tail.events[0].index, 109);
  assert.equal(tail.truncated, true);
});
