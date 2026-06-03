# Minsky Cockpit Tray

macOS menu bar app for controlling the Minsky cockpit daemon.

## Prerequisites

- **Rust toolchain** (for Tauri v2). Install via [rustup](https://rustup.rs/):
  ```bash
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  source "$HOME/.cargo/env"
  ```
  Verified working with `rustc`/`cargo` 1.96.0 (any recent stable should work).
- **Bun** (the repo's runtime) — already required by the parent project.
- **The cockpit daemon** installed via `minsky cockpit install` (required for the
  Start/Stop/Restart menu items and the running-status indicator to work; those
  drive `launchctl load/unload` against `~/Library/LaunchAgents/com.minsky.cockpit.plist`).

> Note: `cockpit-tray/` is a standalone package, **not** part of the root Bun
> workspace (`packages/*`, `services/*`). Always run `bun install` from inside
> `cockpit-tray/`, not from the repo root.

## Development

```bash
cd cockpit-tray
bun install
bun run dev
```

## Build

```bash
cd cockpit-tray
bun install          # installs the Tauri CLI + JS deps (standalone — see note above)
bun run build        # == `tauri build`
```

This produces (arm64 / Apple Silicon):

- `src-tauri/target/release/bundle/macos/Minsky Cockpit.app` — the app bundle
- `src-tauri/target/release/bundle/dmg/Minsky Cockpit_<version>_aarch64.dmg` — a DMG (also emitted; unused for local install)

The first build is slow (it compiles the full Rust dependency tree, ~hundreds of
crates). Subsequent builds are incremental (~20s).

## Install (local, single-principal)

Copy the bundle into `/Applications`:

```bash
cp -r "src-tauri/target/release/bundle/macos/Minsky Cockpit.app" /Applications/
```

### First launch — unsigned-app gatekeeper warning

The app is **not code-signed or notarized** (deferred — see mt#2201). On first
launch macOS Gatekeeper will block it as from an "unidentified developer". Either:

- **Right-click** `Minsky Cockpit.app` in Finder → **Open** → **Open** in the dialog
  (one-time per install), or
- Clear the quarantine attribute from the terminal:
  ```bash
  xattr -dr com.apple.quarantine "/Applications/Minsky Cockpit.app"
  open "/Applications/Minsky Cockpit.app"
  ```

After the first approved launch, the app opens normally.

## What it does

- Shows a menu bar icon (Minsky logo, template-tinted to match light/dark mode)
  with the cockpit daemon's status (running/stopped)
- Polls `http://localhost:3737/api/health` every 5 seconds
- Menu actions: Open in Browser, Start/Stop/Restart Daemon, Quit

## Testing (mt#2226)

Three tiers; standard Tauri WebDriver e2e does **not** apply (it is Windows/Linux-only
— no macOS WKWebView driver — and this app has no webview window to drive).

1. **Rust unit tests** (`cargo test`) — pure logic (e.g. `status_label`). Run:
   ```bash
   cd cockpit-tray/src-tauri && cargo test
   ```
2. **CI build + unit-test smoke** — `.github/workflows/cockpit-tray-ci.yml` runs on
   macOS for any `cockpit-tray/**` change: `cargo test` + `bun run tauri build` +
   bundle-exists assertion. Catches the "compiles in dev but never built" / compile-error
   class (mt#2200). A tray app cannot be boot-smoke-tested headlessly (no WindowServer on
   hosted runners), so live boot/menu behavior is tier 3, not CI.
3. **Local Accessibility status check** — `cockpit-tray/scripts/smoke-status.sh` reads the
   **dropdown status line** via the macOS Accessibility API and asserts it matches the live
   daemon state. This is the check that would have caught mt#2240 (the line was frozen while
   only the tooltip updated). Local-only — reading another process's menu needs Accessibility
   (TCC) permission for your terminal, which CI can't grant. Run with the app running:
   ```bash
   open "/Applications/Minsky Cockpit.app"
   cockpit-tray/scripts/smoke-status.sh   # exit 0 = matches, 1 = mismatch, 2 = skipped
   ```

## Architecture

Tauri v2 app with no window (tray-only). The Rust backend (`src-tauri/src/main.rs`)
handles:

- System tray icon and menu (`TrayIconBuilder`, `image-png` feature for the PNG icon)
- Health endpoint polling via `reqwest` on a background tokio runtime
- `launchctl load/unload` for daemon lifecycle, against the plist that
  `minsky cockpit install` writes
