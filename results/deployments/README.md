# Remote deployment records

These records describe actual EC2 deployment attempts and checks. They are separate from `results/milestone-*`, which contains local experiments; no existing measurements are relabelled as EC2 results.

The user supplied existing instance `i-0cd68d680cd940476` in **ap-southeast-2**, not the originally proposed us-east-1. The target is `resilientcloud.getscoop.app` / `16.176.201.215`, Ubuntu 24.04 ARM64, t4g.small, Standard CPU credits. The account must remain on its Free plan. No new AWS resources are authorized by these records.

`i-0cd68d680cd940476/preflight/checks.json` records key metadata, checksums, DNS and the transition from presented/untrusted SSH fingerprints to exact verification against the user's AWS console system-log fingerprint. Only then did authentication occur. The key remains in Downloads with mode 0400; private-key contents, contact email and administrator source IP are excluded from committed records.

**Deployment succeeded:** https://resilientcloud.getscoop.app. `deployment.json` summarizes actual completed checks. `verification/` contains runtime isolation/health, public HTTPS/API/route checks, desktop/mobile screenshots and sanitized logs. `attempts/` preserves the initial failed loopback check and diagnosis; the deployment-only gateway edge-network correction passed subsequent checks. Certificate issuance, application startup and actual browser results were recorded separately, not inferred from DNS or SSH responding.

The user confirmed the security-group rules through the AWS console. Free-plan and Standard-credit settings are user-confirmed; this deployment performed no plan-changing AWS calls. The expected 48-hour stop deadline is **2026-11-06 18:47:43 UTC / 23:47:43 PKT**. No automatic EC2 stop is scheduled. The operator must stop the existing instance through EC2 by that deadline; Compose down alone does not stop compute charges.
