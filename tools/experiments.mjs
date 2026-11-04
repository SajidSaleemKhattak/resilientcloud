import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { composeArgs, docker, dockerEnvironment, inspectBackend, root } from './docker.mjs';
import { injectFault } from './fault.mjs';
import { openOutput } from './traffic.mjs';
import { readJsonl, summarizeTrial, generateSummary } from './experiments-summary.mjs';

const args=process.argv.slice(2);
const smoke=args.includes('--smoke');
const cleanArgs=args.filter(a=>a!=='--smoke');
if (cleanArgs.length!==2||cleanArgs[0]!=='--out') throw new Error('Usage: node tools/experiments.mjs --out results/new-directory [--smoke]');
const out=cleanArgs[1];
if (existsSync(path.resolve(root,out))) throw new Error('Experiment output must be a new directory');
const {file:journal}=await openOutput(`${out}/events.jsonl`);
const directory=path.resolve(root,out);
const mono=()=>Number(process.hrtime.bigint())/1e6;
const protocol={baselineSeconds:smoke?1:15,observationSeconds:smoke?3:60,guardSeconds:1,
  rate:10,concurrency:8,timeoutMs:2500,repetitions:smoke?1:3,
  controller:{intervalMs:500,probeTimeoutMs:300,failureThreshold:3,maxAttempts:2,verifyTimeoutMs:4000,verifySuccesses:2,cooldownMs:2000}};
const manifest={schemaVersion:1,startedAt:new Date().toISOString(),status:'running',
  purpose:smoke?'Short runner smoke validation; not the repeated experiment matrix':'Repeated local A/B/C experiments; three independent repetitions per group',
  protocol,trials:[],failedAttempts:[],definitions:{
    windows:'Traffic runs baseline+observation+2 guard seconds. Fault command is scheduled after the leading guard and baseline; actual command start anchors exactly15s baseline+60s observation (smoke uses1s+3s). Controls use the same scheduled anchor. Guard requests remain in raw evidence and are counted separately.',
    wholeSuccessRate:'Complete2xx requests / all actually launched requests within [anchor-baseline,anchor+observation). Whole includes baseline and postfault traffic.',
    postFaultSuccessRate:'Complete2xx requests / all actually launched requests within [actual fault command start,command start+observation). Inflight pre-fault launches are excluded; command duration is recorded. Controls have null postFault and separate observation metrics.',
    skipped:'Scheduled slots skipped by generator for scheduler lag or concurrency limit. Excluded from request success denominators and explicitly counted by scheduled time; skipped slots in the analysis window invalidate that trial. Guard drops remain visible.',
    latency:'Request launch to full body or terminal error; nearest-rank p50/p95. latencyMs includes HTTP failures/timeouts; successfulLatencyMs includes only complete2xx.',
    detectionMs:'First failure_confirmed event after fault command start, on calibrated controller Linux monotonic clock, minus host fault-command start. Requires3 consecutive failed probes.',
    recoveryMs:'First recovery_verified event after fault command start minus that start, using calibrated monotonic clocks. Requires2 readiness successes with stable revalidated container identity; never Docker restart acceptance alone. Null means not observed within the60s window (or not applicable for controls).',
    firstSiblingSuccessMs:'Earliest completed successful response from backend-b among requests launched after fault start and completed inside the observation window. Measures survivor availability after injection, not onset of continuous availability or restoration of backend-a.',
    firstTargetSuccessAfterVerificationMs:'Earliest completed successful response from backend-a among requests launched after recovery verification and completed inside the observation window, measured from fault start.',
    longestFailureIntervalMs:'Time from first failed request launch in each consecutive failure sequence to next successful request launch, censored at window end; maximum across sequences. Sampling metric, not proof of continuous outage.',
    clock:'3 timed Dockerexec samples before/after each trial; select minimumroundtrip midpoint mapping hosthrtime to VMhrtime. Halfroundtrip is mapping uncertainty; reject drift above summed uncertainties+100ms.',
    trialValidity:'Fresh resources; healthy initial readiness and both instances reached before two-backend trials; intended fault verified; no skipped slots in measured window; valid clock mapping. HTTP errors, absent detection/recovery, sibling failures and unexpected controller actions are measured outcomes, never grounds to discard a trial. Separate functionalChecks report expected behavior.',
    summaryGeneration:'Derived JSON/CSV are deterministic for a fixed manifest and raw journals. generatedAt uses the final manifest timestamp (latest completed trial while a matrix is running); evidenceHashes identify the raw inputs.',
  }};
