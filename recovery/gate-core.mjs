import http from 'node:http';
import { isIP } from 'node:net';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const services = new Set(['backend-a', 'backend-b']);
const idPattern = /^[a-f0-9]{64}$/;
const api = '/v1.53';

export class GateError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

/** Fixed local socket, fixed API version, absolute deadline, bounded response size. */
export function createDockerClient({ socketPath = '/var/run/docker.sock', timeoutMs = 4000, maxBytes = 1048576 } = {}) {
  return function request(method, route) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve(value);
      };
      const req = http.request({ socketPath, method, path: `${api}${route}`, headers: { accept: 'application/json' } }, res => {
        let bytes = 0;
        const chunks = [];
        res.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > maxBytes) { finish(new GateError(503, 'docker_response_too_large')); req.destroy(); return; }
          chunks.push(chunk);
        });
        res.on('aborted', () => finish(new GateError(503, 'docker_response_aborted')));
        res.on('error', () => finish(new GateError(503, 'docker_unavailable')));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return finish(new GateError(503, 'docker_operation_failed'));
          const body = Buffer.concat(chunks).toString('utf8');
          try { finish(null, body ? JSON.parse(body) : null); }
          catch { finish(new GateError(503, 'docker_invalid_response')); }
        });
      });
      timer = setTimeout(() => { finish(new GateError(503, 'docker_timeout')); req.destroy(); }, timeoutMs);
      req.on('error', () => finish(new GateError(503, 'docker_unavailable')));
      req.end();
    });
  };
}

export function validateContainer(container, { project, directory, network }, service, expectedId) {
  const labels = container?.Config?.Labels ?? {};
  const identity = (container?.Config?.Env ?? []).filter(value => value.startsWith('INSTANCE_ID='));
  const member = container?.NetworkSettings?.Networks?.[network];
  if (!services.has(service) || !idPattern.test(expectedId) || container?.Id !== expectedId
    || labels['com.docker.compose.project'] !== project
    || labels['com.docker.compose.service'] !== service
    || labels['com.docker.compose.project.working_dir'] !== directory
    || labels['io.resilientcloud.role'] !== 'backend'
    || identity.length !== 1 || identity[0] !== `INSTANCE_ID=${service}`
    || !member || typeof container?.State?.Running !== 'boolean'
    || typeof container?.State?.StartedAt !== 'string'
    || (container.State.Running && isIP(member.IPAddress) !== 4)) {
    throw new GateError(403, 'backend_validation_failed');
  }
  return { service, id: expectedId, running: container.State.Running, startedAt: container.State.StartedAt,
    health: container.State.Health?.Status ?? 'unknown', ip: member.IPAddress || null };
}

/** Append-only audit file; all callers await persistence before mutation. */
export async function createAudit(filename, { consoleOutput = true } = {}) {
  await mkdir(path.dirname(filename), { recursive: true });
  let sequence = Promise.resolve();
  const started = performance.now();
  return details => {
    const record = { timestamp: new Date().toISOString(), elapsedMs: performance.now() - started, ...details };
    sequence = sequence.then(() => appendFile(filename, `${JSON.stringify(record)}\n`, { mode: 0o600 }));
    return sequence.then(() => { if (consoleOutput) console.log(JSON.stringify(record)); });
  };
}

export function createGate({ docker, audit, project, directory, network }) {
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project ?? '') || !path.isAbsolute(directory ?? '')
    || network !== `${project}_app`) throw new Error('Invalid gate target configuration');
  const config = { project, directory, network };
  const busy = new Set();

  async function discover(service) {
    if (!services.has(service)) throw new GateError(403, 'unauthorized_service');
    const filters = encodeURIComponent(JSON.stringify({ label: [
      `com.docker.compose.project=${project}`, `com.docker.compose.service=${service}`,
    ] }));
    const candidates = await docker('GET', `/containers/json?all=true&filters=${filters}`);
    if (!Array.isArray(candidates) || candidates.length !== 1 || !idPattern.test(candidates[0]?.Id ?? '')) {
      throw new GateError(409, 'backend_missing_or_ambiguous');
    }
    const id = candidates[0].Id;
    return validateContainer(await docker('GET', `/containers/${id}/json`), config, service, id);
  }

  async function execute({ service, operation, id }) {
    if (!services.has(service) || !['inspect', 'restart'].includes(operation)) throw new GateError(403, 'unauthorized_operation');
    if (operation === 'restart' && !idPattern.test(id ?? '')) throw new GateError(400, 'invalid_container_id');
    if (busy.has(service)) throw new GateError(409, 'backend_busy');
    busy.add(service);
    try {
      const current = await discover(service);
      if (operation === 'inspect') {
        await audit({ event: 'inspection_allowed', service, id: current.id });
        return current;
      }
      if (current.id !== id) throw new GateError(409, 'stale_container_id');
      // A successful response means Docker accepted/completed restart, not readiness.
      await audit({ event: 'restart_requested', service, id });
      await docker('POST', `/containers/${id}/restart?t=1`);
      await audit({ event: 'restart_accepted', service, id });
      return { service, id, accepted: true };
    } finally { busy.delete(service); }
  }

  return { execute, audit };
}

async function readRestartBody(req) {
  if (req.headers['content-type'] !== 'application/json') throw new GateError(400, 'json_required');
  const length = Number(req.headers['content-length']);
  if (req.headers['transfer-encoding'] || !Number.isInteger(length) || length < 1 || length > 128) {
    throw new GateError(400, 'invalid_body_length');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 128) throw new GateError(400, 'body_too_large');
    chunks.push(chunk);
  }
  if (bytes !== length) throw new GateError(400, 'invalid_body_length');
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new GateError(400, 'invalid_json'); }
  if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).length !== 1
    || !Object.hasOwn(body, 'id') || !idPattern.test(body.id)) throw new GateError(400, 'invalid_restart_body');
  return body;
}

/** Handler intentionally implements a tiny application API, never a generic proxy. */
export function createGateServer(gate) {
  const server = http.createServer(async (req, res) => {
    let service;
    let operation;
    try {
      const match = /^\/v1\/backends\/(backend-a|backend-b)(\/restart)?$/.exec(req.url ?? '');
      if (!match || (match[2] ? req.method !== 'POST' : req.method !== 'GET')) {
        throw new GateError(403, 'unauthorized_route');
      }
      service = match[1];
      operation = match[2] ? 'restart' : 'inspect';
      let id;
      if (operation === 'restart') ({ id } = await readRestartBody(req));
      else if (req.headers['transfer-encoding'] || (req.headers['content-length'] && req.headers['content-length'] !== '0')) {
        throw new GateError(400, 'inspection_body_forbidden');
      }
      const result = await gate.execute({ service, operation, id });
      res.writeHead(operation === 'restart' ? 202 : 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(result));
    } catch (error) {
      const failure = error instanceof GateError ? error : new GateError(503, 'gate_unavailable');
      try { await gate.audit({ event: 'request_rejected', service: service ?? null, operation: operation ?? null, reason: failure.code }); }
      catch { /* Audit failure itself prevents any successful authorization response. */ }
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(failure.status, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' });
        res.end(JSON.stringify({ error: failure.code }));
      }
    }
  });
  server.requestTimeout = 3000;
  server.headersTimeout = 3000;
  // A restart has at most three bounded Docker calls (list, inspect, restart).
  // Keep the response socket alive for their combined 12-second deadline.
  server.setTimeout(15000, socket => socket.destroy());
  server.maxHeadersCount = 20;
  return server;
}
