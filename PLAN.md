# ResilientCloud — two-day prototype plan

## Scope and prerequisites

Build and demonstrate locally on a MacBook Air M2; out-of-pocket cloud budget: $0. The user has now confirmed AWS Free plan, $100 credits and 182 days remaining; do not upgrade the plan. AWS deployment preparation is documented in `docs/AWS.md`, but provisioning/deployment still requires explicit approval and region/domain/admin details. Keep project changes inside `resilientcloud`; do not access credentials or modify unrelated files. Use ARM64-compatible images and modest resource limits. This is a single-host prototype: it cannot protect against Mac/EC2, Docker VM, power, or host-network failure.

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

**Milestone 3 — evidence and presentation (completed locally):** repeated A/B/C experiment matrix, actual comparisons, React/TypeScript dashboard, GitHub Actions, architecture diagram, and scholarship demo documentation. Reproducible CLI evidence and live telemetry are displayed separately from saved results.

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

Milestone-1/2 smoke checks are functional validation, separate from the milestone-3 repeated experiment matrix. Hosting evaluation remains deferred. Cloud deployment still requires local validation, a confirmed zero-cost option, and explicit approval.

### Milestone 3 progress

- [x] React/TypeScript responsive read-only dashboard: actual status/events, both instances, readiness, state, probe time, per-incident attempts, timeline, unknown/stale/disconnected/exhausted states, and a single-host limitation.
- [x] Separate saved-evidence charts/tables generated from the experiment summary; invalid trials excluded from chart ranges, missing recovery shown as not observed, no substitute activity.
- [x] Bounded read-only incident-history endpoint; dashboard/status isolation and public write/fault/recovery denial verified on the real stack.
- [x] 27 fresh trials: three repetitions per A/B/C fault pair plus three controls per configuration; identical 15-second baseline/60-second observation, workload and detection parameters.
- [x] Raw requests, skipped slots, monotonic fault/probe/recovery timing, identities, journals, effective configurations, image IDs and source/input hashes retained. Summary regeneration is byte-for-byte deterministic.
- [x] 57 backend/controller/tool tests, 7 dashboard model tests, 9 browser fixture checks, type checks, production builds, Compose validation and workflow lint passed locally.
- [x] Final real dashboard healthy/stale/disconnected desktop/mobile checks passed; screenshots and HTML reports use separate artifact paths.
- [x] Bounded recovery integration smoke passed all 16 checks locally on macOS ARM64/Docker Linux containers; GitHub Actions execution remains unrun.
- [x] Evidence index, README commands/results/architecture/limitations, two-minute demo, and local milestone checkpoint prepared.

The full matrix at `results/milestone-3/validated/` completed with 27 valid trials, no retries/failed attempts, and zero skipped requests. It recorded 20,790 raw requests including guards, with 20,250 requests in the analysis windows. No-fault controls returned 100% whole-trial success. Scenario A had 20% whole-trial and 0% post-fault success for both faults, with no recovery observed. B had 99.867% whole/99.833% post-fault crash success and 100% unhealthy success; its failed backend did not recover. C had 99.867–100% whole/99.833–100% post-fault crash success and 100% unhealthy success. C verified recovery in all six fault trials: crashes 2.432–2.459 seconds, unhealthy services 2.059–2.070 seconds. Clock-mapping uncertainty was approximately ±41–44 ms, plus probe/command/scheduling effects. These three-repetition observations do not establish statistical significance or zero downtime.

Earlier short runner smoke failures remain under `results/milestone-3/runner-smoke/`: they required Docker's slower health polling to agree immediately with verified readiness. The corrected nine-trial smoke is separate from the full matrix. GitHub Actions is configured but has not run on GitHub; local workflow checks cannot establish that result.

