import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function readJsonl(file) {
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}
export function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a,b) => a-b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}
export function metrics(records, start, end, origin) {
  const requests = records.filter(r => r.type === 'request' && r.monotonicMs >= start && r.monotonicMs < end).sort((a,b) => a.monotonicMs-b.monotonicMs);
  const skipped = records.filter(r => r.type === 'skipped' && origin + r.scheduledMs >= start && origin + r.scheduledMs < end);
  const slots = records.filter(r => ['request','skipped'].includes(r.type) && origin + r.scheduledMs >= start && origin + r.scheduledMs < end);
  const successes = requests.filter(r => r.success);
  const instances = {};
  const skippedReasons = {};
  const statuses = {};
  for (const r of requests) { const key = r.instance ?? 'unknown'; instances[key] = (instances[key] ?? 0)+1; const status = r.error ?? String(r.status); statuses[status] = (statuses[status] ?? 0)+1; }
  for (const r of skipped) skippedReasons[r.reason] = (skippedReasons[r.reason] ?? 0)+1;
  let failureStart = null;
  let longestFailureIntervalMs = 0;
  for (const r of requests) {
    if (!r.success && failureStart === null) failureStart = r.monotonicMs;
    if (r.success && failureStart !== null) { longestFailureIntervalMs = Math.max(longestFailureIntervalMs, r.monotonicMs-failureStart); failureStart = null; }
  }
  if (failureStart !== null) longestFailureIntervalMs = Math.max(longestFailureIntervalMs, end-failureStart);
  return { requests: requests.length, successes: successes.length, failures: requests.length-successes.length,
    successRate: requests.length ? successes.length/requests.length : null, skipped: skipped.length, skippedReasons,
    scheduled: slots.length, achievedRequestsPerSecond: requests.length/((end-start)/1000), instances, statuses,
    latencyMs: { p50: percentile(requests.map(r=>r.latencyMs),.5), p95: percentile(requests.map(r=>r.latencyMs),.95) },
    successfulLatencyMs: { p50: percentile(successes.map(r=>r.latencyMs),.5), p95: percentile(successes.map(r=>r.latencyMs),.95) },
    longestFailureIntervalMs };
}
export function summarizeTrial(trial, records, events) {
  const origin = records.find(r => r.type === 'start').originMonotonicMs;
  const start = trial.windowStartMonotonicMs;
  const anchor = trial.anchorMonotonicMs;
  const end = trial.windowEndMonotonicMs;
  const offset = trial.clockBefore.offsetMs;
  const inFault = e => e.service === 'backend-a' && e.monotonicMs-offset >= anchor && e.monotonicMs-offset < end;
  const confirmed = trial.fault === 'control' ? null : events.find(e=>e.type==='failure_confirmed' && inFault(e));
  const recovered = trial.fault === 'control' ? null : events.find(e=>e.type==='recovery_verified' && inFault(e));
  const post = records.filter(r=>r.type==='request' && r.monotonicMs>=anchor && r.monotonicMs<end);
  const completed = r => origin + r.completedElapsedMs;
  const byCompletion = [...post].sort((a,b)=>completed(a)-completed(b));
  const sibling = byCompletion.find(r=>r.success && r.instance==='backend-b' && completed(r)<end);
  const firstTarget = byCompletion.find(r=>r.success && r.instance==='backend-a' && recovered && r.monotonicMs>=recovered.monotonicMs-offset && completed(r)<end);
  const probes = events.filter(e=>e.type==='probe' && e.monotonicMs-offset>=anchor && e.monotonicMs-offset<end);
  const full = records.findLast(r=>r.type==='summary');
  const whole = metrics(records,start,end,origin);
  const mappingDriftMs = trial.clockAfter.offsetMs-offset;
  const stableClock = Math.abs(mappingDriftMs) <= trial.clockBefore.uncertaintyMs+trial.clockAfter.uncertaintyMs+100;
  return { id:trial.id, configuration:trial.configuration, fault:trial.fault, repetition:trial.repetition,
    valid:trial.valid && stableClock, evidencePath:trial.evidencePath, startedAt:trial.startedAt,
    whole, postFault:trial.fault==='control'?null:metrics(records,anchor,end,origin),
    observation:metrics(records,anchor,end,origin), rawWorkload:full,
    guardRequests:full.requests-whole.requests, guardSkipped:full.dropped-whole.skipped,
    detectionMs:confirmed ? confirmed.monotonicMs-offset-anchor : null,
    recoveryMs:recovered ? recovered.monotonicMs-offset-anchor : null, recoveryObserved:Boolean(recovered),
    firstSiblingSuccessMs:trial.fault!=='control'&&sibling?completed(sibling)-anchor:null,
    firstTargetSuccessAfterVerificationMs:recovered&&firstTarget?completed(firstTarget)-anchor:null,
    recoveryAttempts:events.filter(e=>e.type==='restart_requested' && inFault(e)).length,
    clockUncertaintyMs:trial.clockBefore.uncertaintyMs, mappingDriftMs, stableClock,
    siblingProbes:probes.filter(e=>e.service==='backend-b').length,
    siblingFailedProbes:probes.filter(e=>e.service==='backend-b'&&!e.ok).length,
    actualFaultOffsetMs:trial.faultEvent?trial.faultEvent.hostMonotonicMs-origin:null,
    signalDurationMs:trial.faultEvent?.durationMs??null,
    functionalChecks:trial.functionalChecks??null,
  };
}
const range = values => ({ min:values.length?Math.min(...values):null,max:values.length?Math.max(...values):null,values });
export function groupTrials(trials) {
  const groups = [];
  for (const configuration of ['A','B','C']) for (const fault of ['control','crash','unhealthy']) {
    const all = trials.filter(t=>t.configuration===configuration&&t.fault===fault);
    if (!all.length) continue;
    const group = all.filter(t=>t.valid);
    groups.push({configuration,fault,trials:all.length,validTrials:group.length,invalidTrials:all.length-group.length,
      wholeSuccessRate:range(group.map(t=>t.whole.successRate).filter(v=>v!==null)),
      postFaultSuccessRate:range(group.map(t=>t.postFault?.successRate).filter(v=>v!==null&&v!==undefined)),
      detectionMs:range(group.map(t=>t.detectionMs).filter(v=>v!==null)),
      recoveryMs:range(group.map(t=>t.recoveryMs).filter(v=>v!==null)),
      p95LatencyMs:range(group.map(t=>t.whole.latencyMs.p95).filter(v=>v!==null)),
      recoveriesObserved:group.filter(t=>t.recoveryObserved).length,
      skipped:all.reduce((n,t)=>n+t.rawWorkload.dropped,0)});
  }
  return groups;
}
export function generateSummary(directory) {
  const manifest = JSON.parse(readFileSync(path.join(directory,'manifest.json'),'utf8'));
  const trials = manifest.trials.filter(t=>t.completed).map(t=>summarizeTrial(t,
    readJsonl(path.join(directory,t.id,'traffic.jsonl')),readJsonl(path.join(directory,t.id,'controller.events.jsonl'))));
  const evidenceHashes = Object.fromEntries(manifest.trials.filter(t=>t.completed).flatMap(t=>
    ['trial.json','traffic.jsonl','controller.events.jsonl','gate.events.jsonl'].map(file=>[`${t.id}/${file}`,
      createHash('sha256').update(readFileSync(path.join(directory,t.id,file))).digest('hex')])));
  const summary = { schemaVersion:1, generatedAt:manifest.finishedAt??manifest.trials.at(-1)?.finishedAt??manifest.startedAt,status:manifest.status,
    purpose:manifest.purpose,protocol:manifest.protocol,runtime:manifest.runtime,sourceHashes:manifest.sourceHashes,
    definitions:manifest.definitions,trials,groups:groupTrials(trials),failedAttempts:manifest.failedAttempts??[],evidenceHashes,
    limitations:['Three repetitions per group describe individual observations and ranges, not statistical significance.',
      'All containers share one host and Docker VM; host failures are not protected.',
      'Nginx passive traffic failover and readiness-verified backend recovery are different outcomes.'] };
  writeFileSync(path.join(directory,'summary.json'),`${JSON.stringify(summary,null,2)}\n`);
  const columns=['id','configuration','fault','repetition','valid','wholeRequests','wholeSuccesses','wholeSuccessRate','postFaultRequests','postFaultSuccesses','postFaultSuccessRate','p95LatencyMs','detectionMs','recoveryMs','skipped'];
  const csv=[columns.join(',')];
  for (const t of trials) csv.push([t.id,t.configuration,t.fault,t.repetition,t.valid,t.whole.requests,t.whole.successes,t.whole.successRate,t.postFault?.requests??'',t.postFault?.successes??'',t.postFault?.successRate??'',t.whole.latencyMs.p95??'',t.detectionMs??'',t.recoveryMs??'',t.rawWorkload.dropped].join(','));
  writeFileSync(path.join(directory,'trials.csv'),`${csv.join('\n')}\n`);
  return summary;
}
if (process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const [directory]=process.argv.slice(2);
  if (!directory || process.argv.length!==3 || !path.resolve(directory).startsWith(path.resolve('results')+path.sep)) throw new Error('Usage: node tools/experiments-summary.mjs results/new-run-directory');
  console.log(JSON.stringify({trials:generateSummary(directory).trials.length}));
}
