#!/usr/bin/env node
import http from 'node:http';
import https from 'node:https';
import { mkdir, lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const defaults = {
  url: 'http://127.0.0.1:8080/api', duration: 10, rate: 10,
  concurrency: 8, timeoutMs: 2000, label: 'manual',
};
const usage = 'node tools/traffic.mjs --out results/run.jsonl [--url http://127.0.0.1:8080/api] [--duration 10] [--rate 10] [--concurrency 8] [--timeout-ms 2000] [--label manual]';

export function parseArgs(args) {
  const options = { ...defaults };
  const keys = { '--url': 'url', '--duration': 'duration', '--rate': 'rate', '--concurrency': 'concurrency', '--timeout-ms': 'timeoutMs', '--out': 'out', '--label': 'label' };
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const key = keys[args[i]];
    if (!key || seen.has(key) || args[i + 1] === undefined || args[i + 1].startsWith('--')) throw new Error(`Invalid arguments. ${usage}`);
    seen.add(key);
    options[key] = ['duration', 'rate', 'concurrency', 'timeoutMs'].includes(key) ? Number(args[i + 1]) : args[i + 1];
  }
  validateOptions(options);
  if (!options.out) throw new Error(`--out is required. ${usage}`);
  validateOutputName(options.out);
  return options;
}

function validateOptions(options) {
  for (const key of ['duration', 'rate', 'concurrency', 'timeoutMs']) {
    if (!Number.isFinite(options[key]) || options[key] <= 0) throw new Error(`${key} must be a positive finite number`);
  }
  if (!Number.isInteger(options.concurrency) || !Number.isInteger(options.timeoutMs)) throw new Error('concurrency and timeout-ms must be integers');
  if (options.duration > 3600 || options.rate > 1000 || options.concurrency > 1000 || options.timeoutMs > 60000) throw new Error('Limits: duration <= 3600s, rate <= 1000/s, concurrency <= 1000, timeout-ms <= 60000');
  const url = new URL(options.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('URL must be HTTP(S), without credentials or a fragment');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('This local experiment tool accepts only loopback URLs');
  if (typeof options.label !== 'string' || options.label.length > 200) throw new Error('label must be at most 200 characters');
}

function validateOutputName(out) {
  if (typeof out !== 'string' || path.isAbsolute(out) || out.includes('\\') || out.includes('\0')) throw new Error('Output must be a relative JSONL path under results/');
  const parts = out.split('/');
  if (parts[0] !== 'results' || parts.length < 2 || parts.some(p => !p || p === '.' || p === '..') || !out.endsWith('.jsonl')) throw new Error('Output must be a relative JSONL path under results/, without traversal');
}

/** Refuse symlinked output parents and existing files; never overwrite previous evidence. */
export async function openOutput(out) {
  validateOutputName(out);
  let current = await realpath(projectRoot);
  const parts = out.split('/');
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    try { await mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Output directories must be real directories, not symlinks');
  }
  const filename = path.join(current, parts.at(-1));
  const file = await open(filename, 'wx', 0o600);
  return { file, filename };
}

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const round = number => Math.round(number * 1000) / 1000;

/** One GET; no client retry. Timeout covers connect, headers, and full response body. */
export function requestOnce(url, timeoutMs, agent) {
  return new Promise(resolve => {
    const started = performance.now();
    let settled = false;
    let status = null;
    let instance = null;
    let upstreamAddr = null;
    let upstreamStatus = null;
    let timer;
    const finish = (error, body = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!instance && body) {
        try { const parsed = JSON.parse(body); if (typeof parsed.instance === 'string') instance = parsed.instance; } catch { /* Nginx errors can be HTML. */ }
      }
      resolve({ status, instance, upstreamAddr, upstreamStatus, success: !error && status >= 200 && status < 300, error: error ?? null, latencyMs: round(performance.now() - started) });
    };
    const client = new URL(url).protocol === 'https:' ? https : http;
    const req = client.get(url, { agent, headers: { accept: 'application/json' } }, res => {
      status = res.statusCode ?? null;
      const header = res.headers['x-instance-id'];
      instance = typeof header === 'string' ? header : null;
      // Preserve Nginx's complete attempt chain: a final 200 can follow an upstream failure.
      const addressHeader = res.headers['x-upstream-addr'];
      const statusHeader = res.headers['x-upstream-status'];
      upstreamAddr = typeof addressHeader === 'string' ? addressHeader : null;
      upstreamStatus = typeof statusHeader === 'string' ? statusHeader : null;
      let body = '';
      let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 65536) { finish('response_too_large'); req.destroy(); return; }
        body += chunk.toString('utf8');
      });
      res.on('end', () => finish(null, body));
      res.on('error', error => finish(error.code ?? error.message));
      res.on('aborted', () => finish('response_aborted'));
    });
    timer = setTimeout(() => { finish('timeout'); req.destroy(); }, timeoutMs);
    req.on('error', error => finish(error.code ?? error.message));
  });
}

