#!/usr/bin/env bash
# Check that a byo image meets the byo contract (docs/byo-contract.md) on the local kind
# cluster, and report pass or fail per rule. Usage: byo-check.sh IMAGE
#   IMAGE  <registry address>/<path>@sha256:<digest>, as make byo-push prints it
#
# In a throwaway namespace it runs the image as a pod next to a checker pod. The checker
# plays kagent's side: it serves the task store and the model route, and sends the image an
# A2A message over gRPC at the image's pod address. The namespace is deleted on every exit.
set -euo pipefail
# shellcheck source=platform/lib.sh
. "$(dirname "$0")/lib.sh"

# Test knobs: a prebuilt checker image, and the seconds between polls of the checker pod.
POLL_SECONDS="${BYO_CHECK_POLL_SECONDS:-3}"
CHECK_TIMEOUT_SECONDS="${BYO_CHECK_TIMEOUT_SECONDS:-300}"
CONTROLLER_PORT=9090
MODEL_PORT=9091
API_KEY="kagent-placeholder"
INSTRUCTION="You are the contract check's agent. Reply briefly."
IMAGE_PATTERN='^[a-z0-9.-]+(:[0-9]+)?/[a-z0-9._/-]+(@sha256:[a-f0-9]{64}|:[A-Za-z0-9._-]+)$'
# Addresses on the kind network's private ranges: make byo-push prints the registry this way,
# but the nodes pull it as localhost:<port> (cluster.sh points containerd there).
PRIVATE_REGISTRY_PATTERN='^(10(\.[0-9]{1,3}){3}|172\.(1[6-9]|2[0-9]|3[01])(\.[0-9]{1,3}){2}|192\.168(\.[0-9]{1,3}){2}):5000/'

image="${1:-}"
[ -n "$image" ] || fail "usage: byo-check.sh IMAGE (make byo-check IMAGE=...)"
[[ "$image" =~ $IMAGE_PATTERN ]] || fail "IMAGE '$image' is not <registry>/<path>@sha256:<digest>; usage: byo-check.sh IMAGE"

pull_ref() { printf '%s' "$1" | sed -E "s#$PRIVATE_REGISTRY_PATTERN#localhost:$REGISTRY_PORT/#"; }

id="$(uuidgen | tr '[:upper:]' '[:lower:]')"
ns="byo-check-${id:0:8}"
session="$id"
workdir=""

cleanup() {
  local status=$?
  trap - EXIT
  [ -z "$workdir" ] || rm -rf "$workdir"
  if ! k delete namespace "$ns" --ignore-not-found --wait=true >/dev/null 2>&1; then
    echo "byo-check: could not delete namespace $ns; run: kubectl --context $CTX delete namespace $ns" >&2
    exit 1
  fi
  if k get namespace "$ns" >/dev/null 2>&1; then
    echo "byo-check: namespace $ns is still there, left behind; run: kubectl --context $CTX delete namespace $ns" >&2
    exit 1
  fi
  exit "$status"
}
trap cleanup EXIT

