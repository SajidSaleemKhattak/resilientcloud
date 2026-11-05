# Historical EC2 launch checklist

**Historical pre-launch checklist.** The user subsequently supplied an already-running **ap-southeast-2** instance and authorized its deployment at **https://resilientcloud.getscoop.app**. See [the active deployment record](AWS-DEPLOYMENT.md). **Do not provision another instance/key/security group from this checklist.** The original us-east-1 proposal, missing-key check and HTTPS decision below describe the earlier planning state; they are not current blockers. Keep the Free plan and Standard CPU credits.

## Access preparation

**Later resolved:** the user downloaded `resilientcloud.pem`; it was found in Downloads, set to mode 0400 and used outside the repository after the AWS console host-fingerprint comparison. No proposed new Ed25519 key/key-pair resource was generated. The paragraphs below retain the original scoped-search result and proposal.

The local check found no `~/.ssh` directory, no key candidates in the home top level or the checked Downloads/Desktop/Documents/keys/project folders (up to three levels), and no loaded SSH-agent identities. This is a scoped search, not proof that no key exists anywhere on the Mac. Only filenames, metadata and public fingerprints were checked; no private-key contents were read or printed.

A key must therefore be selected or created before eventual launch. Proposed EC2 key-pair name: **`resilientcloud-demo-ed25519`**, imported in **us-east-1** from a passphrase-protected local Ed25519 public key. No key or key-pair resource has been created. Do not select “Proceed without a key pair.” [AWS key-pair guidance](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-key-pairs.html).

If a new key is authorized later, keep it in the ignored project-local `.cache/ssh/` directory, outside the release bundle. Generate it interactively with a passphrase, import only its `.pub` file through EC2 → Network & Security → Key pairs → Actions → Import key pair, and retain the private file only on the Mac. Never paste private-key material into chat or Git. Key generation/import is not part of the work executed so far.

The current public IPv4 was checked against two services and agreed. **Its value is deliberately absent from this file and all tracked project files.** Use the `/32` reported in chat for the security group's SSH source, rechecking it immediately before launch if the network/VPN changes. The EC2 console's “My IP” must agree with the Mac that will initiate SSH.

## Console values to enter after the HTTPS/domain decision

| Console setting | Exact planned value |
| --- | --- |
| Account | Existing **Free plan**; no upgrade, Organizations, Control Tower or advanced-feature activation |
| Region | **US East (N. Virginia), `us-east-1`** |
| Name | `resilientcloud-demo` |
| Number of instances | **1** |
| AMI | **Ubuntu Server 24.04 LTS, ARM64, official Canonical, non-Pro**, with Free Tier eligible badge |
| AMI ID | Select the current matching regional AMI in the console; no AMI ID has been fabricated or account-verified |
| Instance type | **`t4g.small`**, 2 ARM64 vCPUs, 2 GiB RAM; verify Free Tier eligible |
| Purchasing / tenancy | Linux **On-Demand / Shared**; no Spot, reservation or Savings Plan |
| Key pair | `resilientcloud-demo-ed25519` **after the public key is imported**; currently pending |
| VPC/subnet | Existing default VPC, public subnet with Internet Gateway route; no NAT or VPC endpoints |
| Auto-assign public IPv4 | **Enable**; no Elastic IP allocation |
| Security group name | `resilientcloud-demo-sg` (not created) |
| SSH inbound | TCP **22**, custom source **the verified current public IPv4 `/32` from chat**, never `0.0.0.0/0` |
| HTTP inbound | TCP **80** from `0.0.0.0/0` **only if the public-domain Caddy HTTPS option is selected** |
| HTTPS inbound | TCP **443** from `0.0.0.0/0` **only if the public-domain Caddy HTTPS option is selected** |
| All other inbound | No rules; keep 3000, 4000, 8080, 2019, 2375 and 2376 closed |
| IPv6 | Not enabled; no IPv6 inbound rules |
| Outbound | Default allow-all outbound for OS updates, DNS and ACME |
| Root volume | **20 GiB gp3**, **3,000 IOPS**, **125 MiB/s**, encrypted using AWS-managed EBS key |
| Delete root volume on termination | **Yes** |
| Extra storage / snapshots | None |
| Advanced details → Credit specification | **Standard** — explicitly change the T4g default Unlimited setting |
| IAM instance profile | None |
| Detailed monitoring | Disabled |
| Metadata endpoint | Disabled; application requires no AWS credentials or metadata |
| Shutdown behavior | **Stop** |
| Stop/termination protection | Disabled so the planned shutdown/cleanup is not obstructed |
| User data | Empty; follow the manual Docker/bundle instructions after approval |
| Optional identifying tag | `Project=ResilientCloud`, `DemoWindow=48h` |
| Launch action | **Do not click Launch until the HTTPS/domain decision and provisioning authorization are resolved** |

AWS documents t4g.small eligibility and the console's Advanced details → Credit specification control. **T4g defaults to Unlimited**, so checking Standard explicitly is required. [EC2 eligibility](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-free-tier-usage.html), [credit specification](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/burstable-performance-instances-how-to.html).

If the AMI/type is not eligible, the subnet is unavailable, or the console requests a Paid-plan upgrade, stop for review. No authenticated AWS inspection has been performed, so regional AMI IDs, capacity, VPC/subnet IDs and account-specific quotas remain launch-time checks. Do not substitute a paid-plan resource to get past a restriction.

## Original HTTPS options — resolved by the supplied public hostname

- **Existing public domain/subdomain:** provide its hostname, DNS control and certificate-contact email. Use the prepared Caddy overlay; open only the public ingress ports above and point an A record at the instance after approval.
- **Private SSH preview:** port 22 only, with an SSH tunnel to gateway loopback 8080. This is encrypted private access, not a public browser-trusted HTTPS deployment. The public Caddy startup configuration must not be used blindly with a placeholder hostname; review the selected mode before launch.

No domain purchase, Route 53 hosted zone, certificate issuance, DNS update or AWS resource is authorized by this checklist.

## Historical forty-eight-hour budget

The original 48-hour window is historical budgeting only. The user has since requested continued hosting beyond 6 November, limited by remaining credits and Free-plan expiry. There is no current stop deadline and no automatic stop scheduler. Follow [the active hosting policy](AWS-DEPLOYMENT.md#ongoing-hosting-and-credit-limits); keep the Free plan and Standard CPU credits.

| Component | 48-hour estimate |
| --- | --- |
| t4g.small compute | $0.8064 |
| One public IPv4 | $0.2400 |
| 20 GiB gp3 for 48 hours | About $0.1052 |
| **Total credit consumption** | **About $1.15** |
| Balance from the confirmed $100, absent other usage | **About $98.85** |

This uses the existing public AWS price snapshot, no trial discount and no paid extras; storage proration, other usage, taxes and excess transfer can change the total. The [cost model](../results/aws-preparation/cost-estimate.json) retains the assumptions.

Only when shutdown is separately requested: export any new EC2 evidence, run the project Compose `down` command, **stop the instance through EC2 and verify Stopped**, then check the credit balance. EBS remains approximately $1.60/month while retained; the auto-assigned public IPv4 is released on stop. If the demo is finished, terminate after saving evidence and verify deletion of its root EBS volume. Preserve local milestone evidence. Follow the scoped cleanup instructions in [AWS.md](AWS.md).
