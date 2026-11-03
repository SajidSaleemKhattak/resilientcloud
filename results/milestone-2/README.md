# Milestone 2 evidence

- `attempt-1/startup-failure.txt`: runner parse failure before containers/tests started. Fixed duplicate variable declaration; no runtime checks passed in this attempt.
- `attempt-2/`: failed crash trial. The controller recovered successfully, but an overly strict zero-gateway-error assertion failed on two recorded 504s. A second reporting bug obscured that assertion. `diagnosis.txt` explains both; original raw events and failed report remain unchanged.
- `attempt-3/`: passing validation before the final verification-deadline hardening, 16 checks. Raw requests, events, runtime configuration and timings are retained.
- `final/`: passing validation of the final implementation, 16 checks, including capped verification I/O and refusal of late readiness. Client errors remain recorded; sibling availability is verified independently. Isolation was unchanged.
- `final-verified/`: failed verification after Docker's UTC clock shifted. Recovery occurred, but a cross-clock polling comparison timed out. Raw evidence and `diagnosis.txt` are preserved.
- `monotonic-validation/`: failed trial with 36 recorded scheduler skips and changing host/VM clock mapping. Raw actual requests and diagnosis retained.
- `validated/`: final passing validation, 16 checks, using monotonic policy durations, calibration before/after every fault, and idle-sleep prevention. Its source hashes match the checkpoint implementation. 710 actual requests: 708 successful, 2 HTTP 504 responses, zero skipped slots.
- `tests.txt`: earlier automated test output, 42 passed.
- `tests-final.txt`: final automated test output, 43 passed, including the deadline regression.
- `tests-monotonic.txt`: 45 passed, including forward/backward UTC-jump regressions.

These are functional trials, not the future repeated statistical comparison. No milestone-1 evidence was modified. See `../../docs/RECOVERY.md` for timing definitions and limitations.
