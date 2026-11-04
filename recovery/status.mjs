import http from 'node:http';
import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const INCIDENT_TYPES = new Set(['controller_started', 'container_revalidated', 'state_changed',
  'failure_confirmed', 'restart_requested', 'restart_accepted', 'restart_error',
  'recovery_verified', 'recovery_unverified', 'incident_cleared', 'exhausted']);

// Read a fixed-size tail, never an unbounded journal. In-progress final writes
// and the first partial line of a truncated tail are omitted until complete.
export async function readRecentEvents(dataDir, { limit = 100, maxBytes = 512 * 1024 } = {}) {
  const file = await open(path.join(dataDir, 'controller.events.jsonl'), 'r');
  try {
    const { size } = await file.stat();
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(Math.min(size, maxBytes));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    text = text.slice(0, text.lastIndexOf('\n') + 1);
    const records = text.split('\n').filter(Boolean).map(line => JSON.parse(line));
    const incidents = records.filter(event => INCIDENT_TYPES.has(event.type));
    if (incidents.some(event => !Number.isFinite(Date.parse(event.timestamp)) || typeof event.runId !== 'string')) {
      throw new Error('invalid_events');
    }
    return { available: true, events: incidents.slice(-limit).reverse(),
      truncated: start > 0 || incidents.length > limit, limit, order: 'newest_first' };
  } finally { await file.close(); }
}

export function createStatusServer({ dataDir = '/data', staleMs = 5000, now = Date.now } = {}) {
  return http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    if (!['/status', '/events'].includes(request.url)) {
      response.writeHead(404).end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET' }).end(JSON.stringify({ error: 'read_only' }));
      return;
    }
    if (request.url === '/events') {
      try {
        const history = await readRecentEvents(dataDir);
        response.writeHead(200).end(JSON.stringify(history));
      } catch {
        response.writeHead(503).end(JSON.stringify({ available: false, events: [], error: 'events_unavailable' }));
      }
      return;
    }
    try {
      const text = await readFile(path.join(dataDir, 'status.json'), 'utf8');
      if (text.length > 256 * 1024) throw new Error('oversize');
      const snapshot = JSON.parse(text);
      if (!snapshot.backends || !Number.isFinite(Date.parse(snapshot.updatedAt))) throw new Error('invalid');
      const ageMs = Math.max(0, now() - Date.parse(snapshot.updatedAt));
      const backends = Object.fromEntries(Object.entries(snapshot.backends).map(([service, backend]) => {
        const observedAt = Date.parse(backend.lastProbe?.timestamp);
        const observationAgeMs = Number.isFinite(observedAt) ? Math.max(0, now() - observedAt) : null;
        return [service, { ...backend, observationAgeMs, stale: observationAgeMs === null || observationAgeMs > staleMs }];
      }));
      response.writeHead(200).end(JSON.stringify({ ...snapshot, backends, available: true, stale: ageMs > staleMs, ageMs }));
    } catch {
      response.writeHead(503).end(JSON.stringify({ available: false, stale: true, error: 'status_unavailable' }));
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createStatusServer({ dataDir: process.env.DATA_DIR ?? '/data' });
  server.listen(4000, '0.0.0.0');
  process.on('SIGTERM', () => server.close());
}
