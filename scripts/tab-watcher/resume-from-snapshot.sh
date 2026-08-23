#!/usr/bin/env bash
# Consumer for the tab-watcher snapshot: rebuilds the iTerm window/tab layout
# recorded in the snapshot, running `claude --resume <session_id>` in each tab.
#
# Window-grouped by default: the snapshot records `iterm_window_id` per session,
# so sessions that shared a window are restored as tabs of ONE new window rather
# than as N separate windows (the pre-2026-08-05 behavior, still available via
# --flat).
#
# Restoring a large snapshot is the documented trigger for the logd-watchdog
# forced reboot (memory 83d96223: aggregate Claude RSS pushes free pages low,
# logd's firehose drain-mem queue stalls in the same malloc path, watchdog fires
# at 40s). Hence --stagger and --min-free-gb, on by default: tabs open one at a
# time and the run pauses when available memory drops below the floor.
set -euo pipefail

STATE_DIR="${TAB_WATCHER_STATE_DIR:-$HOME/.claude/tab-state}"
SNAPSHOT="$STATE_DIR/snapshot.json"
LIVE_SNAPSHOT="$STATE_DIR/snapshot.json"
DRY_RUN=0
FLAT=0
STAGGER=3
MIN_FREE_GB=8
MAX_WAIT=180
LIMIT=0
SKIP_RUNNING=1
WINDOW_FILTER=()

usage() {
  cat <<EOF
Usage: $0 [options]

Rebuilds the iTerm window/tab layout from a tab-watcher snapshot, resuming each
recorded Claude Code session in its original cwd. Sessions whose jsonl is gone,
and sessions already running, are skipped.

  --snapshot <path>     Snapshot to restore (default: $SNAPSHOT).
                        After a crash use the last PRE-crash file, not the live
                        one: ls -t $STATE_DIR/snapshot-*.json
  --dry-run             Print the plan; open nothing.
  --flat                One window per session (legacy behavior).
  --window <id>         Restore only this snapshot window id. Repeatable.
  --limit <n>           Open at most n tabs total (staged restore).
  --stagger <sec>       Seconds between tabs (default: $STAGGER).
  --min-free-gb <n>     Pause before a tab while available memory is under n GB
                        (default: $MIN_FREE_GB, waits up to ${MAX_WAIT}s). 0 disables.
  --no-skip-running     Resume sessions even if a process already has them open.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --flat) FLAT=1; shift ;;
    --snapshot) SNAPSHOT="$2"; shift 2 ;;
    --window) WINDOW_FILTER+=("$2"); shift 2 ;;
    --limit) LIMIT="$2"; shift 2 ;;
    --stagger) STAGGER="$2"; shift 2 ;;
    --min-free-gb) MIN_FREE_GB="$2"; shift 2 ;;
    --no-skip-running) SKIP_RUNNING=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage >&2; exit 1 ;;
  esac
done

if [ ! -f "$SNAPSHOT" ]; then
  echo "snapshot not found: $SNAPSHOT" >&2
  exit 1
fi

# Stale-snapshot warning: a >5 min old snapshot means the daemon wasn't
# running close to crash time, so the inventory may be incomplete. Suppressed
# when restoring an explicitly-named historical snapshot, where age is expected.
if [ "$SNAPSHOT" = "$LIVE_SNAPSHOT" ]; then
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
fi

# mt#4080. Window grouping is the one thing this script cannot infer from the
# snapshot's own contents: an ungrouped snapshot restores identically whether
# iTerm genuinely had one window or never answered. The producer now records
# which it was, so say so — silently rebuilding a flattened layout is how the
# 2026-08-13 recovery lost a multi-window working set with nothing to notice.
# A snapshot predating these fields carries neither, and is read as observed.
grouping_warning=$(python3 - "$SNAPSHOT" "$STATE_DIR" <<'PY' 2>/dev/null || true
import json, sys
try:
    with open(sys.argv[1]) as fh:
        d = json.load(fh)
except (OSError, ValueError):
    sys.exit(0)
# Resolved, not the literal variable name: this hint is the operator's next command in a
# recovery, so it has to be pasteable as printed.
state_dir = sys.argv[2]
if d.get("iterm_dump", "ok") == "ok":
    sys.exit(0)
if d.get("iterm_grouping_source") == "history":
    print("WARN: iTerm was unresponsive when this snapshot was taken. The window "
          "grouping below was RECOVERED from an earlier snapshot (%s), not observed — "
          "sessions started after that point restore into their own windows."
          % (d.get("iterm_grouping_from") or "timestamp unrecorded"))
else:
    print("WARN: iTerm was unresponsive when this snapshot was taken and no earlier "
          "grouping was available. Window layout will NOT be reconstructed — every "
          "session restores into its own window. Try an older snapshot: "
          "ls -t %s/snapshot-*.json" % state_dir)
PY
)
if [ -n "$grouping_warning" ]; then
  echo "$grouping_warning" >&2
  echo >&2
