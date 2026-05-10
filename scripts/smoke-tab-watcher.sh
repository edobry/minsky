#!/usr/bin/env bash
# Smoke test for the tab-watcher daemon. Runs scripts/tab-watcher/tab-watcher.sh
# once in foreground against an isolated state directory, then asserts a valid
# snapshot is produced. Exits 0 on success, non-zero on failure.
set -euo pipefail

if ! command -v lsof >/dev/null 2>&1; then
  echo "SKIP: lsof not available"
  exit 0
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "SKIP: python3 not available"
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WATCHER="$SCRIPT_DIR/tab-watcher/tab-watcher.sh"

if [ ! -f "$WATCHER" ]; then
  echo "FAIL: $WATCHER not found"
  exit 1
fi

TMP=$(mktemp -d /tmp/smoke-tab-watcher.XXXXXX)
trap "rm -rf '$TMP'" EXIT

TAB_WATCHER_STATE_DIR="$TMP" bash "$WATCHER"

SNAP="$TMP/snapshot.json"
if [ ! -f "$SNAP" ]; then
  echo "FAIL: snapshot not written at $SNAP"
  exit 1
fi

python3 - "$SNAP" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
assert "timestamp" in d, "missing timestamp"
assert "sessions" in d, "missing sessions"
assert isinstance(d["sessions"], list), "sessions is not a list"
print(f"OK: snapshot parses; timestamp={d['timestamp']} sessions={len(d['sessions'])}")
PY

N=$(python3 -c "import json,sys; print(len(json.load(open(sys.argv[1]))['sessions']))" "$SNAP")
# pgrep -f catches Bun-renamed claude procs (process.title rewritten to version string)
if pgrep -f 'Claude.app|/claude' >/dev/null 2>&1 || pgrep -x claude >/dev/null 2>&1; then
  if [ "$N" -lt 1 ]; then
    echo "WARN: claude is running but snapshot has 0 sessions (lsof may need broader filter or pgrep matched non-CLI process)"
  else
    echo "OK: claude is running, snapshot has $N sessions"
  fi
else
  echo "OK: no claude process detected; snapshot has $N sessions"
fi

if ! ls -1 "$TMP"/snapshot-*.json >/dev/null 2>&1; then
  echo "FAIL: history file not created"
  exit 1
fi
echo "OK: history file written"

echo "PASS: smoke-tab-watcher"
