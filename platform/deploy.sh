#!/usr/bin/env bash
# Build the agent image, push it to the local registry, read its sha256 digest from the
# registry, and apply the Harness/AgentTemplate/Agent with image@sha256:<digest>.
# Usage: deploy.sh (run make up first). The agent holds no key; the gateway does.
set -euo pipefail
# shellcheck source=platform/lib.sh
. "$(dirname "$0")/lib.sh"

REPO="hello-agent"
AGENT="hello-agent"
READY_TIMEOUT="${READY_TIMEOUT:-180s}"
MANIFEST_TYPES="application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json"

tag="build-$(date +%s)"
ref="localhost:$REGISTRY_PORT/$REPO:$tag"
docker build -q -t "$ref" "$ROOT/agent" >/dev/null
docker push -q "$ref" >/dev/null
digest="$(curl -fsSI -H "Accept: $MANIFEST_TYPES" "http://localhost:$REGISTRY_PORT/v2/$REPO/manifests/$tag" |
  awk 'tolower($1) == "docker-content-digest:" {print $2}' | tr -d '\r')"
[[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || fail "no sha256 digest from the registry for $ref (got: $digest)"
# Substrate's atelet pulls images itself, from inside the cluster, where localhost:5001
# is not the registry. It speaks plain HTTP only to a private IP, so name the image by the
# registry's address on the kind network. The digest is that of the image pushed above.
registry_ip="$(docker inspect -f '{{(index .NetworkSettings.Networks "kind").IPAddress}}' "$REGISTRY_NAME")"
[[ "$registry_ip" =~ ^[0-9.]+$ ]] || fail "registry $REGISTRY_NAME has no address on the kind network"
image="$registry_ip:$REGISTRY_INTERNAL_PORT/$REPO@$digest"
echo "pushed $image"

# The MCP server the AgentTemplate binds with requireApproval, ready before the agent needs it.
sed "s|@NODE_IMAGE@|$NODE_IMAGE|" "$PLATFORM_DIR/demo-mcp.yaml" | k apply -f -
k rollout status deployment/demo-mcp -n demo-mcp --timeout="$READY_TIMEOUT"
sed "s|@IMAGE@|$image|" "$PLATFORM_DIR/agent.yaml.tmpl" | k apply -f -
k wait --for=condition=Ready "agent/$AGENT" -n "$KAGENT_NS" --timeout="$READY_TIMEOUT"
echo "ok   Agent $AGENT is ready with $image"
