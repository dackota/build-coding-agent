#!/usr/bin/env bash
# Spike (ticket #60): repeat the per-agent model key checks on kind (make up first).
# Makes a random agent key, applies platform/spike-agent-key.yaml (agent spike-key in team-platform,
# keyed model and MCP routes on agentgateway, a one-tool MCP server in spike-key), sends the
# agent one message, prints one PASS/FAIL line per check, and removes everything (KEEP=1
# keeps it). Spends a few hundred model tokens. Exits non-zero on any FAIL.
# The key is held in a shell variable and Secret team-platform/spike-key-agent only; it is never printed.
set -euo pipefail
# shellcheck source=platform/lib.sh
. "$(dirname "$0")/lib.sh"

SPIKE_NS="spike-key"
AGENT="spike-key"
GW_PORT="${SPIKE_PORT:-18090}"
A2A_PORT="${SPIKE_A2A_PORT:-18091}"
CONTROLLER_A2A_PORT=8083
REPLY_TIMEOUT="${REPLY_TIMEOUT:-300}"
READY_TIMEOUT="${READY_TIMEOUT:-300s}"
GW_URL="http://127.0.0.1:$GW_PORT"
KEY="sk-agent-$(openssl rand -hex 24)"
KEY_HASH="$(printf '%s' "$KEY" | shasum -a 256 | cut -d' ' -f1)"
WORD="pelican-$(openssl rand -hex 3)"
START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
failed=0
PIDS=()

# shellcheck disable=SC2329  # runs from the EXIT trap
cleanup() {
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; done
  [ -z "${KEEP:-}" ] || return 0
  render | k delete -f - --ignore-not-found --wait=false >/dev/null 2>&1 || true
  k -n "$PLATFORM_TEAM_NS" delete secret spike-key-agent spike-key-bearer --ignore-not-found >/dev/null
}
trap cleanup EXIT

render() { sed -e "s|@NODE_IMAGE@|$NODE_IMAGE|" -e "s|@KEY_HASH@|$KEY_HASH|" "$PLATFORM_DIR/spike-agent-key.yaml"; }

# check NAME WANT GOT: GOT must contain WANT.
check() {
  if [[ "$3" == *"$2"* ]]; then echo "PASS $1"; else echo "FAIL $1: wanted '$2', got '$(first_line "$3" | cut -c1-300)'"; failed=1; fi
}
# has_key TEXT: true when the key is in TEXT as text, hex (bytea dumps), or base64 (Secret data).
has_key() {
  local hex b64
  hex="$(printf '%s' "$KEY" | xxd -p | tr -d '\n')"
  b64="$(printf '%s' "$KEY" | base64 | tr -d '\n=')"
  grep -qiF -e "$KEY" -e "$hex" -e "$b64" <<<"$1"
}
# absent NAME TEXT: the key is not in TEXT. Never prints TEXT.
absent() {
  if has_key "$2"; then echo "FAIL $1: the key is there"; failed=1; else echo "PASS $1"; fi
}
# status PATH HEADER...: the HTTP status of an MCP initialize POST to the Gateway.
status() {
  local path="$1"; shift
  curl -s -o /dev/null -w '%{http_code}' "$GW_URL$path" "$@" -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"spike","version":"1"}}}'
}
# send TEXT: one A2A SendMessage to the agent through the controller; retries while it wakes.
send() {
  local body resp deadline=$((SECONDS + REPLY_TIMEOUT))
  body="$(jq -n --arg t "$1" --arg id "spike-key-$(date +%s)" \
    '{jsonrpc:"2.0",id:1,method:"SendMessage",params:{message:{messageId:$id,role:"ROLE_USER",parts:[{text:$t}]}}}')"
  while :; do
    resp="$(curl -sS --max-time 180 -H 'content-type: application/json' -H 'A2A-Version: 1.0' \
      -H 'X-User-Id: spike@build-coding-agent' -d "$body" "http://127.0.0.1:$A2A_PORT/agents/$PLATFORM_TEAM_NS/$AGENT" 2>&1)" || true
    if [[ "$resp" == *TASK_STATE_COMPLETED* ]] || [ "$SECONDS" -ge "$deadline" ]; then printf '%s' "$resp"; return 0; fi
    sleep 5
  done
}
# The compiled actor template (env and KAGENT_CONFIG_JSON) Substrate starts the agent from, as text.
actor_template() {
  k -n "$KAGENT_NS" exec deploy/kagent-postgresql -c postgresql -- psql -U postgres -d kagent -At \
    -c "select encode(proto, 'hex') from substrate.actor_templates where name like '$AGENT-%' and name not like '$AGENT-conflict-%'" |
    xxd -r -p | strings -n 4
}

printf '%s' "$KEY" | k -n "$PLATFORM_TEAM_NS" create secret generic spike-key-agent --from-file=OPENAI_API_KEY=/dev/stdin \
  --dry-run=client -o yaml | k apply -f - >/dev/null
printf 'Bearer %s' "$KEY" | k -n "$PLATFORM_TEAM_NS" create secret generic spike-key-bearer --from-file=token=/dev/stdin \
  --dry-run=client -o yaml | k apply -f - >/dev/null
