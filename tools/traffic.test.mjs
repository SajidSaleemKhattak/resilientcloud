import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, symlink, readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs, openOutput, projectRoot, runTraffic } from './traffic.mjs';

async function server(t, handler) {
  const app = http.createServer(handler);
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); });
  return `http://127.0.0.1:${app.address().port}/api`;
}

test('records actual HTTP outcomes, identities, and measured latency', async t => {
  let calls = 0;
  const url = await server(t, (_req, res) => {
    const failed = calls++ % 2 === 1;
    res.writeHead(failed ? 503 : 200, { 'content-type': 'application/json', 'x-instance-id': failed ? 'backend-b' : 'backend-a' });
    res.end(JSON.stringify({ instance: failed ? 'backend-b' : 'backend-a' }));
  });
  const records = [];
  const summary = await runTraffic({ url, duration: 0.25, rate: 20 }, row => records.push(row));
  const requests = records.filter(row => row.type === 'request');
  assert.equal(summary.requests, calls);
  assert.equal(summary.successes + summary.failures, calls);
  assert.equal(summary.scheduled, summary.requests + summary.dropped);
  assert.ok(summary.successes > 0);
  assert.ok(summary.failures > 0);
  assert.ok(requests.every(row => row.latencyMs >= 0 && row.instance && Number.isFinite(row.elapsedMs) && !Number.isNaN(Date.parse(row.timestamp))));
  assert.ok(requests.some(row => row.status === 503 && !row.success && row.error === null));
});

test('timeouts and concurrency saturation produce failures and distinct skipped slots', async t => {
  const url = await server(t, () => {});
  const records = [];
  const summary = await runTraffic({ url, duration: 0.2, rate: 100, concurrency: 1, timeoutMs: 80 }, row => records.push(row));
  assert.equal(summary.successes, 0);
  assert.ok(summary.requests >= 1);
  assert.ok(summary.dropped > 0);
  assert.equal(summary.requests + summary.dropped, summary.scheduled);
  assert.ok(records.filter(row => row.type === 'request').every(row => row.error === 'timeout' && !row.success));
  assert.ok(records.some(row => row.type === 'skipped' && row.reason === 'concurrency_limit'));
  assert.equal(summary.latencySuccessMs.p95, null);
  assert.ok(records.filter(row => row.type === 'request').every(row => row.upstreamAddr === null && row.upstreamStatus === null));
});

test('preserves gateway attempt headers even when the client receives a successful response', async t => {
  const url = await server(t, (_req, res) => {
    res.writeHead(200, { 'x-instance-id': 'backend-b', 'x-upstream-addr': '172.20.0.2:3000, 172.20.0.3:3000', 'x-upstream-status': '503, 200' });
    res.end('{}');
  });
  const records = [];
  await runTraffic({ url, duration: 0.1, rate: 10 }, row => records.push(row));
  const requests = records.filter(row => row.type === 'request');
  assert.ok(requests.length > 0);
  assert.ok(requests.every(row => row.success && row.status === 200 && row.instance === 'backend-b' && row.upstreamAddr === '172.20.0.2:3000, 172.20.0.3:3000' && row.upstreamStatus === '503, 200'));
});

test('falls back to body identity; aborted responses stay failures', async t => {
  let calls = 0;
  const url = await server(t, (_req, res) => {
    if (calls++ === 0) res.end(JSON.stringify({ instance: 'body-only' }));
    else { res.writeHead(200, { 'content-length': 100 }); res.write('short'); setTimeout(() => res.destroy(), 5); }
  });
  const records = [];
  const summary = await runTraffic({ url, duration: 0.2, rate: 10 }, row => records.push(row));
  assert.ok(records.some(row => row.type === 'request' && row.instance === 'body-only'));
  assert.ok(records.some(row => row.type === 'request' && !row.success && row.error));
  assert.ok(summary.failures > 0);
});