const persist=()=>writeFileSync(path.join(directory,'manifest.json'),`${JSON.stringify(manifest,null,2)}\n`);
const event=async(type,details={})=>journal.writeFile(`${JSON.stringify({type,timestamp:new Date().toISOString(),monotonicMs:mono(),...details})}\n`);
function command(configuration,args) {
  const project=`resilientcloud-m3-${configuration.toLowerCase()}`;
  const files=composeArgs(project,configuration==='A'?'one':'two',[]);
  return docker([...files,'-f',path.join(root,'compose.recovery.yaml'),'-f',path.join(root,'compose.experiment.yaml'),
    ...(configuration==='A'?[]:['-f',path.join(root,'compose.experiment-two.yaml')]),...args],{timeout:600_000});
}
function setEnvironment(configuration) {
  Object.assign(dockerEnvironment(),{GATEWAY_PORT:'18085',RECOVERY_ENABLED:String(configuration==='C'),
    MONITORED_SERVICES:configuration==='A'?'backend-a':'backend-a,backend-b'});
}
function fresh(project) {
  assert.equal(docker(['ps','-aq','--filter',`label=com.docker.compose.project=${project}`]).trim(),'','Refusing preexisting project containers');
  assert.equal(docker(['volume','ls','-q','--filter',`label=com.docker.compose.project=${project}`]).trim(),'','Refusing preexisting project volumes');
  assert.equal(docker(['network','ls','-q','--filter',`label=com.docker.compose.project=${project}`]).trim(),'','Refusing preexisting project networks');
}
function state(project,service) {
  const c=inspectBackend(project,service);
  return {id:c.Id,running:c.State.Running,status:c.State.Status,exitCode:c.State.ExitCode,health:c.State.Health?.Status,
    startedAt:c.State.StartedAt,restartCount:c.RestartCount,restartPolicy:c.HostConfig.RestartPolicy.Name,image:c.Image,
    ip:c.NetworkSettings.Networks[`${project}_app`]?.IPAddress};
}
async function getStatus() {
  const response=await fetch('http://127.0.0.1:18085/status',{signal:AbortSignal.timeout(2000)});
  assert.ok(response.ok,`Status HTTP${response.status}`);return response.json();
}
async function untilHealthy(configuration) {
  const start=mono();
  while(mono()-start<30_000) {
    try { const s=await getStatus();const services=configuration==='A'?['backend-a']:['backend-a','backend-b'];
      if(!s.stale && services.every(service=>s.backends[service]?.state==='healthy'&&s.backends[service]?.lastProbe?.ok)&&Object.keys(s.backends).length===services.length) return s;
    } catch {}
    await sleep(100);
  }
  throw new Error('Healthy readiness baseline timed out');
}
function clockSample(configuration) {
  const samples=[];
  for(let i=0;i<3;i++) {
    const before=mono();
    const remote=JSON.parse(command(configuration,['exec','-T','controller','node','-e','console.log(JSON.stringify({utc:Date.now(),monotonic:Number(process.hrtime.bigint())/1e6}))']));
    const after=mono();samples.push({hostBefore:before,hostAfter:after,containerNow:remote.monotonic,containerUtc:remote.utc,
      offsetMs:remote.monotonic-(before+after)/2,uncertaintyMs:(after-before)/2});
  }
  return {...[...samples].sort((a,b)=>a.uncertaintyMs-b.uncertaintyMs)[0],samples};
}
function workload(trialDirectory,id) {
  const options={url:'http://127.0.0.1:18085/api',duration:protocol.baselineSeconds+protocol.observationSeconds+2*protocol.guardSeconds,
    rate:protocol.rate,concurrency:protocol.concurrency,timeoutMs:protocol.timeoutMs,label:id,out:`${trialDirectory}/traffic.jsonl`};
  const child=spawn(process.execPath,['tools/experiments-worker.mjs',JSON.stringify(options)],{cwd:root,stdio:['ignore','ignore','pipe','ipc']});
  let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
  let resolveStart,rejectStart;
  const started=new Promise((resolve,reject)=>{resolveStart=resolve;rejectStart=reject;});
  child.on('message',m=>{if(m.type==='started')resolveStart(m.originMonotonicMs);});
  const done=new Promise((resolve,reject)=>{
    child.once('error',error=>{rejectStart(error);reject(error);});
    child.once('exit',code=>{if(code===0)resolve();else{const error=new Error(`Traffic exited${code}: ${stderr}`);rejectStart(error);reject(error);}});
  });
  done.catch(()=>{});return {started,done};
}
function exportEvidence(configuration,id) {
  const trialPath=path.join(directory,id);
  writeFileSync(path.join(trialPath,'compose.log'),command(configuration,['logs','--no-color','--timestamps']));
  for(const [service,source,destination] of [['controller','/data/controller.events.jsonl','controller.events.jsonl'],['controller','/data/status.json','status.json'],['gate','/audit/gate.events.jsonl','gate.events.jsonl']]) {
    const container=command(configuration,['ps','-aq',service]).trim();
    assert.match(container,/^[a-f0-9]{64}$/);
    docker(['cp',`${container}:${source}`,path.join(trialPath,destination)]);
  }
}
async function runTrial(configuration,fault,repetition,attempt) {
  const base=`${configuration}-${fault}-${repetition}`;
  const id=attempt===1?base:`${base}-attempt${attempt}`;
  const project=`resilientcloud-m3-${configuration.toLowerCase()}`;
  const trial={id,configuration,fault,repetition,attempt,evidencePath:`${out}/${id}`,startedAt:new Date().toISOString(),valid:false,completed:false};
  mkdirSync(path.join(directory,id));
  setEnvironment(configuration);fresh(project);
  let created=false,exported=false,traffic;
  try {
    const config=JSON.parse(command(configuration,['config','--format','json']));
    writeFileSync(path.join(directory,id,'compose.json'),`${JSON.stringify(config,null,2)}\n`);
    for(const [service,value] of Object.entries(config.services)) {
      assert.equal(value.restart,'no');
      if(service!=='gate')assert.ok(!(value.volumes??[]).some(v=>v.target.includes('docker.sock')));
      if(service!=='gateway')assert.equal(value.ports,undefined);
    }
    assert.equal(config.services.gate.network_mode,'none');
    assert.equal(config.services.gateway.ports[0].host_ip,'127.0.0.1');
    assert.equal(Boolean(config.services['backend-b']),configuration!=='A');
    created=true;command(configuration,['up','-d','--no-build','--wait','--wait-timeout','60']);
    const initial=await untilHealthy(configuration);
    trial.controllerConfig=initial.config;
    assert.equal(initial.recoveryEnabled,configuration==='C');
    for(const [key,value] of Object.entries(protocol.controller)) assert.equal(initial.config[key],value,`Controller${key} differs`);
    trial.before={a:state(project,'backend-a'),...(configuration==='A'?{}:{b:state(project,'backend-b')})};
    assert.equal(trial.before.a.health,'healthy');
    assert.equal(trial.before.a.restartPolicy,'no');
    if(trial.before.b)assert.equal(trial.before.b.health,'healthy');
    trial.initialStatus=initial;
    const responses=[];
    for(let i=0;i<10;i++){const r=await fetch('http://127.0.0.1:18085/api',{signal:AbortSignal.timeout(2500)});assert.equal(r.status,200);responses.push((await r.json()).instance);}
    assert.ok(responses.includes('backend-a'));if(configuration!=='A')assert.ok(responses.includes('backend-b'));
    trial.clockBefore=clockSample(configuration);
    traffic=workload(`${out}/${id}`,id);
    const origin=await traffic.started;trial.trafficOriginMonotonicMs=origin;
    const intendedAnchor=origin+(protocol.guardSeconds+protocol.baselineSeconds)*1000;
    await sleep(Math.max(0,intendedAnchor-mono()));
    if(fault!=='control') {
      const hostOffset=mono()-performance.now();
      trial.faultEvent=injectFault({mode:fault,service:'backend-a',project});
      trial.faultEvent.hostMonotonicMs=hostOffset+trial.faultEvent.monotonicMs;
      trial.anchorMonotonicMs=trial.faultEvent.hostMonotonicMs;
      await event('fault',{id,...trial.faultEvent});
      trial.immediate=state(project,'backend-a');
      if(fault==='crash'){assert.equal(trial.immediate.running,false);assert.equal(trial.immediate.exitCode,137);}
      else {
        assert.equal(trial.immediate.running,true);
        trial.unhealthyEndpoints=JSON.parse(command(configuration,['exec','-T','backend-a','node','-e',"Promise.all(['/live','/ready','/api'].map(async path=>{const r=await fetch('http://127.0.0.1:3000'+path);return {path,status:r.status}})).then(v=>console.log(JSON.stringify(v)))"]));
        assert.deepEqual(trial.unhealthyEndpoints.map(v=>v.status),[200,503,503]);
      }
    } else {trial.anchorMonotonicMs=intendedAnchor;await event('control_anchor',{id,anchorMonotonicMs:intendedAnchor});}
    trial.windowStartMonotonicMs=trial.anchorMonotonicMs-protocol.baselineSeconds*1000;
    trial.windowEndMonotonicMs=trial.anchorMonotonicMs+protocol.observationSeconds*1000;
    assert.ok(trial.windowEndMonotonicMs<origin+(protocol.baselineSeconds+protocol.observationSeconds+2*protocol.guardSeconds)*1000,'Fault delay exceeded guard');
    await traffic.done;
    trial.clockAfter=clockSample(configuration);
    trial.after={a:state(project,'backend-a'),...(configuration==='A'?{}:{b:state(project,'backend-b')})};
    trial.finalStatus=await getStatus();
    trial.valid=true;
    exportEvidence(configuration,id);exported=true;
    const records=readJsonl(path.join(directory,id,'traffic.jsonl'));
    const events=readJsonl(path.join(directory,id,'controller.events.jsonl'));
    const derived=summarizeTrial(trial,records,events);
    assert.ok(derived.stableClock,'Clock mapping changed during trial');
    assert.equal(derived.whole.skipped,0,'Workload scheduler skipped measured slots');
    assert.ok(records.findLast(r=>r.type==='summary').requests>0);
    trial.functionalChecks={
      siblingAvailable:configuration==='A'?null:derived.siblingFailedProbes===0&&trial.after.b.startedAt===trial.before.b.startedAt&&trial.after.b.running,
      noFalseActionInControl:fault!=='control'?null:trial.after.a.startedAt===trial.before.a.startedAt&&events.every(e=>!['failure_confirmed','restart_requested'].includes(e.type)),
      failureDetected:fault==='control'?null:derived.detectionMs!==null,
      recoveryVerified:configuration!=='C'||fault==='control'?null:derived.recoveryMs!==null&&trial.after.a.startedAt!==trial.before.a.startedAt&&trial.finalStatus.backends['backend-a'].lastProbe?.ok===true,
      disabledRecoveryNoRestart:configuration==='C'?null:events.every(e=>e.type!=='restart_requested')&&trial.after.a.startedAt===trial.before.a.startedAt,
      disabledFaultPersists:configuration==='C'||fault==='control'?null:trial.after.a.running===(fault==='unhealthy')&&trial.finalStatus.backends['backend-a'].lastProbe?.ok===false,
    };
    trial.valid=true;trial.completed=true;trial.finishedAt=new Date().toISOString();
    writeFileSync(path.join(directory,id,'trial.json'),`${JSON.stringify(trial,null,2)}\n`);
    console.log(`PASS ${id}: ${derived.whole.successes}/${derived.whole.requests}; postfault ${derived.postFault?.successes??'-'}/${derived.postFault?.requests??'-'}; detection ${derived.detectionMs?.toFixed(1)??'n/a'}ms recovery ${derived.recoveryMs?.toFixed(1)??'not observed'}ms`);
    return trial;
  } catch(error) {
    trial.valid=false;trial.error=error.stack;trial.finishedAt=new Date().toISOString();
    console.error(`FAIL ${id}: ${error.message}`);
    await traffic?.done.catch(e=>{trial.trafficError=e.message;});
    if(created&&!exported)try{exportEvidence(configuration,id);exported=true;}catch(e){trial.exportError=e.stack;}
    writeFileSync(path.join(directory,id,'trial.json'),`${JSON.stringify(trial,null,2)}\n`);
    manifest.failedAttempts.push(trial);persist();
    if(!exported&&created)throw new Error(`Evidence export failed; preserving ${project} resources: ${trial.exportError}`);
    return null;
  } finally {
    if(created&&exported)command(configuration,['down','--volumes']);
  }
}

