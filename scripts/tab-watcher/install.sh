#!/usr/bin/env bash
# Install / uninstall / status helper for the claude tab-watcher launchd
# daemon. Idempotent: re-running install bootouts the existing agent first.
set -euo pipefail

LABEL="com.local.claude-tab-watcher"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USER_SCRIPTS_DIR="$HOME/.claude/scripts"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST_DEST="$LAUNCH_AGENTS_DIR/$LABEL.plist"
DAEMON_DEST="$USER_SCRIPTS_DIR/tab-watcher.sh"
RESUMER_DEST="$USER_SCRIPTS_DIR/resume-from-snapshot.sh"
STATE_DIR="$HOME/.claude/tab-state"

domain() { echo "gui/$(id -u)"; }

usage() {
  cat <<EOF
Usage: $0 {install|uninstall|status}

install    Copy scripts to ~/.claude/scripts, render plist into
           ~/Library/LaunchAgents, and bootstrap the launchd agent.
uninstall  Bootout the launchd agent and remove installed files. The
           ~/.claude/tab-state directory is left intact for forensics.
status     Show whether the agent is loaded plus the latest snapshot
           timestamp and session count.
EOF
}

cmd_install() {
  mkdir -p "$USER_SCRIPTS_DIR" "$LAUNCH_AGENTS_DIR" "$STATE_DIR"
  cp "$SCRIPT_DIR/tab-watcher.sh" "$DAEMON_DEST"
  cp "$SCRIPT_DIR/resume-from-snapshot.sh" "$RESUMER_DEST"
  chmod +x "$DAEMON_DEST" "$RESUMER_DEST"

  sed "s|__HOME__|$HOME|g" "$SCRIPT_DIR/$LABEL.plist" > "$PLIST_DEST"

  launchctl bootout "$(domain)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "$(domain)" "$PLIST_DEST"

  echo "installed: $LABEL"
  echo "  daemon:   $DAEMON_DEST"
  echo "  resumer:  $RESUMER_DEST"
  echo "  plist:    $PLIST_DEST"
  echo "  state:    $STATE_DIR"
  echo
  echo "First snapshot should appear at $STATE_DIR/snapshot.json within 30 seconds."
}

cmd_uninstall() {
  launchctl bootout "$(domain)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST_DEST" "$DAEMON_DEST" "$RESUMER_DEST"
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

case "${1:-}" in
  install) cmd_install ;;
  uninstall) cmd_uninstall ;;
  status) cmd_status ;;
  -h|--help) usage ;;
  *) usage >&2; exit 1 ;;
esac
