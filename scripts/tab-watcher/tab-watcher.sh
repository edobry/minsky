#!/usr/bin/env bash
# Tab-watcher daemon: poll running `claude` CLI processes, correlate to iTerm
# tabs, write atomic snapshot to ~/.claude/tab-state/snapshot.json. Intended to
# be invoked every 30s by launchd; safe to run by hand for diagnostics.
#
# Discovery strategy (revised 2026-05-10 during mt#1702 implementation): claude
# 2.1.138 does NOT hold its jsonl open between writes, so `lsof -c claude |
# grep jsonl$` is empty most of the time. Instead we enumerate claude CLI
# processes by checking the `txt` (executable) FD against the versioned
# binary path, then parse `--resume <UUID>` from argv to recover the session
# id. Sessions without `--resume` in argv fall back to the most-recent jsonl
# in the flattened project dir (heuristic, equivalent to the previous tooling).
set -euo pipefail

STATE_DIR="${TAB_WATCHER_STATE_DIR:-$HOME/.claude/tab-state}"
SNAPSHOT="$STATE_DIR/snapshot.json"
HISTORY_KEEP="${TAB_WATCHER_HISTORY_KEEP:-10}"
CLAUDE_BIN_PATTERN="${CLAUDE_BIN_PATTERN:-/\\.local/share/claude/versions/}"

mkdir -p "$STATE_DIR"

# Enumerate likely claude CLI PIDs by argv pattern. We over-collect here and
# verify each candidate against its txt file path in the python parser.
discover_candidate_pids() {
  ps -axww -o pid=,command= 2>/dev/null | awk '
    {
      pid = $1
      $1 = ""
      sub(/^ /, "", $0)
      argv = $0
      if (argv ~ /^claude($| )/) { print pid; next }
      if (argv ~ /^\/[^ ]*\/claude($| )/) { print pid; next }
      # Bun rewrites kernel comm to its version string; some configurations
      # also rewrite argv[0]. Accept the "N.N.N ..." pattern as a candidate.
      if (argv ~ /^[0-9]+\.[0-9]+\.[0-9]+([ \t]|$)/) { print pid; next }
    }
  '
}

# Single osascript call to enumerate iTerm window+tab+tty triples. Fails
# silently and returns empty if iTerm isn't running or automation perms aren't
# granted yet.
dump_iterm_tabs() {
  /usr/bin/osascript 2>/dev/null <<'AS' || true
tell application "System Events"
  if not (exists process "iTerm2") then return ""
end tell
tell application "iTerm"
  set output to ""
  repeat with w in windows
    set winId to id of w as string
    repeat with t in tabs of w
      repeat with s in sessions of t
        set ttyValue to ""
        set sessionName to ""
        try
          set ttyValue to tty of s
        end try
        try
          set sessionName to name of s
        end try
        if ttyValue is not "" then
          set output to output & winId & "|||" & ttyValue & "|||" & sessionName & linefeed
        end if
      end repeat
    end repeat
  end repeat
  return output
end tell
AS
}

