# ADR-014: Cockpit Daemon Lifecycle Ownership — Tray App as Canonical Supervisor, launchd as Optional Headless Mode

## Status

Proposed

## Context

The cockpit daemon (`minsky cockpit start`, an HTTP server on `:3737`) and the cockpit
**tray app** (`cockpit-tray/`, a macOS menu-bar app) currently have a split, ambiguous
ownership model for the daemon's lifecycle:

- The tray app's Start/Stop/Restart menu items shell out to `launchctl load/unload`
  against `~/Library/LaunchAgents/com.minsky.cockpit.plist` (`cockpit-tray/src-tauri/src/main.rs`).
- The plist is installed by `minsky cockpit install` (`src/cockpit/launchd.ts`).
- In practice the daemon is frequently run **manually** for development:
  `bun --watch run src/cli.ts cockpit start --dev` — a foreground process the launchd
  agent knows nothing about.

So there are up to **three** putative owners (launchd, the manual dev process, the tray
app's launchctl calls) and no single source of truth. The originating incident
(mt#2240 / mt#2241, 2026-06-01): the launchd agent was not loaded, the real daemon was the
manual `bun --watch` process, and the tray's Start/Stop/Restart therefore operated on a
non-running launchd agent and silently no-op'd — the daemon "kept running fine in the
browser" while the controls did nothing.

**What launchd actually provides here.** The plist (`src/cockpit/launchd.ts → generatePlist`)
declares only three substantive behaviors, and it is a per-user **LaunchAgent** (login-scoped,
not a privileged system daemon):

1. `RunAtLoad` — start the daemon at login.
2. `KeepAlive { SuccessfulExit: false }` + `ThrottleInterval: 5` — restart on crash (non-zero
   exit), throttled to once per 5s.
3. `StandardOutPath` / `StandardErrorPath` — redirect logs to files.

Each is replicable by a menu-bar app: login-item registration replaces `RunAtLoad`; a
supervision loop replaces `KeepAlive`; piping the child's stdio to log files replaces the log
redirection. The tray app already spawns subprocesses (it shells `launchctl` via `Command`),
so owning the daemon as a managed child is _less_ indirection, not more. This is the standard
pattern for menu-bar daemon managers (Ollama, Docker Desktop's helper, etc.).

**Alternatives considered:**

- **(a) launchd-only (status quo).** Rejected — it is the source of the split-ownership bug.
  The tray controls a lifecycle (launchd) that is not the one actually running in dev, and
  the app has no direct knowledge of the daemon it purports to control.
- **(b) App as sole owner, retire launchd entirely.** Rejected — it removes the ability to run
  the daemon headless (no menu-bar app), which is useful for non-GUI contexts (a server, CI,
  or an unattended box).
- **(c) App owns by default, launchd retained as an optional headless mode.** Chosen.

## Decision

We will make the **cockpit tray app the canonical owner and supervisor of the cockpit
daemon.** The app:

- **Spawns** the daemon as a managed child process on launch.
- **Supervises** it: detects unexpected exit and respawns with a throttle (replicating
  `KeepAlive` + `ThrottleInterval`), and pipes the child's stdout/stderr to the cockpit log
  files.
- **Adopts** an already-running daemon: on launch, if `:3737` is already served (e.g. a manual
  `bun --watch` dev run, or a stale process), the app monitors that daemon via the health
  endpoint instead of double-spawning. Start/Stop/Restart then act on the actual running
  daemon, whatever started it.
- **Tears down** the daemon it spawned on Quit.
- **Auto-starts** by registering itself as a macOS Login Item (replacing `RunAtLoad`).

We will **retain launchd (`minsky cockpit install`) as an optional, explicitly opt-in headless
mode** for running the daemon without the menu-bar app. The two paths coordinate on a single
invariant: **one daemon owns `:3737` at a time.** The tray app must detect an existing
listener (launchd-managed or otherwise) and adopt-or-defer rather than spawn a competitor; the
launchd path remains a deliberate choice for headless contexts, not the default.

## Consequences

**Easier:**

- A single canonical owner removes the split-ownership ambiguity that caused mt#2240/mt#2241.
  Start/Stop/Restart act on the daemon that is actually running.
- Status becomes direct and reliable: the app knows its child's state from the process handle
  (not solely an HTTP poll), with the health poll as the fallback for adopted/external daemons.
- The control surface (the menu) and the supervisor are the same component — coherent, and the
  common pattern for this class of app.
- Local/dev use needs no `minsky cockpit install` step; launching the app is sufficient.

**Harder / newly committed:**

- The app must implement supervision (respawn-on-crash + throttle), child stdio→log
  redirection, login-item registration, and clean teardown — logic that launchd provided
  declaratively.
- **Two lifecycle paths must not fight over `:3737`.** The app and the optional launchd mode
  both have to honor the single-owner invariant; the app must detect-and-adopt an existing
  listener. This coordination is the main new correctness surface.
- The daemon's lifetime is bound to the app under the default path (no app running → no
  daemon). For a login-item menu-bar app this is effectively the prior "always on," and the
  optional launchd headless mode covers the genuine no-GUI case.
- Pre-login/boot start is not provided by either path (the launchd entry is a LaunchAgent, not
  a system LaunchDaemon) — unchanged from today; out of scope.

## Cross-references

- Related tasks: mt#2241 (implements this — tray-app supervisor + adoption + login item),
  mt#2240 (status-line display bug, independent), mt#2226 (tests + CI that should cover the
  supervision/adoption behavior), mt#2242 (this ADR).
- Related ADRs: ADR-002 (persistence-provider architecture) — sibling "one canonical owner with
  pluggable backends" shape; this ADR applies the same single-owner principle to process
  lifecycle.
- Memory: `c627a052` (verification-discipline: exercise the actual user-facing surface) — the
  retrospective that surfaced the split-ownership bug.
- Code: `src/cockpit/launchd.ts` (the launchd path being demoted to optional),
  `cockpit-tray/src-tauri/src/main.rs` (`handle_menu_event` lifecycle handlers to be reworked).
