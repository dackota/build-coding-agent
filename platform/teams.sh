#!/usr/bin/env bash
# Read the one team list (platform/teams.txt, or TEAMS_FILE). Usage:
#   teams.sh names              one team name per line; fails on a bad, duplicate, or no name
#   teams.sh budgets            the budgets file (platform/budgets.txt, or BUDGETS_FILE) as a JSON
#                               object, team to monthly tokens; fails on a bad line, a duplicate,
#                               or a team that is not on the list
#   teams.sh substrate-values   Substrate chart values: platform/substrate-values.yaml plus one
#                               credential-provider namespace policy per team namespace
# A team name is what the values-file schema allows (platform/charts/agent/values.schema.json).
set -euo pipefail

PLATFORM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEAMS_FILE="${TEAMS_FILE:-$PLATFORM_DIR/teams.txt}"
BUDGETS_FILE="${BUDGETS_FILE:-$PLATFORM_DIR/budgets.txt}"
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

budgets() {
  local list line team tokens extra seen=" " out=""
  list="$(names)"
  [ -r "$BUDGETS_FILE" ] || fail "cannot read the budgets file $BUDGETS_FILE"
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%%#*}"
    read -r team tokens extra <<<"$line"
    [ -n "$team" ] || continue
    [[ "$tokens" =~ ^[1-9][0-9]{0,14}$ ]] && [ -z "$extra" ] || fail "budgets line '$line' in $BUDGETS_FILE is not '<team> <whole number of tokens>'"
    has_team "$list" "$team" || fail "budgets team '$team' in $BUDGETS_FILE is not on the team list $TEAMS_FILE"
    case "$seen" in *" $team "*) fail "budgets team $team is listed twice in $BUDGETS_FILE" ;; *) ;; esac
    seen="$seen$team "
    out="$out\"$team\":$tokens,"
  done <"$BUDGETS_FILE"
  printf '{%s}\n' "${out%,}"
}

has_team() { printf '%s\n' "$1" | grep -qxF -- "$2"; }

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
  budgets) budgets ;;
  substrate-values) substrate_values ;;
  *) echo "usage: $0 names|budgets|substrate-values" >&2; exit 2 ;;
esac
