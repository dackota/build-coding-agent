#!/usr/bin/env bash
# Build the coding agent image (agent/) and each skill image (platform/skills/<name>/), push
# them to the local registry, read their sha256 digests from the registry, and pin them in
# the teams release: every team base's Harness coding runs the image by digest, and every
# Application gets the skill images. Argo CD deploys the agents themselves from
# deployments/<team>/<agent>/. Also runs the GitHub and demo MCP servers and makes the GitHub
# token Secret agentgateway holds. Usage: deploy.sh (run make up first). The agent holds no key.
set -euo pipefail
# shellcheck source=platform/lib.sh
. "$(dirname "$0")/lib.sh"

REPO="hello-agent"
READY_TIMEOUT="${READY_TIMEOUT:-180s}"
# How long Argo CD may take to (re)render an agent after the pins change.
AGENT_APPEAR_TIMEOUT="${AGENT_APPEAR_TIMEOUT:-180}"
# The platform team's agents (deployments/platform/), each waited for Ready.
PLATFORM_AGENTS="hello-agent docs-agent triage-agent"
MANIFEST_TYPES="application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json"

GITHUB_TOKEN_NAME="GITHUB_TOKEN"
GITHUB_TOKEN_SECRET="github-mcp-token"

# Secret github-mcp-token in agentgateway-system from GITHUB_TOKEN in .env: the GitHub MCP
# backend's auth (platform/gateway.yaml) sends it to github-mcp-server as
# "Authorization: Bearer <token>". No team namespace and no actor holds it; the copy a cluster
# built before this move kept in each team namespace is deleted. Delete and create, not apply
# (apply would copy the token into an annotation); the token reaches kubectl on stdin from
# printf (a builtin), so it is in no process's argv.
make_github_token_secret() {
  local token team teams
  token="$(read_env_value "$GITHUB_TOKEN_NAME")"
  [ -n "$token" ] || fail "$GITHUB_TOKEN_NAME is missing or empty in $ENV_FILE (git out needs it; see .env.example)"
  k delete secret "$GITHUB_TOKEN_SECRET" -n "$AGW_NS" --ignore-not-found >/dev/null
  printf '%s' "$token" | k create secret generic "$GITHUB_TOKEN_SECRET" -n "$AGW_NS" \
    --from-file=Authorization=/dev/stdin >/dev/null
  echo "Secret $AGW_NS/$GITHUB_TOKEN_SECRET made from $GITHUB_TOKEN_NAME"
  teams="$("$TEAMS_SH" names)"
  for team in $teams; do
    k delete secret "$GITHUB_TOKEN_SECRET" -n "team-$team" --ignore-not-found >/dev/null
  done
}

# The GitHub MCP server, restarted so a new image or args take effect. Its namespace holds no Secret.
deploy_github_mcp() {
  sed "s|@GITHUB_MCP_IMAGE@|$GITHUB_MCP_IMAGE|" "$PLATFORM_DIR/github-mcp.yaml" | k apply -f -
  k rollout restart deployment/github-mcp -n "$GITHUB_MCP_NS"
  k rollout status deployment/github-mcp -n "$GITHUB_MCP_NS" --timeout="$READY_TIMEOUT"
}

# push_image REPO TAG: push localhost:<port>/REPO:TAG and print it by digest on the registry's
# kind-network address. Substrate's atelet pulls images itself, from inside the cluster, where
# localhost:5001 is not the registry, and speaks plain HTTP only to a private IP.
push_image() {
  local repo="$1" tag="$2" digest ip
  docker push -q "localhost:$REGISTRY_PORT/$repo:$tag" >/dev/null
  digest="$(curl -fsSI -H "Accept: $MANIFEST_TYPES" "http://localhost:$REGISTRY_PORT/v2/$repo/manifests/$tag" |
    awk 'tolower($1) == "docker-content-digest:" {print $2}' | tr -d '\r')"
  [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || fail "no sha256 digest from the registry for $repo:$tag (got: $digest)"
  ip="$(docker inspect -f '{{(index .NetworkSettings.Networks "kind").IPAddress}}' "$REGISTRY_NAME")"
  [[ "$ip" =~ ^[0-9.]+$ ]] || fail "registry $REGISTRY_NAME has no address on the kind network"
  echo "$ip:$REGISTRY_INTERNAL_PORT/$repo@$digest"
}

# A skill image: FROM scratch, one SKILL.md at its root, that kagent mounts read-only.
push_skill_image() {
  local name="$1" dir tag
  dir="$(mktemp -d)"
  cp "$PLATFORM_DIR/skills/$name/SKILL.md" "$dir/SKILL.md"
  printf 'FROM scratch\nCOPY SKILL.md /SKILL.md\n' >"$dir/Dockerfile"
  tag="build-$(date +%s)"
  docker build -q -t "localhost:$REGISTRY_PORT/skill-$name:$tag" "$dir" >/dev/null
  rm -rf "$dir"
  push_image "skill-$name" "$tag"
}

# Every skill under platform/skills/ as a JSON object {name: image}.
push_skill_images() {
  local dir name image json="{}"
  for dir in "$PLATFORM_DIR"/skills/*/; do
    name="$(basename "$dir")"
    image="$(push_skill_image "$name")"
    echo "pushed skill $name: $image" >&2
    json="$(jq -c --arg n "$name" --arg i "$image" '. + {($n): $i}' <<<"$json")"
  done
  printf '%s\n' "$json"
}

# Wait for AGENT in NS to exist (Argo CD makes it) and then to be Ready.
wait_for_agent() {
  local agent="$1" ns="$2" deadline=$((SECONDS + AGENT_APPEAR_TIMEOUT))
  until k get agent "$agent" -n "$ns" -o name >/dev/null 2>&1; do
    [ "$SECONDS" -lt "$deadline" ] || fail "Agent $ns/$agent did not appear within ${AGENT_APPEAR_TIMEOUT}s (is Argo CD tracking a revision that has deployments/${ns#team-}/$agent/?)"
    sleep 3
  done
  k wait --for=condition=Ready "agent/$agent" -n "$ns" --timeout="$READY_TIMEOUT"
  echo "ok   Agent $ns/$agent is ready"
}

make_github_token_secret

tag="build-$(date +%s)"
docker build -q -t "localhost:$REGISTRY_PORT/$REPO:$tag" "$ROOT/agent" >/dev/null
image="$(push_image "$REPO" "$tag")"
echo "pushed $image"
skills="$(push_skill_images)"

# The MCP servers behind the catalog tools, ready before an agent needs them.
sed "s|@NODE_IMAGE@|$NODE_IMAGE|" "$PLATFORM_DIR/demo-mcp.yaml" | k apply -f -
k rollout status deployment/demo-mcp -n demo-mcp --timeout="$READY_TIMEOUT"
deploy_github_mcp

# Pin both in the teams release. --reset-then-reuse-values keeps what make up set (the team
# list, the worker image, the Argo CD revision) and takes the chart's current defaults.
h upgrade teams "$PLATFORM_DIR/charts/teams" -n "$ARGOCD_NS" --reset-then-reuse-values \
  --set "images.coding=$image" --set-json "images.skills=$skills" \
  --wait --timeout "$READY_TIMEOUT" >/dev/null
echo "pinned the coding image and skill images in every team base"

for agent in $PLATFORM_AGENTS; do wait_for_agent "$agent" "$PLATFORM_TEAM_NS"; done
