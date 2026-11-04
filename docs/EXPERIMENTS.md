# Repeatable local experiments

## Configurations and controls

| Configuration | Backends | Controller recovery | Traffic failover |
| --- | --- | --- | --- |
| A | backend-a | Off | No surviving upstream |
| B | backend-a and backend-b | Off | Nginx can retry the sibling |
| C | backend-a and backend-b | On | Same Nginx settings as B |

Each configuration has three process-crash trials, three unhealthy-but-running trials, and three no-fault controls: **27 fresh trials**. All faults target backend-a. Configuration and fault ordering are interleaved, with fault order rotated between repetitions. This reduces simple time-order confounding but is not randomized experimental assignment.

All configurations include the same gate, controller, and read-only status services so monitoring overhead is represented in A and B too. A sets `MONITORED_SERVICES=backend-a`; B and C monitor both backends. Recovery is disabled in A and B. No detection settings change: 500 ms probe interval, 300 ms readiness timeout, three consecutive failures, two maximum restart attempts, two successful probes within a four-second verification window, and a two-second cooldown. Docker restart policies remain `no` throughout.

Backend images, resource limits, Nginx timeouts, retry settings, and generator options are held constant. The runner builds once and pins the actual backend/recovery image IDs for every trial. The manifest retains runtime versions, image IDs, source hashes, effective Compose configurations, and actual container IDs/start times.

## Run and regenerate

From the repository root, with Docker running and loopback port **18085** free:

```sh
node tools/experiments-config.mjs
run_id="$(date -u +%Y%m%dT%H%M%SZ)"
run_dir="results/milestone-3/run-${run_id}"
caffeinate -i node tools/experiments.mjs --out "$run_dir"
npm run experiments:summarize -- "$run_dir"
mkdir -p dashboard/public/experiments
cp "$run_dir/summary.json" dashboard/public/experiments/summary.json
npm run dashboard:build
```

`caffeinate` is the existing macOS utility; it prevents idle sleep only while the command runs. On Linux use `node tools/experiments.mjs --out "$run_dir"` without it. Keep the machine awake and avoid competing builds or workloads. The full matrix takes roughly 40 minutes including startup/export between trials. `--smoke` runs nine short checks with one-second baseline and three-second observation; those are explicitly labelled and cannot substitute for the full matrix.

The output directory must be new. The runner refuses pre-existing containers, volumes, and networks belonging to its reserved projects `resilientcloud-m3-a`, `resilientcloud-m3-b`, and `resilientcloud-m3-c`. Each trial creates fresh containers and recovery-budget volumes, verifies initial readiness and baseline responses, and exports journals before removing only resources it created. An export failure leaves the affected resources intact. There is no unrelated Docker cleanup.

`summary.json` and `trials.csv` are derived artifacts. Regeneration reads the original manifest/JSONL and uses the recorded finish time, making the summary deterministic. Raw-input SHA256 hashes identify the evidence used. Copying the summary into `dashboard/public/experiments` updates saved charts on the next production build; it does not alter live telemetry. Existing milestone-1 and milestone-2 evidence is never rewritten.

## Workload and windows

The generator issues **10 requests/second**, with concurrency capped at **8**, a **2,500 ms** client timeout, and **zero client retries**. Nginx's bounded GET retries are retained in upstream response headers. Each raw workload lasts 77 seconds: one leading guard second, a 15-second baseline, a 60-second observation window, and one trailing guard second.

For fault trials, the actual fault-command start anchors the analysis window: exactly 15 seconds before that start and 60 seconds after it. Guard traffic accommodates small scheduling/target-validation delays. `actualFaultOffsetMs` and `signalDurationMs` record the actual timing; fault completion is separate from its start. Controls use the same nominal anchor 16 seconds into the raw workload and the same analysis durations. A control has an observation window but no post-fault rate.

Whole-trial analysis uses actual request launches in `[anchor − 15s, anchor + 60s)`. Post-fault analysis uses launches in `[anchor, anchor + 60s)`; it excludes requests already in flight at fault start. Completion may occur after the window ends and is drained/recorded. Leading/trailing guard requests remain in the raw file and have separate counts. They are not silently mixed into the whole-trial denominator.

Skipped slots represent requests never issued because the client reached its concurrency limit or its scheduler was late. They are classified by scheduled time, reported separately by reason, and excluded from success-rate denominators. Skips inside the analysis window invalidate workload comparability; the runner retains that attempt and permits one fresh retry. Guard skips remain visible. Achieved rate is actual launches divided by the analysis duration. There is no catch-up burst that hides skipped scheduling slots.

## Metric definitions

| Metric | Definition |
| --- | --- |
| Whole-trial success | Complete 2xx responses divided by actual request launches in the 75-second analysis window. Includes baseline and post-fault requests. |
| Post-fault success | Complete 2xx responses divided by actual launches in the 60-second post-fault window. `null` for no-fault controls. |
| Failure | Non-2xx response, timeout, incomplete response, or transport error. Actual HTTP/transport outcomes remain in JSONL. |
| Latency p50/p95 | Nearest-rank percentiles from launch to complete body or terminal error. Main latency includes failed requests; successful-only latency is reported separately. A fast 503 is not evidence of useful low latency. |
| Detection | Actual fault-command start to the controller's first `failure_confirmed` event after that start, requiring three consecutive failed probes. |
| Recovery | Fault-command start to the first `recovery_verified` event within the observation window, requiring two readiness successes with revalidated container identity. Docker acceptance and Docker health polling are separate signals. |
| First sibling response | Completion time of the first successful post-fault request served by backend-b within the window. This observes traffic continuity/failover, not repair of backend-a. |
| First target response after verification | First completed success from backend-a for a request launched after recovery verification. Separate from the controller's readiness-based recovery time. |
| Longest failure interval | Longest span from a failed request launch to the next successful request launch in consecutive failure sequences; censored at window end. A sampled interval, not proof of continuous outage. |

No observed recovery is represented by JSON `null`, an empty CSV duration, and **Not observed** in the dashboard. It is never converted into zero. The same applies if configuration C fails to recover during its window. Functional outcomes such as missing recovery, unexpected restarts, sibling failures, or control failures remain measured outcomes; they do not justify discarding a valid trial. Setup/fault mismatch, clock instability, and skipped workload slots are separately labelled protocol failures.

The host and Docker VM have different monotonic clocks. Before and after each trial, three timed reads estimate their offset; the shortest round trip supplies a midpoint mapping and half-roundtrip uncertainty. Mapping drift greater than the combined uncertainties plus 100 ms invalidates timing. UTC remains an audit timestamp and is not used for duration subtraction. Probe cadence, signal latency, scheduling, and virtualization add further uncertainty; reported decimals are observations, not precision guarantees.

## Evidence and interpretation

Each trial directory contains `traffic.jsonl`, `trial.json`, the controller/gate JSONL journals, `status.json`, effective `compose.json`, and timestamped container logs. The matrix manifest distinguishes completed trials and failed attempts. The summary retains individual trial values and per-group ranges; invalid trials are excluded from ranges and charts, with their raw evidence retained. Functional checks remain distinct from data validity.

The saved dashboard charts use this summary only. They never simulate traffic, invent events, or use expected outcomes as measurements. Live telemetry is read independently from the running status service.

Three repetitions per group support descriptive comparisons only. All services share the same Mac and Docker VM, so resource contention and scheduling can affect results. This experiment does not establish statistical significance, production availability, protection against host failure, or guaranteed uninterrupted traffic.
