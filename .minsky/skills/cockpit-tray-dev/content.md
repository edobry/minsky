# cockpit-tray-dev — develop, test, and ship the Minsky Cockpit tray app

You are working on `cockpit-tray/**`, the Tauri v2 macOS menu-bar app that supervises the cockpit daemon and hosts the in-app cockpit window. This is the **native shell**; the `cockpit-design` skill owns the cockpit **web UI** (`src/cockpit/web/**`). The two are different layers — confusing them is the most common mistake here (see "Two layers" below).

`cockpit-tray/README.md` is the detailed reference (daemon lifecycle, status labels, auto-rebuild, testing tiers). This skill is the agent-loadable mental model + the dev loop; read the README for depth.

## When to invoke

- Changing the tray app's Rust (`cockpit-tray/src-tauri/src/main.rs`): menu items, the cockpit window, daemon supervision.
- Testing a tray change, or answering "why don't I see my change in the menu bar?"
- Building any rung of the harness-host ladder (mt#2230) — the tray is its native vehicle.
- Distributing or updating the installed app.

## Two layers — get this right first

`cockpit-tray` involves two distinct build artifacts. "Why don't I see my change?" almost always means you've confused them:

1. **The cockpit WEB app** (`src/cockpit/web/**`, `src/cockpit/server.ts`) — served by the daemon. A running tray app **auto-rebuilds the web bundle** (mt#2297) and **auto-restarts the daemon on backend changes** (mt#2299) when source changes (e.g. after `git pull`). So a cockpit-web change needs **no manual rebuild** — refresh the window, or let the watcher fire; the "Last build" / "Daemon uptime" menu lines confirm currency.
2. **The tray app's own Rust binary** (`cockpit-tray/src-tauri/**`) — the `.app` itself: menu items, the window, supervision logic. This is **NOT** auto-rebuilt. The installed `/Applications/Minsky Cockpit.app` is a static compiled bundle; merging a Rust change to `main` does nothing to it until you rebuild. This is the layer that bites: mt#2219 (the "Open Cockpit" menu item) was a tray-binary change, so it stayed invisible in the running menu bar until a rebuild.

Decision: **cockpit-web change → no tray rebuild, just refresh. Tray-binary change → `bun run dev` (iterate) or build+reinstall (release).**

## The dev loop (tray-binary changes)

```bash
cd cockpit-tray
bun install        # standalone package — NOT in the root bun workspace; install from here
bun run dev        # == `tauri dev`: compiles, launches, and rebuilds + relaunches on save
```

`tauri dev` watches the Rust source and rebuilds + relaunches on change. This is THE iteration loop — **not** build → copy → relaunch. Quit the installed `/Applications` app first so you don't end up with two tray icons.

## Testing (mt#2226) — and what `cargo check` does NOT prove

`cargo check` / `cargo test` verify the Rust **compiles** and pure logic is correct. They do **not** verify GUI behavior (a menu click opening a window). There is no headless path — Tauri's WebDriver e2e is Windows/Linux-only (no macOS WKWebView driver). Three tiers:

1. `cd cockpit-tray/src-tauri && cargo test` — pure logic (`status_label`, `decide_action`, `throttle_ok`, …).
2. CI (`.github/workflows/cockpit-tray-ci.yml`) — `cargo test` + `tauri build` + bundle-exists, on every `cockpit-tray/**` change.
3. `cockpit-tray/scripts/smoke-status.sh` — local-only; reads the live menu status line via the macOS Accessibility API.

So GUI-behavior verification = `bun run dev` + a manual click. **Do not report a tray UI change "verified" off `cargo check` alone** — that proves compilation, nothing about the click.

## Release install (rare — testing the packaged app, not iterating)

```bash
cd cockpit-tray && bun run build      # tauri build → src-tauri/target/release/bundle/macos/Minsky Cockpit.app
cp -r "src-tauri/target/release/bundle/macos/Minsky Cockpit.app" /Applications/
xattr -dr com.apple.quarantine "/Applications/Minsky Cockpit.app"   # app is unsigned; mt#2201
open "/Applications/Minsky Cockpit.app"
```

Use this only to test the packaged experience or to update your own installed app — never as the iteration loop.

## Keeping the installed app current = auto-update (current gap)

There is no auto-update yet, so a merged tray-binary change won't reach an installed app until someone rebuilds. The production answer is `tauri-plugin-updater` (a first-party Tauri plugin — checks a hosted `latest.json` / GitHub Releases and self-restarts), automatable with GitHub Actions on release. It requires code-signing, which is deferred to **mt#2201** — fold the updater into that task rather than treating "rebuild + reinstall by hand" as the steady state.

## Gotchas

- **External-URL webviews lose Tauri IPC.** The cockpit window loads an external URL (`http://localhost:3737`), so that page **cannot call Tauri commands**. Fine for display-only (Rung 0). For native-bridge features (driving sessions — Rungs 2+ of mt#2230) you must bundle the cockpit frontend into the app (`frontendDist`) or use an iframe bridge.
- **Dock-icon suppression.** The app stays out of the Dock via `LSUIElement` (mt#2202) plus `ActivationPolicy::Accessory` in `main.rs`. If you add a window and a Dock icon appears, that's the regression to fix.
- **Standalone package.** `cockpit-tray/` is NOT part of the root bun workspace — run `bun install` from inside it, not the repo root.
- **Supervisor model (ADR-014 / mt#2241).** The tray is the canonical owner of the daemon lifecycle: spawn / adopt / supervise (respawn-with-throttle) / teardown, plus startup bundle-rebuild (mt#2297) and backend auto-restart (mt#2299). This already implemented the "app-owns-the-server" decision; read ADR-014 before touching lifecycle logic. (It supersedes the lifecycle question framed in mt#2231.)

## Cross-references

- `cockpit-tray/README.md` — the detailed reference (lifecycle, status labels, auto-rebuild, testing).
- `docs/architecture/adr-014-cockpit-daemon-lifecycle-ownership.md` — the daemon supervisor model.
- `cockpit-design` skill + `src/cockpit/CLAUDE.md` — the cockpit **web UI** layer (the other half of the system).
- mt#2230 — harness-host ladder (the tray is its native vehicle); mt#2201 — signing / distribution (fold in auto-update); mt#2219 — the "Open Cockpit" window (the originating "why don't I see it" incident).
