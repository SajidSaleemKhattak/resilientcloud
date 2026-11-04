// Parse all experiment configurations without creating any Docker resources.
import assert from 'node:assert/strict';
import path from 'node:path';
import { composeArgs, docker, dockerEnvironment, root } from './docker.mjs';

let sharedDetection;
for (const configuration of ['A', 'B', 'C']) {
  const project = `resilientcloud-m3-${configuration.toLowerCase()}`;
  const args = [...composeArgs(project, configuration === 'A' ? 'one' : 'two', []),
    '-f', path.join(root, 'compose.recovery.yaml'),
    '-f', path.join(root, 'compose.experiment.yaml'),
    ...(configuration === 'A' ? [] : ['-f', path.join(root, 'compose.experiment-two.yaml')]),
    'config', '--format', 'json'];
  const config = JSON.parse(docker(args, { env: { ...dockerEnvironment(),
    GATEWAY_PORT: '18085', RECOVERY_ENABLED: configuration === 'C' ? 'true' : 'false',
    MONITORED_SERVICES: configuration === 'A' ? 'backend-a' : 'backend-a,backend-b' } }));
  const { services } = config;
  assert.equal(Boolean(services['backend-b']), configuration !== 'A');
  assert.equal(services.controller.environment.RECOVERY_ENABLED, configuration === 'C' ? 'true' : 'false');
  assert.equal(services.controller.environment.MONITORED_SERVICES, configuration === 'A' ? 'backend-a' : 'backend-a,backend-b');
  const { RECOVERY_ENABLED, MONITORED_SERVICES, ...detection } = services.controller.environment;
  if (sharedDetection) assert.deepEqual(detection, sharedDetection, 'Detection settings must match across A/B/C');
  sharedDetection = detection;
  for (const [name, service] of Object.entries(services)) {
    assert.equal(service.restart, 'no', `${name}: restart policy must remain disabled`);
    if (name !== 'gate') assert.ok(!(service.volumes ?? []).some(volume => volume.target === '/var/run/docker.sock'));
  }
  assert.equal(services.gate.network_mode, 'none');
  assert.ok((services.status.volumes ?? []).every(volume => volume.read_only));
  assert.equal(services.gateway.ports.length, 1);
  assert.equal(services.gateway.ports[0].host_ip, '127.0.0.1');
  console.log(`Configuration ${configuration}: Compose syntax, backend count, shared detection policy and isolation passed`);
}
