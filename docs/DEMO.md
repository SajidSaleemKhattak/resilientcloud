# Two-minute local demonstration

## Before the timer

Install dependencies and build using the README commands. Start `npm run compose -- dashboard up -d --build`, open http://127.0.0.1:8080, and wait until both instances report current readiness and healthy controller state. Keep the terminal in `resilientcloud`. Confirm the saved experiment summary is available before the presentation. Builds and setup are not part of the two minutes.

If the controller reports exhausted, do not imply it will automatically rearm. Resolve the incident offline using the recovery design before presenting. Do not delete persisted history to make the demonstration look clean.

## Script

| Time | Action and explanation |
| --- | --- |
| 0:00–0:25 | Show **Live overview**. “These are actual controller observations of two Express services on one machine. A fresh readiness probe can differ from whether the process is running.” Point out timestamps, per-incident attempts, and the read-only label. |
| 0:25–0:55 | In the local terminal run `npm run fault -- crash backend-a`. Watch the real incident timeline. “Nginx can route eligible requests to the surviving instance. The controller separately confirms failure and restarts only an authorized backend. Recovery requires two successful readiness probes.” A fast transition may appear in the timeline between dashboard polls. |
| 0:55–1:20 | Once backend-a is healthy again, run `npm run fault -- unhealthy backend-a`. “This time the process is alive but readiness fails. Process existence alone is insufficient.” Show failure confirmation, restart request, readiness verification, and cooldown in the recorded events. |
| 1:20–1:50 | Select **Saved experiments**. Compare A, B, and C for crash and unhealthy faults. “These are saved trials, independent of the current live display. Each configuration uses the same workload and fault windows. Whole-trial rates include the baseline; post-fault rates do not. ‘Not observed’ is not zero seconds.” Point at individual trial values and ranges. |
| 1:50–2:00 | “This prototype demonstrates local service failover and bounded recovery. All containers share one host: it does not protect against host or Docker VM failure. Three repetitions are descriptive evidence, not a production reliability claim.” |

Fault injection is only a local CLI operation. No browser button or public API can request faults or recovery. After the demonstration, `npm run compose -- dashboard down` stops this project's services and preserves its event volume.

Cloud deployment is deferred until local validation, confirmation of a zero-cost hosting option, and explicit approval. This demonstration requires no cloud resources.