**Milestone 3 completed locally, 2026-11-04.** Final live-dashboard evidence is `results/milestone-3/dashboard-final/`; the bounded integration report is `results/milestone-3/ci-local/`. All 57 backend/controller/tool tests, 7 dashboard model tests, 9 browser fixture checks, and four real browser checks passed. Two repeated saved-summary checks were deliberately skipped in stale/disconnected phases because the same summary had already been checked against all 27 actual trials in the healthy phase. The public dashboard has no mutation channel and no Docker/gate socket. Milestone-1/milestone-2 artifacts and checkpoints are preserved. No local runtime blocker remains. Actual GitHub-hosted CI and any future cloud deployment require subsequent authorized steps; hosting still needs a confirmed zero-cost option and explicit approval.

## Tests, CI, and documentation

### AWS preparation (2026-11-04; not deployed)

- [x] Inspected the existing six-service Compose setup and unchanged recovery/traffic boundaries; completed experiment matrix and evidence preserved without rerunning it.
- [x] Added a separate AWS overlay, version/digest-pinned TLS ingress, content-pinned ARM64 transfer bundle, disabled-by-default fault injection, authenticated SSH administration and a journal archive procedure. Local Compose remains unchanged.
- [x] Short local seven-service profile/HTTPS check: 350/350 requests, no skips; sampled memory up to 277.31 MiB and configured memory ceilings 832 MiB. These are Docker Desktop samples, not EC2 or host-OS measurements.
- [x] Official AWS Free-plan eligibility/prices checked. Proposed us-east-1 t4g.small (2 ARM64 vCPUs/2 GiB), Standard CPU credits, 20 GiB gp3. $17.51/730-hour month including IPv4; $104.80 for 182 days continuously exceeds $100. Eight hours/day with disk retained: approximately $41.31. No trial discount is assumed.
- [x] Prepared access, bootstrap/start, identity/readiness/TLS verification, authenticated faults, event retention, shutdown and project-only cleanup instructions. Bundle/checksum/image save/load validated locally; actual EC2 launch, AWS quotas/account-specific availability and public certificate issuance remain unexecuted.
- [x] User confirmed us-east-1, prepared t4g.small and initial 48-hour window; approximately $1.15 total modeled credit use. Exact console settings are in `docs/AWS-LAUNCH.md`.
- [x] Scoped local SSH-key search completed (no candidates/loaded identities found); public IPv4 checked through two sources and reported only in chat, not stored in project files. No key was generated or imported.
- [x] Later resolved through the user's existing Sydney instance, downloaded SSH key, hostname, certificate email and console host-fingerprint confirmation; deployment was explicitly authorized and completed as recorded below. Free plan and Standard CPU credits retained.

The existing controller/gate journals grow without built-in rotation; the local profile observed about 192 MiB/running day. A 20 GiB disk therefore requires the documented weekly archive/offload procedure and disk monitoring, not unlimited retention. No AWS account resources, private registries, DNS records, credentials or paid services were created/accessed; public pricing/docs and public container images were fetched.

### Existing EC2 deployment (completed and verified)

The user supplied an already-running **i-0cd68d680cd940476** in **ap-southeast-2 (Sydney)**, Ubuntu 24.04 ARM64/t4g.small/Standard credits, public IPv4 **16.176.201.215**, hostname **resilientcloud.getscoop.app**. This supersedes the previously proposed us-east-1 target. Use only this existing instance and keep the Free plan; create no replacement instance or other AWS resources.

