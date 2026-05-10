#!/usr/bin/env bash
# Verify all preconditions before enabling the UI MCP-agent handler.
#
# Usage:
#   IRONRAG_API_BASE_URL=https://example.com \
#   IRONRAG_API_TOKEN=<token> \
#   [IRONRAG_LIBRARY_IDS=uuid1,uuid2] \
#   [IRONRAG_PG_DSN=postgres://...] \
#   scripts/ops/check_mcp_agent_rollout.sh [--with-bench]
#
# Preconditions checked:
#   1. Migration version 6 (0006_ui_mcp_agent.sql) is applied.
#      Requires IRONRAG_PG_DSN; skipped with a warning otherwise.
#   2. Each active library has at least one active "agent" binding.
#      Checked via GET /v1/ai/bindings?scopeKind=library&libraryId={id}.
#   3. (--with-bench) scripts/bench/agent_turn_p95.py p95 <= 25 000 ms.
#
# Output:
#   stderr  — coloured human-readable status table
#   stdout  — single JSON summary line
#
# Exit codes:
#   0  all preconditions pass (ready_to_rollout=true)
#   1  one or more preconditions failed

set -euo pipefail

# ---------------------------------------------------------------------------
# Colour helpers (degrade gracefully when not a TTY)
# ---------------------------------------------------------------------------
if [ -t 2 ]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[0;33m'
    BOLD='\033[1m'
    RESET='\033[0m'
else
    RED='' GREEN='' YELLOW='' BOLD='' RESET=''
fi

ok()   { printf "${GREEN}  OK    %s${RESET}\n" "$*" >&2; }
fail() { printf "${RED}  FAIL  %s${RESET}\n" "$*" >&2; }
warn() { printf "${YELLOW}  WARN  %s${RESET}\n" "$*" >&2; }
info() { printf "  %-6s %s\n" "" "$*" >&2; }
sep()  { printf "%s\n" "$(printf '%.0s─' {1..60})" >&2; }

# ---------------------------------------------------------------------------
# Usage / help
# ---------------------------------------------------------------------------
usage() {
    cat >&2 <<EOF
${BOLD}check_mcp_agent_rollout.sh${RESET} — verify MCP-agent rollout preconditions

${BOLD}Usage${RESET}
  IRONRAG_API_BASE_URL=<url> IRONRAG_API_TOKEN=<token> \\
      $(basename "$0") [--with-bench] [--help]

${BOLD}Required env vars${RESET}
  IRONRAG_API_BASE_URL   Base URL of the IronRAG API (no trailing slash)
  IRONRAG_API_TOKEN      Bearer token for the API

${BOLD}Optional env vars${RESET}
  IRONRAG_LIBRARY_IDS    Comma-separated library UUIDs to check.
                         Defaults to all active libraries discovered via the API.
  IRONRAG_PG_DSN         PostgreSQL DSN (psql-compatible).
                         When set, confirms migration version 6 is applied.
                         When absent, the migration check is skipped.

${BOLD}Flags${RESET}
  --with-bench           Also run scripts/bench/agent_turn_p95.py and report
                         the p95 latency gate result. Requires IRONRAG_LIBRARY_ID
                         to be set for the bench script (uses the first library
                         in the active list if IRONRAG_LIBRARY_ID is unset).
  --help                 Print this help and exit 0.

${BOLD}Output${RESET}
  stderr   Coloured human-readable status table.
  stdout   Single JSON summary line:
           {"migration_v6": true|false|"skipped",
            "libraries": [{"id":"...","agent_binding":true|false}],
            "bench_p95_ms": null|<number>,
            "ready_to_rollout": true|false}

${BOLD}Exit codes${RESET}
  0  All preconditions pass.
  1  One or more preconditions failed or required env vars are missing.

${BOLD}Dependencies${RESET}
  curl, jq (always required)
  psql (required only when IRONRAG_PG_DSN is set)
  python3 (required only with --with-bench)
EOF
    exit 0
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
WITH_BENCH=0
for arg in "$@"; do
    case "$arg" in
        --help|-h) usage ;;
        --with-bench) WITH_BENCH=1 ;;
        *) printf "${RED}Unknown argument: %s${RESET}\n" "$arg" >&2; exit 1 ;;
    esac
done

# ---------------------------------------------------------------------------
# Validate required env vars
# ---------------------------------------------------------------------------
errors=()
: "${IRONRAG_API_BASE_URL:?}" 2>/dev/null || errors+=("IRONRAG_API_BASE_URL is required")
: "${IRONRAG_API_TOKEN:?}"    2>/dev/null || errors+=("IRONRAG_API_TOKEN is required")

