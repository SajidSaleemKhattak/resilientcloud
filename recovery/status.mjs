import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function createStatusServer({ dataDir = '/data', staleMs = 5000, now = Date.now } = {}) {
  return http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    if (request.url !== '/status') {
      response.writeHead(404).end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET' }).end(JSON.stringify({ error: 'read_only' }));
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
