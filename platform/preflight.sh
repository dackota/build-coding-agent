#!/usr/bin/env bash
# Stop `make up` before it creates anything: each tool on PATH, the pinned tool
# versions, a running Docker, and a non-empty OPENCODE_KEY in .env. The key value is
# held only to test that it is non-empty; it is never printed.
set -euo pipefail
# shellcheck source=platform/lib.sh
. "$(dirname "$0")/lib.sh"

TOOLS="kind docker kubectl helm jq curl shasum git"

check_tools() {
  local tool
  for tool in $TOOLS; do
    command -v "$tool" >/dev/null 2>&1 || fail "missing tool: $tool is not on PATH"
  done
}

check_versions() {
  local kind_out kind_version helm_version helm_major docker_out
  kind_out="$(kind version)" || fail "could not run kind version"
  kind_version="$(printf '%s\n' "$kind_out" | awk '{print $2}')"
  [ "$kind_version" = "$KIND_VERSION" ] ||
    fail "wrong kind version: found $kind_version, need $KIND_VERSION (platform/versions.env)"
  helm_version="$(helm version --template '{{.Version}}')" || fail "could not run helm version"
  helm_major="${helm_version#v}"
  helm_major="${helm_major%%.*}"
  case " $HELM_MAJORS " in
    *" $helm_major "*) ;;
    *) fail "wrong helm version: found $helm_version, need major version one of: $HELM_MAJORS" ;;
  esac
  docker_out="$(docker info --format '{{.ServerVersion}}' 2>&1)" ||
    fail "docker is not running (docker info: $(first_line "$docker_out"))"
}

check_key() {
  local value
  [ -f "$ENV_FILE" ] || fail "missing .env file at $ENV_FILE: copy .env.example and set $KEY_NAME"
  [ -r "$ENV_FILE" ] || fail "cannot read .env file at $ENV_FILE"
  value="$(read_key)"
  [ -n "$value" ] || fail "$KEY_NAME is missing or empty in $ENV_FILE: set it to your OpenCode Go key"
}

check_tools
check_versions
check_key
echo "preflight ok: tools, versions, and $KEY_NAME are present"