fi

# Session ids that already have a live process — resuming these would give two
# processes appending to one transcript.
RUNNING_IDS=""
if [ "$SKIP_RUNNING" = "1" ] && [ -f "$LIVE_SNAPSHOT" ]; then
  RUNNING_IDS=$(python3 - "$LIVE_SNAPSHOT" <<'PY' 2>/dev/null || true
import json, sys
d = json.load(open(sys.argv[1]))
print(",".join(s["session_id"] for s in d.get("sessions", []) if s.get("session_id")))
PY
)
fi

# Plan: window_key \t sid \t cwd \t jsonl \t title, ordered by window (largest
# first, so the biggest layout is rebuilt while memory headroom is greatest)
# then by tty, which approximates original left-to-right tab order.
mapfile -t ROWS < <(python3 - "$SNAPSHOT" "$FLAT" "$RUNNING_IDS" "${WINDOW_FILTER[@]+"${WINDOW_FILTER[@]}"}" <<'PY'
import json, sys, collections

snap, flat, running = sys.argv[1], sys.argv[2] == "1", set(filter(None, sys.argv[3].split(",")))
wfilter = set(sys.argv[4:])

sessions = []
for s in json.load(open(snap)).get("sessions", []):
    sid, cwd, jsonl = s.get("session_id", ""), s.get("cwd", ""), s.get("jsonl", "")
    if not (sid and cwd and jsonl) or sid in running:
        continue
    wid = s.get("iterm_window_id") or ""
    if wfilter and wid not in wfilter:
        continue
    sessions.append((wid, s.get("tty", ""), sid, cwd, jsonl, s.get("iterm_tab_title", "")))

# A session with no recorded window id was not an iTerm tab we can group
# (headless/daemon, tty "??"); give each its own window rather than inventing
# a grouping the snapshot does not attest.
groups = collections.defaultdict(list)
for wid, tty, sid, cwd, jsonl, title in sessions:
    key = f"w{wid}" if (wid and not flat) else f"solo:{sid}"
    groups[key].append((tty, sid, cwd, jsonl, title))

for key, items in sorted(groups.items(), key=lambda kv: (-len(kv[1]), kv[0])):
    for tty, sid, cwd, jsonl, title in sorted(items):
        print("\t".join([key, sid, cwd, jsonl, title]))
PY
)

if [ "${#ROWS[@]}" -eq 0 ]; then
  echo "nothing to restore (no eligible sessions in $SNAPSHOT)" >&2
  exit 0
fi

# AppleScript-safe quoter: backslash and double-quote are the only meta chars.
applescript_quote() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '"%s"' "$s"
}

# Available memory = free + inactive + speculative. Inactive pages are
# reclaimable, so counting only free pages would stall the run permanently.
# Prints the EMPTY STRING when the reading is unavailable — vm_stat missing, or
# failing, or emitting something awk can't parse — rather than a number.
#
# "0.0" would be an unavailable observation rendered as a definite value, which
# is the exact conflation this task fixes in the producer, and here it is the
# worst possible value to invent: 0.0 is below every floor, so wait_for_memory
# below would stall the full MAX_WAIT on any machine that simply has no vm_stat.
# Verified pre-fix by shimming vm_stat to exit 127: the run reported "available
# memory now 0.0GB" and exited 0, so nothing surfaced the bad reading.
avail_gb() {
  local out
  command -v vm_stat >/dev/null 2>&1 || return 0
  out=$(vm_stat 2>/dev/null) || return 0
  [ -n "$out" ] || return 0
  # `|| return 0` is load-bearing, and was missing in PR #2993 R1. awk exits 1 on
  # unparseable input; under `set -o pipefail` the pipeline inherits that, and
  # both callers assign it with a BARE assignment (`avail=$(avail_gb)`), whose
  # exit status IS the substitution's — so `set -e` killed the whole run. Caught
  # by the reviewer on R2 and reproduced: a vm_stat that SUCCEEDS but emits
  # unparseable output exited 1 and never printed the summary line. Note the
  # shape — every earlier test shimmed vm_stat to FAIL, so awk never ran and the
  # path stayed invisible.
  printf '%s\n' "$out" | awk '
    /page size of/  { ps = $8 }
    /Pages free/    { gsub(/\./, "", $3); free = $3 }
    /Pages inactive/{ gsub(/\./, "", $3); inact = $3 }
    /Pages specul/  { gsub(/\./, "", $3); spec = $3 }
    END { if (ps == "") exit 1; printf "%.1f", (free + inact + spec) * ps / 1073741824 }
  ' || return 0
}

