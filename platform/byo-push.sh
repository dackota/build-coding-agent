#!/usr/bin/env bash
# Build a byo image from a folder with a Dockerfile, push it to the local registry, and print
# the image line for a values file: the registry's kind-network address, path and sha256
# digest (the only form the values schema takes). Usage: byo-push.sh DIR NAME
#   DIR   the folder to build, e.g. templates/byo-ts
#   NAME  the repository name in the registry, e.g. my-agent
set -euo pipefail
# shellcheck source=platform/lib.sh
. "$(dirname "$0")/lib.sh"

MANIFEST_TYPES="application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json"

dir="${1:-}"
name="${2:-}"
[ -n "$dir" ] && [ -n "$name" ] || fail "usage: byo-push.sh DIR NAME"
[ -f "$dir/Dockerfile" ] || fail "no Dockerfile in $dir"
[[ "$name" =~ ^[a-z0-9]+([._-][a-z0-9]+)*$ ]] || fail "NAME '$name' is not a registry repository name (lower-case letters, digits, . _ -)"

tag="build-$(date +%s)"
docker build -q -t "localhost:$REGISTRY_PORT/$name:$tag" "$dir" >/dev/null
docker push -q "localhost:$REGISTRY_PORT/$name:$tag" >/dev/null
digest="$(curl -fsSI -H "Accept: $MANIFEST_TYPES" "http://localhost:$REGISTRY_PORT/v2/$name/manifests/$tag" |
  awk 'tolower($1) == "docker-content-digest:" {print $2}' | tr -d '\r')"
[[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || fail "no sha256 digest from the registry for $name:$tag (got: $digest)"
ip="$(docker inspect -f '{{(index .NetworkSettings.Networks "kind").IPAddress}}' "$REGISTRY_NAME")"
[[ "$ip" =~ ^[0-9.]+$ ]] || fail "registry $REGISTRY_NAME has no address on the kind network"
echo "image: $ip:$REGISTRY_INTERNAL_PORT/$name@$digest"
