# ResilientCloud — two-day prototype plan

## Scope and prerequisites

Build and demonstrate locally on a MacBook Air M2; cloud budget: $0. Cloud deployment is deferred until local validation and a genuinely zero-cost hosting option are confirmed, then requires explicit user approval. It is not permanently excluded. Keep project changes inside `resilientcloud`; do not access credentials or modify unrelated files. Use ARM64-compatible images and modest resource limits. This is a single-host prototype: it cannot protect against Mac, Docker VM, power, or host-network failure.

Environment checked on 2026-11-03:

| Prerequisite | Result |
| --- | --- |
| Git | 2.50.1 (Apple Git-155) |
| Node.js | v25.8.2 |
| npm | 11.11.1 |
| Docker CLI | 29.7.2 |
| Docker Compose | v5.4.0 |
| Docker daemon | Initially unreachable; milestone 1 recheck succeeded: Docker Desktop 29.7.2, aarch64 |

No listed CLI is missing. Docker is now available. No system software was installed or reset. Milestone 1 pins Node 24 and Nginx 1.28 multiarchitecture image digests; existing host Node remains unchanged. Dependencies and tool caches live inside the project.

## Architecture and boundaries

- **Dashboard:** React + TypeScript, showing instance health, probe timestamps, recovery events, and experiment summaries. Display stale/unknown data explicitly. Read-only; no Docker access or failure/restart buttons.
- **Backends:** two identical Node.js/Express services, `backend-a` and `backend-b`, with distinct instance IDs. Provide a lightweight request endpoint and readiness endpoint; report instance ID in responses. Keep health semantics explicit: a running process can return failing readiness or time out.
- **Traffic:** Nginx balances requests across both instances on a private Compose application network. Publish only the UI/gateway port on loopback. Configure passive upstream failure detection, bounded timeouts, and safe retries for idempotent demo GET requests. Nginx may expose failed requests before detecting a problem; measure this. Open-source Nginx passive checks are separate from controller probes.
- **Networking:** service-name DNS inside Compose; do not publish backend ports. Backends use an internal application network; only Nginx also joins an edge network to enable its loopback host port. Later, route dashboard status reads through a small read-only status service with no Docker socket or restart capability. A separate internal network/shared event volume connects monitoring output to this service; the dashboard and public APIs cannot command the controller.
- **Recovery controller:** isolated Node.js service probes backend readiness, records timestamped state transitions, and restarts only eligible project backend containers. Require consecutive failures, probe timeouts, cooldown, bounded retries, and an exhausted/manual-intervention state. Log reason, target, action, and outcome; never accept public commands.
- **Docker boundary:** the controller uses a private Unix-socket gate, with no gate network or published port. It authorizes only inspection/restart of freshly validated backend IDs, checking project/service/directory/role labels, instance identity and app-network membership. It rejects stale IDs and all other operations; legitimate recreation requires revalidation. Only the gate receives Docker's socket. A read-only socket mount still allows API mutations, so this gate is trusted and must fail closed.

## Failure semantics

**Traffic failover** routes eligible requests away from a failed upstream to a surviving instance; it does not repair containers. **Container recovery** restarts an eligible backend after confirmed failure; it does not guarantee uninterrupted traffic.

Test both a **process crash** (container exits) and an **unhealthy but running service** (readiness fails and requests stall/fail). Compose health status alone does not restart a container. Disable Docker restart policies in all measured scenarios so recovery can be attributed to the controller. Use one backend process per container.

Keep failure injection in a local experiment CLI, outside public APIs. Address only validated project backends. Use a documented test-only fault mechanism to induce a running-service failure, cleared by restart; verify that the process remains alive during that experiment. Include normal-operation controls and crash evidence from container state.

## Experiments and real measurements

Compare these configurations with the same image, resource limits, workload, timeouts, and fault timing:

| Scenario | Backends | Nginx failover | Controller recovery |
| --- | --- | --- | --- |
| A | One | No surviving upstream | Off |
| B | Two | Enabled | Off |
| C | Two | Enabled | On |

For each configuration and fault type, run at least three fresh trials: 15 seconds baseline, inject one fault, observe for 60 seconds, then reset. Include no-fault control runs. Use fixed-rate, bounded-concurrency traffic that does not silently retry failures; record achieved request rate and client saturation. Target one backend consistently and confirm the other stays healthy.

Save raw JSONL/CSV: trial/configuration, monotonic elapsed time and UTC timestamp, request result/status, latency, responding instance, injection time, probe outcomes, controller actions, and verified readiness restoration. Measure success rate, error count, p50/p95 latency, longest consecutive failure interval, detection delay, and recovery delay. Distinguish first successful request through the surviving backend from recovery of the failed instance. Mark recovery not observed within the window as such; do not report zero or invent a duration. Document metric definitions and latency treatment for failed requests.

Generate tables/charts from saved data only; retain commands, configuration, machine/runtime details, image revisions, and raw results for reproduction. Report variability and limitations: low sample count, passive detection delay, polling delay, retry behavior, and shared host resources. Do not claim host resilience or guaranteed zero downtime.

## Two-day delivery order

