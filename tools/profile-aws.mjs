// Local-only sizing/HTTPS smoke; does not call AWS or repeat the fault matrix.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { docker, dockerEnvironment, root } from './docker.mjs';

const out = 'results/aws-preparation/profile';
assert.ok(!existsSync(path.join(root, out)), 'Profile evidence must be new');
mkdirSync(path.join(root, out), { recursive: true });
const cache = path.join(root, '.cache/aws-check');
mkdirSync(cache, { recursive: true });
const project = 'resilientcloud-aws-check';
const files = ['compose.yaml', 'compose.two.yaml', 'compose.recovery.yaml', 'compose.dashboard.yaml', 'deploy/aws/compose.aws.yaml'];
const image = 'caddy:2.11.7-alpine@sha256:e70b164da81ef698b3ad19af799ea6086ce6d9e48ed4079eb9fe26f6fbf14ee5';
const env = { ...dockerEnvironment(), DEMO_DOMAIN: 'localhost', ACME_EMAIL: 'test@example.invalid' };
const override = path.join(cache, 'compose.yaml');
writeFileSync(path.join(cache, 'Caddyfile'), '{\n admin off\n persist_config off\n servers {\n protocols h1 h2\n }\n}\nhttps://localhost {\n tls internal\n reverse_proxy gateway:8080\n}\n');
writeFileSync(override, `services:\n  gateway:\n    ports: !override ["127.0.0.1:18087:8080"]\n  https:\n    ports: !override ["127.0.0.1:18443:443", "127.0.0.1:18088:80"]\n    volumes:\n      - ${JSON.stringify(path.join(cache, 'Caddyfile') + ':/etc/caddy/Caddyfile:ro')}\n`);
const compose = args => docker(['compose', '--project-directory', root, '-p', project,
  ...[...files.map(p => path.join(root, p)), override].flatMap(p => ['-f', p]), ...args], { env, timeout: 300000 });
