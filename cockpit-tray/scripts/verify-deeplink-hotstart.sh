#!/usr/bin/env bash
#
# verify-deeplink-hotstart.sh  (mt#2546)
#
# Exercises the COMMON deep-link flow that mt#2528's original verification missed:
# the tray is running in the menu bar with NO cockpit window open, and a
# `minsky://` link is opened (as a terminal click would do).
#
# ── Diagnosis / conclusion (recorded in-repo per the mt#2546 acceptance criteria) ──
# Root cause is a CODE bug (not Launch-Services churn): `on_open_url` fires on the
# MAIN thread and runs the handler synchronously, holding the run loop; calling
# `WebviewWindowBuilder::build()` from there DEADLOCKS (window creation needs the
# run loop to pump). File-instrumented tracing showed the flow reaching
# `ensure_cockpit_window_visible window_exists=false`, then `build()` never returning.
# Cold-start worked only because it runs in `setup()`, before the run loop is busy.
# The fix defers window CREATION onto the run loop from a background thread.
#
# ── Why this is a script, not a CI unit test ──
# It drives a real installed `.app` and a real WKWebView window, so it cannot run
# in headless CI (there is no headless WKWebView e2e — see mt#2226 /
# cockpit-tray/README.md). Run it locally on macOS after `bun run build` + install.
#
# PASS  = a cockpit window opens (a new :PORT connection appears and/or the
#         cockpit-tray process gains a window) within the timeout.
# FAIL  = neither within the timeout (the mt#2546 bug).
# A screenshot is always saved for the operator to confirm visually — GUI
# detection from the shell is best-effort.
#
# Usage:  cockpit-tray/scripts/verify-deeplink-hotstart.sh [task-id]
#         (task-id defaults to mt%232370; COCKPIT_PORT overrides :3737)
set -uo pipefail

APP="/Applications/Minsky Cockpit.app"
BIN="$APP/Contents/MacOS/cockpit-tray"
PORT="${COCKPIT_PORT:-3737}"
TASK="${1:-mt%232370}"
URL="minsky://task/${TASK}"
SHOT="${TMPDIR:-/tmp}/mt2546-verify.png"

# ── Preconditions: skip gracefully (exit 0) when the harness can't run ──
[[ "$(uname)" == "Darwin" ]] || { echo "SKIP: macOS only (uname=$(uname))"; exit 0; }
[[ -x "$BIN" ]] || { echo "SKIP: '$APP' not installed — build (cd cockpit-tray && bun run build) and copy to /Applications first."; exit 0; }
curl -s -o /dev/null --max-time 3 "http://localhost:${PORT}/api/health" \
  || { echo "SKIP: no cockpit daemon on :${PORT} (start one: minsky cockpit start --port ${PORT})"; exit 0; }

conns() { lsof -nP -iTCP:"${PORT}" -sTCP:ESTABLISHED 2>/dev/null | grep -c ':' || true; }
wins()  { osascript -e 'tell application "System Events" to tell process "cockpit-tray" to count windows' 2>/dev/null || echo 0; }

echo "== mt#2546 hot-start-no-window verification (task=${TASK}, port=${PORT}) =="
echo "-- quit any running tray, relaunch (menu-bar, NO window), settle 14s --"
pkill -9 -f "Minsky Cockpit.app/Contents/MacOS/cockpit-tray" 2>/dev/null || true
sleep 3
open "$APP"
sleep 14
BASE_CONNS="$(conns)"
echo "precondition: windows=$(wins) :${PORT}-conns=${BASE_CONNS}"

echo "-- fire deep link: open '${URL}' --"
open "${URL}"

RESULT="FAIL"
for i in $(seq 1 20); do
  sleep 1
  W="$(wins)"; C="$(conns)"
  if [[ "${W:-0}" -ge 1 ]] || [[ "${C:-0}" -gt "${BASE_CONNS:-0}" ]]; then
    RESULT="PASS"
    echo "PASS after ~${i}s (windows=${W}, :${PORT}-conns ${BASE_CONNS}->${C})"
    break
  fi
done

screencapture -x "${SHOT}" 2>/dev/null \
  && echo "screenshot: ${SHOT} — confirm a cockpit window shows the task page."

if [[ "${RESULT}" == "PASS" ]]; then
  exit 0
fi
echo "FAIL: no cockpit window / new :${PORT} connection within 20s — the mt#2546 bug."
echo "      (If a cockpit window IS visible in ${SHOT}, shell GUI-detection missed it.)"
exit 1
