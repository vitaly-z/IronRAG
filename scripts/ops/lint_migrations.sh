#!/usr/bin/env bash
# lint_migrations.sh — CI-ready migration policy linter for IronRAG
# Checks:
#   1. Frozen-migration integrity (released files must be byte-identical to gh/master)
#   2. Idempotency of the active pre-release migration
#   3. Sequential numbering (no skipped migration numbers)
#   4. Filename convention (NNNN_descriptive_name.sql)
#
# Exit codes: 0 = all FAIL-class checks pass, 1 = at least one FAIL, 2 = usage error

set -euo pipefail

SELF_PATH="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"

# ── colour helpers ────────────────────────────────────────────────────────────
RED='\033[0;31m'; YELLOW='\033[0;33m'; GREEN='\033[0;32m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
if [ ! -t 2 ]; then RED=''; YELLOW=''; GREEN=''; CYAN=''; BOLD=''; RESET=''; fi

err()  { printf "${RED}[FAIL]${RESET}  %s\n" "$*" >&2; }
warn() { printf "${YELLOW}[WARN]${RESET}  %s\n" "$*" >&2; }
ok()   { printf "${GREEN}[OK]${RESET}    %s\n" "$*" >&2; }
info() { printf "${CYAN}[INFO]${RESET}  %s\n" "$*" >&2; }

# ── flags ─────────────────────────────────────────────────────────────────────
STRICT=0; FIX=0; SELF_TEST=0

usage() {
  cat >&2 <<EOF
${BOLD}Usage:${RESET} lint_migrations.sh [--strict] [--fix] [--self-test] [--help]

Checks migration policy compliance for IronRAG:
  1. Frozen-migration integrity  — released files must match gh/master byte-for-byte
  2. Idempotency                 — active pre-release migration must use IF NOT EXISTS etc.
  3. Sequential numbering        — no skipped migration numbers
  4. Filename convention         — NNNN_descriptive_name.sql format

Options:
  --strict     Treat WARN-class findings as FAIL (non-zero exit)
  --fix        Print suggested idempotency patches to stderr
  --self-test  Run against a synthetic invalid migration; exit 0 if linter detects it
  --help       Print this help and exit 0

Output: human-readable coloured summary to stderr, JSON line summary to stdout.
EOF
  exit 0
}

for arg in "$@"; do
  case "$arg" in
    --strict)    STRICT=1 ;;
    --fix)       FIX=1 ;;
    --self-test) SELF_TEST=1 ;;
    --help|-h)   usage ;;
    *) printf "Unknown option: %s\n" "$arg" >&2; exit 2 ;;
  esac
done

# ── repo root ─────────────────────────────────────────────────────────────────
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  printf "Not inside a git repository.\n" >&2; exit 2
}
MIGRATIONS_DIR="$REPO_ROOT/apps/api/migrations"

# ── self-test mode ────────────────────────────────────────────────────────────
if [ "$SELF_TEST" -eq 1 ]; then
  info "Running self-test with synthetic invalid migration …"
  TMPDIR_ST="$(mktemp -d)"
  trap 'rm -rf "$TMPDIR_ST"' EXIT

  # Build a fake repo
  FAKE_REPO="$TMPDIR_ST/repo"
  mkdir -p "$FAKE_REPO/apps/api/migrations"
  cd "$FAKE_REPO"
  git init -q -b master
  git config user.email "lint@test"
  git config user.name "Lint Test"

  # Released migrations (will form gh/master)
  cat > apps/api/migrations/0001_init.sql <<'SQLE'
create table if not exists foo (id uuid primary key);
SQLE
  # Skipped 0002; jump to 0003 to trigger seq-check
  cat > apps/api/migrations/0003_bad.sql <<'SQLE'
-- BAD: no IF NOT EXISTS, non-idempotent
create table bar (id uuid primary key);
create index bar_idx on bar(id);
alter table bar add column name text;
alter type my_enum add value 'new_val';
insert into bar values (gen_random_uuid());
create function myfunc() returns void language sql as '$$select 1$$';
SQLE
  # Bad filename (uppercase)
  cat > apps/api/migrations/0004_BadName.sql <<'SQLE'
