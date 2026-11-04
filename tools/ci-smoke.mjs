import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { composeArgs, docker, root } from './docker.mjs';
import { openOutput } from './traffic.mjs';

/** Bound a command and its child process group; retain all output on disk. */
export async function runBounded(command, args, { cwd = root, logFile, timeoutMs = 600_000, graceMs = 3000 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(graceMs) || graceMs < 0) {
    throw new Error('A positive timeout and nonnegative termination grace are required');
  }
  const log = await open(logFile, 'wx', 0o600);
  const started = performance.now();
  let timer;
  let killTimer;
  let timedOut = false;
  let processGroup;
  const stopGroup = signal => {
    try { if (processGroup) process.kill(-processGroup, signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  try {
    return await new Promise(resolve => {
      const child = spawn(command, args, { cwd, detached: true, stdio: ['ignore', log.fd, log.fd] });
      processGroup = child.pid;
      timer = setTimeout(() => {
        timedOut = true;
        stopGroup('SIGTERM');
        killTimer = setTimeout(() => stopGroup('SIGKILL'), graceMs);
      }, timeoutMs);
      child.once('error', error => resolve({ code: null, signal: null, error: error.message, timedOut, durationMs: performance.now() - started }));
      child.once('close', (code, signal) => resolve({ code, signal, timedOut, durationMs: performance.now() - started }));
    });
  } finally {
    // A cooperative leader can exit before a stubborn grandchild. Kill remaining
    // members of this command's group before cancelling the escalation timer.
    if (timedOut) stopGroup('SIGKILL');
    clearTimeout(timer);
    clearTimeout(killTimer);
    await log.close();
  }
}

/** Read diagnostics only for the two dedicated smoke projects. Never delete here. */
function collectDiagnostics(destination) {
  const failures = [];
  const capture = (name, args) => {
    try { writeFileSync(path.join(destination, name), docker(args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024 })); }
    catch (error) { failures.push({ name, error: error.message }); }
  };
  capture('docker-version.txt', ['version']);
  for (const project of ['resilientcloud-m2', 'resilientcloud-m2-disabled']) {
    capture(`${project}-containers.txt`, ['ps', '-a', '--no-trunc', '--filter', `label=com.docker.compose.project=${project}`]);
    capture(`${project}-logs.txt`, composeArgs(project, 'recovery', ['logs', '--no-color', '--timestamps', '--tail', '500']));
    // A deadline may interrupt the normal runner's export. Preserve journals from
    // exact project/service matches; do not adopt or mutate surviving containers.
    for (const [service, files] of [
      ['controller', ['/data/controller.events.jsonl', '/data/status.json']],
      ['gate', ['/audit/gate.events.jsonl']],
    ]) {
      try {
        const ids = docker(['ps', '-aq', '--no-trunc', '--filter', `label=com.docker.compose.project=${project}`,
          '--filter', `label=com.docker.compose.service=${service}`], { timeout: 5000 }).trim().split(/\s+/).filter(Boolean);
        if (ids.length !== 1) continue;
        for (const file of files) capture(`${project}-${service}-${path.basename(file)}.copy.txt`,
          ['cp', `${ids[0]}:${file}`, path.join(destination, `${project}-${path.basename(file)}`)]);
      } catch (error) { failures.push({ project, service, error: error.message }); }
    }
  }
  writeFileSync(path.join(destination, 'diagnostic-errors.json'), `${JSON.stringify(failures, null, 2)}\n`);
}

export async function main(args = process.argv.slice(2)) {
  if (args.length && (args.length !== 2 || args[0] !== '--out')) throw new Error('Usage: node tools/ci-smoke.mjs [--out results/new-directory]');
  const out = args[1] ?? `results/ci/smoke-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  if (existsSync(path.resolve(root, out))) throw new Error('Smoke output directory must be new');
  // Reuse the evidence writer's path/symlink checks before any output is written.
  const { file } = await openOutput(`${out}/lifecycle.jsonl`);
  const directory = path.join(root, out);
  const startedAt = new Date().toISOString();
  await file.writeFile(`${JSON.stringify({ type: 'start', startedAt, timeoutMs: 600_000, hostPlatform: process.platform, hostArch: process.arch })}\n`);
  console.log(`Running bounded recovery integration smoke; output: ${out}/runner.log`);
  let result;
  try {
    result = await runBounded(process.execPath, ['tools/validate-m2.mjs', '--out', `${out}/validation`], {
      logFile: path.join(directory, 'runner.log'), timeoutMs: 600_000,
    });
    if (result.code !== 0 || result.timedOut || result.error) collectDiagnostics(directory);
    const status = result.code === 0 && !result.timedOut && !result.error ? 'passed' : 'failed';
    const report = { status, startedAt, finishedAt: new Date().toISOString(), hostPlatform: process.platform,
      hostArch: process.arch, deadlineMs: 600_000, ...result, validation: 'validation/report.json',
      note: 'Local execution is not a GitHub Actions run. Timed-out resources are retained for inspection; this wrapper performs no cleanup.' };
    writeFileSync(path.join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    await file.writeFile(`${JSON.stringify({ type: 'finish', ...report })}\n`);
    console.log(`Integration smoke ${status}; report: ${out}/report.json`);
    if (status !== 'passed') process.exitCode = 1;
  } finally { await file.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
