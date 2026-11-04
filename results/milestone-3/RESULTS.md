# Milestone 3 measured results

Generated from `validated/summary.json`; individual values are in `validated/trials.csv` and the raw JSONL. Each fault group contains three fresh trials. Controls have no post-fault rate.

| Configuration | Fault | Whole-trial success range | Post-fault success range | Detection range | Recovery range |
| --- | --- | --- | --- | --- | --- |
| A | control | 100.000% | Not applicable | Not applicable | Not applicable |
| A | crash | 20.000% | 0.000% | 1.028 s–1.048 s | Not observed |
| A | unhealthy | 20.000% | 0.000% | 1.035 s–1.123 s | Not observed |
| B | control | 100.000% | Not applicable | Not applicable | Not applicable |
| B | crash | 99.867% | 99.833% | 1.026 s–1.478 s | Not observed |
| B | unhealthy | 100.000% | 100.000% | 1.059 s–1.438 s | Not observed |
| C | control | 100.000% | Not applicable | Not applicable | Not applicable |
| C | crash | 99.867%–100.000% | 99.833%–100.000% | 1.433 s–1.462 s | 2.432 s–2.459 s |
| C | unhealthy | 100.000% | 100.000% | 1.051 s–1.067 s | 2.059 s–2.070 s |

| Trial | Whole successes/requests | Post-fault successes/requests | p95 latency (all outcomes) | Detection | Recovery | Skipped |
| --- | --- | --- | --- | --- | --- | --- |
| A-control-1 | 750/750 | Not applicable | 6.015 ms | Not applicable | Not applicable | 0 |
| B-control-1 | 750/750 | Not applicable | 6.775 ms | Not applicable | Not applicable | 0 |
| C-control-1 | 750/750 | Not applicable | 5.503 ms | Not applicable | Not applicable | 0 |
| A-crash-1 | 150/750 | 0/600 | 4.537 ms | 1.028 s | Not observed | 0 |
| B-crash-1 | 749/750 | 599/600 | 4.831 ms | 1.478 s | Not observed | 0 |
| C-crash-1 | 749/750 | 599/600 | 5.054 ms | 1.462 s | 2.459 s | 0 |
| A-unhealthy-1 | 150/750 | 0/600 | 4.492 ms | 1.035 s | Not observed | 0 |
| B-unhealthy-1 | 750/750 | 600/600 | 4.846 ms | 1.438 s | Not observed | 0 |
| C-unhealthy-1 | 750/750 | 600/600 | 4.813 ms | 1.051 s | 2.059 s | 0 |
| A-crash-2 | 150/750 | 0/600 | 4.316 ms | 1.048 s | Not observed | 0 |
| B-crash-2 | 749/750 | 599/600 | 4.575 ms | 1.051 s | Not observed | 0 |
| C-crash-2 | 749/750 | 599/600 | 4.930 ms | 1.433 s | 2.433 s | 0 |
| A-unhealthy-2 | 150/750 | 0/600 | 4.514 ms | 1.051 s | Not observed | 0 |
| B-unhealthy-2 | 750/750 | 600/600 | 4.613 ms | 1.059 s | Not observed | 0 |
| C-unhealthy-2 | 750/750 | 600/600 | 4.672 ms | 1.057 s | 2.064 s | 0 |
| A-control-2 | 750/750 | Not applicable | 5.146 ms | Not applicable | Not applicable | 0 |
| B-control-2 | 750/750 | Not applicable | 4.734 ms | Not applicable | Not applicable | 0 |
| C-control-2 | 750/750 | Not applicable | 4.812 ms | Not applicable | Not applicable | 0 |
| A-unhealthy-3 | 150/750 | 0/600 | 4.439 ms | 1.123 s | Not observed | 0 |
| B-unhealthy-3 | 750/750 | 600/600 | 4.636 ms | 1.073 s | Not observed | 0 |
| C-unhealthy-3 | 750/750 | 600/600 | 4.686 ms | 1.067 s | 2.070 s | 0 |
| A-control-3 | 750/750 | Not applicable | 4.551 ms | Not applicable | Not applicable | 0 |
| B-control-3 | 750/750 | Not applicable | 4.764 ms | Not applicable | Not applicable | 0 |
| C-control-3 | 750/750 | Not applicable | 4.737 ms | Not applicable | Not applicable | 0 |
| A-crash-3 | 150/750 | 0/600 | 4.188 ms | 1.030 s | Not observed | 0 |
| B-crash-3 | 749/750 | 599/600 | 5.475 ms | 1.026 s | Not observed | 0 |
| C-crash-3 | 750/750 | 600/600 | 5.576 ms | 1.440 s | 2.432 s | 0 |

All 27 trials were valid; all applicable functional checks passed. No requests were skipped, no trials were retried, and all nine controls had no false recovery actions. Recovery was not observed in A or B. All sibling readiness probes succeeded in B/C, and sibling container start times stayed unchanged.

The 75-second analysis windows contain 20,250 actual requests: 16,645 successes and 3,605 failures. The 77-second raw workloads contain 20,790 requests: 17,131 successes and 3,659 failures. The difference is guard traffic, explicitly excluded from analysis denominators. These mixed totals describe the protocol, not a deployment availability estimate.

Clock calibration uncertainty was ±40.5–44.1 ms; the largest before/after mapping drift was 13.3 ms. Durations also depend on probe cadence, command execution and scheduling. Recovery requires two readiness probes and identity verification, not Docker restart acceptance.

Three repetitions show individual outcomes and ranges only. No claim of statistical significance, guaranteed zero downtime, production reliability or host-failure protection is justified. See `../../docs/EXPERIMENTS.md` for the complete protocol.
