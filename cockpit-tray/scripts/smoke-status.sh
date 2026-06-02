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
# Bundle executable candidates. Tauri names the binary after the Cargo package
# (cockpit-tray); some configs derive it from productName ("Minsky Cockpit").
# Match either so the running-app precondition doesn't false-SKIP.
APP_BIN_RE="/Contents/MacOS/(cockpit-tray|Minsky Cockpit)"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "SKIP: not macOS (tray app + Accessibility API are macOS-only)"
  exit 2
fi

if ! pgrep -f "${APP_BIN_RE}" >/dev/null 2>&1; then
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

# Accessibility/automation permission denial (or System Events being
# unavailable) must SKIP, not FAIL — only a successfully-read line that
# disagrees with the daemon state is a real failure (the mt#2240 class).
is_permission_or_tooling_error() {
  local out="$1" rc="$2"
  [[ "${rc}" -ne 0 ]] && return 0
  case "${out}" in
    *"not allowed"* | *"assistive access"* | *"-25211"* | *"-1719"* | *"execution error"*)
      return 0
      ;;
  esac
  return 1
}

actual=""
read_ok=0
for _ in 1 2 3 4 5 6 7 8; do
  set +e
  out="$(read_status_line)"
  rc=$?
  set -e
  if is_permission_or_tooling_error "${out}" "${rc}"; then
    echo "SKIP: could not use System Events — grant your terminal Accessibility permission (System Settings > Privacy & Security > Accessibility). Detail: ${out}"
    exit 2
  fi
  if [[ "${out}" == "ERROR:"* ]]; then
    # Status item not located yet; keep retrying within the window.
    actual="${out}"
    sleep 1
    continue
  fi
  actual="${out}"
  read_ok=1
  [[ "${actual}" == "${expected}" ]] && break
  sleep 1
done

if [[ "${read_ok}" -ne 1 ]]; then
  echo "SKIP: could not locate the status menu item via Accessibility. Detail: ${actual}"
  exit 2
fi

echo "daemon=${daemon}  expected='${expected}'  menu-line='${actual}'"
if [[ "${actual}" == "${expected}" ]]; then
  echo "PASS: tray status line matches daemon state."
  exit 0
fi

echo "FAIL: tray status line does not match daemon state (the mt#2240 class)."
exit 1
