#!/usr/bin/env bash
# Spike (ticket #50): repeat the agentgateway MCP authorization checks on kind.
# Applies platform/spike-mcp-authz.yaml (namespace spike-mcp), talks MCP to the Gateway
# through a port-forward, prints one PASS/FAIL line per check, removes the namespace.
# Usage: platform/spike-mcp-authz.sh        (KEEP=1 keeps the namespace)
set -euo pipefail
# shellcheck source=platform/lib.sh
. "$(dirname "$0")/lib.sh"

NS="spike-mcp"
PORT="${SPIKE_PORT:-18080}"
URL="http://127.0.0.1:$PORT/spike-mcp"
failed=0
PF_PID=""

# shellcheck disable=SC2329  # runs from the EXIT trap
cleanup() {
  if [ -n "$PF_PID" ]; then kill "$PF_PID" 2>/dev/null || true; wait "$PF_PID" 2>/dev/null || true; fi
  [ -n "${KEEP:-}" ] || k delete namespace "$NS" --ignore-not-found --wait=false >/dev/null
}
trap cleanup EXIT

# mcp KEY JSON: one MCP session (initialize, initialized, the request); prints the response.
mcp() {
  local key="$1" body="$2" sid
  local -a hdr=(-H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H "authorization: Bearer $key")
  sid="$(curl -si "${hdr[@]}" "$URL" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"spike","version":"1"}}}' |
    tr -d '\r' | awk 'tolower($1)=="mcp-session-id:" {print $2}')"
  curl -s "${hdr[@]}" -H "mcp-session-id: $sid" "$URL" -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null
  curl -s "${hdr[@]}" -H "mcp-session-id: $sid" "$URL" -d "$body"
}
list() { mcp "$1" '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | grep -o '"name":"[a-z_]*"' | cut -d'"' -f4 | paste -sd, -; }
call() { mcp "$1" '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"'"$2"'","arguments":{"owner":"'"$3"'","repo":"'"$4"'"}}}'; }

# check NAME WANT GOT: GOT must contain WANT.
check() {
  if [[ "$3" == *"$2"* ]]; then echo "PASS $1"; else echo "FAIL $1: wanted '$2', got '$3'"; failed=1; fi
}

# set_rule EXPR: replace alice's and bob's rules with one rule, to probe what CEL can read.
set_rule() {
  k apply -f - >/dev/null <<YAML
apiVersion: agentgateway.dev/v1alpha1
kind: AgentgatewayPolicy
metadata: {name: spike-tools, namespace: $NS}
spec:
  targetRefs: [{group: agentgateway.dev, kind: AgentgatewayBackend, name: spike-mcp}]
  backend: {mcp: {authorization: {action: Allow, policy: {matchExpressions: ['$1']}}}}
YAML
  sleep 3
}

sed "s|@NODE_IMAGE@|$NODE_IMAGE|" "$PLATFORM_DIR/spike-mcp-authz.yaml" | k apply -f - >/dev/null
k -n "$NS" rollout status deploy/spike-server --timeout=120s >/dev/null
k -n "$AGW_NS" port-forward svc/agentgateway-proxy "$PORT:80" >/dev/null 2>&1 &
PF_PID=$!
# Wait until the Gateway has taken the policies (the first list that shows tools).
for _ in $(seq 30); do [ -n "$(list sk-spike-alice 2>/dev/null)" ] && break; sleep 1; done

check "alice sees only her tools" "issue_read,create_branch" "$(list sk-spike-alice)"
check "bob sees only issue_read" "issue_read" "$(list sk-spike-bob)"
[[ "$(list sk-spike-bob)" != *create_branch* ]] || { echo "FAIL bob sees create_branch"; failed=1; }
check "bob calling a hidden tool is refused" "Unknown tool: create_branch" "$(call sk-spike-bob create_branch acme good)"
check "alice calling a tool not on her list is refused" "Unknown tool: delete_branch" "$(call sk-spike-alice delete_branch acme good)"
check "bob calling his tool works" "ran issue_read on acme/good" "$(call sk-spike-bob issue_read acme good)"
check "a call without a key is 401" "401" "$(curl -s -o /dev/null -w '%{http_code}' "$URL" -H 'content-type: application/json' -d '{}')"
check "alice, repo on her list" "ran issue_read on acme/good" "$(call sk-spike-alice issue_read acme good)"
check "alice, repo not on her list is refused" "Unknown tool: issue_read" "$(call sk-spike-alice issue_read acme evil)"
check "alice, owner not on her list is refused" "Unknown tool: issue_read" "$(call sk-spike-alice issue_read evil good)"

# mcp.tool.arguments, as the docs describe it, is not there: a rule that reads it denies a good call.
set_rule 'mcp.tool.name == "issue_read" && has(mcp.tool.arguments)'
check "mcp.tool.arguments is absent at authorization" "Unknown tool: issue_read" "$(call sk-spike-alice issue_read acme good)"
set_rule 'mcp.tool.name == "issue_read" && !has(mcp.tool.arguments)'
check "!has(mcp.tool.arguments) holds" "ran issue_read on acme/good" "$(call sk-spike-alice issue_read acme good)"

exit "$failed"
