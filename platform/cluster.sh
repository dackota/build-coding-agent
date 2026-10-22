#!/usr/bin/env bash
# Create, remove, or report the kind cluster and its local registry.
# Usage: cluster.sh up|down|status
# The registry is a registry:2 container on localhost:5001, joined to the `kind` Docker
# network; containerd on the node maps localhost:5001 to it (kagent's
# scripts/kind/setup-kind.sh, steps 1 to 5).
set -euo pipefail
# shellcheck source=platform/lib.sh
. "$(dirname "$0")/lib.sh"

# Extra `docker run` label for the registry, e.g. verify.run=<id> (optional).
DOCKER_RUN_LABEL="${DOCKER_RUN_LABEL:-}"
REGISTRY_TIMEOUT="${REGISTRY_TIMEOUT:-5}"
KIND_WAIT="${KIND_WAIT:-120s}"
# docker inspect's error for a name that does not exist; any other error is a failure.
DOCKER_NOT_FOUND="no such object"

# True when the cluster is listed. A failing `kind get clusters` stops the script with
# kind's own message, so a broken kind never reads as "no cluster". kind prints
# "No kind clusters found." on stderr when there are none; it never equals a name.
cluster_exists() {
  local clusters
  clusters="$(kind get clusters 2>&1)" || fail "could not list kind clusters: $(first_line "$clusters")"
  has_line "$CLUSTER" "$clusters"
}

# The registry container's state ("running", "exited", ...), or empty when it does not
# exist. Any other docker error stops the script. Capture it in a plain assignment
# (state="$(registry_state)") so set -e sees the failure.
registry_state() {
  local out
  if out="$(docker inspect -f '{{.State.Status}}' "$REGISTRY_NAME" 2>&1)"; then
    printf '%s\n' "$out"
    return 0
  fi
  case "$(printf '%s' "$out" | tr '[:upper:]' '[:lower:]')" in
    *"$DOCKER_NOT_FOUND"*) return 0 ;;
    *) fail "could not inspect registry $REGISTRY_NAME: $(first_line "$out")" ;;
  esac
}

# The registry's kind network settings as JSON, "null" when it is not on that network.
registry_network() {
  docker inspect -f '{{json .NetworkSettings.Networks.kind}}' "$REGISTRY_NAME"
}

start_registry() {
  local state labels=(--label "app.kubernetes.io/part-of=$CLUSTER")
  [ -n "$DOCKER_RUN_LABEL" ] && labels+=(--label "$DOCKER_RUN_LABEL")
  state="$(registry_state)"
  case "$state" in
    running) echo "registry $REGISTRY_NAME already running" ;;
    "") docker run -d --restart=always -p "127.0.0.1:$REGISTRY_PORT:$REGISTRY_INTERNAL_PORT" \
          --network bridge --name "$REGISTRY_NAME" "${labels[@]}" "$REGISTRY_IMAGE" >/dev/null
        echo "registry $REGISTRY_NAME started on localhost:$REGISTRY_PORT" ;;
    *) docker start "$REGISTRY_NAME" >/dev/null; echo "registry $REGISTRY_NAME restarted" ;;
  esac
}

create_cluster() {
  # shellcheck disable=SC2310  # predicate: is the cluster listed
  if cluster_exists; then
    echo "cluster $CLUSTER already exists; not recreating it"
    return 0
  fi
  kind create cluster --name "$CLUSTER" --config "$PLATFORM_DIR/kind-config.yaml" \
    --image "$KIND_NODE_IMAGE" --wait "$KIND_WAIT"
}

# containerd on each node pulls localhost:5001/... from the registry container.
point_nodes_at_registry() {
  local node nodes dir="/etc/containerd/certs.d/localhost:$REGISTRY_PORT"
  nodes="$(kind get nodes --name "$CLUSTER")"
  for node in $nodes; do
    docker exec "$node" mkdir -p "$dir"
    printf '[host."http://%s:%s"]\n  skip_verify = true\n' "$REGISTRY_NAME" "$REGISTRY_INTERNAL_PORT" |
      docker exec -i "$node" cp /dev/stdin "$dir/hosts.toml"
  done
}

join_kind_network() {
  local network
  network="$(registry_network)"
  if [ "$network" = null ]; then docker network connect kind "$REGISTRY_NAME"; fi
}

# KEP-1755: tell in-cluster tools where the local registry is.
document_registry() {
  k apply -f - >/dev/null <<EOF
apiVersion: v1
kind: ConfigMap
metadata:
  name: local-registry-hosting
  namespace: kube-public
data:
  localRegistryHosting.v1: |
    host: "localhost:$REGISTRY_PORT"
    hostFromClusterNetwork: "$REGISTRY_NAME:$REGISTRY_INTERNAL_PORT"
    help: "https://kind.sigs.k8s.io/docs/user/local-registry/"
EOF
}

up() {
  start_registry
  create_cluster
  point_nodes_at_registry
  join_kind_network
  document_registry
  echo "cluster $CLUSTER (context $CTX) and registry localhost:$REGISTRY_PORT are up"
}

down() {
  local state
  # shellcheck disable=SC2310  # predicate: is the cluster listed; kind errors still exit
  if cluster_exists; then kind delete cluster --name "$CLUSTER"; fi
  state="$(registry_state)"
  if [ -n "$state" ]; then docker rm -f "$REGISTRY_NAME" >/dev/null; fi
  # shellcheck disable=SC2310  # predicate: is the cluster listed; kind errors still exit
  if cluster_exists; then fail "cluster $CLUSTER is still listed after delete"; fi
  state="$(registry_state)"
  [ -z "$state" ] || fail "registry $REGISTRY_NAME still exists after removal (state $state)"
  echo "cluster $CLUSTER and registry $REGISTRY_NAME are gone"
}

status() {
  local failed=0 ready state network="" probe
  # shellcheck disable=SC2310  # predicate: is the cluster listed
  if cluster_exists; then
    if ready="$(k get nodes -o 'jsonpath={.items[*].status.conditions[?(@.type=="Ready")].status}' 2>&1)" &&
      [ -n "$ready" ] && ! printf '%s\n' "$ready" | tr ' ' '\n' | grep -qvx True; then
      echo "ok   kind cluster $CLUSTER: every node Ready"
    else
      echo "FAIL kind cluster $CLUSTER: nodes not Ready (saw: $(first_line "$ready"))"
      failed=1
    fi
  else
    echo "FAIL kind cluster $CLUSTER does not exist"
    failed=1
  fi
  state="$(registry_state)"
  if [ "$state" = running ]; then network="$(registry_network)"; fi
  if [ "$state" != running ]; then
    echo "FAIL registry $REGISTRY_NAME is not running (state: ${state:-absent})"
    failed=1
  elif ! probe="$(curl -fsS --max-time "$REGISTRY_TIMEOUT" "http://localhost:$REGISTRY_PORT/v2/" 2>&1)"; then
    echo "FAIL registry does not answer on localhost:$REGISTRY_PORT ($(first_line "$probe"))"
    failed=1
  elif [ -z "$network" ] || [ "$network" = null ]; then
    echo "FAIL registry is not on the kind network"
    failed=1
  else
    echo "ok   registry on localhost:$REGISTRY_PORT, joined to the kind network"
  fi
  return "$failed"
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  status) status ;;
  *) echo "usage: $0 up|down|status" >&2; exit 2 ;;
esac
