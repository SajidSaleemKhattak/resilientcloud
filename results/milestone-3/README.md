# Milestone 3 evidence index

## Authoritative comparison

- `validated/manifest.json`: full protocol, runtime/image/source metadata, 27 completed trials and no failed attempts.
- `validated/summary.json` and `validated/trials.csv`: summaries regenerated only from saved evidence; dashboard charts use an identical copy at `dashboard/public/experiments/summary.json`.
- `validated/<trial-id>/`: original request JSONL, fault/container observations, readiness probes, controller/gate journals, effective Compose configuration, snapshot and logs for every trial.
- `validated-runner.log`: console output from the full run.
- `RESULTS.md`: readable group ranges and all individual trial values.
- `evidence-review.json`: deterministic summary regeneration, 108 raw-input hashes verified, no invalid/failed functional checks, and timing uncertainty/drift review.
- `final-validation.json`: final check inventory, matching experiment sources and dashboard summary, dashboard source hashes, and confirmation that dedicated test containers were removed.

The full matrix is separate from all short runner/functional smoke tests. The raw workloads include one-second guards around the 15-second baseline and 60-second observation; analysis and guard counts remain distinct. Configuration C's recovery is established by readiness probes, not Docker accepting restart. A/B recovery is not observed within the window. No skipped requests or trial retries occurred in the full matrix.

## Development and short attempts

`runner-smoke/` and `runner-smoke.log` preserve the initial short runner failure. C/crash passed two readiness probes but Docker's independent health polling still reported `starting`; the runner wrongly required immediate agreement. Both original attempts and logs are retained without rewriting. The corrected runner treats controller readiness and Docker health as separate evidence. `runner-smoke-2/` and its console log contain the subsequent nine-trial short validation; they are not part of the repeated comparison.

`dashboard/qa/attempt-1-browser-missing/` (relative to repository root) preserves the first browser attempt, started before its project-local Chromium download completed. This is a browser prerequisite failure, not a dashboard pass. The later fixture browser output is in `checks/browser-fixtures.log`.

During initial code checks, one controller test caught a changed checkpoint error name; the implementation retained the `invalid_checkpoint` error category. A status endpoint test caught headers being committed before an awaited file read could fail; the endpoint now reads first and returns a clean 503 on failure. Both were fixed before the passing final checks and before the experiment image was built.

## Validation

- `checks/`: lockfile installation, backend/controller/tool tests, dashboard model tests, type checks, production build and fixture browser logs.
- `ci-static/`: pinned action/download verification, workflow lint, smoke-wrapper tests and A/B/C Compose validation. `githubActionsRun` remains `not_run`.
- `dashboard-live/`: first passing real-stack dashboard checks and screenshots; includes a browser reporter path warning. Final validation uses a sibling HTML-report directory to avoid overlapping artifact paths.
- `dashboard-final/`: authoritative final real-stack validation; five integration/check groups and four actual browser tests passed. Healthy telemetry and all 27 saved trials were compared with real endpoints; stale/disconnected desktop/mobile states were produced by stopping the controller/status services. Two redundant saved-summary tests were intentionally skipped in those latter phases. Screenshots and sibling HTML-report directories are preserved.
- `ci-local/`: passing local execution of all 16 bounded recovery integration checks, completed in approximately 120 seconds on macOS ARM64 using Docker Linux containers. It is not a GitHub Actions run.

All milestone-1/milestone-2 evidence and both earlier local Git checkpoints are preserved. No cloud resources, deployment, publishing or push were performed. Three repetitions describe local observations and ranges only; all containers share the same host/VM failure domain.