try {
  manifest.runtime={hostNode:process.version,docker:docker(['info','--format','{{.ServerVersion}} {{.Architecture}}']).trim(),compose:docker(['compose','version','--short']).trim()};
  manifest.sourceHashes={};
  const files=['Dockerfile','compose.yaml','compose.two.yaml','compose.recovery.yaml','compose.experiment.yaml','compose.experiment-two.yaml',
    'nginx/one.conf','nginx/two.conf','nginx/experiment.conf','tools/docker.mjs','tools/fault.mjs','tools/traffic.mjs',
    'tools/experiments.mjs','tools/experiments-worker.mjs','tools/experiments-summary.mjs','package.json','package-lock.json'];
  for(const folder of ['backend/src','recovery'])for(const item of readdirSync(path.join(root,folder),{recursive:true,withFileTypes:true}))if(item.isFile()&&!item.name.endsWith('.test.mjs'))files.push(path.relative(root,path.join(item.parentPath,item.name)));
  for(const file of files)manifest.sourceHashes[file]=createHash('sha256').update(readFileSync(path.join(root,file))).digest('hex');
  for(const configuration of ['A','B','C'])fresh(`resilientcloud-m3-${configuration.toLowerCase()}`);
  setEnvironment('C');command('C',['build']);
  manifest.images={backend:JSON.parse(docker(['image','inspect','resilientcloud-backend:m1']))[0].Id,recovery:JSON.parse(docker(['image','inspect','resilientcloud-recovery:m2']))[0].Id};
  Object.assign(dockerEnvironment(),{EXPERIMENT_BACKEND_IMAGE:manifest.images.backend,EXPERIMENT_RECOVERY_IMAGE:manifest.images.recovery});
  persist();
  // Interleave configurations and rotate fault ordering across repetitions to reduce time-order confounding.
  const faults=['control','crash','unhealthy'];
  for(let repetition=1;repetition<=protocol.repetitions;repetition++)for(let offset=0;offset<faults.length;offset++)for(const configuration of ['A','B','C']) {
    const fault=faults[(offset+repetition-1)%faults.length];
    let trial;
    for(let attempt=1;attempt<=2&&!trial;attempt++)trial=await runTrial(configuration,fault,repetition,attempt);
    if(!trial)throw new Error(`${configuration}/${fault}/${repetition} failed both attempts; raw evidence preserved`);
    manifest.trials.push(trial);persist();generateSummary(directory);
  }
  manifest.status=manifest.trials.every(trial=>Object.values(trial.functionalChecks).every(value=>value!==false))?'passed':'failed';
  manifest.finishedAt=new Date().toISOString();persist();
  const summary=generateSummary(directory);
  await event('matrix_complete',{trials:summary.trials.length,failedAttempts:manifest.failedAttempts.length});
  console.log(`COMPLETE ${summary.trials.length} trials; evidence ${out}`);
  if(manifest.status==='failed')process.exitCode=1;
} catch(error) {
  manifest.status='failed';manifest.error=error.stack;manifest.finishedAt=new Date().toISOString();persist();
  try{generateSummary(directory);}catch{}
  await event('matrix_failed',{error:error.message});console.error(error.stack);process.exitCode=1;
} finally {await journal.close();}
