import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

interface StartedBackend {
  child: ChildProcess;
  url: string;
  stop(): Promise<void>;
}

async function startBackend(faultsEnabled: boolean, startUnhealthy = false): Promise<StartedBackend> {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/server.js', import.meta.url))], {
    env: { ...process.env, PORT: '0', INSTANCE_ID: 'process-test', FAULT_INJECTION_ENABLED: String(faultsEnabled), START_UNHEALTHY: String(startUnhealthy) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = await new Promise<string>((resolve, reject) => {
    let buffer = '';
    const deadline = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Backend startup timed out'));
    }, 5000);
    child.once('error', (error) => { clearTimeout(deadline); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(deadline);
      reject(new Error(`Backend exited before startup: code=${code} signal=${signal}`));
    });
    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const event = JSON.parse(line) as { event: string; port?: number };
        if (event.event === 'listening') {
          clearTimeout(deadline);
          resolve(`http://127.0.0.1:${event.port}`);
        }
        newline = buffer.indexOf('\n');
      }
    });
  });
  return {
    child,
    url,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      const deadline = setTimeout(() => child.kill('SIGKILL'), 6000);
      child.kill('SIGTERM');
      try { await exited; } finally { clearTimeout(deadline); }
    },
  };
}

async function waitForStatus(url: string, expected: number) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const response = await fetch(url);
    await response.arrayBuffer();
    if (response.status === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Expected HTTP ${expected} from ${url}`);
}

test('SIGUSR2 produces an unhealthy running process and a new process restores readiness', async (t) => {
  const first = await startBackend(true);
  t.after(first.stop);
  await waitForStatus(`${first.url}/ready`, 200);
  first.child.kill('SIGUSR2');
  await waitForStatus(`${first.url}/ready`, 503);
  await waitForStatus(`${first.url}/api`, 503);
  await waitForStatus(`${first.url}/live`, 200);
  assert.equal(first.child.exitCode, null);
  await first.stop();
  assert.equal(first.child.exitCode, 0);
  const restarted = await startBackend(true);
  t.after(restarted.stop);
  await waitForStatus(`${restarted.url}/ready`, 200);
});

test('disabled fault injection ignores SIGUSR2 without changing readiness', async (t) => {
  const backend = await startBackend(false);
  t.after(backend.stop);
  const ignored = new Promise<void>((resolve) => {
    backend.child.stdout!.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('fault_ignored')) resolve();
    });
  });
  backend.child.kill('SIGUSR2');
  await Promise.race([
    ignored,
    new Promise<never>((_resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('Signal was not acknowledged')), 3000);
      deadline.unref();
    }),
  ]);
  await waitForStatus(`${backend.url}/ready`, 200);
});

test('SIGKILL terminates the backend process', async (t) => {
  const backend = await startBackend(true);
  t.after(backend.stop);
  const exited = once(backend.child, 'exit');
  backend.child.kill('SIGKILL');
  const [code, signal] = await exited;
  assert.equal(code, null);
  assert.equal(signal, 'SIGKILL');
});

test('persistent test fixture survives process recreation and requires fault opt-in', async (t) => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const backend = await startBackend(true, true);
    t.after(backend.stop);
    await waitForStatus(`${backend.url}/ready`, 503);
    await waitForStatus(`${backend.url}/live`, 200);
    await backend.stop();
  }
  const production = await startBackend(false, true);
  t.after(production.stop);
  await waitForStatus(`${production.url}/ready`, 200);
});
