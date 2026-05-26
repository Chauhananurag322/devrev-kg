#!/usr/bin/env bash
# Background rebuild trigger for devrev-kg.
#
# Designed to be invoked from a Claude Code SessionStart hook. Checks whether
# the KG's recorded git sha matches the targetRepo HEAD. If they differ, fires
# off a `pnpm kg:full` in the background and detaches; otherwise returns
# immediately.
#
# Always exits 0 — never blocks session startup. Output goes to a log file
# under outputDir so failures are diagnosable later but invisible to the user.
#
# Configuration: reads paths from config.json next to this script's parent dir.
# All paths in this script (KG_REPO, TARGET_REPO, KG_DIR) are derived from it.

set -u

# Locate this script's repo root (two dirs up from scripts/maybe-rebuild.sh).
KG_REPO="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="${KG_CONFIG:-$KG_REPO/config.json}"

# Bail silently if config is missing — repo not yet initialized for this user.
[ -f "$CONFIG" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

TARGET_REPO="$(jq -r '.targetRepo // empty' "$CONFIG")"
KG_DIR="$(jq -r '.outputDir // empty' "$CONFIG")"

[ -n "$TARGET_REPO" ] || exit 0
[ -n "$KG_DIR" ] || exit 0
[ -d "$TARGET_REPO" ] || exit 0
[ -x "$KG_REPO/dist/build.js" ] || exit 0

mkdir -p "$KG_DIR"
LOG="$KG_DIR/rebuild.log"

HEAD_SHA="$(git -C "$TARGET_REPO" rev-parse HEAD 2>/dev/null || echo unknown)"
BUILD_SHA="$(jq -r '.gitSha // empty' "$KG_DIR/last-build.json" 2>/dev/null || echo)"

# Already up to date — nothing to do.
if [ -n "$BUILD_SHA" ] && [ "$HEAD_SHA" = "$BUILD_SHA" ]; then
  exit 0
fi

# Avoid stacking rebuilds: if a recent rebuild is already running, skip.
PID_FILE="$KG_DIR/.rebuild.pid"
if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE" 2>/dev/null || echo)"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    exit 0
  fi
fi

# Detach the rebuild so this script returns instantly. nohup + redirect +
# background keeps it alive after Claude Code exits.
{
  echo "[$(date -Iseconds)] rebuild kicked off: HEAD=$HEAD_SHA build=${BUILD_SHA:-none}" >> "$LOG"
  cd "$KG_REPO" && nohup node dist/build.js full >> "$LOG" 2>&1 &
  REBUILD_PID=$!
  echo "$REBUILD_PID" > "$PID_FILE"
  disown "$REBUILD_PID" 2>/dev/null || true
} </dev/null >/dev/null 2>&1

exit 0
