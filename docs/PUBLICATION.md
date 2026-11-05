# GitHub publication review

Reviewed on **2026-11-05 (Asia/Karachi)**. The initial review was preparation only. The user subsequently explicitly authorized publishing the full audited history to `https://github.com/SajidSaleemKhattak/resilientcloud.git` on `main` without force-pushing. The live EC2 application was not changed by this review.

## Secret and certificate review

The initial repository snapshot at `dc36f00` contained **677 tracked files**. The review scanned tracked contents and **664 reachable historical Git blobs** across all local refs, including ZIP trace members and ZIP data embedded in Playwright HTML reports. Fifteen unique archives and 30 members were inspected in each scope, with no extraction/scan errors. Candidate reports contain rule names, paths and line numbers only; secret values are never printed.

The checks cover private-key blocks, AWS access IDs/secret assignments, provider tokens, bearer/JWT shapes, authenticated URLs, private runtime contact/source-IP values, and certificate material. Files/configuration were also inspected for accidentally tracked credentials, SSH keys, TLS/ACME state and environment files. PNG screenshots are dashboard captures; the automated text scan does not OCR image pixels. Representative actual dashboard screenshots were visually reviewed during validation.

Two intentional public/test items were reviewed rather than deleted:

| Item | Classification |
| --- | --- |
| `results/aws-preparation/profile/test-public-root.crt` | Public X.509 certificate from the local test CA. No associated private key is tracked or found in reachable history. It is not the live EC2 certificate/key. Retained to preserve the verified local HTTPS evidence. |
| Credential-shaped loopback URL in `tools/traffic.test.mjs` | Deliberately invalid fixture used to verify that the traffic CLI rejects credential-bearing URLs. It is not a working credential. |

No private keys, live certificate private-key material, actual credential candidates, certificate-contact email or administrator source IP were found in the scanned publication contents/history. Existing local/deployment measurements and source checkpoints were preserved; no history rewrite or evidence redaction was needed in this review.

Independent **Gitleaks 8.30.1** scans with default rules and 100% redacted output found **zero findings across reachable Git history and the staged publication tree**. The official macOS ARM64 release archive was SHA256-checked against the release checksum file and used only inside ignored project cache; no system package was installed and no repository contents were uploaded. [Official release](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1).

## Ignore coverage

The ignore rules cover `.env`/runtime variants, project caches and binary deployment bundles, common private key/certificate/keystore extensions, extensionless SSH identity names, SSH/AWS/Docker config directories, `.netrc`, and Caddy/ACME/TLS state directories. The public test-CA certificate has one explicit, documented exception. Placeholder-only `.env.example` remains publishable.

**36 path checks passed:** 29 secret/runtime paths are ignored and seven intended public files remain allowed, including both lockfiles, the example environment, selected evidence and the public test certificate. These checks use `git check-ignore --no-index` so they test the rules even for already-tracked paths. Ignore rules do not erase a file already in Git history; the history scan is therefore a separate check.

The downloaded SSH key stays in Downloads, outside the checkout. Actual runtime configuration, host-key cache, transfer bundles and local tooling remain in ignored `.cache/`. No SSH/private certificate material was opened or copied for this publication review.

## Intentional public metadata

Publication includes the live demo hostname/public IP, EC2 instance ID, public SSH host fingerprint, container IDs/private bridge addresses, runtime versions, source hashes and original local paths in measured evidence. These are operational metadata, not access credentials. They are retained to keep the deployment and experiments reviewable. The dashboard remains read-only, and its saved charts are explicitly local measurements rather than EC2 benchmarks.

## README and publication state

The README includes the live URL and credit/Free-plan-limited hosting policy, local/AWS architecture and Docker boundary, measured A/B/C comparisons with whole/post-fault rates, single-host/sample-size limitations, exact local startup/test commands, and reproduction commands for new evidence directories. Existing CI is validation-only; no successful GitHub-hosted run is claimed before the workflow actually runs there.

The destination was inspected before configuring origin: `git ls-remote` succeeded with no existing refs. Origin is now configured to the supplied destination and the full history was pushed to `main` without force. Actual [GitHub-hosted Linux CI passed at `a18d30b`](https://github.com/SajidSaleemKhattak/resilientcloud/actions/runs/41968345721). The initial run failed Compose validation because a `unix://` URL was used as a mount source; the workflow now derives a filesystem path from the local Unix endpoint without changing isolation. Initial failure, successful job steps and publication summary are recorded under `results/publication-review/github/`, separately from the original audit. No project license was selected as part of this review.

The machine-readable review and ignore-path results are stored under `results/publication-review/`. Original audit/evidence snapshots are preserved unchanged.
