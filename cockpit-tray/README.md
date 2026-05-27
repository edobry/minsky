# Minsky Cockpit Tray

macOS menu bar app for controlling the Minsky cockpit daemon.

## Prerequisites

- [Rust toolchain](https://rustup.rs/) (for Tauri v2)
- The cockpit daemon installed via `minsky cockpit install`

## Development

```bash
cd cockpit-tray
bun install
bun run dev
```

## Build

```bash
bun run build
```

The built `.app` bundle will be in `src-tauri/target/release/bundle/macos/`.

## What it does

- Shows a menu bar icon with the cockpit daemon's status (running/stopped)
- Polls `http://localhost:3737/api/health` every 5 seconds
- Menu actions: Open in Browser, Start/Stop/Restart Daemon, Quit

## Architecture

Tauri v2 app with no window (tray-only). The Rust backend handles:

- System tray icon and menu
- Health endpoint polling via reqwest
- launchctl load/unload for daemon lifecycle