test('scheduler delay records missed slots without issuing a catch-up burst', async t => {
  let calls = 0;
  const url = await server(t, (_req, res) => { calls++; res.end('{}'); });
  const records = [];
  const summary = await runTraffic({ url, duration: 0.2, rate: 40 }, async row => {
    records.push(row);
    if (row.type === 'start') await new Promise(resolve => setTimeout(resolve, 110));
  });
  assert.ok(records.filter(row => row.type === 'skipped' && row.reason === 'scheduler_lag').length >= 3);
  assert.equal(calls, summary.requests);
  assert.equal(summary.requests + summary.dropped, summary.scheduled);
  assert.ok(summary.requests < summary.scheduled);
});

test('rejects malformed CLI arguments, unsafe paths, and nonlocal or credential-bearing URLs', () => {
  const good = ['--out', 'results/one.jsonl'];
  for (const args of [[], ['--missing', 'yes'], [...good, '--rate', 'NaN'], [...good, '--duration', '-1'], [...good, '--concurrency', '1.2'], [...good, '--rate'], [...good, '--rate', '1', '--rate', '2'], ['--out', '../outside.jsonl'], ['--out', '/tmp/out.jsonl'], ['--out', 'results/../out.jsonl'], [...good, '--url', 'http://example.com'], [...good, '--url', 'http://user:pass@localhost']]) {
    assert.throws(() => parseArgs(args));
  }
  assert.equal(parseArgs(good).out, 'results/one.jsonl');
});

test('output refuses overwrites and symlink parents/leaves', async t => {
  // Test scratch files stay under this project and are removed after this test.
  const scratch = await mkdtemp(path.join(projectRoot, 'tools', '.traffic-test-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const relative = `results/.traffic-test-${path.basename(scratch)}`;
  const target = `${relative}/run.jsonl`;
  const first = await openOutput(target);
  t.after(() => rm(path.join(projectRoot, relative), { recursive: true, force: true }));
  await first.file.write('original\n');
  await first.file.close();
  await assert.rejects(openOutput(target), { code: 'EEXIST' });
  assert.equal(await readFile(first.filename, 'utf8'), 'original\n');
  await symlink(scratch, path.join(projectRoot, relative, 'link'));
  await assert.rejects(openOutput(`${relative}/link/escape.jsonl`), /symlinks/);
  await symlink(path.join(scratch, 'new.jsonl'), path.join(projectRoot, relative, 'leaf.jsonl'));
  await assert.rejects(openOutput(`${relative}/leaf.jsonl`), { code: 'EEXIST' });
});

test('CLI serializes concurrent completions into complete JSONL and accounts for every scheduled slot', async t => {
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const url = await server(t, (_req, res) => {
    calls++;
    active++;
    maxActive = Math.max(maxActive, active);
    setTimeout(() => { active--; res.end(JSON.stringify({ instance: 'parallel' })); }, 30);
  });
  const name = `results/.traffic-cli-${process.pid}-${Date.now()}`;
  t.after(() => rm(path.join(projectRoot, name), { recursive: true, force: true }));
  await promisify(execFile)(process.execPath, ['tools/traffic.mjs', '--url', url, '--duration', '0.4', '--rate', '200', '--concurrency', '10', '--out', `${name}/run.jsonl`], { cwd: projectRoot });
  const records = (await readFile(path.join(projectRoot, name, 'run.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records[0].type, 'start');
  const summary = records.at(-1);
  assert.equal(summary.type, 'summary');
  const requests = records.filter(row => row.type === 'request');
  const slots = records.filter(row => row.type === 'request' || row.type === 'skipped').map(row => row.slot).sort((a, b) => a - b);
  assert.deepEqual(slots, Array.from({ length: summary.scheduled }, (_, index) => index));
  assert.equal(requests.length, summary.requests);
  assert.equal(calls, summary.requests);
  assert.ok(maxActive > 1);
  assert.ok(maxActive <= 10);
  assert.ok(requests.every(row => row.success && row.instance === 'parallel'));
});