**Milestone 1 — local backend and failover foundation (completed):** TypeScript/Express identity/readiness/API, pinned ARM64 builds, one/two-backend Compose configurations, Nginx passive failover and DNS re-resolution, restart policies disabled, scoped signal-based local fault injection, JSONL traffic generator, tests, exact README commands. Crash, unhealthy, restart and forced-IP-change behavior validated; original evidence preserved.

**Milestone 2 — isolated recovery (completed):** controller state transitions, bounded actions, Docker authorization gate, persisted events/checkpoints, read-only status, and security tests. Scenario C validated locally with controller recovery enabled and Docker restart policies disabled.

**Milestone 3 — evidence and presentation (Day 2):** repeated A/B/C experiment matrix, actual comparisons, React/TypeScript dashboard, GitHub Actions, architecture diagram, and scholarship demo documentation. Prioritize reproducible CLI evidence over visual polish. If recovery cannot be validated in time, report it as incomplete and retain the measured baseline/failover results.

### Milestone 1 progress

- [x] Docker connectivity rechecked; local ARM64 daemon available.
- [x] Backend, Docker/Compose/Nginx, local fault CLI, JSONL generator, and targeted tests implemented.
- [x] Host port issue diagnosed without resets: add gateway edge network; retain initial failed validation under `results/milestone-1/`.
- [x] Final normal/failure/restart/IP-change integration checks and raw evidence reviewed: 16 passed; 18 HTTP/process/tool tests and TypeScript check passed.
- [x] README with exact commands and actual observations; dedicated local repository and milestone checkpoint prepared.

**Milestone 1 completed, 2026-11-03.** Evidence: `results/milestone-1/final/report.json` and adjacent raw JSONL/logs. At 10 requests/second, normal samples returned 30/30 successes; eight-second crash samples returned 20/80 with one backend and 80/80 with two; unhealthy samples returned 21/80 and 80/80. Samples include pre-fault traffic. Both scenarios rejoined after manual restart and after a verified IP change without restarting Nginx. Recovery remained disabled. Initial connectivity and test-helper label failures are preserved separately; neither is marked passed. No milestone 1 runtime blocker remains.

### Milestone 2 progress

- [x] Bounded probes; 3 consecutive failures; explicit healthy/suspected/recovering/cooldown/exhausted states.
- [x] Two attempts per incident, durable budgets, cooldown, two-probe readiness verification, and exhausted latch across controller restart.
- [x] Private Unix Docker gate; foreign/stale/mismatched targets and unauthorized actions rejected; legitimate recreation revalidated.
- [x] Persistent timestamped event journals outside backends and read-only status with snapshot/per-backend staleness.
- [x] 45 automated tests (including late-verification and UTC-jump regressions), TypeScript checks, ARM64 builds, and 16 live integration checks passed.
- [x] Real fault timings, sibling availability, transient suppression, persistent exhaustion, and disabled recovery recorded; README/design documentation updated.

**Milestone 2 completed, 2026-11-03.** Checkpoint evidence is `results/milestone-2/validated/`; earlier passing and failed attempts remain separate. Crash detection/recovery: 1.275/2.294 seconds; unhealthy: 1.303/2.294 seconds, using calibrated monotonic clocks (uncertainty about ±44–47 ms plus scheduling effects). Clock mapping is checked before/after each fault; idle sleep was prevented during the final run. Persistent failure consumed exactly two attempts and remained exhausted after controller restart. Disabled recovery issued no restarts; transient failure stayed below threshold. Of 710 actual client requests, 708 succeeded and 2 returned 504 during the enabled crash sample; no dropped slots. Healthy sibling probes stayed successful. No milestone-2 runtime blocker remains; offline rearming and component/host resilience remain limitations described in `docs/RECOVERY.md`.

Milestone smoke checks are functional validation, not the three-repetition research experiment matrix above. Dashboard, CI, repeated comparisons and hosting evaluation remain pending. Cloud deployment still requires local validation, a confirmed zero-cost option, and explicit approval.

## Tests, CI, and documentation

- Unit tests: failure thresholds, timeout handling, cooldown/retry limits, successful recovery verification, and refusal of unauthorized targets/actions.
- Compose integration tests: routing to both instances, failover after crash, running-but-unhealthy detection, controller recovery, recovery-disabled behavior, and status/public-service isolation from Docker control. Verify socket/network exposure and target authorization, including foreign project containers and replaced container IDs.
- GitHub Actions: pinned supported Node, `npm ci`, lint, TypeScript checks, unit tests, production builds, Compose configuration validation, and isolated Linux Compose smoke tests. Upload logs/results on failure. No cloud credentials or deployment jobs; test locally on ARM64 too.
- README: prerequisites and daemon startup, architecture/trust boundaries, start/stop/reset commands, experiment commands and metric definitions, actual results, limitations, troubleshooting, and a short scholarship demo narrative. Commit lockfiles, `.env.example`, and experiment scripts; exclude secrets and generated dependencies. Explain precisely what was measured and what remains unproven.

**Completion criteria:** a fresh checkout can start locally, reproduce all three scenarios and both fault types, show genuine measurements, and demonstrate that public services cannot access Docker or request recovery of unrelated containers.
