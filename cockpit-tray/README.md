# Minsky Cockpit Tray

macOS menu bar app for controlling the Minsky cockpit daemon.

## Prerequisites

- **Rust toolchain** (for Tauri v2). Install via [rustup](https://rustup.rs/):
  ```bash
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  source "$HOME/.cargo/env"
  ```
  Verified working with `rustc`/`cargo` 1.96.0 (any recent stable should work).
- **Bun** (the repo's runtime) — already required by the parent project. The app
  spawns the daemon via `bun run src/cli.ts cockpit start` (the source entry, in the
  repo root), so `bun` must be resolvable on PATH; the `minsky` CLI on PATH is only
  used as a fallback to locate the repo root (the launchd plist's `WorkingDirectory`
  is tried first). The app augments PATH with `~/.bun/bin`, `/opt/homebrew/bin`,
  `/usr/local/bin`, `~/.local/bin`, and the standard system dirs, mirroring the
  launchd plist.
- **The cockpit daemon** does **not** need to be installed via `minsky cockpit install`
  for the menu to work: the app owns the daemon's lifecycle directly (see _Daemon
  lifecycle_ below). `minsky cockpit install` (launchd) is retained as an optional,
  opt-in **headless** mode for running the daemon without the menu-bar app.

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

**For deep-link / URL-scheme verification, use the lean installer.** It builds
APP-ONLY (`tauri build --bundles app` — no DMG, so no macOS installer-window
popup), installs into `/Applications`, registers with Launch Services, and clears
quarantine:

```bash
cockpit-tray/scripts/install-local.sh                # full install
cockpit-tray/scripts/install-local.sh --binary-only  # fast iterative re-install (swap inner binary only)
```

> `tauri dev` (`bun run dev`) is the normal loop for ALL tray work EXCEPT
> deep-link testing — the `minsky://` scheme only registers for a bundled app
> installed in `/Applications` (a macOS Launch-Services constraint, not a Tauri
> one), so deep links can't be exercised under `tauri dev`. See the Deep-link
> section below.

To install a bundle you built by hand instead (note that a full `bun run build`
also emits a `.dmg` you don't need for local install):

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
  with the cockpit daemon's status (running / stopped / starting / port-conflict)
- Polls `http://localhost:3737/api/health` every 5 seconds (each poll on a fresh
  connection — mt#2225)
- Menu actions: Open Cockpit (in-app window), Open in Browser, Start/Stop/Restart
  Daemon, Quit
- Keeps the served cockpit-web bundle fresh automatically (rebuilds at startup and
  on source changes) so the operator never sees a stale UI after pulling main —
  see _Bundle auto-rebuild_ below (mt#2297)
- Keeps the running daemon fresh against **backend** source automatically (restarts
  a stale adopted daemon at startup and on backend `.ts` changes) so new widgets /
  routes are never silently missing, with a "Daemon uptime" line showing currency —
  see _Backend auto-restart_ below (mt#2299)

### Daemon lifecycle (supervisor model — mt#2241, ADR-014)

The tray app is the **canonical owner/supervisor** of the cockpit daemon:

- **Spawn** — on launch, if nothing is serving `:3737`, the app starts
  `bun run src/cli.ts cockpit start --no-dev-chromium --port 3737` as a managed
  child process (the **source** entry, matching the launchd plist — the `minsky`
  bundle has a web-bundle path bug, mt#2283), with the child's stdout/stderr
  appended to `~/.local/state/minsky/logs/cockpit-{stdout,stderr}.log`. The child
  runs in the **Minsky repo root** so `src/cli.ts`, the web bundle, and minsky's
  git-based repo-backend detection all resolve (mt#2282); the root is resolved
  from the launchd plist's `WorkingDirectory` (`minsky cockpit install`) or, failing
  that, by canonicalizing the `minsky` bin symlink (`<repo>/scripts/cli-entry.ts`
  → `<repo>`), requiring `src/cli.ts` to be present. If no repo root (or `bun`) can
  be resolved, the app refuses to spawn and the menu shows "Cockpit: repo not
  found" / "Cockpit: bun not found" rather than crash-looping.
- **Adopt** — on launch, if `:3737` is already served by our daemon (e.g. a manual
  `bun --watch ... cockpit start --dev` dev run), the app monitors that daemon via
  the health endpoint instead of double-spawning. Start/Stop/Restart then act on the
  actual running daemon. A listener on `:3737` that does _not_ answer our health
  endpoint is treated as a conflict (the app won't spawn over it or claim it).
- **Supervise** — a daemon the app spawned is respawned if it exits unexpectedly,
  throttled to once per 5s (mirrors launchd `KeepAlive` + `ThrottleInterval`).
- **Tear down** — quitting the app stops the daemon it spawned. An _adopted_
  (externally started) daemon is left running.
- **Login Item** — release builds register the app as a macOS Login Item so it
  (and thus the daemon) auto-starts at login. Remove it via System Settings →
  General → Login Items, or `osascript`/the autostart API.

The launchd path (`minsky cockpit install`) and the app honor a single invariant:
**one daemon owns `:3737` at a time** — whichever binds first wins; the other adopts
or defers. Don't run both in spawn mode simultaneously.

### Bundle auto-rebuild (mt#2297)

The daemon serves the **pre-built production bundle** (`src/cockpit/web/dist`). On a
source checkout that bundle drifts stale when source changes (typically after
`git pull` lands new cockpit features), and the daemon would silently serve the old
UI. The tray keeps it fresh:

- **Startup pre-flight.** Before spawning the daemon, the tray compares
  `src/cockpit/web/dist/index.html`'s mtime against the newest source mtime under
  `src/cockpit/web/**` (skipping `dist`, `node_modules`, `.git`). If source is newer
  — or `dist` is missing — it runs `bun run cockpit:build` from the repo root first.
- **Runtime watcher.** While the daemon runs, a debounced (~500ms) filesystem watcher
  on `src/cockpit/web/**` rebuilds the bundle on any source change. The watcher
  ignores `dist`/`node_modules`/`.git`, so the rebuild's own `dist` writes don't
  re-trigger it. A fresh bundle is picked up on the next browser refresh (the daemon
  is not restarted — Express serves `dist` from disk per request).
- **Source-presence gate.** All of the above is gated on a source checkout being
  present. A packaged / no-source install skips every rebuild path and serves the
  bundle shipped with the app — no error, no staleness warning.
- **"Last build" line.** The tray menu shows a dropdown line with the last build's
  outcome (timestamp on success; the error summary on failure) so staleness can be
  confirmed or ruled out at a glance.
- **Build failures.** A runtime rebuild failure keeps the daemon serving the prior
  bundle and shows `Build FAILED (...) - serving prior bundle`. A startup failure
  with **no** prior bundle to serve refuses to spawn (`Cockpit: start failed`) and
  shows `Build FAILED (...) - nothing to serve`. Full build output is appended to
  `~/.local/state/minsky/logs/cockpit-build.log`. A failure also fires a macOS
  **notification** (OS toast) with the error summary (mt#2306), in addition to the
  status label and "Last build" line. The toast requires notification permission
  (requested best-effort on first launch); if it's denied, the label + "Last build"
  menu line remain the reliable surface.

### Backend auto-restart (mt#2299)

The **server-side** complement to the bundle rebuild above. The daemon loads its
widget registry and route table **at process start**, so when backend source
changes (`src/cockpit/server.ts`, `widget-registry.ts`, `widgets/**`, `config.ts`,
`types.ts`) the running daemon is stale — newly-registered widgets return
`Widget not found` until the process restarts. Because the daemon is spawned from
**source** (`bun run src/cli.ts`), a plain process restart picks up backend changes
with **no build step** (unlike the web bundle, which must be rebuilt). The tray
keeps the daemon current:

- **Startup staleness (adopted daemon).** When the tray adopts an already-running
  daemon, it reads that daemon's start time (`ps -o etime=`) and compares it against
  the newest backend-source mtime under `src/cockpit/**` (excluding `web/**`,
  `node_modules`, `.git`, `dist`, and `*.test.ts`). If source is newer — the daemon
  predates the current code — the tray restarts it before reporting ready. This is
  the originating 2026-06-04 case: an 8-day-old daemon that missed two merged
  feature PRs. A daemon the tray spawns fresh is trivially current, so no check is
  needed there.
- **Runtime watcher.** While the daemon runs, a debounced (~2s — larger than the
  web rebuild's 500ms, since a restart is more disruptive) filesystem watcher on
  `src/cockpit/**` restarts the daemon on any relevant backend `.ts` change. `web/**`
  is excluded (the mt#2297 rebuild path owns it), so a frontend edit rebuilds the
  bundle without bouncing the daemon, and a backend edit restarts the daemon without
  a build.
- **Source-presence gate.** Like the rebuild path, all of the above is gated on a
  source checkout; a packaged / no-source install skips it.
- **"Daemon uptime" line.** The tray menu shows how long the daemon has run plus the
  source mtime it was started against (`Daemon uptime: 3m 12s (src @ 14:30:00 UTC)`),
  so operators can confirm "is my daemon current?" without inspecting
  `ps -p <pid> -o lstart`.
- **Restart-failure surface.** If a restarted daemon crash-loops (e.g. a syntax error
  in `server.ts` makes the new process fail to bind), the status line shows
  `Cockpit: start failed: <stderr tail> (see logs)` rather than a silent "stopped".

Operators running through the tray never need to manually `kill <pid>` or know that
backend changes require a process restart — with one caveat: restart/stop of an
**adopted** daemon (one the tray didn't spawn) infers the holder via `lsof`/`ps` and
sends a `SIGTERM`. If those tools are unavailable or the kill is permission-gated on a
given macOS setup, the tray surfaces the conflict/status message rather than forcibly
killing a foreign listener, and manual intervention may be needed in that edge case.

### Status-line labels

The dropdown status line shows one of:

| Label                                                  | Meaning                                                                                                                                                    | Remediation                                                                                                                                              |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Cockpit: running`                                     | A daemon is serving `:3737` (spawned or adopted).                                                                                                          | —                                                                                                                                                        |
| `Cockpit: stopped`                                     | Nothing is serving `:3737`.                                                                                                                                | Use **Start Daemon**.                                                                                                                                    |
| `Cockpit: starting...`                                 | A spawned daemon is booting (not yet healthy).                                                                                                             | Wait a few seconds.                                                                                                                                      |
| `Cockpit: rebuilding bundle...`                        | A startup pre-flight `cockpit:build` is running before spawn (mt#2297).                                                                                    | Wait for the build to finish; progress/outcome shows on the **Last build** line.                                                                         |
| `Cockpit: :3737 held by pid <N> (not started by tray)` | Some other process holds `:3737` (mt#2299 names the holder pid; falls back to `:3737 in use (not cockpit)` if the pid can't be read).                      | Free the port; Stop/Restart won't kill a foreign listener.                                                                                               |
| `Cockpit: repo not found`                              | No Minsky repo root with `src/cli.ts` could be resolved, so the app refused to spawn.                                                                      | Run `minsky cockpit install` (records the repo in the launchd plist), or ensure the `minsky` bin symlinks into the repo (`<repo>/scripts/cli-entry.ts`). |
| `Cockpit: bun not found`                               | `bun` is not resolvable on PATH.                                                                                                                           | Install Bun (`curl -fsSL https://bun.sh/install \| bash`) so it lands on `~/.bun/bin`.                                                                   |
| `Cockpit: start failed (see logs)`                     | The spawn was attempted but errored (including a startup rebuild with no servable bundle).                                                                 | Check `~/.local/state/minsky/logs/cockpit-stderr.log` and `cockpit-build.log`.                                                                           |
| `Cockpit: start failed: <tail> (see logs)`             | A spawned daemon crash-looped (exited within the respawn-throttle window — e.g. a syntax error in `server.ts`); the stderr tail is shown inline (mt#2299). | Check `~/.local/state/minsky/logs/cockpit-stderr.log`; fix the backend error (the runtime watcher restarts on the next save).                            |

A separate **Last build** dropdown line shows the bundle's last rebuild outcome
(`Last build: HH:MM:SS UTC`, `Rebuilding bundle...`, or `Build FAILED (...)`). A
**Daemon uptime** line (mt#2299) shows how long the daemon has run + the source
mtime it was started against (`Daemon uptime: 3m 12s (src @ 14:30:00 UTC)`), or
`Daemon uptime: —` when nothing is running.

### `minsky://` deep links (mt#2528)

The tray registers the `minsky://` custom URL scheme, so clicking a
`minsky://<type>/<id>` link — e.g. a terminal deeplink (mt#2519) or
`open minsky://task/mt%232370` — **focuses the cockpit window and navigates it**
to that entity's page. If the tray app is closed, macOS Launch Services
**launches it first**, then delivers the URL (click-to-launch).

- **Routing:** `task` → `/tasks/<id>`, `ask` → `/ask/<id>`, `memory` →
  `/memory/<id>`, `session` → `/agents/<id>`; `pr`/`changeset`/unknown → no-op
  (no route yet, mt#2410). All mappings come from the shared codec
  (`src/cockpit/web/lib/entity-codec.ts`, mt#2518) — never hardcoded.
- **How it works (ADR-023):** the cockpit window is an untrusted external-URL
  webview, so the deep-link plugin's JS `onOpenUrl` listener is unavailable. The
  Rust `on_open_url` handler shows/focuses the window and forwards the URL via
  `window.eval` of the SPA-exposed `window.__minskyDeepLink(uri)` global
  (JSON-encoded; retried until the webview is ready so a cold start doesn't drop
  the link). No Tauri IPC / `remote` capability is granted to the SPA — see
  `docs/architecture/adr-023-cockpit-ui-delivery-native-boundary.md`.
- **Cold-start / dead-window recovery (mt#2688):** on a cold start the window
  is created before the daemon is listening, so the initial page load fails
  (connection refused) and the document is blank. The recovery loop behind
  every deep link (and behind the menu's Open Cockpit cold open) TCP-probes
  the daemon port each tick and, once it accepts, **re-navigates** the webview
  to the cockpit URL via `WebviewWindow::navigate` — `location.reload()` is
  NOT used for this, because reloading a never-loaded document just reloads
  the blank page. The deep link is delivered only after the window is on a
  live cockpit document; a live SPA is never gratuitously reloaded. The tray
  menu's Open Cockpit applies the same live-check: reload for a live document
  (daemon-restart refresh), navigate for a dead one.
- **macOS-only:** registration uses `CFBundleURLTypes` / Launch Services
  (auto-generated from `tauri.conf.json` → `plugins.deep-link.desktop.schemes`).
  Windows/Linux scheme registration differs and is a follow-up.
- **Cannot be tested in `tauri dev`** (no `.app` bundle → the scheme is
  unregistered; macOS registers schemes from `Info.plist` at INSTALL time, not at
  runtime). Verify on a real build + install — use the lean installer (app-only
  build, no DMG popup):

  ```bash
  cockpit-tray/scripts/install-local.sh        # app-only build + install + register
  open "/Applications/Minsky Cockpit.app"      # launch the tray (spawns the daemon)
  open 'minsky://task/mt%232370'               # cockpit focuses → /tasks/mt%232370
  # quit the tray app, then:
  open 'minsky://memory/<uuid>'                # app launches → /memory/<uuid>
  # or run the automated hot-start check:
  cockpit-tray/scripts/verify-deeplink-hotstart.sh
  ```

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

### Post-restructure operator smoke (mt#2628)

The mt#2628 module split (`main.rs` → `menu`/`supervisor`/`watcher_web`/
`watcher_backend`/`deeplink`/`launchd`) is tier-1/2 verified only — GUI smoke
cannot run from a session workspace or CI. After the next
`install-local.sh` rebuild+reinstall, the operator verifies once:

- [ ] Menu renders and items function (status line, open cockpit, quit)
- [ ] Clicking a `minsky://` link opens the cockpit window
- [ ] Killing the daemon (`kill <pid>` of the `cockpit start` process) triggers supervisor respawn

## Architecture

Tauri v2 app, tray-only by default (it can open an in-app cockpit window on demand,
mt#2219). The Rust backend (`src-tauri/src/main.rs`) handles:

- System tray icon and menu (`TrayIconBuilder`, `image-png` feature for the PNG icon)
- A single **supervisor thread** (background tokio runtime) that owns the daemon
  `Child`: it runs the health poll (`reqwest`, fresh connection per poll — mt#2225)
  and the spawn / adopt / respawn-with-throttle / teardown lifecycle, driven by a
  command channel from the menu handler (Start/Stop/Restart/Shutdown)
- Cockpit-web bundle freshness (mt#2297): a startup pre-flight rebuild + a
  `notify-debouncer-mini` filesystem watcher that sends a debounced `Rebuild`
  command to the supervisor; the build runner shells out to `bun run cockpit:build`
- Login Item registration via `tauri-plugin-autostart` (LaunchAgent mode, release builds)
- Synchronous teardown of the spawned daemon on `RunEvent::Exit`

The pure decision logic (`decide_action`, `throttle_ok`, `augmented_path`,
`parse_lsof_pid`, `status_label`) is unit-tested without the Tauri runtime.