select 1;
SQLE

  git add .
  git commit -q -m "initial"

  # Create a bare clone to serve as the "gh" remote
  BARE_REMOTE="$TMPDIR_ST/gh-bare"
  git clone -q --bare "$FAKE_REPO" "$BARE_REMOTE"
  # Ensure the bare clone has a branch called master
  git -C "$BARE_REMOTE" symbolic-ref HEAD refs/heads/master 2>/dev/null || true

  git remote add gh "$BARE_REMOTE"
  git fetch -q gh

  # Tamper with a released file locally (after gh/master is set)
  echo "-- tampered" >> apps/api/migrations/0001_init.sql

  # Run ourselves against this fake repo
  LINT_EXIT=0
  bash "$SELF_PATH" --strict 2>/dev/null || LINT_EXIT=$?
  if [ "$LINT_EXIT" -ne 0 ]; then
    ok "Self-test passed: linter correctly detected violations (exit $LINT_EXIT)"
    exit 0
  else
    err "Self-test FAILED: linter should have exited non-zero but exited 0"
    exit 1
  fi
fi

# ── collect local migration files ─────────────────────────────────────────────
mapfile -t LOCAL_FILES < <(find "$MIGRATIONS_DIR" -maxdepth 1 -name '*.sql' | sort)

if [ ${#LOCAL_FILES[@]} -eq 0 ]; then
  warn "No migration files found in $MIGRATIONS_DIR"
fi

# ── resolve gh/master migration set ──────────────────────────────────────────
# gh/master blob SHAs, keyed by filename (basename only)
declare -A GH_BLOBS   # basename -> blob-sha
declare -A GH_PATHS   # basename -> full repo-relative path

GH_AVAILABLE=0
if git -C "$REPO_ROOT" ls-remote --exit-code gh >/dev/null 2>&1; then
  GH_AVAILABLE=1
  while IFS= read -r line; do
    # format: "100644 blob <sha>\t<path>"
    sha="$(printf '%s' "$line" | awk '{print $3}')"
    path="$(printf '%s' "$line" | cut -f2)"
    base="$(basename "$path")"
    GH_BLOBS["$base"]="$sha"
    GH_PATHS["$base"]="$path"
  done < <(git -C "$REPO_ROOT" ls-tree -r gh/master apps/api/migrations/ 2>/dev/null || true)
else
  warn "Remote 'gh' not reachable; skipping frozen-migration integrity check"
fi

# ── tracking ─────────────────────────────────────────────────────────────────
FAIL_COUNT=0
WARN_COUNT=0
declare -a FINDINGS=()  # JSON objects

json_str() {
  # Minimal JSON string escaping for pure bash (no python dep)
  local s="$1"
  s="${s//\\/\\\\}"   # backslash
  s="${s//\"/\\\"}"   # double-quote
  s="${s//$'\n'/\\n}" # newline
  s="${s//$'\t'/\\t}" # tab
  printf '"%s"' "$s"
}

record_fail() {
  local check="$1" file="$2" msg="$3"
  FAIL_COUNT=$(( FAIL_COUNT + 1 ))
  FINDINGS+=("{\"level\":\"FAIL\",\"check\":$(json_str "$check"),\"file\":$(json_str "$file"),\"message\":$(json_str "$msg")}")
}

record_warn() {
  local check="$1" file="$2" msg="$3"
  WARN_COUNT=$(( WARN_COUNT + 1 ))
  FINDINGS+=("{\"level\":\"WARN\",\"check\":$(json_str "$check"),\"file\":$(json_str "$file"),\"message\":$(json_str "$msg")}")
  if [ "$STRICT" -eq 1 ]; then
    FAIL_COUNT=$(( FAIL_COUNT + 1 ))
  fi
}

# ── Check 4: filename convention ─────────────────────────────────────────────
info "Check 4: filename convention"
for f in "${LOCAL_FILES[@]}"; do
  base="$(basename "$f")"
  if ! printf '%s' "$base" | grep -qE '^[0-9]{4}_[a-z][a-z0-9_]+\.sql$'; then
    err "Filename convention: '$base' does not match ^[0-9]{4}_[a-z][a-z0-9_]+\\.sql\$"
    record_fail "filename_convention" "$base" "Does not match ^[0-9]{4}_[a-z][a-z0-9_]+.sql$"
  fi
done

# ── Check 3: sequential numbering ────────────────────────────────────────────
info "Check 3: sequential numbering"
PREV_NUM=0
for f in "${LOCAL_FILES[@]}"; do
  base="$(basename "$f")"
  NUM="${base:0:4}"
  # strip leading zeros for arithmetic
  N=$(( 10#$NUM ))
  if [ "$PREV_NUM" -gt 0 ] && [ "$N" -ne $(( PREV_NUM + 1 )) ]; then
    EXPECTED=$(printf "%04d" $(( PREV_NUM + 1 )))
    err "Sequential numbering: gap detected — expected ${EXPECTED}_*.sql before $base"
    record_fail "sequential_numbering" "$base" "Gap: expected ${EXPECTED}_*.sql before $base"
  fi
  PREV_NUM=$N
done

# ── Check 1: frozen-migration integrity ──────────────────────────────────────
info "Check 1: frozen-migration integrity"
if [ "$GH_AVAILABLE" -eq 1 ]; then
  for f in "${LOCAL_FILES[@]}"; do
    base="$(basename "$f")"
    if [ -n "${GH_BLOBS[$base]+_}" ]; then
      # This file exists in gh/master — it must be byte-identical
      GH_SHA="${GH_BLOBS[$base]}"
      # Compute blob SHA of local file the same way git does
      LOCAL_SHA="$(git -C "$REPO_ROOT" hash-object "$f")"
      if [ "$LOCAL_SHA" != "$GH_SHA" ]; then
        err "Frozen migration modified: $base (local blob $LOCAL_SHA ≠ gh/master $GH_SHA)"
        # Show a diff
        GH_CONTENT="$(git -C "$REPO_ROOT" show "gh/master:${GH_PATHS[$base]}")"
        DIFF_OUT="$(diff <(printf '%s' "$GH_CONTENT") "$f" || true)"
        printf '%s\n' "$DIFF_OUT" >&2
        record_fail "frozen_migration" "$base" "Local blob $LOCAL_SHA differs from gh/master $GH_SHA"
      else
        ok "Frozen OK: $base"
      fi
    fi
  done
fi

# ── Determine active pre-release migration ────────────────────────────────────
# The highest-numbered local file that does NOT appear in gh/master
ACTIVE_MIGRATION=""
for f in "${LOCAL_FILES[@]}"; do
  base="$(basename "$f")"
  if [ -z "${GH_BLOBS[$base]+_}" ]; then
    # Not in gh/master → candidate pre-release file
    ACTIVE_MIGRATION="$f"
  fi
done

# ── Check 2: idempotency ─────────────────────────────────────────────────────
info "Check 2: idempotency of active pre-release migration"
if [ -z "$ACTIVE_MIGRATION" ]; then
  info "No unreleased migration file found — idempotency check skipped"
else
  info "Active pre-release migration: $(basename "$ACTIVE_MIGRATION")"
  BASE="$(basename "$ACTIVE_MIGRATION")"

  # Helper: check a pattern and report
  check_pattern() {
    local level="$1"   # FAIL or WARN
    local desc="$2"
    local fix_hint="$3"
    local pattern="$4"
    local anti_pattern="$5"  # if present on the SAME logical line, it's OK

    # Read file, strip comments, process line by line
    # We normalise multi-word to single lines by joining continuation lines is
    # complex; instead we scan for the bad pattern and then check the same line
    # does NOT contain the guard keyword.
    local lineno=0
    while IFS= read -r line; do
      lineno=$(( lineno + 1 ))
      # skip pure comment lines
      stripped="$(printf '%s' "$line" | sed 's/--.*$//' | tr '[:upper:]' '[:lower:]')"
      if printf '%s' "$stripped" | grep -qiE "$pattern"; then
        if [ -n "$anti_pattern" ] && printf '%s' "$stripped" | grep -qiE "$anti_pattern"; then
          continue  # guard keyword present on same line — OK
        fi
        # Check the next few lines for the guard (covers multi-line ALTER TABLE … ADD COLUMN)
        local context
        context="$(sed -n "${lineno},$((lineno+3))p" "$ACTIVE_MIGRATION" | tr '[:upper:]' '[:lower:]' | tr '\n' ' ')"
        if [ -n "$anti_pattern" ] && printf '%s' "$context" | grep -qiE "$anti_pattern"; then
          continue
        fi
        if [ "$level" = "FAIL" ]; then
          err "Idempotency [$BASE:$lineno]: $desc"
          err "  Line: $(sed -n "${lineno}p" "$ACTIVE_MIGRATION" | xargs)"
          [ "$FIX" -eq 1 ] && printf "${YELLOW}  Suggested fix: %s${RESET}\n" "$fix_hint" >&2
          record_fail "idempotency" "$BASE" "$desc at line $lineno"
        else
          warn "Idempotency [$BASE:$lineno]: $desc"
          warn "  Line: $(sed -n "${lineno}p" "$ACTIVE_MIGRATION" | xargs)"
          [ "$FIX" -eq 1 ] && printf "${YELLOW}  Suggested fix: %s${RESET}\n" "$fix_hint" >&2
          record_warn "idempotency" "$BASE" "$desc at line $lineno"
        fi
      fi
    done < "$ACTIVE_MIGRATION"
  }

  # FAIL-class checks
  check_pattern FAIL \
    "CREATE TABLE without IF NOT EXISTS" \
    "Add IF NOT EXISTS after TABLE keyword" \
    "^\s*create\s+table\s" \
    "if\s+not\s+exists"

  check_pattern FAIL \
    "CREATE INDEX without IF NOT EXISTS" \
    "Add IF NOT EXISTS after INDEX keyword" \
    "^\s*create\s+(unique\s+)?index\s" \
    "if\s+not\s+exists"

  check_pattern FAIL \
    "ALTER TYPE ... ADD VALUE without IF NOT EXISTS" \
    "Add IF NOT EXISTS after ADD VALUE" \
    "add\s+value\s" \
    "if\s+not\s+exists"

  check_pattern FAIL \
    "ALTER TABLE ... ADD COLUMN without IF NOT EXISTS" \
    "Add IF NOT EXISTS after ADD COLUMN" \
    "add\s+column\s" \
    "if\s+not\s+exists"

  # WARN-class checks
  check_pattern WARN \
    "INSERT INTO without ON CONFLICT clause" \
    "Add ON CONFLICT DO NOTHING or ON CONFLICT ... DO UPDATE" \
    "^\s*insert\s+into\s" \
    "on\s+conflict"

  check_pattern WARN \
    "CREATE FUNCTION without OR REPLACE" \
    "Use CREATE OR REPLACE FUNCTION" \
    "^\s*create\s+function\s" \
    "or\s+replace"
fi

# ── JSON summary to stdout ────────────────────────────────────────────────────
printf '{"fail_count":%d,"warn_count":%d,"findings":[' \
  "$FAIL_COUNT" "$WARN_COUNT"
FIRST=1
for obj in "${FINDINGS[@]}"; do
  [ "$FIRST" -eq 1 ] && FIRST=0 || printf ','
  printf '%s' "$obj"
done
printf ']}\n'

# ── Human summary to stderr ───────────────────────────────────────────────────
printf '\n' >&2
if [ "$FAIL_COUNT" -eq 0 ] && [ "$WARN_COUNT" -eq 0 ]; then
  printf "${GREEN}${BOLD}All checks passed.${RESET}\n" >&2
elif [ "$FAIL_COUNT" -eq 0 ]; then
  printf "${YELLOW}${BOLD}%d warning(s), 0 failures.%s${RESET}\n" \
    "$WARN_COUNT" "$([ "$STRICT" -eq 1 ] && echo ' (--strict: warnings treated as failures)' || echo '')" >&2
else
  printf "${RED}${BOLD}%d failure(s), %d warning(s).${RESET}\n" "$FAIL_COUNT" "$WARN_COUNT" >&2
fi

# Exit non-zero if any FAIL-class findings (WARN elevated to FAIL under --strict
# is already counted in FAIL_COUNT)
[ "$FAIL_COUNT" -eq 0 ]