- [x] Located `resilientcloud.pem` in Downloads; set owner-read-only mode 0400, kept outside the repository, and did not print private contents.
- [x] Prepared ARM64 bundle checksums verified. Public DNS A points to the supplied IP; public DNS query shows no AAAA/CAA records. Earlier local OS resolver IPv4-mapped output was not a real AAAA record.
- [x] Captured presented SSH **public** host fingerprints without authenticating or trusting them; separate deployment preflight records are under `results/deployments/i-0cd68d680cd940476/`.
- [x] Compared the presented ED25519 host fingerprint exactly with the user's AWS console system-log value before authentication; strict host-key checking and a project-cache pin were used for all SSH/SCP connections.
- [x] Received the certificate-contact email and stored it only in private runtime configuration; public Let's Encrypt certificate and hostname/chain verification passed.
- [x] Verified instance ID/Ubuntu 24.04/ARM64/root disk; installed Docker 29.7.2 and Compose 5.7.0; transferred and checked the ARM64 bundle/images; started with fault injection false in both backends and restart policies disabled.
- [x] Corrected deployment-only gateway networking after Docker suppressed the loopback port on internal-only bridges. Gateway joins edge with 127.0.0.1:8080; backend/status/controller/gate isolation remains intact. The initial failed check is preserved separately.
- [x] Verified fresh healthy telemetry, 20/20 API requests from both identities, 24 public route checks, blocked external private ports, socket/network isolation, and real desktop/mobile browser rendering with zero browser errors. No fault experiments/matrix rerun occurred.
- [x] User verified exactly three security-group inbound rules in the AWS console: restricted administrator SSH plus public HTTP/HTTPS; no other ingress. Administrator source IP/contact email/private keys are not committed.
- [x] Recorded actual launch **2026-11-04 18:47:43 UTC**, stop deadline **2026-11-06 18:47:43 UTC / 23:47:43 PKT**, and Sydney estimated 48-hour credits **$1.38** separately from local experiments. **No automatic EC2 stop is scheduled; operator must stop via EC2 console by the deadline.**

**Live URL: https://resilientcloud.getscoop.app.** Deployment checks passed; no current blocker remains. See `docs/AWS-DEPLOYMENT.md` and `results/deployments/i-0cd68d680cd940476/deployment.json`. Only the existing instance was used, with no new AWS resources or account-plan/credit-mode changes. Local Compose, backend/recovery policy and all completed experiment evidence are preserved.

### GitHub publication preparation (2026-11-05; not pushed)

- [x] Audited tracked files and reachable Git history, including saved archive contents; no actual credentials/private keys found. The intentionally retained public test-CA certificate and invalid parser-test URL were reviewed and kept.
- [x] Independent Gitleaks scans found zero findings in history and the staged publication contents. Tooling stayed in ignored project cache; no source was uploaded for scanning.
- [x] Strengthened credential/key/TLS-state ignore patterns and verified 36 ignore/allow cases. Existing raw evidence and checkpoints are unchanged.
- [x] Updated the README with the temporary live URL, local/AWS architecture, measured comparisons, single-host/sample-size limitations and portable reproduction commands. Review details are in `docs/PUBLICATION.md` and `results/publication-review/`.
- [ ] Configure the intended GitHub remote and obtain authorization for the actual push. **No remote is currently configured; no push or GitHub-hosted CI run has occurred.**

- Unit tests: failure thresholds, timeout handling, cooldown/retry limits, successful recovery verification, and refusal of unauthorized targets/actions.
- Compose integration tests: routing to both instances, failover after crash, running-but-unhealthy detection, controller recovery, recovery-disabled behavior, and status/public-service isolation from Docker control. Verify socket/network exposure and target authorization, including foreign project containers and replaced container IDs.
- GitHub Actions: pinned supported Node/Docker, lockfile `npm ci`, TypeScript checks, unit tests, production builds, browser states, Compose configuration validation, and bounded Linux Compose smoke tests. Upload logs/results on failure. The workflow itself is linted locally. No cloud credentials or deployment jobs; local ARM64 results are recorded separately from GitHub execution.
- README: prerequisites and daemon startup, architecture/trust boundaries, start/stop/reset commands, experiment commands and metric definitions, actual results, limitations, troubleshooting, and a short scholarship demo narrative. Commit lockfiles, `.env.example`, and experiment scripts; exclude secrets and generated dependencies. Explain precisely what was measured and what remains unproven.

**Completion criteria:** a fresh checkout can start locally, reproduce all three scenarios and both fault types, show genuine measurements, and demonstrate that public services cannot access Docker or request recovery of unrelated containers.
