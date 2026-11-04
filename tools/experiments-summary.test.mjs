import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root } from './docker.mjs';
import { generateSummary, groupTrials, metrics, summarizeTrial } from './experiments-summary.mjs';

function fixture() {
  const request = (monotonicMs, success, instance, latencyMs) => ({ type:'request',monotonicMs,
    scheduledMs:monotonicMs,completedElapsedMs:monotonicMs+latencyMs,success,instance,latencyMs,status:success?200:503,error:null });
  const requests = [request(500,true,'backend-a',5),request(1100,true,'backend-a',10),
    request(1900,false,'backend-a',2500),request(2100,false,null,20),
    request(2300,true,'backend-b',100),request(2200,true,'backend-b',400),
    request(2700,true,'backend-a',100),request(4000,true,'backend-b',10)];
  const records = [{type:'start',originMonotonicMs:0},...requests,
    {type:'skipped',monotonicMs:3000,scheduledMs:2400,reason:'concurrency_limit'},
    {type:'summary',requests:requests.length,dropped:1}];
  const trial = {id:'C-crash-1',configuration:'C',fault:'crash',repetition:1,valid:true,completed:true,
    evidencePath:'test-only',startedAt:'2026-11-04T00:00:00.000Z',finishedAt:'2026-11-04T00:01:00.000Z',
    windowStartMonotonicMs:1000,anchorMonotonicMs:2000,windowEndMonotonicMs:4000,
    clockBefore:{offsetMs:100,uncertaintyMs:10},clockAfter:{offsetMs:110,uncertaintyMs:10},
    faultEvent:{hostMonotonicMs:2000,durationMs:20}};
  const events = [{type:'failure_confirmed',service:'backend-a',monotonicMs:2500},
    {type:'restart_requested',service:'backend-a',monotonicMs:2550},
    {type:'recovery_verified',service:'backend-a',monotonicMs:2700},
    {type:'probe',service:'backend-b',monotonicMs:2800,ok:false}];
  return {records,trial,events};
}

test('whole and post-fault metrics use actual launch windows and separately account for skipped schedules',()=>{
  const {trial,records,events}=fixture();
  const result=summarizeTrial(trial,records,events);
  assert.equal(result.whole.requests,6);
  assert.equal(result.whole.successes,4);
  assert.equal(result.whole.failures,2);
  assert.equal(result.whole.successRate,4/6);
  assert.equal(result.postFault.requests,4);
  assert.equal(result.postFault.successRate,3/4);
  assert.equal(result.whole.skipped,1);
  assert.deepEqual(result.whole.skippedReasons,{concurrency_limit:1});
  assert.equal(result.whole.longestFailureIntervalMs,300);
  assert.equal(result.whole.latencyMs.p95,2500);
  assert.equal(result.whole.successfulLatencyMs.p95,400);
  assert.equal(result.guardRequests,2);
});

test('failure and recovery timings use mapped controller events; survivor timing uses earliest completed response',()=>{
  const {trial,records,events}=fixture();
  const result=summarizeTrial(trial,records,events);
  assert.equal(result.detectionMs,400);
  assert.equal(result.recoveryMs,600);
  assert.equal(result.firstSiblingSuccessMs,400);
  assert.equal(result.firstTargetSuccessAfterVerificationMs,800);
  assert.equal(result.recoveryAttempts,1);
  assert.equal(result.siblingFailedProbes,1);
  assert.equal(result.valid,true,'a sibling failure is retained as a measured outcome');
});

test('absent recovery is null even in C, controls have no post-fault outcome and clock drift invalidates mapping',()=>{
  const {trial,records,events}=fixture();
  const missing=summarizeTrial(trial,records,events.filter(e=>e.type!=='recovery_verified'));
  assert.equal(missing.recoveryMs,null);
  assert.equal(missing.recoveryObserved,false);
  assert.equal(missing.valid,true);
  const control=summarizeTrial({...trial,fault:'control'},records,events);
  assert.equal(control.postFault,null);
  assert.equal(control.detectionMs,null);
  assert.equal(control.recoveryMs,null);
  const drift=summarizeTrial({...trial,clockAfter:{offsetMs:1000,uncertaintyMs:10}},records,events);
  assert.equal(drift.stableClock,false);
  assert.equal(drift.valid,false);
});

test('ranges exclude invalid trials and preserve unobserved recovery instead of coercing it to zero',()=>{
  const {trial,records,events}=fixture();
  const good=summarizeTrial(trial,records,events);
  const absent={...good,id:'C-crash-2',recoveryMs:null,recoveryObserved:false};
  const invalid={...good,id:'C-crash-3',valid:false,recoveryMs:99999};
  const [group]=groupTrials([good,absent,invalid]);
  assert.equal(group.trials,3);
  assert.equal(group.validTrials,2);
  assert.deepEqual(group.recoveryMs.values,[600]);
  assert.equal(group.recoveriesObserved,1);
  assert.equal(group.skipped,3);
  assert.equal(metrics([],0,1000,0).successRate,null);
  assert.equal(metrics([],0,1000,0).latencyMs.p95,null);
});

test('saved summary regeneration is deterministic and hashes its original evidence',async t=>{
  const {trial,records,events}=fixture();
  const cache=path.join(root,'.cache','summary-tests');await mkdir(cache,{recursive:true});
  const directory=await mkdtemp(path.join(cache,'run-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  await mkdir(path.join(directory,trial.id));
  const manifest={status:'passed',startedAt:trial.startedAt,finishedAt:trial.finishedAt,trials:[trial],protocol:{},definitions:{}};
  await writeFile(path.join(directory,'manifest.json'),JSON.stringify(manifest));
  await writeFile(path.join(directory,trial.id,'trial.json'),JSON.stringify(trial));
  await writeFile(path.join(directory,trial.id,'traffic.jsonl'),records.map(JSON.stringify).join('\n')+'\n');
  await writeFile(path.join(directory,trial.id,'controller.events.jsonl'),events.map(JSON.stringify).join('\n')+'\n');
  await writeFile(path.join(directory,trial.id,'gate.events.jsonl'),'');
  const first=generateSummary(directory);
  const csv=await readFile(path.join(directory,'trials.csv'),'utf8');
  assert.deepEqual(generateSummary(directory),first);
  assert.equal(await readFile(path.join(directory,'trials.csv'),'utf8'),csv);
  assert.equal(Object.keys(first.evidenceHashes).length,4);
  assert.match(first.evidenceHashes[`${trial.id}/traffic.jsonl`],/^[a-f0-9]{64}$/);
});