if [[ ${#errors[@]} -gt 0 ]]; then
    for msg in "${errors[@]}"; do
        printf "${RED}ERROR: %s${RESET}\n" "$msg" >&2
    done
    echo >&2
    usage
fi

BASE_URL="${IRONRAG_API_BASE_URL%/}"
PG_DSN="${IRONRAG_PG_DSN:-}"
EXPLICIT_LIBRARY_IDS="${IRONRAG_LIBRARY_IDS:-}"

# ---------------------------------------------------------------------------
# Dependency check
# ---------------------------------------------------------------------------
for cmd in curl jq; do
    if ! command -v "$cmd" &>/dev/null; then
        printf "${RED}ERROR: required tool '%s' not found in PATH${RESET}\n" "$cmd" >&2
        exit 1
    fi
done

if [[ -n "$PG_DSN" ]] && ! command -v psql &>/dev/null; then
    warn "psql not found — DB migration check will be skipped despite IRONRAG_PG_DSN being set"
    PG_DSN=""
fi

if [[ "$WITH_BENCH" -eq 1 ]] && ! command -v python3 &>/dev/null; then
    warn "python3 not found — --with-bench will be skipped"
    WITH_BENCH=0
fi

# ---------------------------------------------------------------------------
# Curl helper (token never echoed)
# ---------------------------------------------------------------------------
api_get() {
    # $1 = path (starting with /)
    local path="$1"
    curl --fail --silent --show-error \
        -H "Authorization: Bearer ${IRONRAG_API_TOKEN}" \
        -H "Accept: application/json" \
        "${BASE_URL}${path}"
}

# ---------------------------------------------------------------------------
# Header
# ---------------------------------------------------------------------------
sep
printf "${BOLD}  IronRAG MCP-agent rollout precondition check${RESET}\n" >&2
printf "  target: %s\n" "$BASE_URL" >&2
sep

# ---------------------------------------------------------------------------
# Track overall readiness
# ---------------------------------------------------------------------------
READY=1   # 1 = still passing; 0 = at least one failure

# ---------------------------------------------------------------------------
# Precondition 1 — Migration version 6
# ---------------------------------------------------------------------------
printf "\n${BOLD}[1/3] Migration 0006_ui_mcp_agent${RESET}\n" >&2

MIGRATION_V6_STATUS="skipped"

if [[ -n "$PG_DSN" ]]; then
    mig_count=$(psql "$PG_DSN" -t -A -c \
        "SELECT COUNT(*) FROM _sqlx_migrations WHERE version = 6;" 2>&1) || {
        fail "psql query failed: $mig_count"
        MIGRATION_V6_STATUS="false"
        READY=0
        mig_count=0
    }
    mig_count="${mig_count//[[:space:]]/}"
    if [[ "$mig_count" == "1" ]]; then
        ok "migration version 6 is applied"
        MIGRATION_V6_STATUS="true"
    else
        fail "migration version 6 not found in _sqlx_migrations (count=${mig_count})"
        MIGRATION_V6_STATUS="false"
        READY=0
    fi
else
    warn "IRONRAG_PG_DSN not set — skipping DB migration check (HTTP-only mode)"
    MIGRATION_V6_STATUS='"skipped"'
fi

# ---------------------------------------------------------------------------
# Precondition 2 — Discover active libraries
# ---------------------------------------------------------------------------
printf "\n${BOLD}[2/3] Agent binding check per library${RESET}\n" >&2

declare -a LIBRARY_IDS=()

if [[ -n "$EXPLICIT_LIBRARY_IDS" ]]; then
    IFS=',' read -ra LIBRARY_IDS <<< "$EXPLICIT_LIBRARY_IDS"
    info "using explicit library list (${#LIBRARY_IDS[@]} entries)"
else
    info "discovering active libraries via API..."
    # Enumerate workspaces, then libraries per workspace
    workspaces_json=$(api_get "/v1/catalog/workspaces") || {
        fail "failed to GET /v1/catalog/workspaces"
        echo '{"migration_v6":'"$MIGRATION_V6_STATUS"',"libraries":[],"bench_p95_ms":null,"ready_to_rollout":false}'
        exit 1
    }
    workspace_ids=$(printf '%s' "$workspaces_json" | jq -r '.[].id // empty' 2>/dev/null) || {
        fail "failed to parse workspaces response"
        echo '{"migration_v6":'"$MIGRATION_V6_STATUS"',"libraries":[],"bench_p95_ms":null,"ready_to_rollout":false}'
        exit 1
    }

    while IFS= read -r ws_id; do
        [[ -z "$ws_id" ]] && continue
        libs_json=$(api_get "/v1/catalog/workspaces/${ws_id}/libraries") || {
            warn "failed to GET libraries for workspace ${ws_id} — skipping"
            continue
        }
        while IFS= read -r lib_id; do
            [[ -z "$lib_id" ]] && continue
            LIBRARY_IDS+=("$lib_id")
        done < <(printf '%s' "$libs_json" | jq -r '.[] | select(.lifecycleState == "active") | .id // empty' 2>/dev/null)
    done <<< "$workspace_ids"

    info "found ${#LIBRARY_IDS[@]} active library/libraries"
fi

if [[ ${#LIBRARY_IDS[@]} -eq 0 ]]; then
    warn "no active libraries found — agent binding check skipped"
fi

# For each library, check for an active agent binding
LIBRARIES_JSON="["
FIRST_LIBRARY_ID=""

for lib_id in "${LIBRARY_IDS[@]}"; do
    [[ -z "$FIRST_LIBRARY_ID" ]] && FIRST_LIBRARY_ID="$lib_id"

    bindings_json=$(api_get "/v1/ai/bindings?scopeKind=library&libraryId=${lib_id}") || {
        fail "library ${lib_id}: failed to GET /v1/ai/bindings"
        LIBRARIES_JSON+='{"id":"'"$lib_id"'","agent_binding":false},'
        READY=0
        continue
    }

    has_agent=$(printf '%s' "$bindings_json" | jq -r \
        '[.[] | select(.bindingPurpose == "agent" and .bindingState == "active")] | length' 2>/dev/null) || has_agent=0

    if [[ "$has_agent" -gt 0 ]]; then
        ok "library ${lib_id}: active agent binding found (${has_agent})"
        LIBRARIES_JSON+='{"id":"'"$lib_id"'","agent_binding":true},'
    else
        fail "library ${lib_id}: no active agent binding"
        LIBRARIES_JSON+='{"id":"'"$lib_id"'","agent_binding":false},'
        READY=0
    fi
done

# Trim trailing comma
LIBRARIES_JSON="${LIBRARIES_JSON%,}]"

# ---------------------------------------------------------------------------
# Precondition 3 — Latency benchmark (optional)
# ---------------------------------------------------------------------------
printf "\n${BOLD}[3/3] Latency benchmark (p95 gate ≤ 25 000 ms)${RESET}\n" >&2

BENCH_P95_MS="null"

if [[ "$WITH_BENCH" -eq 0 ]]; then
    info "skipped (pass --with-bench to enable)"
else
    # Resolve which library to bench against
    bench_lib="${IRONRAG_LIBRARY_ID:-${FIRST_LIBRARY_ID:-}}"
    if [[ -z "$bench_lib" ]]; then
        warn "no library available for bench — skipping latency check"
    else
        bench_script_dir="$(cd "$(dirname "$0")/../.." && pwd)"
        bench_script="${bench_script_dir}/scripts/bench/agent_turn_p95.py"

        if [[ ! -f "$bench_script" ]]; then
            warn "bench script not found at ${bench_script} — skipping latency check"
        else
            info "running latency benchmark against library ${bench_lib}..."
            bench_output=$(IRONRAG_API_BASE_URL="$BASE_URL" \
                           IRONRAG_API_TOKEN="$IRONRAG_API_TOKEN" \
                           IRONRAG_LIBRARY_ID="$bench_lib" \
                           python3 "$bench_script" 2>/dev/null) && bench_exit=0 || bench_exit=$?

            BENCH_P95_MS=$(printf '%s' "$bench_output" | tail -1 | jq -r '.p95_ms // "null"' 2>/dev/null) || BENCH_P95_MS="null"

            if [[ "$bench_exit" -eq 0 ]]; then
                ok "p95 latency = ${BENCH_P95_MS} ms (within gate)"
            else
                fail "p95 latency = ${BENCH_P95_MS} ms (gate breach or bench error, exit=${bench_exit})"
                READY=0
            fi
        fi
    fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
sep
if [[ "$READY" -eq 1 ]]; then
    READY_BOOL="true"
    printf "\n${GREEN}${BOLD}  RESULT: ready_to_rollout = true${RESET}\n\n" >&2
else
    READY_BOOL="false"
    printf "\n${RED}${BOLD}  RESULT: ready_to_rollout = false — one or more checks failed${RESET}\n\n" >&2
fi
sep

# ---------------------------------------------------------------------------
# JSON summary to stdout
# ---------------------------------------------------------------------------
printf '{"migration_v6":%s,"libraries":%s,"bench_p95_ms":%s,"ready_to_rollout":%s}\n' \
    "$MIGRATION_V6_STATUS" \
    "$LIBRARIES_JSON" \
    "$BENCH_P95_MS" \
    "$READY_BOOL"

[[ "$READY_BOOL" == "true" ]] && exit 0 || exit 1
