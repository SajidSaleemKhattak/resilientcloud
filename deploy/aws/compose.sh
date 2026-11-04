#!/bin/sh
# Run on the future EC2 host through authenticated SSH. Never runs AWS APIs.
set -eu
aws_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)
test "$#" -gt 0 || { echo 'Usage: sh deploy/aws/compose.sh <Compose command>' >&2; exit 1; }
for aws_arg do
  case "$aws_arg" in
    -p|-p?*|-f|-f?*|--project*|--file*|--env-file*) echo 'Project/file overrides are disabled' >&2; exit 1;;
  esac
done
case "${DOCKER_HOST:-unix:///var/run/docker.sock}" in
  unix:///*) ;; *) echo 'Use the host-local Docker Unix socket only' >&2; exit 1;;
esac
test -f "$aws_root/deploy/aws/.env" || { echo 'Create deploy/aws/.env from the example first' >&2; exit 1; }
mkdir -p "$aws_root/.cache/aws-docker"
printf '{"auths":{}}\n' > "$aws_root/.cache/aws-docker/config.json"
export PROJECT_DIRECTORY="$aws_root"
test -f "$aws_root/deploy/aws/release.yaml" || { echo 'Use the prepared bundle: release.yaml is missing' >&2; exit 1; }
exec docker --config "$aws_root/.cache/aws-docker" --host "${DOCKER_HOST:-unix:///var/run/docker.sock}" compose \
  --project-directory "$aws_root" --env-file "$aws_root/deploy/aws/.env" -p resilientcloud \
  -f "$aws_root/compose.yaml" -f "$aws_root/compose.two.yaml" \
  -f "$aws_root/compose.recovery.yaml" -f "$aws_root/compose.dashboard.yaml" \
  -f "$aws_root/deploy/aws/compose.aws.yaml" -f "$aws_root/deploy/aws/release.yaml" "$@"
