#!/usr/bin/env bash
# Print each agent's and each team's monthly token use against its cap, one line each, for
# make status. The caps are in the ratelimit config (written by the minter); the use is in
# the Redis counters the ratelimit service keeps. Exits non-zero, with a FAIL line, when the
# config or Redis cannot be read. Reads no Secret.
set -euo pipefail
# shellcheck source=platform/lib.sh
. "$(dirname "$0")/lib.sh"

RATELIMIT_CONFIGMAP="ratelimit-config"
# The ratelimit service names a counter <domain>_<key>_<value>_<start of the window, in seconds>.
DOMAIN="agw"

redis() { k exec -n "$AGW_NS" deploy/redis -- redis-cli "$@"; }

if ! config="$(k get configmap "$RATELIMIT_CONFIGMAP" -n "$AGW_NS" -o 'jsonpath={.data.config\.yaml}' 2>&1)"; then
  echo "FAIL tokens: cannot read ConfigMap $RATELIMIT_CONFIGMAP ($(first_line "$config"))"
  exit 1
fi
if ! entries="$(printf '%s' "$config" | jq -r '.descriptors // [] | sort_by(.key, .value)[] | [.key, .value, .rate_limit.requests_per_unit] | @tsv' 2>&1)" || [ -z "$entries" ]; then
  echo "FAIL tokens: $RATELIMIT_CONFIGMAP has no caps yet (the minter writes them) ($(first_line "$entries"))"
  exit 1
fi
if ! counters="$(redis --scan --pattern "${DOMAIN}_*" 2>&1)"; then
  echo "FAIL tokens: cannot read the counters in Redis ($(first_line "$counters"))"
  exit 1
fi

# newest_counter PREFIX: the counter for the latest window of PREFIX, empty when there is none.
newest_counter() {
  local prefix="$1" name rest best="" best_start=-1
  while IFS= read -r name; do
    rest="${name#"$prefix"}"
    [[ "$name" == "$prefix"* && "$rest" =~ ^[0-9]+$ ]] || continue
    if [ "$rest" -gt "$best_start" ]; then best="$name"; best_start="$rest"; fi
  done <<<"$counters"
  printf '%s' "$best"
}

while IFS=$'\t' read -r key value cap; do
  counter="$(newest_counter "${DOMAIN}_${key}_${value}_")"
  used=0
  if [ -n "$counter" ]; then
    if ! used="$(redis GET "$counter" 2>&1)"; then
      echo "FAIL tokens: cannot read counter $counter ($(first_line "$used"))"
      exit 1
    fi
    used="$(printf '%s' "$used" | tr -d '[:space:]')"
  fi
  [[ "$used" =~ ^[0-9]+$ ]] || used=0
  percent=$((used * 100 / cap))
  note="${percent}%"
  if [ "$used" -gt "$cap" ]; then note="${percent}%, over its cap"; fi
  label="$(printf %s "$value" | tr . /)"
  echo "ok   tokens $key $label: $used of $cap ($note)"
done <<<"$entries"
