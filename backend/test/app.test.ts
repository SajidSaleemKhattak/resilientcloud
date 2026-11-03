import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createBackend } from '../src/app.js';

async function serve(instance: string) {
  const backend = createBackend({ instance });
  const server = backend.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    ...backend,
    url,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

test('healthy service identifies its instance in body and response header', async (t) => {
  const backend = await serve('backend-a');
  t.after(backend.close);
  for (const path of ['/api', '/ready', '/live']) {
    const response = await fetch(`${backend.url}${path}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-instance-id'), 'backend-a');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).instance, 'backend-a');
  }
});

test('an unhealthy service stays alive, returns 503, and requires fresh state to recover', async (t) => {
  const backend = await serve('backend-b');
  t.after(backend.close);
  backend.markUnhealthy();
  backend.markUnhealthy();
  for (let sample = 0; sample < 2; sample += 1) {
    const readiness = await fetch(`${backend.url}/ready`);
    assert.equal(readiness.status, 503);
    assert.deepEqual(await readiness.json(), { instance: 'backend-b', ready: false });
    const api = await fetch(`${backend.url}/api`);
    assert.equal(api.status, 503);
    assert.deepEqual(await api.json(), { instance: 'backend-b', error: 'instance_unhealthy' });
    const live = await fetch(`${backend.url}/live`);
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { instance: 'backend-b', alive: true });
  }
  assert.equal(createBackend({ instance: 'backend-b' }).isReady(), true);
});

test('HTTP has no fault controls and does not accept application mutations', async (t) => {
  const backend = await serve('backend-a');
  t.after(backend.close);
  for (const path of ['/fault', '/fault/unhealthy', '/crash', '/restart', '/admin/fault']) {
    for (const method of ['GET', 'POST']) {
      const response = await fetch(`${backend.url}${path}`, { method });
      assert.equal(response.status, 404, `${method} ${path}`);
      await response.arrayBuffer();
    }
  }
  const mutation = await fetch(`${backend.url}/api`, { method: 'POST' });
  assert.equal(mutation.status, 404);
  await mutation.arrayBuffer();
  assert.equal(backend.isReady(), true);
});

test('instance IDs cannot inject response headers', () => {
  assert.throws(() => createBackend({ instance: 'bad\r\nheader' }), /INSTANCE_ID/);
  assert.throws(() => createBackend({ instance: '' }), /INSTANCE_ID/);
});
