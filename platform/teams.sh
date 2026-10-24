#!/usr/bin/env bash
# Read the one team list (platform/teams.txt, or TEAMS_FILE). Usage:
#   teams.sh names              one team name per line; fails on a bad, duplicate, or no name
#   teams.sh substrate-values   Substrate chart values: platform/substrate-values.yaml plus one
#                               credential-provider namespace policy per team namespace
# A team name is what the values-file schema allows (platform/charts/agent/values.schema.json).
set -euo pipefail

PLATFORM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEAMS_FILE="${TEAMS_FILE:-$PLATFORM_DIR/teams.txt}"
SUBSTRATE_BASE="$PLATFORM_DIR/substrate-values.yaml"
TEAM_PATTERN='^[a-z]([a-z0-9-]{0,18}[a-z0-9])?$'

fail() { echo "teams.sh: $*" >&2; exit 1; }

names() {
  local line name seen=" "
  [ -r "$TEAMS_FILE" ] || fail "cannot read the team list $TEAMS_FILE"
  while IFS= read -r line || [ -n "$line" ]; do
    name="${line%%#*}"
    name="$(printf '%s' "$name" | tr -d '[:space:]')"
    [ -n "$name" ] || continue
    [[ "$name" =~ $TEAM_PATTERN ]] || fail "team name '$name' in $TEAMS_FILE is not lower-case letters, digits and dashes (max 20)"
    case "$seen" in *" $name "*) fail "team $name is listed twice in $TEAMS_FILE" ;; *) ;; esac
    seen="$seen$name "
    printf '%s\n' "$name"
  done <"$TEAMS_FILE"
  [ "$seen" != " " ] || fail "no teams in $TEAMS_FILE"
}

# Substrate lists replace and are read only at install, so a new team needs a rebuild.
substrate_values() {
  local list name
  list="$(names)"
  cat "$SUBSTRATE_BASE"
  for name in $list; do
    printf '    - atespace: team-%s\n      allowedNamespaces: [team-%s]\n' "$name" "$name"
  done
}

case "${1:-}" in
  names) names ;;
  substrate-values) substrate_values ;;
  *) echo "usage: $0 names|substrate-values" >&2; exit 2 ;;
esac
