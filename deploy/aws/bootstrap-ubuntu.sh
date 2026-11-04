#!/bin/bash
# Execute only over fingerprint-verified SSH on the authorized existing EC2 host.
set -euo pipefail
test "$(uname -m)" = aarch64
. /etc/os-release
test "$ID" = ubuntu && test "$VERSION_ID" = 24.04
test "$(cat /sys/devices/virtual/dmi/id/board_asset_tag)" = i-0cd68d680cd940476
sudo -n true
if command -v docker >/dev/null 2>&1; then
  echo 'Docker already exists; inspect it before changing packages.' >&2
  exit 2
fi
for package in docker.io docker-compose docker-compose-v2 podman-docker containerd runc; do
  if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q '^install ok installed$'; then
    echo "Existing package $package requires review; refusing an automatic uninstall." >&2
    exit 2
  fi
done
export DEBIAN_FRONTEND=noninteractive
sudo apt-get -o DPkg::Lock::Timeout=180 update
sudo DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=180 install -y ca-certificates curl python3
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
printf 'Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: %s\nComponents: stable\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/docker.asc\n' \
  "$VERSION_CODENAME" "$(dpkg --print-architecture)" | sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null
sudo apt-get -o DPkg::Lock::Timeout=180 update
docker_version='5:29.7.2-1~ubuntu.24.04~noble'
apt-cache madison docker-ce | grep -F "$docker_version"
sudo DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=180 install -y \
  "docker-ce=$docker_version" "docker-ce-cli=$docker_version" containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker --config /home/ubuntu/resilientcloud/.cache/aws-docker --host unix:///var/run/docker.sock version
sudo docker --config /home/ubuntu/resilientcloud/.cache/aws-docker --host unix:///var/run/docker.sock compose version
