// Separate process keeps Docker CLI calls from blocking the workload scheduler.
import { openOutput, runTraffic } from './traffic.mjs';
const options = JSON.parse(process.argv[2]);
const { file } = await openOutput(options.out);
let writes = Promise.resolve();
try {
  await runTraffic(options, record => {
    if (record.type === 'start') process.send?.({ type: 'started', originMonotonicMs: record.originMonotonicMs });
    writes = writes.then(() => file.writeFile(`${JSON.stringify(record)}\n`));
    return writes;
  });
} catch (error) { console.error(error.stack); process.exitCode = 1; }
finally { await writes.catch(() => {}); await file.close(); process.disconnect?.(); }
