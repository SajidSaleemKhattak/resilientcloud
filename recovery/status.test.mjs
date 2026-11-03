import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStatusServer } from './status.mjs';

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
});
