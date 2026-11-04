import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function estimate({ runningHours, storageHours = runningHours, storageGiB = 20,
  instanceRate = 0.0168, ipv4Rate = 0.005, storageRate = 0.08 } = {}) {
  for (const value of [runningHours,storageHours,storageGiB,instanceRate,ipv4Rate,storageRate]) {
    if (!Number.isFinite(value) || value < 0) throw new Error('Costs require nonnegative finite inputs');
  }
  const compute=runningHours*instanceRate,ipv4=runningHours*ipv4Rate,storage=storageGiB*storageRate*storageHours/730;
  return {runningHours,storageHours,storageGiB,compute,ipv4,storage,total:compute+ipv4+storage};
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const prices=JSON.parse(readFileSync(new URL('../results/aws-preparation/selected-prices.json',import.meta.url)));
  const instanceRate=Number(prices.find(p=>p['Instance Type']==='t4g.small').PricePerUnit);
  const storageRate=Number(prices.find(p=>p.Unit==='GB-Mo').PricePerUnit);
  const report={asOf:'2026-11-04',region:'us-east-1',balanceUsd:100,remainingDays:182,
    assumptions:{instanceRate,ipv4Rate:0.005,storageRate,storageGiB:20,planningMonthHours:730,
      cpuMode:'standard (no surplus-credit fees)',trialDiscountAssumed:false,elasticIp:false,
      egress:'within the shared 100 GB/month internet-out allowance',excluded:'other AWS usage, taxes, domain purchase, snapshots, paid DNS/logging/load balancing'},
    plans:Object.fromEntries(Object.entries({twoDays:{runningHours:48},oneWeek:{runningHours:168},monthAlwaysOn:{runningHours:730},all182Days:{runningHours:182*24},eightHoursPerDay182Days:{runningHours:182*8,storageHours:182*24}}).map(([k,v])=>[k,estimate({...v,instanceRate,storageRate})]))};
  writeFileSync(new URL('../results/aws-preparation/cost-estimate.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}
