#!/usr/bin/env bash
# Install / uninstall / status / drift helper for the claude tab-watcher launchd
# daemon. Idempotent: re-running install bootouts the existing agent first.
#
# THIS IS THE ONLY SUPPORTED WAY THE INSTALLED COPY IS WRITTEN (mt#3873 SC4).
# The repo copy under scripts/tab-watcher/ is canonical; ~/.claude/scripts/ holds
# installed artifacts, the same relationship ADR-028 establishes for
# .minsky/hooks -> .claude/hooks. Editing the installed copy by hand is what let
# the two diverge for three months, so `drift` exists to make that loud.
set -euo pipefail

LABEL="com.local.claude-tab-watcher"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Overridable so the test suite can install into a scratch dir instead of $HOME.
USER_SCRIPTS_DIR="${TAB_WATCHER_INSTALL_DIR:-$HOME/.claude/scripts}"
LAUNCH_AGENTS_DIR="${TAB_WATCHER_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
PLIST_DEST="$LAUNCH_AGENTS_DIR/$LABEL.plist"
STATE_DIR="${TAB_WATCHER_STATE_DIR:-$HOME/.claude/tab-state}"

# Every script this tooling installs. Adding a file here is what brings it under
# the drift check — `resume-tabs-in-place.sh` existed only in the installed
# location until mt#3873, which is precisely how it escaped version control.
INSTALLED_SCRIPTS=(tab-watcher.sh resume-from-snapshot.sh resume-tabs-in-place.sh)

domain() { echo "gui/$(id -u)"; }

usage() {
  cat <<EOF
Usage: $0 {install|uninstall|status|drift}

install    Copy scripts to $USER_SCRIPTS_DIR, render plist into
           $LAUNCH_AGENTS_DIR, and bootstrap the launchd agent.
uninstall  Bootout the launchd agent and remove installed files. The
           state directory is left intact for forensics.
status     Show whether the agent is loaded plus the latest snapshot
           timestamp and session count.
drift      Compare every installed script against the repo copy. Exits 0 when
           they match, 1 when any differs or is missing, and prints the diff.

Env overrides (for tests): TAB_WATCHER_INSTALL_DIR,
TAB_WATCHER_LAUNCH_AGENTS_DIR, TAB_WATCHER_STATE_DIR.
EOF
}

cmd_install() {
  mkdir -p "$USER_SCRIPTS_DIR" "$LAUNCH_AGENTS_DIR" "$STATE_DIR"
  for script in "${INSTALLED_SCRIPTS[@]}"; do
    cp "$SCRIPT_DIR/$script" "$USER_SCRIPTS_DIR/$script"
    chmod +x "$USER_SCRIPTS_DIR/$script"
  done

  sed "s|__HOME__|$HOME|g" "$SCRIPT_DIR/$LABEL.plist" > "$PLIST_DEST"

  if [ "${TAB_WATCHER_SKIP_LAUNCHCTL:-0}" != "1" ]; then
    launchctl bootout "$(domain)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$(domain)" "$PLIST_DEST"
  fi

  echo "installed: $LABEL"
  for script in "${INSTALLED_SCRIPTS[@]}"; do
    echo "  script:   $USER_SCRIPTS_DIR/$script"
  done
  echo "  plist:    $PLIST_DEST"
  echo "  state:    $STATE_DIR"
  echo
  echo "First snapshot should appear at $STATE_DIR/snapshot.json within 30 seconds."
}

cmd_uninstall() {
  if [ "${TAB_WATCHER_SKIP_LAUNCHCTL:-0}" != "1" ]; then
    launchctl bootout "$(domain)/$LABEL" 2>/dev/null || true
  fi
  rm -f "$PLIST_DEST"
  for script in "${INSTALLED_SCRIPTS[@]}"; do
    rm -f "$USER_SCRIPTS_DIR/$script"
  done
  echo "uninstalled: $LABEL (state directory $STATE_DIR left intact)"
}

cmd_status() {
  if launchctl print "$(domain)/$LABEL" >/dev/null 2>&1; then
    echo "loaded: $LABEL"
  else
    echo "NOT loaded: $LABEL"
  fi
  local snap="$STATE_DIR/snapshot.json"
  if [ -f "$snap" ]; then
    python3 - "$snap" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print(f"last snapshot: {d.get('timestamp','?')} ({len(d.get('sessions',[]))} sessions)")
PY
  else
    echo "no snapshot yet"
  fi
}

# SC3: fail loudly on divergence rather than letting it accumulate silently.
# Reports EVERY differing script before exiting, so one run tells you the whole
# story instead of one file at a time.
cmd_drift() {
  local drifted=0
  for script in "${INSTALLED_SCRIPTS[@]}"; do
    local installed="$USER_SCRIPTS_DIR/$script"
    local canonical="$SCRIPT_DIR/$script"
    if [ ! -f "$installed" ]; then
      echo "DRIFT: $script is not installed at $installed" >&2
      drifted=1
      continue
    fi
    if ! diff -u "$canonical" "$installed" >/dev/null 2>&1; then
      echo "DRIFT: $script differs between repo and install" >&2
      diff -u "$canonical" "$installed" >&2 || true
      drifted=1
    fi
  done

  if [ "$drifted" -ne 0 ]; then
    echo >&2
    echo "The repo copy under scripts/tab-watcher/ is canonical. Re-run" >&2
    echo "  $0 install" >&2
    echo "to overwrite the installed copy, or port the installed change into the" >&2
    echo "repo first if the drift is a fix that only exists there." >&2
    return 1
  fi

  echo "no drift: ${#INSTALLED_SCRIPTS[@]} scripts match their repo copies"
}

case "${1:-}" in
  install) cmd_install ;;
  uninstall) cmd_uninstall ;;
  status) cmd_status ;;
  drift) cmd_drift ;;
  -h|--help) usage ;;
  *) usage >&2; exit 1 ;;
esac
