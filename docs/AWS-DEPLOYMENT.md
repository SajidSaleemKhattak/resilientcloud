# Active EC2 deployment

**Working URL: https://resilientcloud.getscoop.app**

Deployed and verified on **2026-11-05 PKT (2026-11-04 UTC)** using only the user-supplied existing instance. No additional AWS resources or account-plan changes were made.

| Setting | Actual value / verification |
| --- | --- |
| Instance | `i-0cd68d680cd940476` |
| Region | **ap-southeast-2 (Sydney)**; supersedes the original us-east-1 proposal |
| Public IP | `16.176.201.215` |
| OS / size | Ubuntu 24.04 ARM64, t4g.small; OS/architecture/instance ID checked over verified SSH |
| Account / CPU credits | **Free plan / Standard**, user-confirmed; no AWS operations changed them |
| Root disk | Approximately 20 GiB, 19 GiB filesystem; disk size/free space checked remotely |
| Runtime | Docker **29.7.2**, API 1.55 (supports gate API 1.53), Compose **5.7.0** |
| SSH key | `~/Downloads/resilientcloud.pem`, mode **0400**, retained outside Git; contents never printed |
| Server identity | ED25519 fingerprint compared exactly against the user-provided AWS console system log before authentication |
| Certificate | Trusted **Let's Encrypt**, hostname/chain and HTTP→HTTPS redirect verified |
| Public application ports | Caddy TCP 80/443 only; gateway 8080 is loopback-only |
| SSH access | TCP 22 restricted to the operator's current `/32`, confirmed by the user in the AWS console; that address is not stored here |
| Fault injection | **Disabled** in both backend environments; HTTP fault/recovery paths rejected |
| Recovery | Controller running, fresh healthy probes for both backends; Docker restart policies remain `no` |

## Verified behavior

The transferred bundle's three SHA256 checks and four ARM64 image identities passed on EC2. All seven containers are running. Only the private gate mounts Docker's socket; status has read-only controller data, no Docker/gate socket, and only its internal status-read network. Backend/controller networks remain internal and the gate has no network. External checks could not connect to ports 3000, 4000, 8080, 2019, 2375 or 2376.

Public checks passed for the dashboard, status, incident feed, favicon and saved result summary. All **20 actual API smoke requests succeeded**, with responses from both backend identities. **24 route checks** confirmed expected GET responses and denied public mutation/fault/recovery paths. Real Chromium desktop/mobile checks matched the displayed container IDs to current telemetry, verified all saved-result tabs, found no document overflow and recorded zero browser errors.

The 27 saved trials are still **local experiment evidence**, not EC2 experiments. No fault experiment or completed matrix rerun was performed remotely. Healthy startup issued no controller restart actions. This deployment check does not establish EC2 failover/recovery timings, zero downtime or host-failure protection.

Evidence is under [`results/deployments/i-0cd68d680cd940476/`](../results/deployments/i-0cd68d680cd940476/deployment.json), separate from all local milestone evidence. Private-key material, TLS private keys, certificate-contact email and administrator source IP are excluded from committed records.

## Deployment correction

The initial application start succeeded over public HTTPS, but the administrative `127.0.0.1:8080/status` check failed. Docker suppressed the host-port mapping because the gateway joined only internal bridges. The original failed attempt/diagnosis are preserved separately.

The deployed AWS overlay now also attaches **only the gateway** to the existing edge bridge, retaining the explicit `127.0.0.1:8080` binding. Backend, status, controller and gate isolation is unchanged. The gateway was recreated alone; backend IDs/start times and healthy telemetry remained unchanged. Loopback administration and public HTTPS were reverified after the correction.

Do not re-extract the original `files.tar.gz` over the running project: it contains the pre-correction AWS overlay. The current `deploy/aws/compose.aws.yaml` is authoritative. Generate a fresh bundle from current source for any future fresh deployment.

## Administration

From the local repository root, use the console-verified, project-local known-host pin:

```sh
ssh -F /dev/null -i "$HOME/Downloads/resilientcloud.pem" \
  -o IdentitiesOnly=yes -o IdentityAgent=none -o StrictHostKeyChecking=yes \
  -o HostKeyAlgorithms=ssh-ed25519 \
  -o UserKnownHostsFile="$PWD/.cache/deployment-i-0cd68d680cd940476/known_hosts" \
  -o GlobalKnownHostsFile=/dev/null ubuntu@16.176.201.215
```

On EC2:

```sh
cd ~/resilientcloud
sudo sh deploy/aws/compose.sh ps
curl --fail --silent http://127.0.0.1:8080/status | python3 -m json.tool
sudo sh deploy/aws/compose.sh logs --tail 50 controller gate
df -h /
```

The runtime `.env` holds the provided certificate email and `RC_ENABLE_FAULTS=false`, mode 0600. No cloud credentials or registry login were installed. Keep public fault injection disabled. Do not recreate/enable backend fault handlers unless a separate authenticated demonstration is explicitly intended.

## Ongoing hosting and credit limits

The user superseded the initial 48-hour stop plan on 5 November 2026: **keep the existing instance running beyond 6 November**. There is no scheduled stop deadline. **No automatic stopping is configured or authorized.** Keep the AWS **Free plan** and **Standard** CPU credits; do not upgrade the account plan.

Hosting depends on the **remaining credit balance and actual Free-plan expiry shown in the AWS console**. The originally reported $100 and 182 days are not a current billing reading. Check Billing and Cost Management → Credits and the Free Tier account-plan/expiry details regularly; the remaining balance and expiry have not been queried through authenticated AWS APIs. Retain the weekly journal archive/offload procedure in [AWS.md](AWS.md) and monitor `df -h /` so extended hosting does not fill the disk.

Launch was 4 November 2026, 18:47:43 UTC. The original 48-hour estimate below is historical budgeting evidence, not a shutdown instruction. Immutable deployment records retain the earlier plan for provenance; this section is the current operating policy.

The deployment-time official Sydney rates yielded approximately **$1.38** for 48 hours: compute $1.0176, public IPv4 $0.24, assumed 20 GiB gp3 about $0.1262. No promotional discount is assumed. Storage remains metered while the instance is stopped. These are estimates, excluding other usage/taxes/excess transfer; no authenticated billing balance was queried. See the separately saved [regional estimate](../results/deployments/i-0cd68d680cd940476/preflight/48-hour-estimate.json) and [official Sydney price list](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/ap-southeast-2/index.csv).

When shutdown is separately requested, first download any new logs/evidence needed. Run `sudo sh deploy/aws/compose.sh down` to preserve data/certificate volumes, then stop through EC2. Auto-assigned public IPv4 is released on stop; a later start needs an updated DNS A record and explicit Compose startup. Do not upgrade the Free plan, allocate paid extras, terminate before saving data, or clean unrelated Docker/AWS resources.