# The checker image: prebuilt when BYO_CHECK_CHECKER_IMAGE is set, else built from the repo
# and pushed to the local registry.
checker_image() {
  if [ -n "${BYO_CHECK_CHECKER_IMAGE:-}" ]; then
    printf '%s' "$BYO_CHECK_CHECKER_IMAGE"
    return
  fi
  workdir="$(mktemp -d)"
  mkdir -p "$workdir/src/byo-check"
  cp "$ROOT/templates/byo-ts/package.json" "$ROOT/templates/byo-ts/pnpm-lock.yaml" "$workdir/"
  cp "$ROOT/agent/src/wire.ts" "$workdir/src/"
  cp "$ROOT"/agent/src/byo-check/*.ts "$workdir/src/byo-check/"
  cp "$PLATFORM_DIR/byo-check/Dockerfile" "$workdir/"
  local line
  line="$("$PLATFORM_DIR/byo-push.sh" "$workdir" byo-checker)"
  pull_ref "${line#image: }"
}

manifests() {
  local checker="$1" agent="$2" stub="byo-stub.$ns.svc"
  local config
  config="$(jq -nc --arg cp "http://$stub:$CONTROLLER_PORT" --arg base "http://$stub:$MODEL_PORT/v1" --arg ins "$INSTRUCTION" \
    '{runtime: {control_plane_url: $cp}, agent: {model: {model: "check-model", openai: {base_url: $base}}, instruction: $ins}}')"
  cat <<YAML
apiVersion: v1
kind: Namespace
metadata: {name: $ns}
---
apiVersion: v1
kind: ConfigMap
metadata: {name: byo-agent-config, namespace: $ns}
data:
  config.json: |
    $config
---
apiVersion: v1
kind: ConfigMap
metadata: {name: byo-agent-identity, namespace: $ns}
data:
  name: session-$session
---
apiVersion: v1
kind: Service
metadata: {name: byo-stub, namespace: $ns}
spec:
  selector: {app: byo-checker}
  ports:
    - {name: controller, port: $CONTROLLER_PORT}
    - {name: model, port: $MODEL_PORT}
---
apiVersion: v1
kind: Service
metadata: {name: byo-agent, namespace: $ns}
spec:
  clusterIP: None
  publishNotReadyAddresses: true
  selector: {app: byo-agent}
---
apiVersion: v1
kind: Pod
metadata: {name: byo-checker, namespace: $ns, labels: {app: byo-checker}}
spec:
  restartPolicy: Never
  containers:
    - name: checker
      image: $checker
      env:
        - {name: BYO_AGENT_HOST, value: "byo-agent.$ns.svc"}
        - {name: BYO_SESSION_ID, value: "$session"}
        - {name: BYO_API_KEY, value: "$API_KEY"}
        - {name: BYO_INSTRUCTION, value: "$INSTRUCTION"}
        - {name: BYO_CONTROLLER_PORT, value: "$CONTROLLER_PORT"}
        - {name: BYO_MODEL_PORT, value: "$MODEL_PORT"}
YAML
  [ -z "$agent" ] || cat <<YAML
---
apiVersion: v1
kind: Pod
metadata: {name: byo-agent, namespace: $ns, labels: {app: byo-agent}}
spec:
  restartPolicy: Never
  containers:
    - name: agent
      image: $agent
      env:
        - {name: OPENAI_API_KEY, value: "$API_KEY"}
      volumeMounts:
        - {name: config, mountPath: /config}
        - {name: identity, mountPath: /run/kagent/identity}
  volumes:
    - {name: config, configMap: {name: byo-agent-config}}
    - {name: identity, configMap: {name: byo-agent-identity}}
YAML
}

# Prints the checker pod's phase once it is Succeeded or Failed; fails after the timeout.
wait_for_verdict() {
  local deadline=$((SECONDS + CHECK_TIMEOUT_SECONDS)) phase
  while :; do
    phase="$(k get pod byo-checker -n "$ns" -o 'jsonpath={.status.phase}')"
    case "$phase" in Succeeded | Failed) printf '%s' "$phase"; return 0 ;; *) ;; esac
    [ "$SECONDS" -lt "$deadline" ] || fail "the checker did not finish within ${CHECK_TIMEOUT_SECONDS}s (phase: $phase)"
    sleep "$POLL_SECONDS"
  done
}

checker="$(checker_image)"
agent="$(pull_ref "$image")"
echo "byo-check: checking $image in namespace $ns"
manifests "$checker" "" | k apply -f - >/dev/null
k wait --for=condition=Ready pod/byo-checker -n "$ns" --timeout=120s >/dev/null
# The image starts only now, so the checker sees its start-up from the first moment.
manifests "$checker" "$agent" | k apply -f - >/dev/null
phase="$(wait_for_verdict)"
k logs byo-checker -n "$ns"
if [ "$phase" != "Succeeded" ]; then
  echo "--- the image's own output (a start-up fault shows here) ---" >&2
  k logs byo-agent -n "$ns" --tail=20 >&2 || true
  k get pod byo-agent -n "$ns" -o 'jsonpath={.status.containerStatuses[*].state}' >&2 || true
  exit 1
fi
