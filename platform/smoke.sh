#!/usr/bin/env bash
# Live smoke test on the running platform (run make up first). Usage: smoke.sh
#  1. Push a tiny image to the local registry, read its sha256 digest, and apply a
#     kagent Harness that names the image by that digest. The API server must accept
#     it, and the kind node must pull the image by digest from the registry.
#  2. Send one A2A message to triage-agent, the platform team's agent on kagent's stock
#     runtime, which answers through agentgateway, and print the reply. This spends model
#     tokens on the OpenCode Go plan.
set -euo pipefail
# shellcheck source=platform/lib.sh
. "$(dirname "$0")/lib.sh"

SMOKE_REPO="registry-smoke"
SMOKE_HARNESS="registry-smoke"
# A stock-runtime agent of the platform team (deployments/platform/triage-agent).
SMOKE_AGENT="triage-agent"
LOCAL_PORT="${LOCAL_PORT:-18083}"
REPLY_TIMEOUT="${REPLY_TIMEOUT:-300}"
RETRY_DELAY="${RETRY_DELAY:-5}"
# kagent-controller's A2A port, and the longest one request may wait for a reply.
CONTROLLER_A2A_PORT=8083
A2A_MAX_TIME="${A2A_MAX_TIME:-180}"
# How much of a non-answer to show on each retry line.
PREVIEW_CHARS=160
PROMPT="${PROMPT:-What is 7 times 6? Answer with just the number.}"
MANIFEST_TYPES="application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json"

push_smoke_image() {
  local tag ref digest
  tag="smoke-$(date +%s)"
  ref="localhost:$REGISTRY_PORT/$SMOKE_REPO:$tag"
  docker pull -q "$SMOKE_IMAGE" >/dev/null
  docker tag "$SMOKE_IMAGE" "$ref"
  docker push -q "$ref" >/dev/null
  docker rmi "$ref" >/dev/null
  digest="$(curl -fsSI -H "Accept: $MANIFEST_TYPES" \
    "http://localhost:$REGISTRY_PORT/v2/$SMOKE_REPO/manifests/$tag" |
    awk 'tolower($1) == "docker-content-digest:" {print $2}' | tr -d '\r')"
  [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || fail "no sha256 digest from the registry for $ref (got: $digest)"
  printf '%s\n' "$digest"
}

check_harness() {
  local digest image node got
  digest="$(push_smoke_image)"
  image="localhost:$REGISTRY_PORT/$SMOKE_REPO@$digest"
  echo "pushed $image"
  k apply -f - <<EOF
apiVersion: api.kagent.dev/v1alpha3
kind: Harness
metadata: {name: $SMOKE_HARNESS, namespace: $PLATFORM_TEAM_NS}
spec:
  byo: {}
  workload:
    image: $image
    command: ["/bin/true"]
  substrate:
    workerPoolRef: {name: team-default}
    snapshotPolicy:
      location: gs://ate-snapshots/kagent/
EOF
  got="$(k get harness "$SMOKE_HARNESS" -n "$PLATFORM_TEAM_NS" -o 'jsonpath={.spec.workload.image}')"
  [ "$got" = "$image" ] || fail "Harness $SMOKE_HARNESS image is $got, want $image"
  k get harness "$SMOKE_HARNESS" -n "$PLATFORM_TEAM_NS"
  node="$(kind get nodes --name "$CLUSTER" | head -n 1)"
  docker exec "$node" crictl pull "$image" >/dev/null ||
    fail "kind node $node could not pull $image from the registry"
  echo "ok   Harness $SMOKE_HARNESS accepted with $image; node $node pulled it"
}

# One JSON-RPC SendMessage to the stock-runtime agent through the controller's A2A endpoint.
# Retries while the agent is still waking (a non-2xx answer or a JSON-RPC error).
send_message() {
  local pf body resp answer deadline=$((SECONDS + REPLY_TIMEOUT))
  # stdout is kubectl's "Forwarding from" chatter; its errors stay on stderr.
  k port-forward -n "$KAGENT_NS" svc/kagent-controller "$LOCAL_PORT:$CONTROLLER_A2A_PORT" >/dev/null &
  pf=$!
  # Stop the port-forward only if it is still running: one that already exited has
  # printed its own error, and there is nothing left to kill.
  # shellcheck disable=SC2064  # expand pf now
  trap "if ps -p $pf >/dev/null; then kill $pf; fi" EXIT
  body="$(jq -n --arg t "$PROMPT" --arg id "smoke-$(date +%s)" \
    '{jsonrpc:"2.0",id:1,method:"SendMessage",params:{message:{messageId:$id,role:"ROLE_USER",parts:[{text:$t}]}}}')"
  while :; do
    if resp="$(curl -fsS --max-time "$A2A_MAX_TIME" -H 'content-type: application/json' -H 'A2A-Version: 1.0' \
      -H 'X-User-Id: smoke@build-coding-agent' -d "$body" \
      "http://localhost:$LOCAL_PORT/agents/$PLATFORM_TEAM_NS/$SMOKE_AGENT" 2>&1)"; then
      # A 2xx answer that is not JSON is a controller fault, not a waking agent.
      answer="$(printf '%s' "$resp" | jq -r '[.result.task.artifacts[]?.parts[]?.text // empty,
        .result.message.parts[]?.text // empty] | join("\n")')" ||
        fail "$SMOKE_AGENT answered with a body jq cannot read: $(first_line "$resp" | cut -c1-"$PREVIEW_CHARS")"
      if [ -n "$answer" ]; then
        echo "$SMOKE_AGENT replied:"
        printf '%s\n' "$answer"
        return 0
      fi
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      fail "no reply from $SMOKE_AGENT within ${REPLY_TIMEOUT}s; last answer: $(first_line "$resp")"
    fi
    echo "no reply yet ($(first_line "$resp" | cut -c1-"$PREVIEW_CHARS")); retrying in ${RETRY_DELAY}s"
    sleep "$RETRY_DELAY"
  done
}

check_harness
send_message
