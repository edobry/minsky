#!/usr/bin/env bash
# Consumer for the tab-watcher snapshot: opens iTerm tabs running
# `claude --resume <session_id>` for each session in the snapshot whose
# jsonl is still present on disk.
set -euo pipefail

STATE_DIR="${TAB_WATCHER_STATE_DIR:-$HOME/.claude/tab-state}"
SNAPSHOT="$STATE_DIR/snapshot.json"
DRY_RUN=0

usage() {
  cat <<EOF
Usage: $0 [--dry-run] [--snapshot <path>]

Reads $SNAPSHOT (or --snapshot <path>) and opens an iTerm tab running
'claude --resume <session_id>' for each recorded session whose jsonl still
exists on disk. Sessions whose jsonl is missing are skipped with a warning.

  --dry-run             Print the actions but don't open tabs.
  --snapshot <path>     Use a specific snapshot file (e.g. a historical one).
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --snapshot) SNAPSHOT="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage >&2; exit 1 ;;
  esac
done

if [ ! -f "$SNAPSHOT" ]; then
  echo "snapshot not found: $SNAPSHOT" >&2
  exit 1
fi

# Stale-snapshot warning: a >5 min old snapshot means the daemon wasn't
# running close to crash time, so the inventory may be incomplete.
age_sec=$(python3 - "$SNAPSHOT" <<'PY' 2>/dev/null || echo 0
import json, sys, time
from datetime import datetime
ts = json.load(open(sys.argv[1])).get("timestamp", "")
if not ts:
    print(0)
else:
    t = datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").timestamp()
    print(int(time.time() - t))
PY
)
if [ "$age_sec" -gt 300 ]; then
  echo "WARN: snapshot is ${age_sec}s old (>5 min) — daemon may have been down at crash time" >&2
fi

# Project sessions to TSV: session_id\tcwd\tjsonl. Empty fields are dropped.
mapfile -t ROWS < <(python3 - "$SNAPSHOT" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for s in d.get("sessions", []):
    sid = s.get("session_id", "")
    cwd = s.get("cwd", "")
    jsonl = s.get("jsonl", "")
    if sid and cwd and jsonl:
        print(f"{sid}\t{cwd}\t{jsonl}")
PY
)

# AppleScript-safe quoter: backslash and double-quote are the only meta chars.
applescript_quote() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '"%s"' "$s"
}

for row in "${ROWS[@]}"; do
  IFS=$'\t' read -r sid cwd jsonl <<< "$row"
  if [ ! -f "$jsonl" ]; then
    echo "SKIP: $sid — jsonl missing on disk: $jsonl" >&2
    continue
  fi
  echo "RESUME: $sid (cwd=$cwd)"
  [ "$DRY_RUN" = "1" ] && continue

  # Build the shell command for the new tab. Single-quote the cwd and sid;
  # both are paths/UUIDs from our snapshot so '\'' replacement is enough.
  cwd_q="'${cwd//\'/\'\\\'\'}'"
  sid_q="'${sid//\'/\'\\\'\'}'"
  shell_cmd="cd $cwd_q && claude --resume $sid_q"
  shell_cmd_q=$(applescript_quote "$shell_cmd")

  /usr/bin/osascript -e "tell application \"iTerm\" to (create window with default profile command $shell_cmd_q)" >/dev/null
done
