#!/usr/bin/env bash
# Report each platform part on the kind cluster: one ok or FAIL line for Substrate,
# kagent, agentgateway, Argo CD and its ApplicationSet, each team's base (platform/teams.txt),
# each of our agents (in namespace agents), and the image pins. Exits non-zero when any
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
team_names=""

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
  local name="$1" ready
  ready="$(k get agent "$name" -n "$AGENTS_NS" \
    -o 'jsonpath={.status.conditions[?(@.type=="Ready")].status}' 2>&1 || true)"
  if [ "$ready" = True ]; then pass "agent $AGENTS_NS/$name Ready"
  else flunk "agent $AGENTS_NS/$name not Ready (saw: $(first_line "$ready"))"; fi
}

# The ApplicationSet that deploys deployments/<team>/<agent>/, and the revision it tracks.
check_applicationset() {
  local revision
  # shellcheck disable=SC2310  # wrapper: k is one kubectl call
  if ! revision="$(k get applicationset agents -n "$ARGOCD_NS" \
    -o 'jsonpath={.spec.generators[0].git.revision}' 2>&1)" || [ -z "$revision" ]; then
    flunk "Argo CD: ApplicationSet agents missing (saw: $(first_line "$revision"))"
  else
    pass "Argo CD: ApplicationSet agents tracks deployments/ at $revision"
  fi
}

# A team's base: its namespace's ServiceAccount, Harness and AppProject exist, its
# ModelConfig is Accepted, and its WorkerPool has every replica ready.
check_team_base() {
  local team="$1" ns="team-$1" missing="" name model pool
  for name in serviceaccount/team-default harness.api.kagent.dev/kagent-stock; do
    k get "$name" -n "$ns" -o name >/dev/null 2>&1 || missing="$missing $name"
  done
  k get appproject "$ns" -n "$ARGOCD_NS" -o name >/dev/null 2>&1 || missing="$missing appproject/$ns"
  model="$(k get modelconfig.api.kagent.dev default-model-config -n "$ns" \
    -o 'jsonpath={.status.conditions[?(@.type=="Accepted")].status}' 2>&1 || true)"
  pool="$(k get workerpool.ate.dev team-default -n "$ns" \
    -o 'jsonpath={.status.readyReplicas}/{.spec.replicas}' 2>&1 || true)"
  if [ -n "$missing" ]; then flunk "team base $team: missing in $ns:$missing"
  elif [ "$model" != True ]; then flunk "team base $team: ModelConfig default-model-config not Accepted (saw: $(first_line "$model"))"
  elif ! [[ "$pool" =~ ^([1-9][0-9]*)/([0-9]+)$ ]] || [ "${BASH_REMATCH[1]}" != "${BASH_REMATCH[2]}" ]; then
    flunk "team base $team: WorkerPool team-default not ready (saw: $(first_line "$pool"))"
  else
    pass "team base $team: namespace $ns, WorkerPool $pool ready, ModelConfig Accepted, Harness kagent-stock, AppProject $ns"
  fi
}

# Every image (containers and init containers) in the platform namespaces must be one
# of the pinned digests. imageID is the digest the node actually pulled.
IMAGE_IDS='{range .items[*].status.containerStatuses[*]}{.imageID}{"\n"}{end}{range .items[*].status.initContainerStatuses[*]}{.imageID}{"\n"}{end}'
check_images() {
  local ns out ids="" id strays="" team namespaces
  namespaces=("$KAGENT_NS" "$AGENTS_NS" "$SUBSTRATE_NS" "$PODCERT_NS" "$AGW_NS" "$DEMO_MCP_NS" "$GITHUB_MCP_NS" "$ARGOCD_NS")
  for team in $team_names; do namespaces+=("team-$team"); done
  for ns in "${namespaces[@]}"; do
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
check_part "Argo CD" "argocd teams" "$ARGOCD_NS"
check_applicationset
if ! team_names="$("$TEAMS_SH" names 2>&1)"; then
  flunk "teams: $(first_line "$team_names")"
  team_names=""
fi
for team in $team_names; do check_team_base "$team"; done
check_agent stock-agent
check_agent triage-agent
check_agent docs-agent
check_agent hello-agent
check_images
exit "$failed"
