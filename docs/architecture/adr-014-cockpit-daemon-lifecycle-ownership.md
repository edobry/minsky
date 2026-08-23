# ADR-014: Cockpit Daemon Lifecycle Ownership — Tray App as Canonical Supervisor, launchd as Optional Headless Mode

## Status

Accepted (2026-06-02 — principal approved Option C; implemented in mt#2241)

Amended 2026-08-11 (mt#3988) — see [Amendment: the port is resolved, not
fixed](#amendment-2026-08-11-the-port-is-resolved-not-fixed).
Amended 2026-08-12 (mt#3815) — see [Amendment: the supervisor owns a REGISTRY,
not a daemon](#amendment-2026-08-12-the-supervisor-owns-a-registry-not-a-daemon).

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

### Relation to existing documentation

This ADR is **forward-looking**. The current implementation still matches the older behavior
described in `docs/architecture/cockpit.md` ("Daemon mode (mt#2140)") — launchd as the primary
managed path and the tray app as a `launchctl` controller. That remains accurate until
mt#2241 lands the supervisor model. When mt#2241 ships, `docs/architecture/cockpit.md` is
updated to point at this ADR as the lifecycle source of truth.

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

## Implementation notes and risks (non-normative)

These are guidance for the mt#2241 implementation, not part of the decision:

- **Adoption detection.** Prefer attempting the daemon's own bind and treating an
  `EADDRINUSE` on `:3737` as "a daemon (or something) already owns the port", combined with a
  health probe (`GET /api/health`) to confirm it is _our_ daemon before adopting. Bind-failure
  alone proves the port is taken; the health probe disambiguates our daemon from an unrelated
  listener.
- **TOCTOU race.** There is a time-of-check/time-of-use gap between "probe says nothing is on
  `:3737`" and "we spawn". Two app instances (or app + launchd headless) launching
  concurrently could both decide to spawn. Mitigate by making the daemon's own startup bind
  authoritative (the loser gets `EADDRINUSE` and the app falls back to adopt), rather than
  relying on the pre-spawn probe as a lock. A user-level lockfile or single-instance guard on
  the app is a secondary defense.
- **Adopted vs spawned status source.** For a daemon the app spawned, derive status from the
  child process handle (plus health poll). For an adopted/external daemon, fall back to the
  health poll. Either way the poll must use a fresh connection per check (see mt#2225).
- **launchd coexistence.** The optional headless launchd mode and the app must honor the
  single-owner-of-`:3737` invariant: whichever binds first wins; the other adopts or defers.
  Running both in "spawn" mode simultaneously is the misconfiguration to guard against.

## Implementation note 2026-08-17 (mt#4205): the CLI path adopts the same predicate

**Not an amendment — nothing this ADR decides changes.** It records that a SECOND implementer now
follows the adoption rule above.

The "Implementation notes and risks" section prescribes pairing an `EADDRINUSE` with a health probe
to confirm the holder is ours, and the 2026-08-12 amendment's first bullet fixes what "ours" means
(an identity assertion, fail-closed on a missing `service`, with a non-2xx answer still counting as
ours). Until mt#4205 only the tray supervisor implemented that. The CLI's own guard —
`minsky cockpit start`, the launchd and manual paths this ADR keeps as the opt-in headless mode —
had independently arrived at a cruder answer: it classified the holder from a state file alone and
then REFUSED to displace it, so the one holder it could identify with certainty was the one it never
cleared.

`src/cockpit/port-recovery.ts` now mirrors `daemon_core.rs`'s `is_ours` on that path. The
single-owner invariant is unchanged; what changes is that both owners now resolve a contested port
the same way, rather than the CLI path answering it differently from the supervisor. Operator-facing
detail: `docs/architecture/cockpit.md` § _Port recovery: displacing a wedged incumbent_.

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

## Implementation amendment (gh#1761, 2026-06-29)

### Launchd plist: `--watch` removed, `ThrottleInterval` raised to 60

The plist generated by `generatePlist()` in `src/cockpit/launchd.ts` was updated
as part of gh#1761:

- **`--watch` removed.** `bun --watch` is a dev affordance that hot-reloads on
  source-file changes. In a supervised daemon it is a crash-loop amplifier: when
  the daemon restarts under `KeepAlive`, `--watch` starts watching source files
  again immediately and can trigger a second restart before the previous one has
  finished, creating a tight respawn loop. The plist now uses a plain `bun run`
  invocation with no `--watch`.

- **`ThrottleInterval` raised from 5 to 60.** The ADR's Context section documents
  the old value (`ThrottleInterval: 5`). The implementation ships with 60 s to
  give the DB circuit breaker time to recover between restarts, which reduces the
  risk of launchd hitting its restart-count ceiling under a sustained DB outage.
  Note: the cockpit daemon's own `unhandledRejection` handler now degrades
  gracefully for DB errors (staying up and retrying internally) rather than
  exiting, so `KeepAlive` restarts under normal circuit-breaker events should no
  longer occur — the raised ThrottleInterval is a defence-in-depth measure for
  genuinely fatal crashes.

### Legacy-agent eviction: PID-verification safety guard

The `run_supervisor()` function in `cockpit-tray/src-tauri/src/main.rs` evicts
the legacy launchd agent (`com.minsky.cockpit`) when a Conflict is detected at
port 3737. Before gh#1761, eviction was triggered solely by the agent being
loaded (`launchctl list` exit 0), which could clobber a legitimately-configured
agent that happens to share the label.

The `try_evict_legacy_launchd` function now requires a PID match before evicting:

1. It receives the port holder's PID from `lsof -ti tcp:3737` as `port_holder:
Option<u32>`. If the port holder is unknown (`None`), eviction is skipped.
2. It calls `launchctl list com.minsky.cockpit` to probe the agent and parses
   the agent's PID from the plist-style output via `parse_launchctl_pid()`.
3. Only if the launchd agent's PID matches the port holder's PID does it proceed
   with `launchctl bootout` + `launchctl disable`.

This ensures the eviction path is conservative: it only removes the launchd agent
when the agent is demonstrably the process holding the port.

## Amendment 2026-08-11: the port is resolved, not fixed

This ADR is written throughout in terms of a literal `:3737`, and the original
implementation took that literally: the tray pinned the port in four separate
constants (`supervisor.rs`'s `DAEMON_PORT` and `HEALTH_URL`, `menu.rs`'s
`COCKPIT_URL` and a hand-synced `COCKPIT_PORT` copy for the webview's
same-origin check), plus a fifth URL in `watcher_backend.rs`.

**mt#3988 replaces all five with one value resolved from the `cockpit.port`
configuration key** (default 3737, `MINSKY_COCKPIT_PORT` override, explicit
`--port` still wins), read once at tray startup from the same checkout the tray
spawns the daemon from — so the supervisor and the daemon cannot disagree about
which port they mean.

**Nothing about the decision this ADR records changes.** The tray is still the
canonical supervisor; launchd is still the optional headless path; the
single-owner invariant still holds. What changes is its SUBJECT: read every
`:3737` below as _the configured cockpit port_. Specifically, the invariant
"one daemon owns `:3737` at a time" is now "one daemon owns the configured port
at a time", and the warning that _"two lifecycle paths must not fight over
`:3737`"_ is what a hardcoded port silently defeated — an operator who moved the
daemon to another port got exactly the fight this ADR set out to prevent, with
the tray spawning a second daemon on 3737 beside it (2026-06-04; originally
misattributed to launchd coexistence in mt#2301, and traced to the hardcoded
port in mt#2427 → mt#3988).

Two consequences worth stating explicitly:

- The `EADDRINUSE`-based availability probe this ADR prescribes ("prefer
  attempting the daemon's own bind") is unchanged in kind — it now binds the
  resolved port.
- The tray resolves the port ONCE at launch. Changing `cockpit.port` under a
  running tray does not move it; quit and relaunch. This is deliberate: a port
  that could change under a live supervisor would reintroduce the same
  two-owners-two-ports state from the other direction.

## Amendment 2026-08-12: the supervisor owns a REGISTRY, not a daemon

This ADR is written throughout in terms of "the daemon", singular, and mt#2427
explicitly scoped multi-daemon supervision OUT. **ADR-038 §Question 3 lifts that
boundary, and mt#3815 implements it:** the tray supervises a registry of named
daemons, and the local MCP daemon (`minsky mcp start --local-daemon`, mt#3814)
is the second entry alongside the cockpit daemon.

**Every decision this ADR records still holds — now PER ENTRY.**
Spawn-as-managed-child, adopt-rather-than-double-spawn, respawn with throttle,
child stdio→log redirection, teardown on Quit, and single-owner-of-port are
unchanged in kind; each applies to each registered daemon and its own port.
Read "the daemon" below as "each registered daemon", and "the port" as "that
entry's port".

Three consequences are NOT mechanical restatements and are worth having here:

- **The health probe asserts an IDENTITY, not a status code.** ADR-014's
  adoption rule ("confirm it is our daemon before adopting") was implemented as
  a 2xx check, which cannot distinguish two Minsky services — they are built
  from the same monorepo and answer 200 identically (mt#3148, and mt#3142 is the
  incident). Each entry now carries the `service` value its health body must
  publish, and a missing field fails just as a wrong one does. The visible
  consequence is a Conflict status naming the port holder rather than a silent
  adoption of whatever answered.
- **An exit is CLASSIFIED, not assumed to be a crash.** mt#3814 gave the MCP
  daemon its own identity-asserting adopt-or-fail on `EADDRINUSE`, so a spawned
  daemon now has three intentional non-crash exits, two of them exit-0. The
  supervisor discriminates with a health re-probe: an exit-0 with an incumbent
  of ours serving means ADOPT (never respawn beside it); an exit-0 with nothing
  serving is a clean stop or mt#3764's ppid-transition self-exit, restored
  without counting toward the crash-loop accounting; a non-zero exit against a
  foreign listener surfaces a conflict rather than respawning into a port that
  will keep refusing.
- **The registered MCP entry is spawned with mt#3764's never-connected idle exit
  DISABLED.** That watcher self-terminates an HTTP-mode `mcp start` after 30
  minutes with no MCP session, and is armed whenever the process's startup ppid
  is not 1 — precisely the tray-spawned case. It exists to reap an _abandoned_
  listener, which is the condition supervision replaces; left armed it produces a
  30-minute exit/respawn cycle with a gap the operator lands in. mt#3764's OTHER
  watcher — parent-death on a ppid transition — stays armed, and is what makes
  "kill the tray and the daemon does not survive as an orphan" true.

Implementation: `cockpit-tray/src-tauri/src/supervisor/registry.rs` (the entries),
`supervisor/daemon_core.rs` (the mechanism, mt#3990), `supervisor.rs` (the
per-daemon policy). ADR-038 §Question 2's decision that the two daemons stay
SEPARATE PROCESSES is inherited unchanged — this is one supervisor of two
processes, not one merged process.
