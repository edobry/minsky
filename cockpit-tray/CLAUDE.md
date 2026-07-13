# cockpit-tray — Tauri menu-bar app: dev, test, ship

Auto-loads when any file under `cockpit-tray/**` is read. This is the Minsky Cockpit **tray app** (Tauri v2, macOS menu bar): it supervises the cockpit daemon and hosts the in-app cockpit window. The cockpit **web UI** is a different layer — `src/cockpit/**` (see `src/cockpit/CLAUDE.md` + the `cockpit-design` skill).

For depth on this app — daemon lifecycle, status labels, auto-rebuild, testing tiers — read `cockpit-tray/README.md`. For the agent dev/test/ship mental model, invoke the **`cockpit-tray-dev`** skill.

## Two layers (the #1 mistake here)

"Why don't I see my change?" almost always means these two were confused:

- **cockpit-web** (`src/cockpit/web/**`, `src/cockpit/server.ts`) — the running tray **auto-rebuilds the bundle (mt#2297) and auto-restarts the daemon (mt#2299)** on source change. No manual tray rebuild; just refresh the window.
- **tray binary** (`cockpit-tray/src-tauri/**`) — the `.app` itself (menu, window, supervision). **NOT** auto-rebuilt; the installed app is a static bundle. A merged Rust change is invisible until rebuilt. mt#2219 was this layer.

## Dev loop (tray-binary changes)

```bash
cd cockpit-tray && bun install && bun run dev   # tauri dev: rebuild + relaunch on save
```

`cockpit-tray/` is a standalone package (not in the root bun workspace) — run `bun install` from inside it. `cargo check` proves it compiles, NOT that the GUI works; verify a UI change with `bun run dev` + a manual click (there is no headless WKWebView e2e — mt#2226).

**Deep-link / `minsky://` scheme changes are the exception:** `tauri dev` cannot test them (macOS registers schemes from `Info.plist` at install time, not at runtime). Use the lean installer — `cockpit-tray/scripts/install-local.sh` builds APP-ONLY (`tauri build --bundles app`, no DMG / no installer-window popup), installs to `/Applications`, and registers the scheme — then `cockpit-tray/scripts/verify-deeplink-hotstart.sh`. Do NOT use a full `bun run build` for deep-link verification (it rebuilds the DMG and flashes the installer window each time — mt#2553).

## Cross-references

- `cockpit-tray/README.md` — detailed reference. `cockpit-tray-dev` skill — agent mental model.
- ADR-014 / mt#2241 — daemon supervisor model. mt#2201 — signing + auto-update. mt#2230 — harness-host ladder (this app is its native vehicle).
