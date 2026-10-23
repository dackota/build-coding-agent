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

# Secret github-mcp-token in the agents namespace from GITHUB_TOKEN in .env, value
# "Bearer <token>": the Authorization header RemoteMCPServer github-mcp takes with headersFrom,
# which Substrate's egress gateway adds to the agent's requests. Delete and create, not apply
# (apply would copy the token into an annotation); the token reaches kubectl on stdin from
# printf (a builtin), so it is in no process's argv.
make_github_token_secret() {
  local token
  token="$(read_env_value "$GITHUB_TOKEN_NAME")"
  [ -n "$token" ] || fail "$GITHUB_TOKEN_NAME is missing or empty in $ENV_FILE (git out needs it; see .env.example)"
  k delete secret "$GITHUB_TOKEN_SECRET" -n "$AGENTS_NS" --ignore-not-found >/dev/null
  printf 'Bearer %s' "$token" | k create secret generic "$GITHUB_TOKEN_SECRET" -n "$AGENTS_NS" \
    --from-file=token=/dev/stdin >/dev/null
  echo "Secret $AGENTS_NS/$GITHUB_TOKEN_SECRET made from $GITHUB_TOKEN_NAME"
}

# The GitHub MCP server, restarted so a new image or args take effect. Its namespace holds no
# Secret: the old auth proxy's Secret and ConfigMap are deleted if a cluster still has them.
deploy_github_mcp() {
  sed "s|@GITHUB_MCP_IMAGE@|$GITHUB_MCP_IMAGE|" "$PLATFORM_DIR/github-mcp.yaml" | k apply -f -
  k delete secret "$GITHUB_TOKEN_SECRET" -n "$GITHUB_MCP_NS" --ignore-not-found
  k delete configmap github-mcp-proxy -n "$GITHUB_MCP_NS" --ignore-not-found
  k rollout restart deployment/github-mcp -n "$GITHUB_MCP_NS"
  k rollout status deployment/github-mcp -n "$GITHUB_MCP_NS" --timeout="$READY_TIMEOUT"
}

# Builds a skill image (FROM scratch, one SKILL.md at its root), pushes it to the local
# registry, and prints its address on the kind network pinned by digest (as for the agent image).
push_skill_image() {
  local repo="$1" skill_file="$2" dir ref_tag skill_digest ip
  dir="$(mktemp -d)"
  cp "$skill_file" "$dir/SKILL.md"
  printf 'FROM scratch\nCOPY SKILL.md /SKILL.md\n' >"$dir/Dockerfile"
  ref_tag="localhost:$REGISTRY_PORT/$repo:build-$(date +%s)"
  docker build -q -t "$ref_tag" "$dir" >/dev/null
  rm -rf "$dir"
  docker push -q "$ref_tag" >/dev/null
  skill_digest="$(curl -fsSI -H "Accept: $MANIFEST_TYPES" "http://localhost:$REGISTRY_PORT/v2/$repo/manifests/${ref_tag##*:}" |
    awk 'tolower($1) == "docker-content-digest:" {print $2}' | tr -d '\r')"
  [[ "$skill_digest" =~ ^sha256:[a-f0-9]{64}$ ]] || fail "no sha256 digest from the registry for $ref_tag (got: $skill_digest)"
  ip="$(docker inspect -f '{{(index .NetworkSettings.Networks "kind").IPAddress}}' "$REGISTRY_NAME")"
  [[ "$ip" =~ ^[0-9.]+$ ]] || fail "registry $REGISTRY_NAME has no address on the kind network"
  echo "$ip:$REGISTRY_INTERNAL_PORT/$repo@$skill_digest"
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
k wait --for=condition=Ready "agent/$AGENT" -n "$AGENTS_NS" --timeout="$READY_TIMEOUT"
echo "ok   Agent $AGENT is ready with $image"
# docs-agent: a second Agent on the same hello-harness (platform/docs-agent.yaml), with one
# skill that kagent mounts from a tiny image pinned by digest.
skill_image="$(push_skill_image docs-skill "$PLATFORM_DIR/skills/docs-style/SKILL.md")"
echo "pushed $skill_image"
sed "s|@DOCS_SKILL_IMAGE@|$skill_image|" "$PLATFORM_DIR/docs-agent.yaml" | k apply -f -
k wait --for=condition=Ready agent/docs-agent -n "$AGENTS_NS" --timeout="$READY_TIMEOUT"
echo "ok   Agent docs-agent is ready"
# triage-agent: the stock runtime, reading issues through github-mcp (issue_read only).
k apply -f "$PLATFORM_DIR/triage-agent.yaml"
k wait --for=condition=Ready agent/triage-agent -n "$AGENTS_NS" --timeout="$READY_TIMEOUT"
echo "ok   Agent triage-agent is ready"
