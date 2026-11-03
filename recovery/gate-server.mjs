import { chmod, chown, lstat, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createAudit, createDockerClient, createGate, createGateServer } from './gate-core.mjs';

const socket = '/run/gate/gate.sock';
await mkdir('/run/gate', { recursive: true });
await chmod('/run/gate', 0o755);
try {
  const info = await lstat(socket);
  if (!info.isSocket()) throw new Error('Refusing to replace a non-socket gate path');
  await unlink(socket);
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const dataDirectory = process.env.DATA_DIR ?? '/audit';
if (!path.isAbsolute(dataDirectory)) throw new Error('DATA_DIR must be absolute');
const audit = await createAudit(path.join(dataDirectory, 'gate.events.jsonl'));
const gate = createGate({ docker: createDockerClient(), audit, project: process.env.PROJECT_NAME,
  directory: process.env.PROJECT_DIRECTORY, network: process.env.APP_NETWORK });
const server = createGateServer(gate);
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
await chmod(socket, 0o660);
await chown(socket, 1000, 1000);
await audit({ event: 'gate_started', project: process.env.PROJECT_NAME });
const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
