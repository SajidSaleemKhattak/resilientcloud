// Read-only configuration validation. No AWS calls, image pulls or containers.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { docker, dockerEnvironment, root } from './docker.mjs';

const files=['compose.yaml','compose.two.yaml','compose.recovery.yaml','compose.dashboard.yaml','deploy/aws/compose.aws.yaml'];
const checks=[];
for(const enabled of ['false','true']) {
  const config=JSON.parse(docker(['compose','--project-directory',root,'-p','resilientcloud-aws-check',
    ...files.flatMap(f=>['-f',path.join(root,f)]),'config','--format','json'],
    {env:{...dockerEnvironment(),DEMO_DOMAIN:'demo.example.com',ACME_EMAIL:'operator@example.com',RC_ENABLE_FAULTS:enabled}}));
  assert.equal(Object.keys(config.services).length,7);
  assert.equal(config.networks.app.internal,true);assert.equal(config.networks['status-read'].internal,true);assert.equal(config.networks.web.internal,true);
  for(const [name,service]of Object.entries(config.services)) {
    assert.equal(service.restart,'no');assert.equal(service.pull_policy,'never');assert.equal(service.build,undefined);
    if(!['gateway','https'].includes(name))assert.equal(service.ports,undefined);
    if(name!=='gate')assert.ok(!(service.volumes??[]).some(v=>v.target.includes('docker.sock')));
  }
  assert.equal(config.services.gate.network_mode,'none');
  assert.deepEqual(Object.keys(config.services.status.networks),['status-read']);
  assert.ok(config.services.status.volumes.every(v=>v.read_only));
  assert.ok(!config.services.status.volumes.some(v=>v.target.includes('gate')));
  assert.deepEqual(Object.keys(config.services.gateway.networks).sort(),['app','edge','status-read','web']);
  assert.equal(config.services.gateway.ports.length,1);assert.equal(config.services.gateway.ports[0].host_ip,'127.0.0.1');
  assert.deepEqual(config.services.https.ports.map(p=>p.published).sort(),['443','80']);
  assert.ok(!config.services.https.volumes.some(v=>v.target.includes('docker')||v.target.includes('gate')));
  assert.equal(config.services.controller.environment.RECOVERY_ENABLED,'true');
  assert.equal(config.services.controller.environment.FAILURE_THRESHOLD,'3');assert.equal(config.services.controller.environment.PROBE_TIMEOUT_MS,'300');
  for(const backend of ['backend-a','backend-b'])assert.equal(config.services[backend].environment.FAULT_INJECTION_ENABLED,enabled);
  checks.push({faultInjectionEnabled:enabled,passed:true});
}
const report={checkedAt:new Date().toISOString(),status:'passed',checks,
  scope:'Merged AWS configuration only, no authenticated AWS account inspection or provisioning',
  verified:['seven services','only HTTPS ingress public; gateway loopback','internal backend/status networks','private socket gate',
    'no automatic restart policies','no on-instance builds/pulls','unchanged detection settings','admin-selected signal handler']};
writeFileSync(path.join(root,'results/aws-preparation/configuration-checks.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
