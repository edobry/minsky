#!/usr/bin/env bash
# mt#2226 — local behavioral smoke check for the cockpit tray app.
#
# Asserts the tray's DROPDOWN STATUS LINE (the surface the user actually sees,
# read via the macOS Accessibility API) agrees with the real daemon state. This
# is the check that would have caught mt#2240 (the line was frozen on
# "Cockpit: checking..." while only the tooltip updated) — a build-only or
# tooltip-only check missed it.
#
# LOCAL ONLY: reading another process's menu via System Events needs macOS
# Accessibility (TCC) permission for the controlling terminal, which cannot be
# granted non-interactively on hosted CI runners. The CI tier
# (.github/workflows/cockpit-tray-ci.yml) covers build + cargo test; this script
# covers the live menu-line behavior.
#
# Usage:
#   cockpit-tray/scripts/smoke-status.sh
#
# Preconditions: the tray app is running (Minsky Cockpit.app). The script
# derives the expected label from a live health probe and asserts the menu line
# matches.
#
# Exit codes: 0 = menu line matches daemon state; 1 = mismatch (the bug class);
# 2 = precondition not met (app not running / not on macOS / Accessibility
# denied) — reported as SKIP, not failure.

set -euo pipefail

HEALTH_URL="http://localhost:3737/api/health"
PROCESS="cockpit-tray"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "SKIP: not macOS (tray app + Accessibility API are macOS-only)"
  exit 2
fi

if ! pgrep -f "Minsky Cockpit.app/Contents/MacOS/${PROCESS}" >/dev/null 2>&1; then
  echo "SKIP: tray app not running. Launch it first: open '/Applications/Minsky Cockpit.app'"
  exit 2
fi

# Determine expected label from a live health probe (fresh connection).
if curl -s -o /dev/null --max-time 2 "${HEALTH_URL}"; then
  expected="Cockpit: running"
  daemon="up"
else
  expected="Cockpit: stopped"
  daemon="down"
fi

# Read the dropdown status line (menu item 1) via the Accessibility API. The
# poll interval is 5s, so allow up to ~8s for the tray to converge to the
# current daemon state before asserting.
read_status_line() {
  # The Accessibility process name is the EXECUTABLE name ("cockpit-tray"), not
  # the bundle productName. Empirically `exists process "cockpit-tray"` is true
  # and this read returns the status line; the productName ("Minsky Cockpit")
  # also resolves on some macOS versions. Try both candidate names so the check
  # is robust to how System Events exposes the process.
  #
  # Within the matched process, search for the status item by its "Cockpit: "
  # title prefix across the status-area menu bars (2, then 1), rather than
  # assuming a fixed index — robust to menu-extra ordering / layout.
  osascript -e 'tell application "System Events"
    repeat with pname in {"cockpit-tray", "Minsky Cockpit"}
      if exists process pname then
        tell process pname
          repeat with mb in {menu bar 2, menu bar 1}
            try
              repeat with mbi in menu bar items of mb
                try
                  repeat with mi in menu items of menu 1 of mbi
                    set t to (title of mi)
                    if t starts with "Cockpit: " then return t
                  end repeat
                end try
              end repeat
            end try
          end repeat
        end tell
      end if
    end repeat
    return "ERROR: status menu item (Cockpit: ...) not found"
  end tell' 2>&1
}

actual=""
for _ in 1 2 3 4 5 6 7 8; do
  actual="$(read_status_line)"
  case "$actual" in
    "ERROR:"*)
      echo "SKIP: could not read tray menu via Accessibility (grant Accessibility permission to your terminal): ${actual}"
      exit 2
      ;;
    "${expected}")
      break
      ;;
  esac
  sleep 1
done

echo "daemon=${daemon}  expected='${expected}'  menu-line='${actual}'"
if [[ "${actual}" == "${expected}" ]]; then
  echo "PASS: tray status line matches daemon state."
  exit 0
fi

echo "FAIL: tray status line does not match daemon state (the mt#2240 class)."
exit 1
