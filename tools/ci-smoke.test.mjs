import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { root } from './docker.mjs';
import { runBounded } from './ci-smoke.mjs';

async function fixture(t) {
  const parent = path.join(root, '.cache', 'ci-tests');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'run-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'output.log');
}

test('CI command preserves stdout/stderr and nonzero exit status', async t => {
  const logFile = await fixture(t);
  const result = await runBounded(process.execPath, ['-e', "console.log('out');console.error('err');process.exitCode=7"], { logFile, timeoutMs: 5000 });
  assert.equal(result.code, 7);
  assert.equal(result.timedOut, false);
  assert.equal(await readFile(logFile, 'utf8'), 'out\nerr\n');
});

test('CI deadline terminates a stuck process even when SIGTERM is ignored', async t => {
  const logFile = await fixture(t);
  const result = await runBounded(process.execPath, ['-e', "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"], { logFile, timeoutMs: 500, graceMs: 100 });
  assert.equal(result.timedOut, true);
  assert.equal(result.code, null);
  assert.equal(result.signal, 'SIGKILL');
  assert.ok(result.durationMs < 5000);
  assert.match(await readFile(logFile, 'utf8'), /ready/);
});

test('CI command refuses to overwrite diagnostics', async t => {
  const logFile = await fixture(t);
  await runBounded(process.execPath, ['-e', "console.log('original')"], { logFile, timeoutMs: 5000 });
  await assert.rejects(runBounded(process.execPath, ['-e', "console.log('replacement')"], { logFile, timeoutMs: 5000 }), { code: 'EEXIST' });
  assert.equal(await readFile(logFile, 'utf8'), 'original\n');
});

test('CI command reports spawn failures without claiming success', async t => {
  const result = await runBounded(path.join(root, '.cache', 'nonexistent-ci-command'), [], { logFile: await fixture(t), timeoutMs: 5000 });
  assert.equal(result.code, null);
  assert.match(result.error, /ENOENT/);
  assert.equal(result.timedOut, false);
});

test('CI deadline also terminates a descendant when its leader exits first', async t => {
  const logFile = await fixture(t);
  const script = `const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'});
    console.log(child.pid);setInterval(()=>{},1000);`;
  const result = await runBounded(process.execPath, ['-e', script], { logFile, timeoutMs: 500, graceMs: 100 });
  assert.equal(result.timedOut, true);
  const pid = Number((await readFile(logFile, 'utf8')).trim());
  assert.ok(Number.isInteger(pid) && pid > 0);
  let alive = true;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') { alive = false; break; } throw error; }
    await sleep(50);
  }
  assert.equal(alive, false, 'Timed-out child process must not survive its leader');
});