render | k apply -f - >/dev/null
k -n "$SPIKE_NS" rollout status deploy/spike-key-server --timeout="$READY_TIMEOUT" >/dev/null
k -n "$PLATFORM_TEAM_NS" wait --for=condition=Ready "agent/$AGENT" --timeout="$READY_TIMEOUT" >/dev/null
# kubectl itself, not the k function: a backgrounded function is a subshell, and killing it
# leaves its kubectl running.
kubectl --context "$CTX" -n "$AGW_NS" port-forward svc/agentgateway-proxy "$GW_PORT:80" >/dev/null 2>&1 &
PIDS+=($!)
kubectl --context "$CTX" -n "$KAGENT_NS" port-forward svc/kagent-controller "$A2A_PORT:$CONTROLLER_A2A_PORT" >/dev/null 2>&1 &
PIDS+=($!)
# Wait until the Gateway has the keyed MCP route (the right key gets through).
for _ in $(seq 30); do [ "$(status /spike-key/mcp -H "x-agent-key: $KEY" 2>/dev/null)" = 200 ] && break; sleep 1; done

# 1. The agent answers through its keyed model route and calls its keyed MCP route.
reply="$(send "Call spike_echo with the text $WORD, then reply with exactly what it returned.")"
check "the agent answers (task completed)" "TASK_STATE_COMPLETED" "$reply"
check "the agent's MCP call went through with its key" "spike-echo: $WORD" "$reply"
gwlog="$(k -n "$AGW_NS" logs deploy/agentgateway-proxy --since-time="$START")"
check "model calls took the keyed route and got 200" "route=$AGW_NS/spike-key-model endpoint=opencode.ai:443" \
  "$(grep 'route=agentgateway-system/spike-key-model' <<<"$gwlog" | grep 'http.status=200' || true)"
check "MCP tools/call took the keyed route and got 200" "mcp.method.name=tools/call" \
  "$(grep 'route=agentgateway-system/spike-key-mcp ' <<<"$gwlog" | grep 'http.status=200' || true)"
srvlog="$(k -n "$SPIKE_NS" logs deploy/spike-key-server)"
check "the MCP server ran the call" "\"text\":\"$WORD\"" "$srvlog"
if [[ "$srvlog" == *key-header-reached-server* ]]; then echo "FAIL a key header reached the MCP server"; failed=1
else echo "PASS no key header reached the MCP server"; fi

# 2. The keyed routes refuse no key and a wrong key.
wrong="sk-agent-$(openssl rand -hex 24)"
check "model route, no key: 401" "401" "$(status /spike-key/v1/chat/completions)"
check "model route, wrong key: 401" "401" "$(status /spike-key/v1/chat/completions -H "authorization: Bearer $wrong")"
check "MCP route, no key: 401" "401" "$(status /spike-key/mcp)"
check "MCP route, wrong key: 401" "401" "$(status /spike-key/mcp -H "x-agent-key: $wrong")"
check "MCP route, the agent's key: 200" "200" "$(status /spike-key/mcp -H "x-agent-key: $KEY")"
open="$(status /v1/chat/completions)"
if [ "$open" = 401 ]; then echo "FAIL the open /v1 route of the other agents now wants a key"; failed=1
else echo "PASS the open /v1 route of the other agents is untouched (got $open, not 401)"; fi

# 3. The key is not in the actor's env, runtime config, or logs; only the placeholder is.
if has_key "$(k -n "$PLATFORM_TEAM_NS" get secret spike-key-agent -o yaml)"; then echo "PASS the key search finds the key in its Secret (control)"
else echo "FAIL the key search misses the key in its own Secret"; failed=1; fi
tmpl="$(actor_template)"
check "actor env holds the placeholder for OPENAI_API_KEY" "kagent-credential-injected" "$(grep -A1 -x 'OPENAI_API_KEY' <<<"$tmpl" || true)"
check "actor runtime config holds an env reference for x-agent-key" '"x-agent-key":"__KAGENT_ENV[KAGENT_CREDENTIAL_' "$tmpl"
absent "key absent from the compiled actor env and runtime config" "$tmpl"
absent "key absent from the whole kagent and Substrate database" \
  "$(k -n "$KAGENT_NS" exec deploy/kagent-postgresql -c postgresql -- pg_dump -U postgres --data-only kagent)"
worker="$(k -n "$PLATFORM_TEAM_NS" logs deploy/team-default --since-time="$START")"
check "the worker logs hold the agent's actor lines" "\"ate.template.atespace\":\"$PLATFORM_TEAM_NS\",\"ate.template.name\":\"$AGENT-" "$worker"
absent "key absent from the actor's logs (worker pod)" "$worker"
absent "key absent from the controller's logs" "$(k -n "$KAGENT_NS" logs deploy/kagent-controller --since-time="$START")"
absent "key absent from agentgateway's logs" "$gwlog"

# 4. A second credential for the same origin and header is refused at compile time.
k -n "$PLATFORM_TEAM_NS" wait --for=condition=Compatible=False agent/spike-key-conflict --timeout=60s >/dev/null || true
check "Authorization twice on one origin is rejected" \
  "conflicting credentials for http://agentgateway-proxy.agentgateway-system.svc.cluster.local:80 header authorization" \
  "$(k -n "$PLATFORM_TEAM_NS" get agent spike-key-conflict -o jsonpath='{.status.conditions[?(@.type=="Compatible")].message}')"

exit "$failed"
