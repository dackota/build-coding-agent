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

GITHUB_TOKEN_NAME="GITHUB_TOKEN"
GITHUB_MCP_NS="github-mcp"
GITHUB_TOKEN_SECRET="github-mcp-token"

# Secret github-mcp-token from GITHUB_TOKEN in .env, for the GitHub MCP server's auth proxy
# only. Delete and create, not apply (apply would copy the token into an annotation); the
# token reaches kubectl on stdin from printf (a builtin), so it is in no process's argv.
make_github_token_secret() {
  local token
  token="$(read_env_value "$GITHUB_TOKEN_NAME")"
  [ -n "$token" ] || fail "$GITHUB_TOKEN_NAME is missing or empty in $ENV_FILE (git out needs it; see .env.example)"
  k create namespace "$GITHUB_MCP_NS" --dry-run=client -o yaml | k apply -f - >/dev/null
  k delete secret "$GITHUB_TOKEN_SECRET" -n "$GITHUB_MCP_NS" --ignore-not-found >/dev/null
  printf %s "$token" | k create secret generic "$GITHUB_TOKEN_SECRET" -n "$GITHUB_MCP_NS" \
    --from-file=token=/dev/stdin >/dev/null
  echo "Secret $GITHUB_MCP_NS/$GITHUB_TOKEN_SECRET made from $GITHUB_TOKEN_NAME"
}

# The GitHub MCP server and its auth proxy; restarted so a new token or proxy takes effect.
deploy_github_mcp() {
  k create configmap github-mcp-proxy -n "$GITHUB_MCP_NS" \
    --from-file=github-mcp-proxy.mjs="$PLATFORM_DIR/github-mcp-proxy.mjs" --dry-run=client -o yaml | k apply -f -
  sed -e "s|@NODE_IMAGE@|$NODE_IMAGE|" -e "s|@GITHUB_MCP_IMAGE@|$GITHUB_MCP_IMAGE|" "$PLATFORM_DIR/github-mcp.yaml" | k apply -f -
  k rollout restart deployment/github-mcp -n "$GITHUB_MCP_NS"
  k rollout status deployment/github-mcp -n "$GITHUB_MCP_NS" --timeout="$READY_TIMEOUT"
}

make_github_token_secret

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
# The GitHub MCP server the AgentTemplate binds with requireApproval, for git out.
deploy_github_mcp
# Egress for git over HTTPS and npm, by DNS name; no credential in it.
k apply -f "$PLATFORM_DIR/egress.yaml"
sed "s|@IMAGE@|$image|" "$PLATFORM_DIR/agent.yaml.tmpl" | k apply -f -
k wait --for=condition=Ready "agent/$AGENT" -n "$KAGENT_NS" --timeout="$READY_TIMEOUT"
# docs-agent: a second Agent on the same hello-harness (platform/docs-agent.yaml).
k apply -f "$PLATFORM_DIR/docs-agent.yaml"
k wait --for=condition=Ready agent/docs-agent -n "$KAGENT_NS" --timeout="$READY_TIMEOUT"
echo "ok   Agent $AGENT is ready with $image"
# triage-agent: the stock runtime, reading issues through github-mcp (issue_read only).
k apply -f "$PLATFORM_DIR/triage-agent.yaml"
k wait --for=condition=Ready agent/triage-agent -n "$KAGENT_NS" --timeout="$READY_TIMEOUT"
echo "ok   Agent triage-agent is ready"
