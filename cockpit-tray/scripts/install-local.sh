#!/usr/bin/env bash
#
# install-local.sh (mt#2553) — lean local build + install of the Minsky Cockpit
# tray app, for deep-link / URL-scheme verification.
#
# WHY THIS EXISTS
#   Testing the `minsky://` deep-link scheme on macOS REQUIRES a bundled `.app`
#   installed in /Applications: Launch Services registers the scheme from the
#   app's Info.plist at INSTALL time, not at runtime, so `tauri dev` cannot test
#   it. This is a macOS platform constraint, not a Tauri one (see
#   https://v2.tauri.app/plugin/deep-linking/ — "no workaround to avoid
#   reinstalling on macOS when testing custom URL schemes").
#
#   For ALL OTHER tray work, use `bun run dev` (tauri dev, hot-reload, no install).
#   Only deep-link/scheme verification needs this build+install path.
#
# WHAT IT DOES DIFFERENTLY FROM `bun run build`
#   It builds APP-ONLY via `tauri build --bundles app` — NOT a full `tauri build`,
#   which ALSO produces a `.dmg` and runs `bundle_dmg.sh`, which mounts the disk
#   image and flashes the macOS "drag to Applications" installer window on every
#   rebuild. The DMG is pure waste for local dev.
#
# USAGE
#   cockpit-tray/scripts/install-local.sh
#       Full path: app-only build -> replace /Applications bundle -> re-register
#       with Launch Services -> clear quarantine.
#
#   cockpit-tray/scripts/install-local.sh --binary-only
#       Fast iterative path: app-only build -> swap ONLY the inner binary in the
#       already-installed bundle (skips the LS re-register; the scheme
#       registration is on the bundle path + Info.plist, which don't change when
#       only the binary is swapped). Use after the first full install when
#       iterating on Rust changes.
#
# Then verify:  cockpit-tray/scripts/verify-deeplink-hotstart.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRAY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_NAME="Minsky Cockpit.app"
BUILT_APP="$TRAY_DIR/src-tauri/target/release/bundle/macos/$APP_NAME"
INSTALLED_APP="/Applications/$APP_NAME"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

BINARY_ONLY=0
[[ "${1:-}" == "--binary-only" ]] && BINARY_ONLY=1

[[ "$(uname)" == "Darwin" ]] || {
  echo "install-local.sh: macOS only (uname=$(uname)); deep-link scheme testing is macOS-specific."
  exit 1
}

# Build APP-ONLY via the Tauri CLI directly (`bunx tauri`, the @tauri-apps/cli
# devDependency) — no dependence on an npm passthrough script, and crucially no
# `.dmg` / `bundle_dmg.sh` step (which flashes the installer window).
echo "==> app-only build (bunx tauri build --bundles app — no DMG, no installer-window popup)"
(cd "$TRAY_DIR" && bunx tauri build --bundles app)

[[ -d "$BUILT_APP" ]] || {
  echo "install-local.sh: build did not produce '$BUILT_APP'"
  exit 1
}

# Derive the inner binary name from the freshly-built bundle rather than
# hardcoding it (Tauri names it from tauri.conf.json productName / the Cargo bin,
# which can change). Fail loudly if no executable is found.
BINARY_NAME="$(ls "$BUILT_APP/Contents/MacOS/" 2>/dev/null | head -n1)"
[[ -n "$BINARY_NAME" && -x "$BUILT_APP/Contents/MacOS/$BINARY_NAME" ]] || {
  echo "install-local.sh: no executable found in '$BUILT_APP/Contents/MacOS/'"
  exit 1
}
BINARY_REL="Contents/MacOS/$BINARY_NAME"

# Quit any running instance so the bundle / binary can be replaced cleanly.
osascript -e 'quit app "Minsky Cockpit"' 2>/dev/null || true
pkill -f "$APP_NAME/$BINARY_REL" 2>/dev/null || true
sleep 1

if [[ "$BINARY_ONLY" == "1" && -d "$INSTALLED_APP" ]]; then
  echo "==> --binary-only: swapping inner binary in the already-registered bundle"
  cp -f "$BUILT_APP/$BINARY_REL" "$INSTALLED_APP/$BINARY_REL"
else
  if [[ "$BINARY_ONLY" == "1" ]]; then
    echo "==> --binary-only requested but '$INSTALLED_APP' is not installed yet — doing a full install"
  fi
  echo "==> installing: replace '$INSTALLED_APP' + re-register with Launch Services"
  rm -rf "$INSTALLED_APP"
  cp -R "$BUILT_APP" /Applications/
  "$LSREGISTER" -f "$INSTALLED_APP"
fi

# Clear the quarantine flag so the app launches without a Gatekeeper prompt.
xattr -dr com.apple.quarantine "$INSTALLED_APP" 2>/dev/null || true

echo "==> installed: $INSTALLED_APP"
echo "    launch:            open \"$INSTALLED_APP\""
echo "    verify deep link:  cockpit-tray/scripts/verify-deeplink-hotstart.sh"
