#!/usr/bin/env bash
# Report each platform part on the kind cluster: one ok or FAIL line for Substrate,
# kagent, agentgateway, the stock agent, and the image pins. Exits non-zero when any
# line is FAIL. Reads Secret names only, never their data.
set -euo pipefail
# shellcheck source=platform/lib.sh
. "$(dirname "$0")/lib.sh"

WAIT="${STATUS_TIMEOUT:-10s}"
PODCERT_NS="podcertificate-controller-system"
# The demo MCP server make deploy runs (platform/demo-mcp.yaml); empty before the first deploy.
DEMO_MCP_NS="demo-mcp"
LOCK_FILE="$PLATFORM_DIR/images.lock"
failed=0
releases=""

pass() { echo "ok   $*"; }
flunk() { echo "FAIL $*"; failed=1; }

# missing_releases NAME...: the names not deployed, space separated.
missing_releases() {
  local name out=""
  for name in "$@"; do
    # shellcheck disable=SC2310  # predicate: is the release deployed
    has_line "$name" "$releases" || out="$out $name"
  done
  printf '%s' "${out# }"
}

# deployments_available NS...: empty when every Deployment in each namespace is
# Available, else the first error.
deployments_available() {
  local ns out
  for ns in "$@"; do
    # shellcheck disable=SC2310  # wrapper: k is one kubectl call
    if ! out="$(k wait --for=condition=Available deployment --all -n "$ns" --timeout="$WAIT" 2>&1)"; then
      printf '%s: %s' "$ns" "$(first_line "$out")"
      return 0
    fi
  done
}

check_part() { # LABEL "RELEASES" NAMESPACES...
  local label="$1" names="$2" missing problem
  shift 2
  # shellcheck disable=SC2086  # names is a word list
  missing="$(missing_releases $names)"
  if [ -n "$missing" ]; then flunk "$label: release not deployed: $missing"; return 0; fi
  problem="$(deployments_available "$@")"
  if [ -n "$problem" ]; then flunk "$label: deployments not Available ($problem)"; return 0; fi
  pass "$label: releases $names deployed, deployments Available"
}

check_gateway() {
  local programmed secret
  programmed="$(k get gateway agentgateway-proxy -n "$AGW_NS" \
    -o 'jsonpath={.status.conditions[?(@.type=="Programmed")].status}' 2>&1 || true)"
  secret="$(k get secret "$KEY_SECRET" -n "$AGW_NS" -o name 2>&1 || true)"
  if [ "$programmed" != True ]; then
    flunk "model route: Gateway agentgateway-proxy not Programmed (saw: $(first_line "$programmed"))"
  elif [ "$secret" != "secret/$KEY_SECRET" ]; then
    flunk "model route: key Secret $KEY_SECRET missing (saw: $(first_line "$secret"))"
  else
    pass "model route: Gateway agentgateway-proxy Programmed, key Secret $KEY_SECRET present"
  fi
}

check_agent() {
  local ready
  ready="$(k get agent stock-agent -n "$KAGENT_NS" \
    -o 'jsonpath={.status.conditions[?(@.type=="Ready")].status}' 2>&1 || true)"
  if [ "$ready" = True ]; then pass "stock agent stock-agent Ready"
  else flunk "stock agent stock-agent not Ready (saw: $(first_line "$ready"))"; fi
}

# Every image (containers and init containers) in the platform namespaces must be one
# of the pinned digests. imageID is the digest the node actually pulled.
IMAGE_IDS='{range .items[*].status.containerStatuses[*]}{.imageID}{"\n"}{end}{range .items[*].status.initContainerStatuses[*]}{.imageID}{"\n"}{end}'
check_images() {
  local ns out ids="" id strays=""
  for ns in "$KAGENT_NS" "$SUBSTRATE_NS" "$PODCERT_NS" "$AGW_NS" "$DEMO_MCP_NS"; do
    # shellcheck disable=SC2310  # wrapper: k is one kubectl call
    out="$(k get pods -n "$ns" -o "jsonpath=$IMAGE_IDS" 2>&1)" ||
      { flunk "images: kubectl in $ns: $(first_line "$out")"; return 0; }
    ids="$ids
$out"
  done
  for id in $(printf '%s\n' "$ids" | sed '/^$/d' | sort -u); do
    grep -qxF -- "$id" "$LOCK_FILE" || strays="$strays $id"
  done
  if [ -n "$strays" ]; then flunk "images: not in platform/images.lock:$strays"
  else pass "images: every running platform image is pinned in platform/images.lock"; fi
}

if ! releases="$(h list -A --deployed -q 2>&1)"; then
  flunk "helm releases (helm: $(first_line "$releases"))"
  exit 1
fi
check_part "Substrate" "substrate-crds substrate-podcert substrate" "$SUBSTRATE_NS" "$PODCERT_NS"
check_part "kagent" "kagent-crds kagent" "$KAGENT_NS"
check_part "agentgateway" "agentgateway-crds agentgateway" "$AGW_NS"
check_gateway
check_agent
check_images
exit "$failed"
