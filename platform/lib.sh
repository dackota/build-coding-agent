#!/usr/bin/env bash
# shellcheck disable=SC2034  # the names are used by the scripts that source this file
# Shared names and helpers for the platform scripts. Sourced, not run.
# Every kubectl call goes through k (kubectl --context) and every helm call through
# h (helm --kube-context), so no call relies on the active context.

PLATFORM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$PLATFORM_DIR/.." && pwd)"
# shellcheck source=platform/versions.env
. "$PLATFORM_DIR/versions.env"

CLUSTER="build-coding-agent"
CTX="kind-$CLUSTER"
REGISTRY_NAME="$CLUSTER-registry"
REGISTRY_INTERNAL_PORT=5000
BIN_DIR="${BIN_DIR:-$ROOT/.bin}"
# The key file: .env in the main checkout, which every worktree shares.
MAIN_CHECKOUT="$(dirname "$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir)")"
ENV_FILE="${ENV_FILE:-$MAIN_CHECKOUT/.env}"
KEY_NAME="OPENCODE_KEY"

# kagent's own install (the controller); every agent of ours lives in AGENTS_NS (platform/agents.yaml).
KAGENT_NS="kagent"
AGENTS_NS="agents"
GITHUB_MCP_NS="github-mcp"
SUBSTRATE_NS="ate-system"
AGW_NS="agentgateway-system"
KEY_SECRET="opencode-go-key"

fail() { echo "$(basename "$0"): $*" >&2; exit 1; }
k() { kubectl --context "$CTX" "$@"; }
h() { helm --kube-context "$CTX" "$@"; }
first_line() { printf '%s\n' "$1" | head -n 1; }

# True when NAME ($1) is a whole line of the listing in $2. Callers capture listings in
# a plain assignment so a failing tool stops the script (set -e is off in conditions).
has_line() { printf '%s\n' "$2" | grep -qxF -- "$1"; }

# The value of variable NAME ($1) in ENV_FILE, quotes and surrounding whitespace removed.
# Prints it to stdout for a pipe into kubectl only; callers never echo it.
read_env_value() {
  local name="$1" line
  # grep exits 1 for no match (an empty value, which the caller reports); 2 is an error.
  line="$(grep -m1 "^$name=" "$ENV_FILE")" || [ "$?" -eq 1 ] || fail "could not read $ENV_FILE"
  printf '%s' "${line#"$name"=}" | tr -d "[:space:]\"'"
}

# The OPENCODE_KEY value from ENV_FILE (see read_env_value).
read_key() { read_env_value "$KEY_NAME"; }

# os-arch as the kagent release names its CLI assets, e.g. darwin-arm64.
os_arch() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$arch" in aarch64) arch=arm64 ;; x86_64) arch=amd64 ;; *) ;; esac
  echo "$os-$arch"
}
