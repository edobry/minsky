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
# At the 30s cadence this is ~1h of rolling history (~35KB/file). The old
# default of 10 was five minutes, which could not survive a reboot.
HISTORY_KEEP="${TAB_WATCHER_HISTORY_KEEP:-120}"
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
# silently and returns empty if iTerm isn't running, if automation perms aren't
# granted yet, or — the case mt#4080 is about — if iTerm is wedged and never
# answers the AppleEvent. The caller cannot tell those apart from the return
# value alone, which is why build_snapshot records the EMPTINESS separately
# rather than letting it masquerade as an observed layout.
dump_iterm_tabs() {
  # Test seam: lets the suite exercise the unresponsive-iTerm path without
  # wedging a real iTerm. Never set in production; mirrors the
  # TAB_WATCHER_SKIP_LAUNCHCTL seam install.sh already uses.
  if [ "${TAB_WATCHER_FORCE_EMPTY_DUMP:-0}" = "1" ]; then
    return 0
  fi
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
    lsof_out=$(/usr/sbin/lsof -nP -p "$pids_csv" -a -d cwd,txt -Ffpn 2>/dev/null || true)
    # One multi-PID ps call gets argv + tty + started for every candidate.
    # macOS ps accepts both space- and comma-separated PIDs; using the comma
    # form here mirrors lsof above and matches the BSD ps(1) documented form.
    ps_out=$(ps -o pid=,tty=,lstart=,command= -p "$pids_csv" 2>/dev/null || true)
  else
    lsof_out=""
    ps_out=""
  fi

  TS="$timestamp" ITERM="$iterm_dump" LSOF="$lsof_out" PS="$ps_out" \
  PIDS_LIST="$pids_list" CLAUDE_BIN_PATTERN="$CLAUDE_BIN_PATTERN" HOME_DIR="$HOME" \
  SNAP_STATE_DIR="$STATE_DIR" \
  /usr/bin/python3 <<'PY'
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

# mt#4080. An empty dump is an OBSERVATION FAILURE, not an observed absence of
# windows, and the two used to be written identically: every session got
# iterm_window_id "" via the .get default below, indistinguishable from a real
# single-window state. Record the distinction, then try to recover the grouping.
#
# Recovery joins on TTY, which is the whole reason it can work: the tty comes
# from ps/lsof, which do not depend on iTerm answering. So a session that is
# still running still has the tty it was recorded under, and a grouping from
# before the wedge re-attaches to exactly the sessions it described. Sessions
# started since the last good dump simply do not match, and stay ungrouped —
# the join is self-limiting, which is why it needs no age cutoff.
iterm_dump_status = "ok" if iterm_by_tty else "unavailable"
grouping_source = "live" if iterm_by_tty else "none"
grouping_from = ""


def _recover_grouping(state_dir):
    """Newest OBSERVED grouping from snapshot history, as (map, its timestamp).

    Only snapshots whose own grouping was observed live are eligible: chaining
    recovery onto a recovered snapshot would keep re-dating a stale layout and
    make grouping_from meaningless. Legacy snapshots predate these fields, so
    absence of the marker plus a populated window id counts as live.
    """
    try:
        candidates = [Path(state_dir) / "snapshot.json"]
        candidates += sorted(
            Path(state_dir).glob("snapshot-*.json"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
    except OSError:
        return {}, ""

    for path in candidates:
        try:
            with open(path) as fh:
                prior = json.load(fh)
        except (OSError, ValueError):
            continue
        if prior.get("iterm_grouping_source", "live") != "live":
            continue
        recovered = {}
        for sess in prior.get("sessions", []):
            tty, win = sess.get("tty", ""), sess.get("iterm_window_id", "")
            if tty and win:
                recovered[tty] = (win, sess.get("iterm_tab_title", ""))
        if recovered:
            return recovered, prior.get("timestamp", "")
    return {}, ""


if not iterm_by_tty:
    _recovered, _from = _recover_grouping(os.environ["SNAP_STATE_DIR"])
    if _recovered:
        iterm_by_tty = _recovered
        grouping_source = "history"
        grouping_from = _from

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
        # Match the binary path regardless of cur_fd value. We already filtered
        # via `-d cwd,txt`, so any path that matches the versioned-binary
        # pattern is the executable for this PID — robust against lsof
        # versions that emit numeric FDs instead of the literal "txt" string.
        if not lsof_info[cur_pid]["is_cli"] and claude_bin_pat.search(val):
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

# `iterm_dump` and `iterm_grouping_source` are always emitted so a consumer can
# branch on them without guessing; `iterm_grouping_from` only when it means
# something. Additive — every snapshot already on disk predates all three, so
# consumers must treat their ABSENCE as the legacy "assume observed" case.
snapshot = {"timestamp": timestamp, "iterm_dump": iterm_dump_status,
            "iterm_grouping_source": grouping_source}
if grouping_from:
    snapshot["iterm_grouping_from"] = grouping_from
snapshot["sessions"] = sessions
print(json.dumps(snapshot, indent=2))
PY
}

# Preserve the last snapshot taken before the current boot. Rolling retention
# alone is a self-defeating design for a crash-recovery tool: at a 30s cadence
# HISTORY_KEEP=10 is five minutes of history, so the watcher restarting after an
# unclean reboot deletes the pre-crash inventory — the only thing anyone wants —
# before a human can get to it. Observed 2026-08-05: every pre-crash snapshot
# was gone ~18 min after reboot. The archive is written once per boot and is
# never a pruning candidate.
archive_pre_boot_snapshot() {
  local boot_epoch marker newest newest_epoch
  # Anchor the match. `.*sec = ` is greedy and binds to the `usec = ` field,
  # yielding the microseconds (6 digits) instead of the epoch — which makes
  # `newest_epoch -lt boot_epoch` permanently false, so nothing is ever
  # archived, while the marker below is still written so it never retries.
  # Observed 2026-08-05 after the 14:19 panic: marker `.preboot-archived-478607`
  # (a usec value), no preboot-*.json, pre-crash inventory saved only by the
  # raised HISTORY_KEEP.
  boot_epoch=$(sysctl -n kern.boottime 2>/dev/null | sed -n 's/^{ *sec = \([0-9]*\).*/\1/p')
  [ -n "$boot_epoch" ] || return 0
  marker="$STATE_DIR/.preboot-archived-$boot_epoch"
  [ -e "$marker" ] && return 0

  # `|| true` is load-bearing under `set -o pipefail`: with no snapshot-*.json yet,
  # `ls` exits 1, the pipeline inherits it, and `set -e` kills the whole run BEFORE
  # any snapshot is written. That is invisible on a populated state dir — which is
  # every run of an already-installed watcher — and fires on exactly one case: the
  # FIRST run after install, or after the state dir is cleared. Found by running the
  # merged script against an empty TAB_WATCHER_STATE_DIR (mt#3873).
  newest=$(ls -1t "$STATE_DIR"/snapshot-*.json 2>/dev/null | head -1 || true)
  if [ -n "$newest" ]; then
    newest_epoch=$(stat -f %m "$newest" 2>/dev/null || echo 0)
    if [ "$newest_epoch" -lt "$boot_epoch" ]; then
      cp "$newest" "$STATE_DIR/preboot-$(date -u -r "$boot_epoch" +"%Y%m%dT%H%M%SZ").json"
      echo "archived pre-boot snapshot: $newest" >&2
    fi
  fi
  : > "$marker"
}

main() {
  local tmp hist
  archive_pre_boot_snapshot

  tmp="$SNAPSHOT.tmp"
  build_snapshot > "$tmp"
  mv "$tmp" "$SNAPSHOT"

  hist="$STATE_DIR/snapshot-$(date -u +"%Y%m%dT%H%M%SZ").json"
  cp "$SNAPSHOT" "$hist"

  prune_history
}

# Prune historical snapshots beyond HISTORY_KEEP. Anchored to the rolling
# snapshot-*.json series, so preboot-*.json is never a pruning candidate (one
# small file per boot, retained indefinitely).
#
# Uses a shell glob into an array rather than a pipeline so a zero-match case
# can't trip `set -o pipefail`. The live copy had drifted to an
# `ls | tail | xargs` pipeline guarded by a trailing `|| true`; that does work,
# but it is the same pipefail hazard class archive_pre_boot_snapshot above was
# just fixed for, so the repo's pipefail-immune form is kept rather than
# overwritten during the reconciliation (mt#3873).
prune_history() {
  local files=("$STATE_DIR"/snapshot-*.json)
  # If the glob didn't match anything, bash leaves the literal pattern as the
  # single array element — detect and skip.
  if [ "${#files[@]}" -le "$HISTORY_KEEP" ] || [ ! -e "${files[0]}" ]; then
    return 0
  fi
  # Sort by mtime desc, keep newest $HISTORY_KEEP, remove the rest.
  while IFS= read -r f; do
    rm -f -- "$f"
  done < <(stat -f '%m %N' "${files[@]}" 2>/dev/null \
    | sort -rn \
    | tail -n +$((HISTORY_KEEP + 1)) \
    | awk '{ $1=""; sub(/^ /, ""); print }')
}

main
