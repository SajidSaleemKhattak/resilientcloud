#!/bin/sh
# Authenticated host administration only. Archives before truncation, preserves status/budgets.
# Run weekly while the instance is being used. Download/verify archives before deleting copies.
set -eu
aws_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)
cd "$aws_root"
aws_stamp=$(date -u +%Y%m%dT%H%M%SZ)
aws_backup="$aws_root/.cache/event-archives/$aws_stamp"
mkdir -p "$aws_root/.cache/event-archives"
mkdir "$aws_backup"
aws_controller=$(sh deploy/aws/compose.sh ps -aq controller)
aws_gate=$(sh deploy/aws/compose.sh ps -aq gate)
test -n "$aws_controller" && test -n "$aws_gate"
export DOCKER_CONFIG="$aws_root/.cache/aws-docker"
export DOCKER_HOST=unix:///var/run/docker.sock
unset DOCKER_CONTEXT
for aws_id in "$aws_controller" "$aws_gate"; do
  test "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$aws_id")" = "$aws_root"
  test "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$aws_id")" = resilientcloud
done
for aws_volume in resilientcloud_controller-data resilientcloud_gate-data; do
  test "$(docker volume inspect --format '{{index .Labels "com.docker.compose.project"}}' "$aws_volume")" = resilientcloud
done
sh deploy/aws/compose.sh stop controller gate
# Copy only journals/checkpoint; no Docker config, .env, or TLS private-key material.
docker cp "$aws_controller:/data/controller.events.jsonl" "$aws_backup/controller.events.jsonl"
docker cp "$aws_controller:/data/status.json" "$aws_backup/status.json"
docker cp "$aws_gate:/audit/gate.events.jsonl" "$aws_backup/gate.events.jsonl"
(cd "$aws_backup" && gzip controller.events.jsonl gate.events.jsonl && sha256sum *.gz status.json > SHA256SUMS && sha256sum -c SHA256SUMS)
# An ephemeral helper mounts only the two project data volumes, offline from all networks.
# Never delete status.json: it contains consumed restart attempts and exhausted latches.
docker run --rm --pull never --network none --read-only --cap-drop ALL --user 1000:1000 \
  -v resilientcloud_controller-data:/controller \
  resilientcloud-recovery:aws node -e \
  'const fs=require("node:fs");const f=fs.openSync("/controller/controller.events.jsonl","r+");fs.ftruncateSync(f,0);fs.fsyncSync(f);fs.closeSync(f)'
docker run --rm --pull never --network none --read-only --cap-drop ALL --user 0:0 \
  -v resilientcloud_gate-data:/audit resilientcloud-recovery:aws node -e \
  'const fs=require("node:fs");const f=fs.openSync("/audit/gate.events.jsonl","r+");fs.ftruncateSync(f,0);fs.fsyncSync(f);fs.closeSync(f)'
sh deploy/aws/compose.sh up -d --no-build gate controller
if test -n "${SUDO_UID:-}" && test -n "${SUDO_GID:-}"; then chown -R "$SUDO_UID:$SUDO_GID" "$aws_backup"; fi
printf 'Archived to %s; budgets retained. Monitoring paused briefly during rotation.\n' "$aws_backup"