wait_for_memory() {
  [ "$MIN_FREE_GB" = "0" ] && return 0
  local waited=0 avail
  while :; do
    avail=$(avail_gb)
    # Unknown is not zero. Pacing on an unreadable number would stall the full
    # MAX_WAIT on every tab, for a floor that can never be satisfied because the
    # reading never arrives — so decline to pace rather than invent a value.
    if [ -z "$avail" ]; then
      echo "  ...memory unreadable (no usable vm_stat) — pacing disabled for this run" >&2
      return 0
    fi
    awk -v a="$avail" -v m="$MIN_FREE_GB" 'BEGIN { exit !(a < m) }' || return 0
    if [ "$waited" -ge "$MAX_WAIT" ]; then
      echo "WARN: available memory ${avail}GB still under ${MIN_FREE_GB}GB after ${waited}s — continuing anyway" >&2
      return 0
    fi
    echo "  ...paused: ${avail}GB available, need ${MIN_FREE_GB}GB (waited ${waited}s)" >&2
    sleep 10
    waited=$((waited + 10))
  done
}

# iTerm AppleScript, verified on 3.6.6 (2026-08-05, re-verified 2026-08-13).
#
# CORRECTED 2026-08-13 (mt#3873): the original note here said `create tab with
# default profile command "..."` HANGS the AppleEvent and creates nothing. Too
# strong, and the overstatement matters because it sends a reader looking for
# the wrong cause. Re-tested on the same iTerm 3.6.6:
#   create tab with default profile command "/bin/sh -c 'sleep 40'"  -> tab created, sleep running
#   create tab with default profile command "cd <dir> && claude ..."  -> nothing created
# iTerm execs the argument DIRECTLY rather than through a shell, so a shell
# EXPRESSION (`cd x && y`) fails instantly with `cd` read as the program name,
# while a real program invocation works. `tell current session of it` is
# untested here and left as reported.
#
# The form used below -- create the tab bare, then a separate `tell current
# session` that writes the command -- is kept regardless: it is what
# restore-sessions.sh has used since 2026-04, and writing the command as text
# means the shell interprets it, so `cd x && y` needs no wrapper. Prefer it over
# anything clever. Both helpers target `current window`, which is the window
# most recently created -- so don't click into another iTerm window mid-run.
open_window() {  # $1=cmd $2=title
  /usr/bin/osascript <<EOF
tell application "iTerm"
  activate
  create window with default profile
  tell current window
    tell current session
      set name to $(applescript_quote "$2")
      write text $(applescript_quote "$1")
    end tell
  end tell
end tell
EOF
}

open_tab() {  # $1=cmd $2=title
  /usr/bin/osascript <<EOF
tell application "iTerm"
  tell current window
    create tab with default profile
    tell current session
      set name to $(applescript_quote "$2")
      write text $(applescript_quote "$1")
    end tell
  end tell
end tell
EOF
}

prev_key=""
new_group=1
opened=0

for row in "${ROWS[@]}"; do
  IFS=$'\t' read -r key sid cwd jsonl title <<< "$row"

  if [ "$LIMIT" -gt 0 ] && [ "$opened" -ge "$LIMIT" ]; then
    echo "limit of $LIMIT reached — $(( ${#ROWS[@]} - opened )) session(s) left in $SNAPSHOT" >&2
    break
  fi
  if [ ! -f "$jsonl" ]; then
    echo "SKIP: ${sid:0:8} — jsonl missing on disk: $jsonl" >&2
    continue
  fi

  cwd_q="'${cwd//\'/\'\\\'\'}'"
  sid_q="'${sid//\'/\'\\\'\'}'"
  shell_cmd="cd $cwd_q && claude --resume $sid_q"

  if [ "$key" != "$prev_key" ]; then
    echo "WINDOW $key"
    prev_key="$key"
    new_group=1
  fi
  echo "  TAB ${sid:0:8}  ${title:-$cwd}"

  if [ "$DRY_RUN" = "1" ]; then
    opened=$((opened + 1))
    continue
  fi

  tab_name="${title:-${sid:0:8}}"
  wait_for_memory
  if [ "$new_group" = "1" ]; then
    open_window "$shell_cmd" "$tab_name" >/dev/null
    new_group=0
  else
    open_tab "$shell_cmd" "$tab_name" >/dev/null
  fi
  opened=$((opened + 1))
  sleep "$STAGGER"
done

echo
mem_now=$(avail_gb)
if [ -n "$mem_now" ]; then
  echo "opened $opened tab(s); available memory now ${mem_now}GB"
else
  echo "opened $opened tab(s); available memory unknown (no usable vm_stat)"
fi
