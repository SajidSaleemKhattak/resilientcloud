import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { docker, inspectBackend, projects } from './docker.mjs';

export function parseFaultArgs(args) {
  const [mode, service, ...rest] = args;
  let project = 'resilientcloud';
  if (rest.length === 2 && rest[0] === '--project') project = rest[1];
  else if (rest.length) throw new Error('Unexpected fault arguments');
  if (!['crash', 'unhealthy'].includes(mode) || !['backend-a', 'backend-b'].includes(service)
    || !projects.includes(project)) throw new Error('Usage: npm run fault -- crash|unhealthy backend-a|backend-b [--project resilientcloud]');
  return { mode, service, project };
}

export function injectFault({ mode, service, project }) {
  // Validate all arguments even when called programmatically.
  parseFaultArgs([mode, service, '--project', project]);
  const target = inspectBackend(project, service);
  if (!target.State.Running) throw new Error('Target backend is already stopped');
  if (mode === 'unhealthy' && !target.Config.Env.includes('FAULT_INJECTION_ENABLED=true')) {
    throw new Error('Fault injection is not enabled on this backend');
  }
  const started = performance.now();
  const event = { type: 'fault', timestamp: new Date().toISOString(), project, service,
    containerId: target.Id, mode, signal: mode === 'crash' ? 'SIGKILL' : 'SIGUSR2' };
  // Signal the exact inspected ID, never a caller-supplied name or shell expression.
  docker(['kill', '--signal', event.signal, target.Id]);
  return { ...event, completedAt: new Date().toISOString(), durationMs: performance.now() - started };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(injectFault(parseFaultArgs(process.argv.slice(2))))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
