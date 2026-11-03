import { createBackend } from './app.js';

const instance = process.env.INSTANCE_ID ?? 'backend-local';
const portText = process.env.PORT ?? '3000';
if (!/^\d+$/.test(portText) || Number(portText) > 65535) {
  throw new Error('PORT must be an integer between 0 and 65535.');
}
const port = Number(portText);
const faultsEnabled = process.env.FAULT_INJECTION_ENABLED === 'true';
const backend = createBackend({ instance });
// Local Compose test fixture for failures that a restart cannot fix.
if (faultsEnabled && process.env.START_UNHEALTHY === 'true') backend.markUnhealthy();

function log(event: string, details: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), event, instance, ...details }));
}

// Signals are available to the local Docker operator, never via an HTTP route.
process.on('SIGUSR2', () => {
  if (!faultsEnabled) {
    log('fault_ignored', { reason: 'fault_injection_disabled' });
    return;
  }
  backend.markUnhealthy();
  log('fault_injected', { fault: 'unhealthy' });
});

const server = backend.app.listen(port, '0.0.0.0', () => {
  const address = server.address();
  log('listening', { port: typeof address === 'object' && address ? address.port : port, faultsEnabled });
});

server.on('error', (error) => {
  log('server_error', { message: error.message });
  process.exitCode = 1;
});

let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  backend.markUnhealthy();
  log('shutdown', { signal });
  const deadline = setTimeout(() => {
    server.closeAllConnections();
    process.exit(1);
  }, 5000);
  deadline.unref();
  server.close((error) => {
    clearTimeout(deadline);
    process.exitCode = error ? 1 : 0;
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