build_snapshot() {
  local timestamp pids_csv pids_list lsof_out ps_out iterm_dump
  timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  iterm_dump=$(dump_iterm_tabs)

  pids_list=$(discover_candidate_pids | tr '\n' ' ')
  pids_csv=$(echo "$pids_list" | tr ' ' '\n' | grep -v '^$' | paste -sd, -)

  if [ -n "$pids_csv" ]; then
    # One multi-PID lsof call gets cwd + txt for every candidate.
    lsof_out=$(lsof -nP -p "$pids_csv" -a -d cwd,txt -Ffpn 2>/dev/null || true)
    # One multi-PID ps call gets argv + tty + started for every candidate.
    ps_out=$(ps -o pid=,tty=,lstart=,command= -p "${pids_list% }" 2>/dev/null || true)
  else
    lsof_out=""
    ps_out=""
  fi

  TS="$timestamp" ITERM="$iterm_dump" LSOF="$lsof_out" PS="$ps_out" \
  PIDS_LIST="$pids_list" CLAUDE_BIN_PATTERN="$CLAUDE_BIN_PATTERN" HOME_DIR="$HOME" \
  python3 <<'PY'
import json, os, re, time
from datetime import datetime
from pathlib import Path

timestamp = os.environ["TS"]
iterm_raw = os.environ["ITERM"]
home = os.environ["HOME_DIR"]
claude_bin_pat = re.compile(os.environ["CLAUDE_BIN_PATTERN"])

# Build tty -> (window_id, tab_title). iTerm reports tty as /dev/ttysNNN;
# `ps -o tty=` reports ttysNNN — index both forms so the join works either way.
iterm_by_tty = {}
for line in iterm_raw.splitlines():
    line = line.strip()
    if not line: continue
    parts = line.split("|||", 2)
    if len(parts) != 3: continue
    win_id, tty_path, tab_title = parts
    iterm_by_tty[tty_path] = (win_id, tab_title)
    if tty_path.startswith("/dev/"):
        iterm_by_tty[tty_path[len("/dev/"):]] = (win_id, tab_title)

# Parse lsof -Ffpn: each PID has one fcwd record (with its n<path>) and many
# ftxt records (binary + every loaded library). Capture the first cwd and set
# is_cli=True if any txt path matches the claude binary pattern.
lsof_info = {}
cur_pid = None
cur_fd = None
for line in os.environ["LSOF"].splitlines():
    if not line: continue
    tag, val = line[0], line[1:]
    if tag == "p":
        cur_pid = int(val)
        cur_fd = None
        lsof_info.setdefault(cur_pid, {"cwd": "", "is_cli": False})
    elif tag == "f":
        cur_fd = val
    elif tag == "n" and cur_pid is not None:
        if cur_fd == "cwd" and not lsof_info[cur_pid]["cwd"]:
            lsof_info[cur_pid]["cwd"] = val
        elif cur_fd == "txt" and not lsof_info[cur_pid]["is_cli"]:
            if claude_bin_pat.search(val):
                lsof_info[cur_pid]["is_cli"] = True

# Parse ps output. Format: "pid tty lstart command...". lstart is 5
# whitespace-separated tokens ("Sun May 10 19:30:00 2026"); everything
# after is command.
ps_info = {}
ps_line_re = re.compile(r"^\s*(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$")
for line in os.environ["PS"].splitlines():
    m = ps_line_re.match(line)
    if not m: continue
    pid_s, tty, lstart, argv = m.groups()
    ps_info[int(pid_s)] = (tty.strip(), lstart.strip(), argv.strip())

resume_re = re.compile(r"--resume[ =]+([0-9a-f-]{36})")
now_epoch = int(time.time())
sessions = []
pids = [int(p) for p in os.environ["PIDS_LIST"].split() if p]
for pid in pids:
    li = lsof_info.get(pid)
    pi = ps_info.get(pid)
    if not pi or not li or not li["is_cli"]:
        continue
    tty, started, argv = pi
    cwd = li["cwd"]
    m = resume_re.search(argv)
    session_id = m.group(1) if m else ""
    jsonl = ""
    if cwd:
        flat = cwd.replace("/", "-")
        proj_dir = os.path.join(home, ".claude", "projects", flat)
        if session_id:
            candidate = os.path.join(proj_dir, session_id + ".jsonl")
            if os.path.isfile(candidate):
                jsonl = candidate
        if not jsonl and os.path.isdir(proj_dir):
            try:
                files = sorted(Path(proj_dir).glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
                if files:
                    jsonl = str(files[0])
                    if not session_id:
                        session_id = files[0].stem
            except OSError:
                pass

    win_id, tab_title = iterm_by_tty.get(tty, ("", ""))
    uptime_sec = 0
    if started:
        try:
            t = datetime.strptime(started, "%a %b %d %H:%M:%S %Y")
            uptime_sec = max(0, now_epoch - int(t.timestamp()))
        except Exception:
            uptime_sec = 0
    sessions.append({
        "pid": pid,
        "session_id": session_id,
        "cwd": cwd,
        "jsonl": jsonl,
        "tty": tty,
        "iterm_window_id": win_id,
        "iterm_tab_title": tab_title,
        "uptime_sec": uptime_sec,
    })

print(json.dumps({"timestamp": timestamp, "sessions": sessions}, indent=2))
PY
}

main() {
  local tmp hist
  tmp="$SNAPSHOT.tmp"
  build_snapshot > "$tmp"
  mv "$tmp" "$SNAPSHOT"

  hist="$STATE_DIR/snapshot-$(date -u +"%Y%m%dT%H%M%SZ").json"
  cp "$SNAPSHOT" "$hist"

  ls -1t "$STATE_DIR"/snapshot-*.json 2>/dev/null \
    | tail -n +$((HISTORY_KEEP + 1)) \
    | xargs -I {} rm -f {} 2>/dev/null || true
}

main