const save = (name, value) => writeFileSync(path.join(root, out, name), `${JSON.stringify(value, null, 2)}\n`);
const report = { startedAt: new Date().toISOString(), status: 'running', scope: 'Local Docker Desktop ARM64; sampled container usage, not EC2/OS measurements', phases: {}, checks: [] };
let created = false, exported = false;
function bytes(value) {
  const [, amount, unit] = value.trim().match(/^([\d.]+)\s*(B|KiB|MiB|GiB|kB|MB|GB)$/) ?? [];
  assert.ok(amount, `Unknown memory unit: ${value}`);
  return Number(amount) * ({ B:1, KiB:1024, MiB:1024**2, GiB:1024**3, kB:1000, MB:1000**2, GB:1000**3 }[unit]);
}
function journalBytes() {
  const size = (service, file) => Number(compose(['exec', '-T', service, 'node', '-e', `console.log(require('node:fs').statSync(${JSON.stringify(file)}).size)`]).trim());
  return { controller: size('controller', '/data/controller.events.jsonl'), gate: size('gate', '/audit/gate.events.jsonl') };
}
async function phase(name, seconds) {
  const samples = [], start = performance.now();
  while (performance.now() - start < seconds * 1000) {
    const ids = compose(['ps', '-q']).trim().split(/\s+/);
    const rows = docker(['stats', '--no-stream', '--format', '{{json .}}', ...ids]).trim().split('\n').map(JSON.parse);
    samples.push({ timestamp: new Date().toISOString(), elapsedMs: performance.now() - start,
      containers: rows.map(r => ({ name: r.Name, cpuPercent: Number(r.CPUPerc.replace('%', '')), memoryBytes: bytes(r.MemUsage.split('/')[0]) })) });
    await sleep(1000);
  }
  report.phases[name] = { durationMs: performance.now() - start, samples,
    totalMemoryMiB: samples.map(s => s.containers.reduce((n,c) => n+c.memoryBytes/1024**2,0)),
    totalCpuPercent: samples.map(s => s.containers.reduce((n,c) => n+c.cpuPercent,0)) };
}
try {
  for (const args of [['ps','-aq'],['volume','ls','-q'],['network','ls','-q']]) {
    assert.equal(docker([...args,'--filter',`label=com.docker.compose.project=${project}`]).trim(), '', 'Refusing pre-existing profile resources');
  }
  docker(['tag', 'resilientcloud-backend:m1', 'resilientcloud-backend:aws']);
  docker(['tag', 'resilientcloud-recovery:m2', 'resilientcloud-recovery:aws']);
  docker(['pull', image]);
  report.runtime = { hostNode: process.version, docker: docker(['info','--format','{{.ServerVersion}} {{.Architecture}}']).trim() };
  report.images = JSON.parse(docker(['image','inspect','resilientcloud-backend:aws','resilientcloud-recovery:aws',image]));
  // Retain only image sizing/identity metadata, not unrelated Docker state.
  report.images = report.images.map(i => ({ id:i.Id, architecture:i.Architecture, size:i.Size }));
  created = true;
  compose(['up','-d','--no-build','--wait','--wait-timeout','60']);
  const before = journalBytes(), started = performance.now();
  const httpsId = compose(['ps','-q','https']).trim();
  assert.match(httpsId,/^[a-f0-9]{64}$/);
  const ca = path.join(root,out,'test-public-root.crt');
  docker(['cp',`${httpsId}:/data/caddy/pki/authorities/local/root.crt`,ca]);
  for (const endpoint of ['/','/status','/events','/experiments/summary.json','/api']) {
    const code = (await import('node:child_process')).execFileSync('curl',['--silent','--show-error','--cacert',ca,'--output','/dev/null','--write-out','%{http_code}',`https://localhost:18443${endpoint}`],{encoding:'utf8'});
    assert.equal(code,'200',endpoint);
  }
  for (const endpoint of ['/fault','/restart','/v1/backends/backend-a/restart']) {
    const code = (await import('node:child_process')).execFileSync('curl',['--silent','--show-error','--cacert',ca,'--request','POST','--output','/dev/null','--write-out','%{http_code}',`https://localhost:18443${endpoint}`],{encoding:'utf8'});
    assert.equal(code,'404',endpoint);
  }
  report.checks.push('Local HTTPS with explicitly trusted test CA; dashboard/status/events/results/API load; mutation paths denied');
  await phase('idle',30);
  const child = spawn(process.execPath,['tools/traffic.mjs','--url','https://localhost:18443/api','--duration','35','--rate','10','--concurrency','8','--timeout-ms','2500','--label','aws-sizing-https','--out',`${out}/traffic.jsonl`],
    {cwd:root,env:{...process.env,NODE_EXTRA_CA_CERTS:ca},stdio:['ignore','ignore','inherit']});
  const completed = new Promise((resolve,reject) => { child.once('error',reject); child.once('exit',code=>code===0?resolve():reject(new Error(`Traffic exited ${code}`))); });
  await phase('load',30); await completed;
  report.traffic = readFileSync(path.join(root,out,'traffic.jsonl'),'utf8').trim().split('\n').map(JSON.parse).at(-1);
  assert.equal(report.traffic.failures,0);assert.equal(report.traffic.dropped,0);
  const after = journalBytes(), elapsed = (performance.now()-started)/1000;
  report.journalGrowth = { before,after,seconds:elapsed,bytesPerSecond:(after.controller+after.gate-before.controller-before.gate)/elapsed };
  report.checks.push('Actual HTTPS workload: 10 requests/second, zero client retries, no failures or skipped slots');
  report.status='passed';
} catch (error) { report.status='failed';report.error=error.stack;process.exitCode=1; }
finally {
  if(created) {
    try {
      writeFileSync(path.join(root,out,'compose.log'),compose(['logs','--no-color','--timestamps']));
      for(const [service,file,destination] of [['controller','/data/controller.events.jsonl','controller.events.jsonl'],['controller','/data/status.json','status.json'],['gate','/audit/gate.events.jsonl','gate.events.jsonl']]) {
        const id=compose(['ps','-aq',service]).trim();assert.match(id,/^[a-f0-9]{64}$/);
        docker(['cp',`${id}:${file}`,path.join(root,out,destination)]);
      }
      exported=true;
    } catch(error) {report.exportError=error.stack;report.status='failed';process.exitCode=1;}
    if(exported)compose(['down','--volumes']); // Only this fresh local check project.
  }
  report.finishedAt=new Date().toISOString();save('report.json',report);
  console.log(JSON.stringify({status:report.status,error:report.error,phases:Object.fromEntries(Object.entries(report.phases).map(([k,p])=>[k,{samples:p.samples.length,maxMemoryMiB:Math.max(...p.totalMemoryMiB),maxCpuPercent:Math.max(...p.totalCpuPercent)}])),journalGrowth:report.journalGrowth},null,2));
}
