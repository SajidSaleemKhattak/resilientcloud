import test from 'node:test';import assert from 'node:assert/strict';import { estimate } from './aws-cost.mjs';
test('monthly estimate includes compute, public IPv4 and provisioned EBS',()=>{
  const r=estimate({runningHours:730});assert.equal(r.compute,12.264);assert.equal(r.ipv4,3.65);assert.equal(r.storage,1.6);assert.ok(Math.abs(r.total-17.514)<1e-9);
});
test('stopping compute releases ephemeral IPv4 but does not stop storage credit consumption',()=>{
  const r=estimate({runningHours:0,storageHours:730});assert.equal(r.compute,0);assert.equal(r.ipv4,0);assert.equal(r.total,1.6);
  assert.ok(estimate({runningHours:182*24}).total>100);
  assert.ok(estimate({runningHours:182*8,storageHours:182*24}).total<42);
});
test('invalid cost inputs fail rather than giving a misleading budget',()=>{
  for(const v of [NaN,Infinity,-1,undefined])assert.throws(()=>estimate({runningHours:v}));
});
