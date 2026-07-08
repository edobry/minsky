#!/usr/bin/env bash
#
# verify-deeplink-coldstart.sh  (mt#2688)
#
# Exercises the COLD-START deep-link flow: NOTHING is running (no tray, no
# daemon), and a `minsky://` link is opened — as a terminal click would do.
# Launch Services starts the tray; the tray spawns the daemon; the deep-link
# recovery loop must (a) create the window, (b) wait out the daemon boot,
# (c) re-NAVIGATE the initially-dead (connection-refused) document, and
# (d) deliver the link — ending with a live cockpit page, not a white window.
#
# ── The mt#2688 bug this guards against ──
# The window was created ~150 ms after launch, WKWebView's load of
# localhost:3737 got connection-refused (daemon still booting), and nothing
# ever re-attempted navigation — the window stayed white forever, even after
# the daemon was healthy. reload()-based recovery shares the blind spot:
# reloading a never-loaded document reloads the blank page.
#
# ── Why this is a script, not a CI unit test ──
# It drives a real installed `.app`, a real daemon boot, and a real WKWebView
# window, so it cannot run in headless CI (no headless WKWebView e2e — see
# mt#2226 / cockpit-tray/README.md). Sibling of verify-deeplink-hotstart.sh
# (mt#2546), which covers the tray-already-running flow.
#
# PASS  = after the deep link cold-launches everything, the daemon comes up
#         AND the cockpit-tray process holds an ESTABLISHED connection to the
#         daemon port (the webview actually loaded content) AND a window is
#         present, within the timeout.
# FAIL  = daemon up but no webview connection / no window (the white-window
#         bug), or the daemon never came up.
# A screenshot is always saved for the operator to confirm visually — GUI
# detection from the shell is best-effort.
#
# Usage:  cockpit-tray/scripts/verify-deeplink-coldstart.sh [task-id]
#         (task-id defaults to mt%232370; COCKPIT_PORT overrides :3737)
set -uo pipefail

APP="/Applications/Minsky Cockpit.app"
BIN="$APP/Contents/MacOS/cockpit-tray"
PORT="${COCKPIT_PORT:-3737}"
TASK="${1:-mt%232370}"
URL="minsky://task/${TASK}"
SHOT="${TMPDIR:-/tmp}/mt2688-coldstart-verify.png"
# Daemon cold boot takes seconds; the recovery budget is 60 s. Poll a bit past it.
TIMEOUT_S=75

# ── Preconditions: skip gracefully (exit 0) when the harness can't run ──
[[ "$(uname)" == "Darwin" ]] || { echo "SKIP: macOS only (uname=$(uname))"; exit 0; }
[[ -x "$BIN" ]] || { echo "SKIP: '$APP' not installed — run cockpit-tray/scripts/install-local.sh first."; exit 0; }

listener_pid() { lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN -t 2>/dev/null | head -n1; }
# WKWebView network traffic is attributed to the com.apple.WebKit.Networking
# helper process, not cockpit-tray. `+c 0` untruncates lsof's COMMAND column
# so we can attribute established connections to the webview specifically
# (a bare port-wide count could pass on unrelated clients).
estab()        { lsof +c 0 -nP -iTCP:"${PORT}" -sTCP:ESTABLISHED 2>/dev/null | grep -c 'WebKit' || true; }
wins()         { osascript -e 'tell application "System Events" to tell process "cockpit-tray" to count windows' 2>/dev/null || echo 0; }

echo "== mt#2688 cold-start verification (task=${TASK}, port=${PORT}) =="
echo "-- teardown: quit tray, kill any daemon on :${PORT}, confirm nothing listens --"
osascript -e 'quit app "Minsky Cockpit"' 2>/dev/null || true
pkill -9 -f "Minsky Cockpit.app/Contents/MacOS/cockpit-tray" 2>/dev/null || true
sleep 2
LPID="$(listener_pid)"
if [[ -n "${LPID}" ]]; then
  echo "   killing daemon pid ${LPID} (listener on :${PORT})"
  kill "${LPID}" 2>/dev/null || true
  sleep 2
  LPID="$(listener_pid)"
  [[ -n "${LPID}" ]] && { kill -9 "${LPID}" 2>/dev/null || true; sleep 1; }
fi
[[ -z "$(listener_pid)" ]] || { echo "SKIP: could not free :${PORT} (pid $(listener_pid) still listening)"; exit 0; }
echo "   cold state confirmed: no tray, nothing on :${PORT}"

echo "-- fire deep link from cold: open '${URL}' --"
open "${URL}"

RESULT="FAIL"
DAEMON_UP_AT=""
for i in $(seq 1 "${TIMEOUT_S}"); do
  sleep 1
  if [[ -z "${DAEMON_UP_AT}" && -n "$(listener_pid)" ]]; then
    DAEMON_UP_AT="${i}"
    echo "   daemon listening on :${PORT} after ~${i}s"
  fi
  W="$(wins)"; E="$(estab)"
  if [[ "${W:-0}" -ge 1 && "${E:-0}" -ge 1 ]]; then
    RESULT="PASS"
    echo "PASS after ~${i}s (windows=${W}, WebKit ESTABLISHED conns on :${PORT}=${E}, daemon up at ~${DAEMON_UP_AT:-?}s)"
    break
  fi
done

screencapture -x "${SHOT}" 2>/dev/null \
  && echo "screenshot: ${SHOT} — confirm the cockpit window shows the task page (NOT white)."

if [[ "${RESULT}" == "PASS" ]]; then
  exit 0
fi
echo "FAIL: within ${TIMEOUT_S}s: daemon up at ~${DAEMON_UP_AT:-never}s, windows=$(wins), webkit-estab=$(estab)."
echo "      A window with 0 WebKit connections to :${PORT} is the mt#2688 white-window signature."
echo "      (If the window IS visibly live in ${SHOT}, shell GUI-detection missed it.)"
exit 1