function percentile(values, percent) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(percent * sorted.length) - 1)];
}

/** emit is awaited for backpressure; delayed schedule slots are recorded rather than replayed. */
export async function runTraffic(input, emit) {
  const options = { ...defaults, ...input };
  validateOptions(options);
  const started = performance.now();
  const originMonotonicMs = Number(process.hrtime.bigint()) / 1e6;
  const durationMs = options.duration * 1000;
  const interval = 1000 / options.rate;
  const scheduled = Math.ceil(durationMs / interval);
  const agent = new (new URL(options.url).protocol === 'https:' ? https.Agent : http.Agent)({ keepAlive: true, maxSockets: options.concurrency });
  const pending = new Set();
  const latencies = [];
  const successfulLatencies = [];
  const instances = {};
  let requests = 0;
  let successes = 0;
  let dropped = 0;
  let writeFailure;
  await emit({ type: 'start', schemaVersion: 1, originMonotonicMs, timestamp: new Date().toISOString(), url: options.url, label: options.label, durationSeconds: options.duration, ratePerSecond: options.rate, concurrency: options.concurrency, timeoutMs: options.timeoutMs, clientRetries: 0 });
  try {
    let slot = 0;
    while (slot < scheduled) {
      if (writeFailure) throw writeFailure;
      const elapsed = performance.now() - started;
      const due = slot * interval;
      if (elapsed < due) { await sleep(due - elapsed); continue; }
      const newerSlotDue = Math.min(scheduled, Math.floor(elapsed / interval));
      const reason = slot < newerSlotDue || elapsed >= durationMs ? 'scheduler_lag' : pending.size >= options.concurrency ? 'concurrency_limit' : null;
      if (reason) {
        dropped++;
        await emit({ type: 'skipped', monotonicMs: originMonotonicMs + elapsed, timestamp: new Date().toISOString(), elapsedMs: round(elapsed), slot, scheduledMs: round(due), reason });
      } else {
        const requestSlot = slot;
        const timestamp = new Date().toISOString();
        requests++;
        const promise = requestOnce(options.url, options.timeoutMs, agent).then(async result => {
          latencies.push(result.latencyMs);
          if (result.success) { successes++; successfulLatencies.push(result.latencyMs); }
          if (result.instance) instances[result.instance] = (instances[result.instance] ?? 0) + 1;
          await emit({ type: 'request', monotonicMs: originMonotonicMs + elapsed, timestamp, elapsedMs: round(elapsed), completedElapsedMs: round(performance.now() - started), slot: requestSlot, scheduledMs: round(due), ...result });
        }).catch(error => { writeFailure = error; }).finally(() => pending.delete(promise));
        pending.add(promise);
      }
      slot++;
    }
    // Keep the observation window intact, including the final partial interval.
    await sleep(Math.max(0, durationMs - (performance.now() - started)));
    await Promise.all(pending);
    if (writeFailure) throw writeFailure;
    const wallDurationMs = round(performance.now() - started);
    const summary = {
      type: 'summary', timestamp: new Date().toISOString(), label: options.label,
      scheduled, requests, successes, failures: requests - successes, dropped,
      successRate: requests ? successes / requests : null,
      achievedRequestsPerSecond: round(requests / options.duration),
      wallDurationMs, instances,
      latencyAllMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
      latencySuccessMs: { p50: percentile(successfulLatencies, 0.5), p95: percentile(successfulLatencies, 0.95) },
      definitions: { achievedRequestsPerSecond: 'requests launched / configured durationSeconds; wallDurationMs includes draining outstanding requests', latency: 'GET launch to complete body or terminal error; all includes HTTP errors and timeouts; success includes only complete 2xx responses; nearest-rank percentiles', dropped: 'schedule slots skipped for concurrency or scheduler lag; excluded from request and success counts', upstreamAddr: 'raw X-Upstream-Addr response header, or null when absent', upstreamStatus: 'raw X-Upstream-Status response header; preserves multiple Nginx attempts even when final response succeeds; null when absent' },
    };
    await emit(summary);
    return summary;
  } finally {
    await Promise.all(pending);
    agent.destroy();
  }
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--help') { console.log(usage); return; }
  const options = parseArgs(args);
  const { file } = await openOutput(options.out);
  let writes = Promise.resolve();
  try {
    const summary = await runTraffic(options, record => {
      // Serialize whole-record writes; writeFile also handles short underlying writes.
      writes = writes.then(() => file.writeFile(`${JSON.stringify(record)}\n`));
      return writes;
    });
    console.log(JSON.stringify({ output: options.out, ...summary }, null, 2));
  } finally {
    await writes.catch(() => {});
    await file.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`traffic: ${error.message}`); process.exitCode = 1; });
}
