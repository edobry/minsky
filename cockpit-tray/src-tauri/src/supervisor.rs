// Daemon supervisor: spawn/detect/kill/health-poll, the self-health watchdog
// (mt#2578), and the process-management + repo/PATH-resolution primitives it's
// built from. Owns `Sup`, the mutable state driven by `run_supervisor` on its
// own OS thread, and the menu-item handles the supervisor pushes status text
// to (constructed by `menu::build`). Split out of main.rs (mt#2628); see
// docs/architecture/adr-014-cockpit-daemon-lifecycle-ownership.md.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant, SystemTime};

use tauri::menu::MenuItem;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::mpsc;

use crate::launchd::try_evict_legacy_launchd;
use crate::port::cockpit_port;
use crate::watcher_backend::{
    cockpit_backend_root, cockpit_backend_roots, newest_backend_mtime_across, start_backend_watcher,
};
use crate::watcher_web::{
    cockpit_source_root, cockpit_web_src, format_hms_utc, preflight_rebuild, reload_cockpit_window,
    report_build_result, run_cockpit_build, set_build_status, should_reload_after_build,
    start_web_watcher, PreflightResult,
};

// The supervised port is no longer a constant (mt#3988): it is resolved once at
// startup by `crate::port::init` and read here via `cockpit_port()`, so the tray
// supervises whatever port the daemon is configured to serve on. The health URL
// is composed from that value and the entry's own health PATH by
// `daemon_core::probe_health` (mt#3815).
/// The daemon-agnostic supervision core (mt#3990). Everything in here would be
/// identical for any supervised local daemon; this file is the COCKPIT policy
/// layer that drives it. ADR-038 §Question 3's registry (mt#3815) consumes the
/// core directly rather than going through this file.
pub(crate) mod daemon_core;

/// The registry itself (mt#3815): which daemons exist, their identity strings,
/// and how each is spawned. `daemon_core` is the mechanism, this file is the
/// per-daemon policy, and `registry` is the data both are driven by.
pub(crate) mod registry;

pub(crate) use registry::DaemonId;

// Only what the cockpit policy layer actually calls. `should_takeover_adopted`,
// `status_label`, `ADOPTED_TAKEOVER_POLL_THRESHOLD`, `augmented_path`,
// `last_nonempty_capped` and the `lsof`/`parse_*`/`is_executable` internals are
// deliberately absent: the core reaches them itself, and this layer's only
// users of them were the tests that moved with them (mt#3990).
//
// Several of these are re-exported rather than merely used here, because
// `main.rs`, `port.rs` and `watcher_web.rs` reach them as `supervisor::<name>`
// and the extraction must not churn their import lists — `path_env`,
// `resolve_program`, `open_log`, `teardown` and `SpawnedPgid` all keep working
// at their old paths.
use daemon_core::daemon_labels;

pub(crate) use daemon_core::{
    breaches_ceiling, classify_exit, daemon_memory_bytes, daemon_start_time, decide_action,
    format_duration, handle_health_down_no_child, kill_group, kill_pid, kill_pid_force,
    log_tail_last_line, open_log, path_env, pid_on_port, port_holder, port_in_use, probe_health,
    record_spawned, resolve_program, spawn_daemon, take_spawned, teardown, throttle_ok,
    DaemonAction, DaemonLabels, DaemonSpawnSpec, ExitClass, NoChildCounters, NoChildEffect,
    SpawnedPgids, SupervisedDaemon, ALERT_COOLDOWN, HTTP_FAILURE_POLL_THRESHOLD,
    MEMORY_CEILING_BYTES, POLL_INTERVAL, RESPAWN_THROTTLE, RESTART_STORM_THRESHOLD,
    RESTART_STORM_WINDOW,
};

/// The cockpit daemon's health endpoint and the identity its body must carry.
///
/// `/api/health` is the cockpit's path (the MCP daemon's is `/health`), and
/// `minsky-cockpit` is its `service` value — asserted rather than inferred from
/// the status code, per mt#3148. Both are per-daemon registry data now, so they
/// sit beside `COCKPIT_LABELS` rather than inside the supervision core.
pub(crate) const COCKPIT_HEALTH_PATH: &str = "/api/health";
pub(crate) const COCKPIT_SERVICE: &str = "minsky-cockpit";

/// Consecutive health polls reporting the daemon cannot serve DB-backed work,
/// before this watchdog acts.
///
/// At POLL_INTERVAL = 5s → 24 polls ≈ 2 min (spec requirement: "DB degraded > 2
/// min"). Grounded in the poll cadence rather than a round number of seconds,
/// which is also what makes it robust: change POLL_INTERVAL and the wall-clock
/// bound moves with it rather than silently meaning something else.
///
/// **A single degraded poll is common and self-clears** — observed live
/// 2026-08-24T23:58Z, cockpit daemon at `db: "degraded"` with
/// `consecutiveDegraded: 1`, back to `ok` within 30s with no recycle and no
/// intervention. A threshold of 1 would have restarted a daemon that was about
/// to recover by itself, which is why this is 24 and not a smaller number.
///
/// No longer policy-layer state (mt#4472): it applied only to the cockpit
/// because "only the cockpit daemon's health body carries a `db` field at all",
/// and mt#4471 gave the MCP daemon `db` and `ready`.
const NOT_READY_POLL_THRESHOLD: u32 = 24;

/// Minimum gap between two not-ready RESTARTS of the same entry (mt#4472).
///
/// The threshold above bounds how long a daemon must be unserving before the
/// FIRST restart. This bounds the second: after a restart, the counter resets
/// and has to climb again, so the natural floor is already ~2 min — but only
/// while the restart actually takes effect. A daemon that comes back and is
/// immediately unserving again (the database itself being down, which a restart
/// cannot fix — the spec's `## Does NOT cover`) would otherwise re-restart on
/// that same 2-minute cadence indefinitely.
///
/// 10 min = 5x the detection threshold: long enough that a restart-cannot-fix
/// condition costs at most ~6 restarts an hour rather than ~30, and short
/// enough that a genuinely wedged daemon is not left unserving for a working
/// session. The restart-storm watchdog (`RESTART_STORM_THRESHOLD` over
/// `RESTART_STORM_WINDOW`) is the second, independent backstop and alerts the
/// principal when restarts cluster regardless of which path triggered them.
const NOT_READY_RESTART_COOLDOWN: Duration = Duration::from_secs(600);

/// The cockpit daemon's contribution to the supervision core's string seam
/// (mt#3990). Registering a second daemon means adding a second value of this
/// type, not editing `daemon_core`.
/// The cockpit daemon's labels, from its name written once (mt#4233).
///
/// The name was `"Cockpit"` until then. Bare, it read as the APP — it is also
/// the product name, the window title, the tray tooltip and the quit item —
/// while the sibling entry read "MCP daemon", so a menu asked "which one is the
/// daemon?" answered with the wrong one. Operator's call, ask#9153, answered
/// 2026-08-22 ("Cockpit daemon / MCP daemon", no role gloss).
pub(crate) const COCKPIT_LABELS: DaemonLabels = daemon_labels!(
    "Cockpit daemon",
    "~/.local/state/minsky/logs/cockpit-stderr.log"
);

/// Daemon status line while a pre-flight bundle rebuild runs before spawn (mt#2297).
///
/// The one cockpit status line OUTSIDE `DaemonLabels` — nothing else has a web
/// bundle — so it is the single place the name literal is still written twice.
/// `concat!` takes literal TOKENS, not `const` idents, so it cannot be spliced
/// from `COCKPIT_LABELS.display_name`; `every_cockpit_status_line_carries_the_daemon_name`
/// pins the two together instead, and fails if a rename touches only one.
pub(crate) const LABEL_BUILDING: &str = "Cockpit daemon: rebuilding bundle...";
// `LABEL_RUNNING` / `LABEL_STOPPED` / `LABEL_STARTING` lived here until mt#4233.
// They are now generated by `daemon_labels!` from the name above, so the cockpit
// declares its name once rather than once per status line.
//
// `LABEL_START_FAILED` / `LABEL_NO_REPO` / `LABEL_NO_BUN` lived here until
// mt#3815. They are now rendered by `failure_label` from the entry's own
// `display_name`, so each daemon's failures are attributed to it rather than
// all reading "Cockpit:".

/// The cockpit daemon's log filenames within the shared daemon log directory
/// (`daemon_core::open_log` resolves the directory). Named once so the spawn's
/// stderr redirection and `daemon_error_tail`'s read cannot drift apart — before
/// mt#3990 each spelled the string out independently.
const COCKPIT_STDOUT_LOG: &str = "cockpit-stdout.log";
const COCKPIT_STDERR_LOG: &str = "cockpit-stderr.log";

/// Handles to the PER-DAEMON dropdown lines, stored in Tauri managed state so
/// the supervisor loop can update their text directly.
///
/// The menu is attached to the TRAY (`TrayIconBuilder::menu(&menu)`), not to the
/// app, so `app.menu()` returns `None`. Holding the item handles is the reliable
/// path (mt#2240). Constructed by `menu::build`.
///
/// Was a pair of singletons (`StatusMenuItem` / `UptimeMenuItem`) until mt#3815:
/// one status line and one uptime line existed because one daemon did. A `Vec`
/// keyed by [`DaemonId`] rather than a map — the registry has two entries and a
/// linear scan of two is not worth a hash.
pub(crate) struct DaemonMenuItems {
    pub(crate) status: Vec<(DaemonId, MenuItem<Wry>)>,
    pub(crate) uptime: Vec<(DaemonId, MenuItem<Wry>)>,
}

impl DaemonMenuItems {
    fn status_for(&self, id: DaemonId) -> Option<&MenuItem<Wry>> {
        self.status.iter().find(|(d, _)| *d == id).map(|(_, i)| i)
    }

    fn uptime_for(&self, id: DaemonId) -> Option<&MenuItem<Wry>> {
        self.uptime.iter().find(|(d, _)| *d == id).map(|(_, i)| i)
    }
}

/// Handle to the build-status dropdown `MenuItem` (mt#2297), held in managed
/// state so the supervisor loop can update it directly. Constructed by
/// `menu::build`.
///
/// Stays a SINGLETON where the status and uptime lines became per-daemon: only
/// the cockpit has a web bundle to build, so a per-entry build line would be a
/// permanently-empty row for every other daemon (mt#3815).
pub(crate) struct BuildMenuItem(pub(crate) MenuItem<Wry>);

/// Sender for lifecycle commands from the (main-thread) menu handler to the
/// supervisor thread that owns the daemon `Child`.
pub(crate) struct SupervisorHandle(pub(crate) mpsc::UnboundedSender<SupervisorCmd>);

/// A lifecycle command, addressed to ONE registry entry (mt#3815).
///
/// `Shutdown` and `Rebuild` carry no [`DaemonId`] for opposite reasons:
/// shutdown is global (quitting the tray tears down everything it spawned), and
/// rebuild is cockpit-only (nothing else has a web bundle).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SupervisorCmd {
    Start(DaemonId),
    Stop(DaemonId),
    /// Restart with no operator behind it: the internal port-conflict retry
    /// paths above, and the `AutoRestart` background task's re-send once the
    /// turn-active gate clears. Never gated on driven-session turn activity
    /// itself — the gate lives on `AutoRestart`, which re-sends this once it
    /// passes. Never notifies: a source-change auto-restart fires on every save
    /// now that mt#4230 widened the watcher root, and a toast per save is noise.
    /// Contrast `OperatorRestart` below and `AutoRestart` further down.
    Restart(DaemonId),
    /// The tray menu's "Restart" leaf, and ONLY that (mt#4233).
    ///
    /// Mechanically identical to `Restart` — it delegates to the same
    /// `restart_entry` — but a DISTINCT variant, because the handler otherwise
    /// cannot tell an operator click from a watcher fire: `AutoRestart` re-sends
    /// `Restart` through this same channel, so hanging the notification off the
    /// `Restart` arm would toast on every watcher restart as well.
    ///
    /// It exists because success was silent. Every other tray notification fires
    /// on FAILURE, so a restart that hit the WRONG daemon was observationally
    /// identical to one that worked — which is what turned the 2026-08-17
    /// mis-click into a false "the restart mechanism is broken" investigation,
    /// including a subagent dispatched on that premise. The mis-click itself was
    /// nearly free; the silence is what made it expensive.
    OperatorRestart(DaemonId),
    /// Automatic restart triggered by a backend-source change
    /// (`watcher_backend::start_backend_watcher`, mt#2299). Gated by the
    /// mt#3048 turn-active check (RFC "Conversation-first drive" Phase 1
    /// slice 6): if a driven session's turn is actively streaming, the
    /// restart is deferred for a bounded grace period
    /// (`watcher_backend::wait_for_turn_idle_or_grace_expiry`) before
    /// proceeding anyway — never indefinitely. Handled as a NON-BLOCKING
    /// dispatch (mt#3048 R2 fix): the gate wait runs on a spawned background
    /// task, not inline in the `run_supervisor` select loop, so it never
    /// blocks Start/Stop/Restart/Shutdown/Rebuild or the watchdog poll arm
    /// — see the `AutoRestart` match arm's own comment for why. The task
    /// re-sends the operator-explicit `Restart` once ready, so the actual
    /// stop/spawn always runs on the main loop via the `Restart` arm.
    ///
    /// Known minor edge case, intentionally NOT addressed: a SECOND burst of
    /// backend-source edits arriving DURING a deferred wait debounces
    /// independently and spawns its OWN background task/eventual `Restart`
    /// send, which lands shortly after the first — a harmless extra restart
    /// of an already-just-restarted daemon, not a correctness bug (the
    /// mt#3038 resume machinery recovers it the same way either restart
    /// would). Coalescing this would need tracking "a wait is already in
    /// flight" shared state across tasks for marginal benefit; left as a
    /// documented, low-risk simplification.
    ///
    /// Cockpit-only in practice — it is dispatched by the cockpit's backend
    /// source watcher — but carries the id like its siblings so the turn-active
    /// gate stays one mechanism if a future entry ever needs it.
    AutoRestart(DaemonId),
    Shutdown,
    /// A cockpit-web source file changed at runtime — rebuild the bundle
    /// without disturbing the running daemon (mt#2297).
    Rebuild,
}

// ---------------------------------------------------------------------------
// Minsky-installation resolution (cockpit policy).
//
// The PATH/program/port/process primitives these sit beside used to live here
// too; they moved to `daemon_core` (mt#3990). What stays is the part that knows
// it is resolving a MINSKY repo for the COCKPIT daemon: the per-user
// `com.minsky.cockpit` launchd plist, and the `src/cli.ts` source-entry shape
// the cockpit is spawned from.
// ---------------------------------------------------------------------------

/// Non-empty `$HOME`, or `None`. Used where an empty HOME must NOT degrade to a
/// relative/system path (e.g. resolving the per-user launchd plist).
fn home_dir() -> Option<String> {
    match std::env::var("HOME") {
        Ok(h) if !h.is_empty() => Some(h),
        _ => None,
    }
}

/// A directory is a usable source-spawn root if it contains `src/cli.ts` — the
/// daemon is spawned as `bun run src/cli.ts ...` from here.
fn has_cli_source(p: &Path) -> bool {
    p.join("src/cli.ts").exists()
}

/// Given the canonicalized `minsky` bin path, derive the repo root — but only
/// when it has the expected `<repo>/scripts/cli-entry.ts` shape. Returns `None`
/// for any other shape so a system-installed `minsky` (e.g. `/usr/local/bin/minsky`)
/// can't mis-resolve `/usr/local` as a "repo root". Pure path arithmetic.
fn repo_root_from_bin_path(real: &Path) -> Option<PathBuf> {
    if real.file_name()? != "cli-entry.ts" {
        return None;
    }
    let scripts = real.parent()?;
    if scripts.file_name()? != "scripts" {
        return None;
    }
    scripts.parent().map(|p| p.to_path_buf())
}

/// Read `WorkingDirectory` from the daemon's launchd plist (written by
/// `minsky cockpit install`), if present — the user-configured repo root. Returns
/// `None` when `$HOME` is unset/empty so we never fall back to a system-level
/// `/Library/LaunchAgents` plist.
fn repo_root_from_launchd_plist(path: &str) -> Option<PathBuf> {
    let home = home_dir()?;
    let plist = Path::new(&home).join("Library/LaunchAgents/com.minsky.cockpit.plist");
    if !plist.exists() {
        return None;
    }
    let plutil =
        resolve_program("plutil", path).unwrap_or_else(|| PathBuf::from("/usr/bin/plutil"));
    let out = Command::new(plutil)
        .args([
            "-extract",
            "WorkingDirectory",
            "raw",
            "-o",
            "-",
            plist.to_str()?,
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(PathBuf::from(s))
    }
}

/// Resolve the Minsky repo root the spawned daemon must run in. The daemon is
/// started as `bun run src/cli.ts cockpit start` (source, matching the launchd
/// plist — the `minsky` bundle has a web-bundle path bug, mt#2283), and minsky's
/// git-based repo-backend detection runs in the cwd, so a GUI app launched from
/// /Applications (cwd `/`) would otherwise fail (mt#2282). Sources, in order:
///   1. the launchd plist's `WorkingDirectory` (explicit user config)
///   2. the canonicalized `minsky` bin symlink: `<repo>/scripts/cli-entry.ts` -> `<repo>`
/// Each candidate must contain `src/cli.ts` (`has_cli_source`).
pub(crate) fn resolve_repo_root(path: &str) -> Option<PathBuf> {
    if let Some(root) = repo_root_from_launchd_plist(path) {
        if has_cli_source(&root) {
            return Some(root);
        }
    }
    if let Some(minsky) = resolve_program("minsky", path) {
        if let Ok(real) = std::fs::canonicalize(&minsky) {
            if let Some(repo) = repo_root_from_bin_path(&real) {
                if has_cli_source(&repo) {
                    return Some(repo);
                }
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Supervisor thread.
// ---------------------------------------------------------------------------

/// Mutable state owned by the supervisor loop: the COCKPIT daemon's supervision
/// state, plus the cockpit-only policy state that rides alongside it.
///
/// The split is mt#3990's: everything generic — the child, the spawn/status/
/// uptime bookkeeping, and the whole self-health watchdog — lives on
/// [`SupervisedDaemon`] in `daemon_core`, which is the record mt#3815's registry
/// holds N of. What stays HERE is the four fields that would mean nothing for a
/// second daemon: a bundle-build label (only the cockpit has a web bundle), the
/// backend-source mtime the adoption decision compares against (only the cockpit
/// has a watched source tree), and the `db`-degraded counter and its alert
/// cooldown (only the cockpit's `/api/health` publishes a `db` field).
pub(crate) struct Sup {
    /// Which registry entry this is.
    pub(crate) id: DaemonId,
    /// This entry's supervised daemon, in the core's terms.
    pub(crate) daemon: SupervisedDaemon,
    /// What this daemon needs beyond generic supervision. The cockpit has a
    /// lot; the MCP daemon has none, which is the whole reason the split exists.
    pub(crate) policy: DaemonPolicy,
}

/// The per-daemon policy layer (mt#3815).
///
/// A closed enum rather than `Box<dyn DaemonPolicy>`: the set is closed at two
/// (see `registry::DaemonId`), the match arms make every per-daemon difference
/// visible at the call site instead of scattering it across impls, and it costs
/// no allocation or dynamic dispatch in a 5s poll loop.
pub(crate) enum DaemonPolicy {
    Cockpit(CockpitPolicy),
    /// The MCP daemon carries no policy state at all: no bundle to build, no
    /// watched source tree, and a health body with no `db` field. Its entry is
    /// the generic core and nothing else — which is the property mt#3990's
    /// extraction claimed and this variant demonstrates.
    Mcp,
}

/// The four fields that mean nothing for any daemon but the cockpit. They were
/// fields of `Sup` itself until mt#3815; a second entry would have inherited a
/// build label and a `db` counter that do not apply to it.
pub(crate) struct CockpitPolicy {
    /// Last value pushed to the build-status menu line (mt#2297), for dedupe.
    pub(crate) last_build_label: Option<String>,
    /// Newest backend-source mtime at the moment the daemon was (re)started — the
    /// "source version" the running daemon reflects (mt#2299).
    pub(crate) daemon_source_mtime: Option<SystemTime>,
    // mt#4472 moved `consecutive_db_degraded` and `last_db_alert` out of here
    // and onto `SupervisedDaemon`. They were cockpit-only because the cockpit
    // was the only entry publishing a readiness signal; it no longer is.
}

impl Sup {
    /// A registry entry for `id`, with every piece of supervision state at its
    /// "nothing has happened" value.
    fn new(id: DaemonId, daemon: SupervisedDaemon, policy: DaemonPolicy) -> Self {
        Self { id, daemon, policy }
    }

    /// The cockpit policy state, or `None` for any other entry.
    ///
    /// Every cockpit-only behavior routes through this rather than through an
    /// `if id == Cockpit` check: the `None` arm is then the compiler's problem
    /// at each site, not a convention.
    pub(crate) fn cockpit_mut(&mut self) -> Option<&mut CockpitPolicy> {
        match &mut self.policy {
            DaemonPolicy::Cockpit(p) => Some(p),
            DaemonPolicy::Mcp => None,
        }
    }

    /// The source mtime the running daemon reflects, if this entry tracks one.
    /// Only the cockpit does — it is the only entry with a watched source tree.
    fn source_mtime(&self) -> Option<SystemTime> {
        match &self.policy {
            DaemonPolicy::Cockpit(p) => p.daemon_source_mtime,
            DaemonPolicy::Mcp => None,
        }
    }

    fn set_source_mtime(&mut self, mtime: Option<SystemTime>) {
        if let Some(p) = self.cockpit_mut() {
            p.daemon_source_mtime = mtime;
        }
    }
}

/// Update the visible status label (this daemon's dropdown line, plus the tray
/// tooltip for the cockpit), skipping the UI round-trip when the label hasn't
/// changed.
pub(crate) fn set_status(app: &AppHandle, sup: &mut Sup, label: &str) {
    if sup.daemon.last_status.as_deref() == Some(label) {
        return;
    }
    sup.daemon.last_status = Some(label.to_string());
    let _ = update_status(app, sup.id, label);
}

fn update_status(app: &AppHandle, id: DaemonId, label: &str) -> tauri::Result<()> {
    // Marshal the UI mutation onto the main thread (AppKit menu/tray mutations
    // want the main thread). The status items live in managed state because the
    // menu is attached to the tray, not app.menu() (mt#2240).
    let app_handle = app.clone();
    let label = label.to_string();
    app.run_on_main_thread(move || {
        if let Some(items) = app_handle.try_state::<DaemonMenuItems>() {
            if let Some(item) = items.status_for(id) {
                let _ = item.set_text(&label);
            }
        }
        // The tooltip is single-valued and the tray is "Minsky Cockpit", so it
        // keeps tracking the cockpit entry. A tooltip that flipped between two
        // daemons' states on whichever polled last would be worse than one that
        // answers a fixed question.
        if id == DaemonId::Cockpit {
            if let Some(tray) = app_handle.tray_by_id("main") {
                let _ = tray.set_tooltip(Some(&label));
            }
        }
    })
}

/// The cockpit daemon's argv, minus the program itself (mt#3990).
///
/// This is the entirety of what used to be hardcoded inside `spawn_daemon`'s
/// body. Splitting it out both feeds `DaemonSpawnSpec` and makes the arguments
/// checkable without spawning anything — which is what pins the extraction's
/// behavior-preservation claim for the spawn path.
///
/// `bun run src/cli.ts cockpit start` is the SOURCE entry, matching the launchd
/// plist: the `minsky` bundle has a web-bundle path bug (mt#2283), and minsky's
/// git-based repo-backend detection runs in the cwd (mt#2282). The resolved port
/// is passed as an explicit `--port`, which outranks the daemon's own
/// `cockpit.port` lookup (mt#3988) — deliberate, since the two read the same
/// configuration and so agree, and passing it explicitly means the daemon serves
/// the port the tray is about to supervise even if configuration changes
/// underneath a long-running tray.
fn cockpit_spawn_args(port: u16) -> Vec<String> {
    vec![
        "run".to_string(),
        "src/cli.ts".to_string(),
        "cockpit".to_string(),
        "start".to_string(),
        "--no-dev-chromium".to_string(),
        "--port".to_string(),
        port.to_string(),
    ]
}

/// The argv, log filenames and extra environment for ONE registry entry.
///
/// The dispatch that turns a `DaemonId` into "what process do I actually run".
/// Every arm's data lives with its daemon — the cockpit's here, the MCP
/// daemon's in `registry` — so this function is the only place that needs to
/// know both exist.
fn spawn_plan(
    sup: &Sup,
) -> (
    Vec<String>,
    &'static str,
    &'static str,
    &'static [(&'static str, &'static str)],
) {
    match sup.id {
        DaemonId::Cockpit => (
            cockpit_spawn_args(sup.daemon.port),
            COCKPIT_STDOUT_LOG,
            COCKPIT_STDERR_LOG,
            // The cockpit daemon needs no environment beyond PATH.
            &[],
        ),
        DaemonId::Mcp => (
            registry::mcp_spawn_args(),
            registry::MCP_STDOUT_LOG,
            registry::MCP_STDERR_LOG,
            &registry::MCP_SPAWN_ENV,
        ),
    }
}

/// A failure label for this entry, in its own name. The cockpit's renderings
/// are byte-identical to the constants these replaced (`display_name` is
/// `"Cockpit"`), so nothing an operator sees for the cockpit changed.
fn failure_label(sup: &Sup, what: &str) -> String {
    format!("{}: {what}", sup.daemon.labels.display_name)
}

fn do_spawn(app: &AppHandle, sup: &mut Sup, spawned: &SpawnedPgids, path: &str) {
    let bun = match resolve_program("bun", path) {
        Some(b) => b,
        None => {
            eprintln!(
                "[cockpit-tray] bun not found on PATH — cannot spawn the {}",
                sup.daemon.labels.display_name
            );
            let label = failure_label(sup, "bun not found");
            set_status(app, sup, &label);
            // No running child results from this path — don't leave a prior
            // daemon's uptime line visible (mt#2299, reviewer R1 B2).
            clear_uptime(app, sup);
            return;
        }
    };
    let repo_root = match resolve_repo_root(path) {
        Some(r) => r,
        None => {
            eprintln!(
                "[cockpit-tray] could not resolve Minsky repo root with src/cli.ts — refusing to spawn into a crash cwd (run `minsky cockpit install` or link the minsky bin)"
            );
            let label = failure_label(sup, "repo not found");
            set_status(app, sup, &label);
            clear_uptime(app, sup);
            return;
        }
    };
    // mt#2297: source-gated pre-flight rebuild. Only when the web source is
    // present (developer/source operator); a no-source install skips this and
    // serves whatever bundle ships with the app. Cockpit-only policy — the
    // `cockpit_mut()` guard is what keeps it from running for an entry with no
    // bundle (mt#3815).
    if sup.cockpit_mut().is_some() && cockpit_web_src(&repo_root).is_dir() {
        if let PreflightResult::Refuse = preflight_rebuild(app, sup, &bun, &repo_root, path) {
            let label = failure_label(sup, "start failed (see logs)");
            set_status(app, sup, &label);
            clear_uptime(app, sup);
            return;
        }
    }
    let (args, stdout_log, stderr_log, extra_env) = spawn_plan(sup);
    match spawn_daemon(&DaemonSpawnSpec {
        program: &bun,
        args: &args,
        cwd: &repo_root,
        path_env: path,
        stdout_log,
        stderr_log,
        extra_env,
    }) {
        Ok((child, pid)) => {
            // A fresh child has not breached anything (mt#4105). Clearing here
            // rather than only on the exit path means no route into a new child
            // can inherit the previous one's verdict.
            sup.daemon.killed_for_ceiling = false;
            sup.daemon.child = Some(child);
            sup.daemon.last_spawn = Some(Instant::now());
            // mt#2299: a fresh tray-spawn is current as of now; record the
            // wall-clock start + the backend-source version it reflects so the
            // uptime line can render "running Xs, started against src @ HH:MM:SS".
            // Gate the source-mtime capture on the BACKEND source root, not the
            // web root (reviewer R1 B1). `set_source_mtime` is a no-op for an
            // entry with no watched source tree.
            sup.daemon.daemon_started_at = Some(SystemTime::now());
            let mtime = cockpit_backend_root(path)
                .and_then(|r| newest_backend_mtime_across(&cockpit_backend_roots(&r)));
            sup.set_source_mtime(mtime);
            record_spawned(spawned, sup.id.slug(), pid);
            let starting = sup.daemon.labels.starting;
            set_status(app, sup, starting);
        }
        Err(e) => {
            eprintln!(
                "[cockpit-tray] {} spawn failed: {e}",
                sup.daemon.labels.display_name
            );
            let label = failure_label(sup, "start failed (see logs)");
            set_status(app, sup, &label);
            clear_uptime(app, sup);
        }
    }
}

/// Stop the running daemon. If we spawned it, kill our process group. If it was
/// ADOPTED (our health endpoint answers), kill the PID on the port. A foreign
/// listener (port in use but NOT our daemon) is never killed: `adopted_ok` must
/// be true for the port-owner kill path. Callers compute `adopted_ok` from a
/// fresh health probe so a conflict (someone else on the supervised port) is
/// left untouched.
fn do_stop(sup: &mut Sup, spawned: &SpawnedPgids, path: &str, adopted_ok: bool) {
    let port = sup.daemon.port;
    if let Some(mut child) = sup.daemon.child.take() {
        // Only THIS entry's process group — the other registered daemon's is
        // left alone (AT2: killing one must not touch the other).
        let pgid = take_spawned(spawned, sup.id.slug());
        #[cfg(unix)]
        if let Some(pgid) = pgid {
            kill_group(pgid);
        }
        let _ = child.kill();
        let _ = child.wait();
    } else if adopted_ok {
        if let Some(pid) = pid_on_port(port, path) {
            kill_pid(pid);
        }
    }
}

// `health_ok(client, port)` lived here: a bare 2xx check against the cockpit's
// endpoint. mt#3815 replaced it with `entry_is_ours`, which asks the same
// question PER ENTRY and asserts the `service` identity rather than the status
// code. The widening matters because the tray acts on the answer by adopting,
// restarting, or SIGTERMing the port holder, and every Minsky service is built
// from the same monorepo and answers 200 the same way (mt#3148/mt#3142).

/// Build the registry: one [`Sup`] per [`DaemonId`], in menu order.
///
/// This is where ADR-038 §Question 3's "registry of named daemons" is actually
/// a registry: the supervisor below iterates whatever this returns, and adding a
/// third daemon is adding a variant plus an arm here.
fn build_registry() -> Vec<Sup> {
    DaemonId::ALL
        .into_iter()
        .map(|id| match id {
            DaemonId::Cockpit => Sup::new(
                id,
                // The port is read once, here, so every probe, spawn, adoption
                // decision and label for this entry provably refers to the same
                // one (mt#3988).
                SupervisedDaemon::new(
                    COCKPIT_LABELS,
                    cockpit_port(),
                    COCKPIT_HEALTH_PATH,
                    COCKPIT_SERVICE,
                ),
                DaemonPolicy::Cockpit(CockpitPolicy {
                    last_build_label: None,
                    daemon_source_mtime: None,
                }),
            ),
            DaemonId::Mcp => Sup::new(
                id,
                SupervisedDaemon::new(
                    registry::MCP_LABELS,
                    registry::MCP_PORT,
                    registry::MCP_HEALTH_PATH,
                    registry::MCP_SERVICE,
                ),
                DaemonPolicy::Mcp,
            ),
        })
        .collect()
}

fn entry_mut(entries: &mut [Sup], id: DaemonId) -> Option<&mut Sup> {
    entries.iter_mut().find(|s| s.id == id)
}

/// Whether this entry's daemon is answering AND identifies itself as the one we
/// expect. The single question every lifecycle decision below is built on.
async fn entry_is_ours(client: &reqwest::Client, sup: &Sup) -> bool {
    probe_health(client, sup.daemon.port, sup.daemon.health_path)
        .await
        .is_ours(sup.daemon.expected_service)
}

/// Adopt a health-confirmed daemon of ours: monitor it rather than spawn beside
/// it, restarting first if this entry's policy says the running one is stale.
async fn adopt_running(app: &AppHandle, sup: &mut Sup, spawned: &SpawnedPgids, path: &str) {
    match adopt_decision(sup, path) {
        AdoptDecision::Stale => {
            // Adopted daemon predates the current backend source (the
            // 2026-06-04 8-day-stale case) — restart it (kill the
            // health-confirmed daemon, respawn fresh) so new widget
            // registrations / routes load before we report ready (mt#2299).
            do_stop(sup, spawned, path, true);
            tokio::time::sleep(Duration::from_millis(500)).await;
            do_spawn(app, sup, spawned, path);
        }
        AdoptDecision::Fresh {
            started,
            source_mtime,
        } => {
            sup.daemon.daemon_started_at = started;
            sup.set_source_mtime(source_mtime);
            let running = sup.daemon.labels.running;
            set_status(app, sup, running);
            refresh_uptime(app, sup);
        }
    }
}

/// Adopt-or-spawn-or-surface-a-conflict for ONE entry. The boot path and the
/// explicit Start command are the same decision, so they are the same function
/// (before mt#3815 the two were copy-pasted, eviction retry and all).
async fn bring_up(
    app: &AppHandle,
    sup: &mut Sup,
    spawned: &SpawnedPgids,
    path: &str,
    client: &reqwest::Client,
) {
    let port = sup.daemon.port;
    match decide_action(entry_is_ours(client, sup).await, port_in_use(port)) {
        DaemonAction::Adopt => adopt_running(app, sup, spawned, path).await,
        DaemonAction::Conflict => {
            // gh#1761: before showing "conflict" to the operator, check if the
            // port holder is the legacy `com.minsky.cockpit` launchd agent
            // (installed by `minsky cockpit install`). If so, evict it (bootout
            // + disable) and retry — ADR-014 single-ownership.
            //
            // Cockpit-only, and not merely by convention: the plist it evicts is
            // the COCKPIT daemon's, so running it for another entry would take a
            // legacy cockpit agent down because something unrelated found its
            // own port busy.
            let evicted =
                sup.id == DaemonId::Cockpit && try_evict_legacy_launchd(pid_on_port(port, path));
            if evicted {
                // Give the OS ~1 s to release the port, then re-check.
                tokio::time::sleep(Duration::from_secs(1)).await;
                match decide_action(entry_is_ours(client, sup).await, port_in_use(port)) {
                    DaemonAction::Adopt => adopt_running(app, sup, spawned, path).await,
                    DaemonAction::Conflict => {
                        // Still blocked even after eviction — show label.
                        report_conflict(app, sup, path);
                        clear_uptime(app, sup);
                    }
                    DaemonAction::Spawn => do_spawn(app, sup, spawned, path),
                }
            } else {
                report_conflict(app, sup, path);
                clear_uptime(app, sup);
            }
        }
        DaemonAction::Spawn => do_spawn(app, sup, spawned, path),
    }
}

/// Stop one entry's daemon, leaving a foreign listener on its port untouched.
async fn stop_entry(
    app: &AppHandle,
    sup: &mut Sup,
    spawned: &SpawnedPgids,
    path: &str,
    client: &reqwest::Client,
) {
    let port = sup.daemon.port;
    let had_child = sup.daemon.child.is_some();
    let h = entry_is_ours(client, sup).await;
    do_stop(sup, spawned, path, h);
    if !had_child && !h && port_in_use(port) {
        // A foreign process owns the port — we didn't (and won't) kill it.
        report_conflict(app, sup, path);
    } else {
        let stopped = sup.daemon.labels.stopped;
        set_status(app, sup, stopped);
    }
    clear_uptime(app, sup);
}

/// Restart one entry's daemon, refusing to restart over a foreign listener.
async fn restart_entry(
    app: &AppHandle,
    sup: &mut Sup,
    spawned: &SpawnedPgids,
    path: &str,
    client: &reqwest::Client,
) {
    let port = sup.daemon.port;
    let h = entry_is_ours(client, sup).await;
    if sup.daemon.child.is_none() && !h && port_in_use(port) {
        // Foreign listener owns the port — refuse to restart over it.
        report_conflict(app, sup, path);
    } else {
        do_stop(sup, spawned, path, h);
        tokio::time::sleep(Duration::from_millis(500)).await;
        do_spawn(app, sup, spawned, path);
    }
}

/// What the supervisor does after one of its own children exits, per
/// `daemon_core::classify_exit`.
///
/// The two exit-0 classes are why this is a `match` rather than "respawn on
/// exit" (mt#3814): an adopt-race exit means something of ours already serves
/// the port, and respawning would put a second daemon beside it.
///
/// **`CleanStop` still respawns**, and deliberately: the spec's amendment table
/// says a ppid-transition self-exit must not be treated "as a crash-loop
/// signal", which is about the THROTTLE ACCOUNTING, not about abandoning the
/// daemon. A supervisor that stopped restoring a daemon because it exited
/// tidily would have stopped supervising it. What `CleanStop` skips is the
/// restart-storm timestamp, so a tidy exit never contributes to a crash-loop
/// alert.
async fn handle_child_exit(
    app: &AppHandle,
    sup: &mut Sup,
    spawned: &SpawnedPgids,
    path: &str,
    class: ExitClass,
    poll_now: Instant,
) {
    match class {
        ExitClass::AdoptedIncumbent => {
            eprintln!(
                "[cockpit-tray] {} child exited but an incumbent of ours holds port {} — adopting it rather than respawning (mt#3814 adopt race)",
                sup.daemon.labels.display_name, sup.daemon.port
            );
            // No throttle increment and no restart timestamp: nothing crashed,
            // and a benign race is not a crash-loop signal.
            sup.daemon.consecutive_http_failed = 0;
            sup.daemon.last_http_alert = None;
            sup.daemon.last_process_started_at_ms = None;
            sup.daemon.daemon_started_at = adopted_start_time(sup, path);
            let running = sup.daemon.labels.running;
            set_status(app, sup, running);
            refresh_uptime(app, sup);
        }
        ExitClass::Conflict => {
            eprintln!(
                "[cockpit-tray] {} child exited against a foreign listener on port {} — not respawning into a port that will keep refusing",
                sup.daemon.labels.display_name, sup.daemon.port
            );
            sup.daemon.consecutive_http_failed = 0;
            sup.daemon.last_http_alert = None;
            report_conflict(app, sup, path);
            clear_uptime(app, sup);
        }
        ExitClass::CleanStop | ExitClass::Crash | ExitClass::CeilingKill => {
            // The crash-exit path (restart-storm) owns the alerting for this
            // case; reset the HTTP-failure counter so the two paths don't
            // double-alert.
            sup.daemon.consecutive_http_failed = 0;
            sup.daemon.last_http_alert = None;
            clear_uptime(app, sup);
            // Clear last_process_started_at_ms so the first successful health
            // poll after respawn does NOT double-count a restart via the
            // adopted-daemon change-detection path.
            sup.daemon.last_process_started_at_ms = None;
            if class == ExitClass::Crash {
                // Record this crash; the next poll will prune + check the threshold.
                sup.daemon.restart_timestamps.push(poll_now);
                eprintln!(
                    "[watchdog] {} child crash: {} restarts in window",
                    sup.daemon.labels.display_name,
                    sup.daemon.restart_timestamps.len()
                );
            } else {
                let why = if class == ExitClass::CeilingKill {
                    "was terminated for breaching its memory ceiling"
                } else {
                    "exited cleanly"
                };
                eprintln!(
                    "[cockpit-tray] {} child {why} — restoring it without counting a crash",
                    sup.daemon.labels.display_name
                );
            }
            if throttle_ok(sup.daemon.last_spawn, Instant::now(), RESPAWN_THROTTLE) {
                do_spawn(app, sup, spawned, path);
            } else {
                // Crash-looping: exited within the respawn-throttle window
                // (e.g. a syntax error in server.ts that makes the new process
                // fail to bind). Surface the stderr tail instead of a silent
                // "stopped" (mt#2299 #5).
                let label = match daemon_error_tail(sup) {
                    Some(e) => failure_label(sup, &format!("start failed: {e} (see logs)")),
                    None => sup.daemon.labels.stopped.to_string(),
                };
                set_status(app, sup, &label);
            }
        }
    }
}

/// The healthy-poll arm's per-daemon half: what to do when this entry answered
/// and identified itself.
///
/// The not-ready watchdog lives here rather than in the core because the
/// READING of the health body is per-entry (`db` for the cockpit, `ready` for
/// the MCP daemon); the counters it drives are generic and live on
/// `SupervisedDaemon` (mt#4472).
///
/// Returns what the watchdog decided rather than acting on it. A restart needs
/// `spawned`, `path` and a `client` and is `async`; this function has none of
/// those and is sync, so returning the decision keeps the IO in `poll_entry`
/// and leaves the decision itself unit-testable without a daemon
/// (`testing-standards.mdc §Testable Design`).
#[must_use]
fn handle_healthy_poll(
    app: &AppHandle,
    sup: &mut Sup,
    probe: &daemon_core::HealthProbe,
    poll_now: Instant,
) -> Option<String> {
    // An answer from the right service that is not 2xx: the daemon is up and
    // says it is unwell. Restarting cannot fix what a 503 reports (mt#2949), so
    // this is a LABEL, not a lifecycle decision.
    if !probe.http_ok() {
        let label = failure_label(
            sup,
            &format!("unhealthy (HTTP {})", probe.status.unwrap_or_default()),
        );
        set_status(app, sup, &label);
        refresh_uptime(app, sup);
        return None;
    }

    let readiness = readiness_from_body(&sup.policy, probe.body.as_ref());

    // --- Watchdog: not-ready detection (mt#4472) ---
    let mut restart_reason: Option<String> = None;
    match readiness {
        Readiness::Serving | Readiness::Abstain => {
            if sup.daemon.consecutive_not_ready > 0 {
                eprintln!(
                    "[watchdog] {} recovered after {} not-ready polls",
                    sup.daemon.labels.display_name, sup.daemon.consecutive_not_ready
                );
            }
            sup.daemon.consecutive_not_ready = 0;
            // Condition cleared — next episode re-alerts immediately.
            sup.daemon.last_not_ready_alert = None;
        }
        Readiness::NotServing(state) => {
            sup.daemon.consecutive_not_ready += 1;
            let alert_cooldown_elapsed = sup
                .daemon
                .last_not_ready_alert
                .map(|t| poll_now.duration_since(t) >= ALERT_COOLDOWN)
                .unwrap_or(true);
            let restart_cooldown_elapsed = sup
                .daemon
                .last_not_ready_restart
                .map(|t| poll_now.duration_since(t) >= NOT_READY_RESTART_COOLDOWN)
                .unwrap_or(true);
            let outcome = assess_not_ready(
                sup.daemon.consecutive_not_ready,
                alert_cooldown_elapsed,
                restart_cooldown_elapsed,
            );

            // The duration is derived from OUR OWN poll count, never from a
            // timestamp in the daemon's body (mt#4472).
            //
            // The decision stands; its original stated reason did not (mt#4538).
            // That reason read "`dbHealth.lastAttemptAt` is frozen at process
            // boot", generalized from one 102-minute window in which the field
            // sat at the boot instant. It is not frozen — it dates an INIT
            // ATTEMPT, and init happens only at boot and on a re-init, so it
            // holds precisely when nothing has been re-attempted. Two live reads
            // on 2026-08-25 found it 2384s and 3769s PAST boot, each coincident
            // with a logged pool recycle.
            //
            // The real reason is stronger: an init-attempt stamp is not a
            // not-ready duration on any daemon, moving or still, so no reading
            // of it would have answered this question. `dbHealth.lastSuccessAt`
            // (added by mt#4538) IS the field that dates reachability, and this
            // watchdog still does not read it — what we need is how long WE have
            // observed not-ready, which is our own poll count, not the daemon's
            // view of its database.
            let sustained_secs = sup.daemon.consecutive_not_ready as u64 * POLL_INTERVAL.as_secs();

            if outcome.alert || outcome.restart {
                let reason = format!(
                    "{} has been unable to serve DB-backed work ({state}) for {sustained_secs}s. \
                     Check logs: {}",
                    sup.daemon.labels.display_name, sup.daemon.labels.stderr_log_hint,
                );
                if outcome.alert {
                    notify_daemon_unhealthy(app, sup.daemon.labels.display_name, &reason);
                    eprintln!("[watchdog] not-ready alert: {}", reason);
                    sup.daemon.last_not_ready_alert = Some(poll_now);
                }
                if outcome.restart {
                    // SC4: the restart is attributable — reason AND the observed
                    // duration, so it never reads as a spontaneous respawn.
                    eprintln!(
                        "[watchdog] not-ready RESTART of {} after {sustained_secs}s unserving \
                         ({state}) — RFC \"Thin hooks\" §Answerer recovery",
                        sup.daemon.labels.display_name,
                    );
                    sup.daemon.last_not_ready_restart = Some(poll_now);
                    // The counter restarts with the daemon: the replacement has
                    // not been observed unserving yet, and carrying the old
                    // streak forward would re-trip the threshold on its first
                    // bad poll.
                    sup.daemon.consecutive_not_ready = 0;
                    restart_reason = Some(reason);
                }
            }
        }
    }
    // Daemon HTTP is up (serving or not) — still show running: it answers UI
    // requests either way; only DB-backed work fails.
    let running = sup.daemon.labels.running;
    set_status(app, sup, running);
    // mt#2299: keep the uptime line ticking while healthy.
    refresh_uptime(app, sup);
    restart_reason
}

/// Whether a health body says the daemon can currently serve DB-backed work.
///
/// Per-entry because the two daemons publish different fields — which is not an
/// inconsistency to normalize away here: `ready` is the MCP daemon's own
/// end-to-end verdict (mt#4471 races a real round trip against a timer), while
/// the cockpit publishes the raw `db` state. Reading each one's actual signal
/// beats inventing a lowest common denominator.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Readiness {
    /// Serving. Resets the counter.
    Serving,
    /// Answering, but reporting it cannot serve. Carries the operator-facing
    /// state word for the alert text.
    NotServing(String),
    /// The body does not say, or says not-ready for an EXPECTED reason. Treated
    /// exactly like `Serving` for counting purposes: this watchdog's action is
    /// destructive, so "cannot tell" must never accumulate toward it.
    Abstain,
}

fn readiness_from_body(policy: &DaemonPolicy, body: Option<&serde_json::Value>) -> Readiness {
    match policy {
        DaemonPolicy::Cockpit(_) => match db_status_from_body(body) {
            DbStatus::Ok => Readiness::Serving,
            // `Unknown` means the body carried no `db` field we understood —
            // abstain rather than counting it as a fault.
            DbStatus::Unknown => Readiness::Abstain,
            other => Readiness::NotServing(format!("db: {other:?}").to_lowercase()),
        },
        DaemonPolicy::Mcp => {
            // SC5: `unconfigured` is `ready: false` BY DESIGN — the offline/dev
            // boot, which `health-payload.ts` documents and the CI bundle-boot
            // smoke gate depends on. Restarting it would loop forever on a
            // daemon that is behaving exactly as intended.
            let mode = body
                .and_then(|v| v.get("persistence"))
                .and_then(|v| v.get("mode"))
                .and_then(|v| v.as_str());
            if mode == Some("unconfigured") {
                return Readiness::Abstain;
            }
            match body.and_then(|v| v.get("ready")).and_then(|v| v.as_bool()) {
                Some(true) => Readiness::Serving,
                Some(false) => Readiness::NotServing("db: degraded".to_string()),
                // No `ready` field at all: a daemon built before mt#4471. Absent
                // is not false — treating it as not-ready would restart-loop
                // every older build.
                None => Readiness::Abstain,
            }
        }
    }
}

/// What the not-ready watchdog does this poll. Pure: no clock, no IO, no
/// `Sup` — every input is a value, so the threshold and both cooldowns are
/// testable without a daemon or a running tray.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct NotReadyOutcome {
    alert: bool,
    restart: bool,
}

fn assess_not_ready(
    consecutive_not_ready: u32,
    alert_cooldown_elapsed: bool,
    restart_cooldown_elapsed: bool,
) -> NotReadyOutcome {
    if consecutive_not_ready <= NOT_READY_POLL_THRESHOLD {
        // Below the threshold nothing happens — the single transient degraded
        // poll (observed live, self-cleared in <30s) must not reach either arm.
        return NotReadyOutcome {
            alert: false,
            restart: false,
        };
    }
    NotReadyOutcome {
        alert: alert_cooldown_elapsed,
        restart: restart_cooldown_elapsed,
    }
}

/// One poll tick for ONE registry entry.
///
/// Generic apart from the two `match sup.policy` hooks it delegates to. Before
/// mt#3815 this was ~200 inline lines of the cockpit's `select!` arm.
async fn poll_entry(
    app: &AppHandle,
    sup: &mut Sup,
    spawned: &SpawnedPgids,
    path: &str,
    client: &reqwest::Client,
) {
    let port = sup.daemon.port;
    let probe = probe_health(client, port, sup.daemon.health_path).await;
    let ours = probe.is_ours(sup.daemon.expected_service);
    let poll_now = Instant::now();

    // --- Watchdog: restart-storm detection ---
    // Prune timestamps older than the rolling window.
    sup.daemon
        .restart_timestamps
        .retain(|t| poll_now.duration_since(*t) < RESTART_STORM_WINDOW);

    if sup.daemon.restart_timestamps.len() > RESTART_STORM_THRESHOLD {
        let cooldown_elapsed = sup
            .daemon
            .last_restart_alert
            .map(|t| poll_now.duration_since(t) >= ALERT_COOLDOWN)
            .unwrap_or(true);
        if cooldown_elapsed {
            let reason = format!(
                "{} {} restarts in the last {}m — possible crash-loop. \
                 Check logs: {}",
                sup.daemon.restart_timestamps.len(),
                sup.daemon.labels.display_name,
                RESTART_STORM_WINDOW.as_secs() / 60,
                sup.daemon.labels.stderr_log_hint,
            );
            notify_daemon_unhealthy(app, sup.daemon.labels.display_name, &reason);
            sup.daemon.last_restart_alert = Some(poll_now);
            eprintln!("[watchdog] restart-storm alert: {}", reason);
        }
    } else {
        // Condition cleared — next episode re-alerts immediately.
        sup.daemon.last_restart_alert = None;
    }

    // --- Memory ceiling: enforced from OUT of process (mt#4105) ---
    //
    // Deliberately ahead of the `if ours` branch, which returns early on a
    // healthy daemon. A wedged event loop fails the health probe and would be
    // reached either way, but a daemon that is ballooning while STILL serving
    // would never be — and the ceiling is about size, not liveness.
    //
    // `child.id()` rather than the discovery record's pid: this arm governs a
    // child THIS supervisor spawned, so the pid is one it owns. An adopted
    // daemon is another process's to police (see the spec's Out of scope).
    if let Some(pid) = sup.daemon.child.as_ref().map(|c| c.id()) {
        let measured = daemon_memory_bytes(pid);
        if breaches_ceiling(measured, MEMORY_CEILING_BYTES) {
            let bytes = measured.unwrap_or(0);
            eprintln!(
                "[cockpit-tray] {} pid {pid} at {} MB exceeds the {} MB ceiling — SIGKILL \
                 (its in-process watcher cannot fire if its event loop is wedged)",
                sup.daemon.labels.display_name,
                bytes / (1024 * 1024),
                MEMORY_CEILING_BYTES / (1024 * 1024),
            );
            // Record BEFORE killing: the flag is what the next poll's
            // `classify_exit` reads to tell this from a crash, and a kill that
            // raced the flag would be counted against the restart throttle.
            sup.daemon.killed_for_ceiling = true;
            kill_pid_force(pid);
            // Cooldown-gated like every other alert here (PR #3045 R1): a daemon
            // that balloons, is killed, respawns and balloons again would
            // otherwise toast on every cycle. The kill itself is NOT gated —
            // only the notification is.
            let cooldown_elapsed = sup
                .daemon
                .last_ceiling_alert
                .map(|t| poll_now.duration_since(t) >= ALERT_COOLDOWN)
                .unwrap_or(true);
            if cooldown_elapsed {
                notify_daemon_unhealthy(
                    app,
                    sup.daemon.labels.display_name,
                    &format!(
                        "{} exceeded its {} MB memory ceiling and was terminated. It is being \
                         restarted automatically — no action needed unless this repeats. Logs: {}",
                        sup.daemon.labels.display_name,
                        MEMORY_CEILING_BYTES / (1024 * 1024),
                        sup.daemon.labels.stderr_log_hint,
                    ),
                );
                sup.daemon.last_ceiling_alert = Some(poll_now);
            }
            // Let the next tick observe the exit through the normal path rather
            // than reaping here: `handle_child_exit` owns respawn, throttling and
            // status, and duplicating any of that is how the two disagree.
            return;
        }
    }

    if ours {
        // Reap a child that died while an incumbent of ours took the port.
        //
        // Found by mt#3815's live acceptance run: the healthy branch returns
        // before the child-exit branch below is ever reached, so an entry whose
        // child lost a bind race kept a DEAD `Child` handle and a stale process
        // group. Two things then disagree with reality — `handle_child_exit`
        // never runs, so the entry never enters the ADOPTED state its status
        // claims; and `do_stop` takes the dead child, kills its empty group, and
        // therefore never stops the daemon actually serving, so Quit would leave
        // it running (AT5). The pre-mt#3815 single-daemon loop had the same
        // early return and the same latent hole.
        let dead_child = match sup.daemon.child.as_mut().map(|c| c.try_wait()) {
            Some(Ok(Some(status))) => Some(status.code()),
            _ => None,
        };
        if let Some(code) = dead_child {
            eprintln!(
                "[cockpit-tray] {} child exited ({code:?}) but an incumbent of ours serves port {} — adopting it",
                sup.daemon.labels.display_name, port
            );
            sup.daemon.child = None;
            // Forget the group WITHOUT killing it: the incumbent is not in it,
            // and the child that was is already gone.
            let _ = take_spawned(spawned, sup.id.slug());
            sup.daemon.daemon_started_at = adopted_start_time(sup, path);
        }

        // Health restored — reset failure counter + cooldown.
        if sup.daemon.consecutive_http_failed > 0 {
            eprintln!(
                "[watchdog] {} health restored after {} failed polls",
                sup.daemon.labels.display_name, sup.daemon.consecutive_http_failed
            );
        }
        sup.daemon.consecutive_http_failed = 0;
        sup.daemon.last_http_alert = None;

        // Detect adopted-daemon restarts via processStartedAtMs change.
        if let (Some(prev), Some(curr)) = (
            sup.daemon.last_process_started_at_ms,
            probe.process_started_at_ms,
        ) {
            if curr != prev {
                sup.daemon.restart_timestamps.push(poll_now);
                eprintln!(
                    "[watchdog] adopted-daemon restart detected via processStartedAtMs: {prev} → {curr}"
                );
            }
        }
        if probe.process_started_at_ms.is_some() {
            sup.daemon.last_process_started_at_ms = probe.process_started_at_ms;
        }

        // mt#4472: the watchdog DECIDES in `handle_healthy_poll` and the restart
        // happens here, where `spawned`/`path`/`client` are in scope and we can
        // await. `restart_entry` already refuses to restart over a foreign
        // listener, so the not-ready path inherits that safety rather than
        // re-implementing it.
        //
        // Reconciling with the rule three lines into `handle_healthy_poll`
        // ("Restarting cannot fix what a 503 reports (mt#2949), so this is a
        // LABEL, not a lifecycle decision"): that still holds and is untouched.
        // It governs a NON-2xx answer — the daemon reporting an upstream fault
        // it is merely relaying. This path is the opposite case: a 2xx answer
        // whose body says the daemon's OWN pool is not serving, which a restart
        // demonstrably does fix (`minsky mcp restart --execute` cleared exactly
        // this twice on 2026-08-24) and which the Accepted RFC "Thin hooks"
        // §Answerer recovery requires a supervisor restart for.
        if let Some(reason) = handle_healthy_poll(app, sup, &probe, poll_now) {
            notify_daemon_unhealthy(
                app,
                sup.daemon.labels.display_name,
                &format!("Restarting: {reason}"),
            );
            restart_entry(app, sup, spawned, path, client).await;
        }
        return;
    }

    // Health poll failed (or something that is not ours answered) — the daemon
    // is down or unresponsive. Increment the sustained-failure counter BEFORE
    // branching; the crash-exit arm resets it (that path is owned by
    // restart-storm).
    sup.daemon.consecutive_http_failed += 1;

    // Read the child's state into an OWNED value before branching: the arms
    // below mutate `sup` and `.await`, neither of which can happen while a
    // borrow of `sup.daemon.child` is live.
    enum ChildState {
        Exited(Option<i32>),
        Alive,
        Unknown,
    }
    let child_state = match sup.daemon.child.as_mut().map(|c| c.try_wait()) {
        Some(Ok(Some(status))) => ChildState::Exited(status.code()),
        Some(Ok(None)) => ChildState::Alive,
        Some(Err(_)) | None => ChildState::Unknown,
    };

    match child_state {
        ChildState::Exited(code) => {
            // Our child is gone; forget it and its process group before
            // deciding what its exit MEANT.
            sup.daemon.child = None;
            let _ = take_spawned(spawned, sup.id.slug());
            // The discriminator (mt#3814): re-probe rather than match a log
            // line. An exit-0 that lost a benign bind race leaves an incumbent
            // of ours serving; an exit-0 self-termination leaves nothing.
            let reprobe_is_ours = entry_is_ours(client, sup).await;
            // Take the ceiling flag: it describes THIS child's death and must
            // not survive into the next one's classification.
            let killed_for_ceiling = std::mem::take(&mut sup.daemon.killed_for_ceiling);
            let class = classify_exit(code, reprobe_is_ours, port_in_use(port), killed_for_ceiling);
            handle_child_exit(app, sup, spawned, path, class, poll_now).await;
        }
        ChildState::Alive => {
            // Child alive but not yet serving — still booting or hung. This is
            // the primary "unhealthy-but-not-exiting" path: the daemon is
            // running but not accepting health requests.
            if sup.daemon.consecutive_http_failed > HTTP_FAILURE_POLL_THRESHOLD {
                let cooldown_elapsed = sup
                    .daemon
                    .last_http_alert
                    .map(|t| poll_now.duration_since(t) >= ALERT_COOLDOWN)
                    .unwrap_or(true);
                if cooldown_elapsed {
                    let sustained_secs =
                        sup.daemon.consecutive_http_failed as u64 * POLL_INTERVAL.as_secs();
                    let reason = format!(
                        "{} has been unresponsive for {sustained_secs}s \
                         while its process is still alive — possible hang. \
                         Check logs: {}",
                        sup.daemon.labels.display_name, sup.daemon.labels.stderr_log_hint,
                    );
                    notify_daemon_unhealthy(app, sup.daemon.labels.display_name, &reason);
                    sup.daemon.last_http_alert = Some(poll_now);
                    eprintln!(
                        "[watchdog] sustained HTTP-failure (child alive) alert: {}",
                        reason
                    );
                }
            }
            let starting = sup.daemon.labels.starting;
            set_status(app, sup, starting);
        }
        ChildState::Unknown => {
            // No child of ours (adopted daemon down, or never spawned).
            // Decision logic lives in `handle_health_down_no_child` (mt#2794) —
            // this call site just wires the live AppHandle/lsof/process seams.
            // The counters and the labels both come off the core's record
            // (mt#3990). `labels` is copied out first because the effect
            // closure below needs its own `&mut sup` borrow.
            let labels = sup.daemon.labels;
            let mut counters = NoChildCounters::take_from(&mut sup.daemon);
            handle_health_down_no_child(
                &mut counters,
                poll_now,
                Instant::now(),
                port,
                &labels,
                || port_in_use(port),
                |eff| match eff {
                    NoChildEffect::Notify(reason) => {
                        notify_daemon_unhealthy(app, labels.display_name, &reason)
                    }
                    NoChildEffect::Spawn => do_spawn(app, sup, spawned, path),
                    NoChildEffect::SetStatus(label) => set_status(app, sup, label),
                    NoChildEffect::ClearUptime => clear_uptime(app, sup),
                },
            );
            counters.write_back_to(&mut sup.daemon);
        }
    }
}

fn run_supervisor(
    app: AppHandle,
    mut rx: mpsc::UnboundedReceiver<SupervisorCmd>,
    spawned: SpawnedPgids,
) {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");

    rt.block_on(async move {
        let path = path_env();
        // The registry (mt#3815). Constructed BEFORE the watchers and the
        // health client, because each entry OWNS its port.
        let mut entries = build_registry();
        // mt#2297: runtime cockpit-web watcher (source-gated). Held for the
        // supervisor's lifetime; dropping it stops the watch. `None` on a
        // no-source install — the auto-rebuild feature simply doesn't run.
        let _web_watcher = cockpit_source_root(&path)
            .and_then(|root| start_web_watcher(&app, &cockpit_web_src(&root)));
        // mt#2299: runtime backend-source watcher. Sibling of `_web_watcher`;
        // dispatches `Restart` (not `Rebuild`) on a backend `.ts`/`.mts`/`.cts`
        // change. `web/**` is excluded so a frontend edit never restarts the
        // daemon. Gated on `cockpit_backend_root` (BACKEND source presence), NOT
        // `cockpit_source_root` (web presence) — reviewer R1 B1: the web gate
        // made the whole feature silently no-op when `web/` was absent.
        //
        // Both watchers are COCKPIT policy and stay wired to the cockpit entry:
        // the MCP daemon has no bundle and no watched tree.
        let _backend_watcher = cockpit_backend_root(&path)
            .and_then(|root| start_backend_watcher(&app, &cockpit_backend_roots(&root)));
        // pool_max_idle_per_host(0) disables keep-alive reuse: each poll opens a
        // fresh connection. Without this a pooled connection can go stale
        // (daemon idle-close / half-open socket) and every poll fails its 2s
        // timeout, sticking status on "stopped" while the daemon is up (mt#2225).
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .pool_max_idle_per_host(0)
            .build()
            .expect("reqwest client");

        // Initial adoption-or-spawn, per entry. Sequential rather than
        // concurrent: each one may shell out to `lsof` and run a pre-flight
        // bundle build, and two entries racing those would interleave their
        // output for no gain at N=2.
        for sup in entries.iter_mut() {
            bring_up(&app, sup, &spawned, &path, &client).await;
        }

        loop {
            tokio::select! {
                cmd = rx.recv() => match cmd {
                    Some(SupervisorCmd::Start(id)) => {
                        if let Some(sup) = entry_mut(&mut entries, id) {
                            bring_up(&app, sup, &spawned, &path, &client).await;
                        }
                    }
                    Some(SupervisorCmd::Stop(id)) => {
                        if let Some(sup) = entry_mut(&mut entries, id) {
                            stop_entry(&app, sup, &spawned, &path, &client).await;
                        }
                    }
                    Some(SupervisorCmd::Restart(id)) => {
                        if let Some(sup) = entry_mut(&mut entries, id) {
                            restart_entry(&app, sup, &spawned, &path, &client).await;
                        }
                    }
                    // The operator clicked Restart on this daemon's submenu.
                    // Identical mechanism to the arm above — deliberately the
                    // same `restart_entry` — plus the confirmation toast, which
                    // hangs HERE and not there because `AutoRestart` re-sends
                    // `Restart` and would otherwise toast on every source save
                    // (mt#4233).
                    Some(SupervisorCmd::OperatorRestart(id)) => {
                        if let Some(sup) = entry_mut(&mut entries, id) {
                            restart_entry(&app, sup, &spawned, &path, &client).await;
                            notify_operator_restart(&app, sup);
                        }
                    }
                    Some(SupervisorCmd::AutoRestart(id)) => {
                        // mt#3048 (R2 fix, PR #2193 review): do NOT await the
                        // turn-active gate INLINE in this match arm — this
                        // `tokio::select!` loop is single-threaded, so an inline
                        // await here would block EVERY other arm (Start/Stop/
                        // Restart/Shutdown/Rebuild, and the health-poll watchdog
                        // below) for up to TURN_ACTIVE_GRACE (60s) any time a
                        // turn is active — unintentionally gating even an
                        // operator-explicit Restart/Stop click behind our
                        // auto-restart deferral, and blinding the self-health
                        // watchdog for the same window. Instead, spawn the wait
                        // as a background task on this SAME (current-thread)
                        // tokio runtime: it cooperatively yields at each
                        // `.await` inside `wait_for_turn_idle_or_grace_expiry`,
                        // so this loop keeps servicing every other command and
                        // the watchdog poll arm while it waits. Once idle (or
                        // the grace period elapses), the task re-sends
                        // `SupervisorCmd::Restart` through the SAME channel, so
                        // the actual stop/spawn always happens back HERE via
                        // the (unmodified) `Restart` arm above — the entries'
                        // mutation stays confined to this one loop, never
                        // shared across tasks. In the common (no active turn)
                        // case the background task's first check returns
                        // near-instantly and re-sends `Restart` immediately, so
                        // end-to-end latency for the common case is unchanged
                        // (one extra channel round-trip, not a blocking wait).
                        //
                        // Known minor edge case, intentionally NOT addressed: a
                        // SECOND burst of backend-source edits arriving DURING a
                        // deferred wait debounces independently and spawns its
                        // OWN background task/eventual `Restart` send, which
                        // lands shortly after the first — a harmless extra
                        // restart of an already-just-restarted daemon.
                        if let Some(handle) = app.try_state::<SupervisorHandle>() {
                            let tx_clone = handle.0.clone();
                            let client_clone = client.clone();
                            tokio::spawn(async move {
                                crate::watcher_backend::wait_for_turn_idle_or_grace_expiry(
                                    &client_clone,
                                )
                                .await;
                                let _ = tx_clone.send(SupervisorCmd::Restart(id));
                            });
                        }
                    }
                    Some(SupervisorCmd::Rebuild) => {
                        // Runtime source change. Rebuild WITHOUT touching the
                        // daemon — Express serves dist from disk per request, so
                        // the fresh bundle is live for any NEW client
                        // immediately; a failed rebuild leaves the prior bundle.
                        //
                        // An ALREADY-OPEN cockpit window is the exception: it
                        // keeps running the JS/CSS it loaded at document-load
                        // time, so it needs an explicit refresh or it silently
                        // sits on stale code indefinitely (mt#3320 — this used
                        // to say the bundle was "picked up on the next browser
                        // refresh", which quietly made that the operator's job).
                        //
                        // Cockpit-only: it is the only entry with a bundle.
                        if let Some(sup) = entry_mut(&mut entries, DaemonId::Cockpit) {
                            if let (Some(root), Some(bun)) =
                                (cockpit_source_root(&path), resolve_program("bun", &path))
                            {
                                set_build_status(&app, sup, "Rebuilding bundle...".to_string());
                                let result = run_cockpit_build(&bun, &root, &path);
                                report_build_result(&app, sup, &result, true);
                                // Coalescing is upstream, not here: the
                                // watcher's BUILD_DEBOUNCE (500ms) collapses a
                                // burst of saves into ONE Rebuild command, so a
                                // burst yields one rebuild and therefore one
                                // reload. No guard is needed at this layer —
                                // adding a second debounce would only delay the
                                // refresh.
                                if should_reload_after_build(&result) {
                                    reload_cockpit_window(&app);
                                }
                            }
                        }
                    }
                    Some(SupervisorCmd::Shutdown) | None => {
                        // Every entry, not just the cockpit (AT5). Pass a fresh
                        // health probe as adopted_ok (matching the Stop arm) so
                        // quitting the app never kills a FOREIGN listener on a
                        // supervised port — only our spawned child (via the
                        // process group inside do_stop) or our health-confirmed
                        // adopted daemon. (mt#2305; PR #1558 reviewer R3.)
                        for sup in entries.iter_mut() {
                            let h = entry_is_ours(&client, sup).await;
                            do_stop(sup, &spawned, &path, h);
                        }
                        break;
                    }
                },
                _ = tokio::time::sleep(POLL_INTERVAL) => {
                    // One tick drives EVERY entry. Sequential for the same
                    // reason the boot path is: each probe has a 2s ceiling and
                    // the arms shell out, so at N=2 the ordering is simpler than
                    // the concurrency would be worth.
                    for sup in entries.iter_mut() {
                        poll_entry(&app, sup, &spawned, &path, &client).await;
                    }
                }
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Self-health watchdog types + helpers (mt#2578).
// ---------------------------------------------------------------------------

/// DB health state as reported by the /api/health `db` field (gh#1761 / PR #1770).
/// `Unknown` covers parse failures and pre-gh#1761 daemons that don't emit the field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DbStatus {
    Ok,
    Degraded,
    Unreachable,
    /// Field absent or unparseable — treated as degraded for alert purposes.
    Unknown,
}

/// Read the cockpit's `db` field out of a health body.
///
/// Pure, and the ONE place the mapping lives — the generic probe in
/// `daemon_core` does not know this field exists, because only the cockpit's
/// `/api/health` publishes it. It is pinned against
/// `src/cockpit/routes/health.ts` (the emitter) via the shared golden fixture
/// `contract/cockpit-health-shape.json` (mt#2629) — see the `health_contract`
/// test module at the bottom of this file and `contract/README.md`. Renaming
/// `db` in health.ts without updating both sides of the contract fails a test
/// here.
///
/// The `HealthDetail` struct and `poll_health_detail` that used to wrap this
/// were removed in mt#3815: the transport, the `service` identity assertion and
/// `processStartedAtMs` are now `daemon_core::probe_health`'s, shared by every
/// entry, and `poll_entry` reads this one cockpit field off the probe's body.
fn db_status_from_body(body: Option<&serde_json::Value>) -> DbStatus {
    match body.and_then(|v| v.get("db")).and_then(|v| v.as_str()) {
        Some("ok") => DbStatus::Ok,
        Some("degraded") => DbStatus::Degraded,
        Some("unreachable") => DbStatus::Unreachable,
        _ => DbStatus::Unknown,
    }
}

/// Fire a best-effort OS-toast when the daemon is self-reporting unhealthy (mt#2578).
/// Mirrors `watcher_web::notify_build_failure`; ignored if notification permission
/// is unavailable.
/// Toast that a supervised daemon is unhealthy.
///
/// Takes the entry's display name rather than hardcoding one (PR #3299 R1).
/// Every caller is per-entry — the restart-storm, sustained-HTTP-failure,
/// memory-ceiling and not-ready watchdogs all run once per registered daemon —
/// so a fixed "Cockpit" title was already the wrong shape and became visibly
/// wrong when mt#4472 let the MCP entry raise these: the operator would get a
/// toast blaming the cockpit for an MCP wedge, which is worse than no toast,
/// because it points triage at the wrong process.
fn notify_daemon_unhealthy(app: &AppHandle, display_name: &str, reason: &str) {
    let _ = app
        .notification()
        .builder()
        .title(unhealthy_title(display_name))
        .body(reason)
        .show();
}

/// Confirm an operator-triggered restart — success OR failure (mt#4233).
///
/// Reports the OUTCOME, not the action: `child` is `Some` only once `do_spawn`
/// actually holds a process, so a refused restart (a foreign listener owns the
/// port) and a failed spawn (no bun, no repo root, a refused pre-flight rebuild)
/// both report as failures instead of a cheerful "Restarted" over a daemon that
/// is not running. The failure body is the status line those same paths just
/// set, which already distinguishes which of them it was.
///
/// Only `OperatorRestart` reaches here, and that matters in both directions: the
/// source-change watcher re-sends plain `Restart` and must stay silent (it fires
/// on every save now that mt#4230 widened the watcher root), while the not-ready
/// watchdog calls `restart_entry` directly and already raises its own
/// `"Restarting: {reason}"` alert — so neither double-notifies.
fn notify_operator_restart(app: &AppHandle, sup: &Sup) {
    let name = sup.daemon.labels.display_name;
    let builder = app.notification().builder();
    let builder = if sup.daemon.child.is_some() {
        builder
            .title(format!("Restarted {name}"))
            .body(format!("Starting on :{}.", sup.daemon.port))
    } else {
        builder.title(format!("Could not restart {name}")).body(
            sup.daemon
                .last_status
                .clone()
                .unwrap_or_else(|| "See the tray status line for why.".to_string()),
        )
    };
    let _ = builder.show();
}

/// The unhealthy toast's title.
///
/// Extracted (mt#4233) so the doubling it used to carry is testable. The literal
/// was `"{display_name} daemon unhealthy"`, which was correct only while
/// `display_name` was the bare product name. mt#4472 gave the MCP entry — whose
/// name was ALREADY "MCP daemon" — the ability to raise these, and every toast
/// it raised from then until this change was titled "MCP daemon daemon
/// unhealthy". `display_name` now carries the class word for both entries, so
/// the suffix is gone rather than conditional.
fn unhealthy_title(display_name: &str) -> String {
    format!("{display_name} unhealthy")
}

// ---------------------------------------------------------------------------
// Adopted-daemon backend-staleness decision (mt#2299).
// ---------------------------------------------------------------------------

/// What to do with an adopted (health-confirmed) daemon, given backend staleness.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AdoptDecision {
    /// Adopted daemon is current (or staleness is undeterminable) — monitor it.
    Fresh {
        started: Option<SystemTime>,
        source_mtime: Option<SystemTime>,
    },
    /// Backend source is newer than the adopted daemon's start — restart it so
    /// new widget registrations / routes load (the 2026-06-04 originating case).
    Stale,
}

/// When the daemon currently serving this entry's port started.
///
/// For the MCP entry the DISCOVERY RECORD is preferred over an `lsof` probe
/// (mt#3814 wrote it "for the supervisor and the CLI"): it names the pid
/// directly, where `lsof` gives a pid the supervisor still has to attribute.
/// A record that is missing, for a different port, or whose pid is gone falls
/// through to the probe rather than deciding "no daemon" — mt#3814's own
/// docstring is explicit that a missing record is inconclusive, and the health
/// probe remains the authority on whether anything is actually serving.
fn adopted_start_time(sup: &Sup, path: &str) -> Option<SystemTime> {
    if sup.id == DaemonId::Mcp {
        if let Some(record) = registry::read_discovery_record() {
            if record.port == sup.daemon.port {
                if let Some(started) = daemon_start_time(record.pid) {
                    return Some(started);
                }
            }
        }
    }
    pid_on_port(sup.daemon.port, path).and_then(daemon_start_time)
}

/// Decide whether an adopted daemon is backend-stale. Compares the daemon's
/// start time (`ps` etime) against the newest backend-source mtime. A source
/// install with both signals available and `source > start` is Stale; anything
/// undeterminable (no source tree, pid gone, ps failure) is treated as Fresh
/// (never restart on a guess).
///
/// Staleness is COCKPIT policy (mt#3815): it compares against the cockpit's
/// watched backend source tree, which no other entry has. An entry without one
/// is always Fresh — not because staleness was checked and passed, but because
/// the question does not apply.
fn adopt_decision(sup: &Sup, path: &str) -> AdoptDecision {
    let started = adopted_start_time(sup, path);
    if !matches!(sup.policy, DaemonPolicy::Cockpit(_)) {
        return AdoptDecision::Fresh {
            started,
            source_mtime: None,
        };
    }
    let source_mtime = cockpit_backend_root(path)
        .and_then(|r| newest_backend_mtime_across(&cockpit_backend_roots(&r)));
    if let (Some(st), Some(sm)) = (started, source_mtime) {
        if sm > st {
            return AdoptDecision::Stale;
        }
    }
    AdoptDecision::Fresh {
        started,
        source_mtime,
    }
}

// ---------------------------------------------------------------------------
// Daemon-uptime display (mt#2299).
// ---------------------------------------------------------------------------

/// Render one daemon's uptime menu line: how long it has run + the source mtime
/// it was started against. `started == None` → "<name> uptime: —". Pure.
///
/// Two mt#3815 changes, both forced by there being more than one line now.
/// The line is PREFIXED with the daemon's name, because two rows both reading
/// "Daemon uptime:" name nothing. And the `(src @ …)` clause is emitted only
/// when a source mtime is actually known: an entry with no watched source tree
/// has nothing to report there, and the previous `(src @ unknown)` fallback
/// would have made that absence look like a failed lookup.
fn uptime_label(
    name: &str,
    started: Option<SystemTime>,
    source_mtime: Option<SystemTime>,
    now: SystemTime,
) -> String {
    match started {
        Some(st) => {
            let dur = now.duration_since(st).unwrap_or_default();
            match source_mtime {
                Some(sm) => format!(
                    "{name} uptime: {} (src @ {})",
                    format_duration(dur),
                    format_hms_utc(sm)
                ),
                None => format!("{name} uptime: {}", format_duration(dur)),
            }
        }
        None => format!("{name} uptime: —"),
    }
}

/// Update this daemon's uptime dropdown line on the main thread (mt#2299).
fn update_uptime_status(app: &AppHandle, id: DaemonId, label: &str) -> tauri::Result<()> {
    let app_handle = app.clone();
    let label = label.to_string();
    app.run_on_main_thread(move || {
        if let Some(items) = app_handle.try_state::<DaemonMenuItems>() {
            if let Some(item) = items.uptime_for(id) {
                let _ = item.set_text(&label);
            }
        }
    })
}

/// Set the uptime label, skipping the UI round-trip when unchanged.
fn set_uptime_status(app: &AppHandle, sup: &mut Sup, label: String) {
    if sup.daemon.last_uptime_label.as_deref() == Some(label.as_str()) {
        return;
    }
    sup.daemon.last_uptime_label = Some(label.clone());
    let _ = update_uptime_status(app, sup.id, &label);
}

/// Recompute + push the uptime line from the current daemon-start/source state.
fn refresh_uptime(app: &AppHandle, sup: &mut Sup) {
    let label = uptime_label(
        sup.daemon.labels.display_name,
        sup.daemon.daemon_started_at,
        sup.source_mtime(),
        SystemTime::now(),
    );
    set_uptime_status(app, sup, label);
}

/// Clear the uptime line + recorded start state (daemon no longer running).
fn clear_uptime(app: &AppHandle, sup: &mut Sup) {
    sup.daemon.daemon_started_at = None;
    sup.set_source_mtime(None);
    let label = uptime_label(
        sup.daemon.labels.display_name,
        None,
        None,
        SystemTime::now(),
    );
    set_uptime_status(app, sup, label);
}

/// Status line for a foreign listener on the supervised port, naming the holder
/// pid (mt#2299,
/// narrow scope — message only, no kill). Pure.
/// Set the Conflict status AND say who is holding the port.
///
/// The label alone is not a diagnostic: through the whole mt#3785 outage the
/// tray's only signal was a menu item nobody was looking at, and stderr carried
/// nothing at all — `do_spawn`'s four failure paths all log, but the Conflict
/// arm returns before reaching any of them.
///
/// Logs on the TRANSITION only. `set_status` already returns early when the
/// label is unchanged, so the health-poll arms that route through here every
/// 5 s stay quiet once a conflict is steady-state; a change of holder changes
/// the label and is reported.
fn report_conflict(app: &AppHandle, sup: &mut Sup, path: &str) {
    let port = sup.daemon.port;
    let holder = port_holder(port, path);
    let pid = holder.as_ref().map(|(pid, _)| *pid);
    let label = conflict_label_for(sup.daemon.labels.display_name, sup.id.slug(), port, pid);
    if sup.daemon.last_status.as_deref() != Some(label.as_str()) {
        // The ADDRESS is reported, not assumed (PR #2684 R2): the probe is
        // scoped to loopback but that covers both families, and "which address"
        // is exactly what the original incident turned on.
        eprintln!(
            "[cockpit-tray] not spawning {}: port {port} is held by {}",
            sup.daemon.labels.display_name,
            match &holder {
                Some((pid, addr)) => format!("pid {pid} on {addr}"),
                None => "a process lsof could not name".to_string(),
            }
        );
    }
    set_status(app, sup, &label);
}

/// Both arms name the SUPERVISED port (mt#3988) rather than a literal 3737:
/// on a configured tray the whole point of the label is telling the operator
/// which port is contended, and a label naming a port the tray is not watching
/// is worse than no label. Since mt#3815 they also name WHICH daemon's port,
/// because there is more than one.
fn conflict_label_for(display_name: &str, slug: &str, port: u16, pid: Option<u32>) -> String {
    match pid {
        Some(p) => format!("{display_name}: :{port} held by pid {p} (not started by tray)"),
        None => format!("{display_name}: :{port} in use (not {slug})"),
    }
}

/// Last non-empty line of THIS entry's stderr log, capped — used to summarize a
/// restart/start failure in its status line (mt#2299, criterion 5).
///
/// The bounded-tail mechanism moved to `daemon_core::log_tail_last_line`
/// (mt#3990); what stays here is which log file to read, which is per-entry
/// since mt#3815. It comes from `spawn_plan`, the same function the spawn
/// redirects stderr through, so the status line and the log cannot drift apart.
fn daemon_error_tail(sup: &Sup) -> Option<String> {
    let (_, _, stderr_log, _) = spawn_plan(sup);
    log_tail_last_line(stderr_log)
}

// ---------------------------------------------------------------------------
// Wiring helpers, called from `main()`'s composition.
// ---------------------------------------------------------------------------

pub(crate) fn send_cmd(app: &AppHandle, cmd: SupervisorCmd) {
    if let Some(handle) = app.try_state::<SupervisorHandle>() {
        let _ = handle.0.send(cmd);
    }
}

/// Wire up the command channel and spawn the supervisor thread on its own OS
/// thread. Must be called from `main()`'s setup closure so `SupervisorHandle`
/// is registered as managed state before any menu click can attempt to send a
/// command.
pub(crate) fn spawn(app: AppHandle, spawned: SpawnedPgids) {
    let (tx, rx) = mpsc::unbounded_channel::<SupervisorCmd>();
    app.manage(SupervisorHandle(tx));
    let sup_app = app.clone();
    std::thread::spawn(move || run_supervisor(sup_app, rx, spawned));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::port::DEFAULT_COCKPIT_PORT;
    use std::time::UNIX_EPOCH;

    /// A configured non-default port, used by the mt#3988 cases below. Chosen to
    /// match the port in the 2026-06-04 incident this task fixes.
    const CONFIGURED_PORT: u16 = 4317;

    // -----------------------------------------------------------------------
    // Not-ready watchdog (mt#4472).
    //
    // Both units under test are pure, which is the point of splitting the
    // DECISION out of `handle_healthy_poll`: the threshold, both cooldowns and
    // every per-entry body reading are asserted here with no daemon, no tray,
    // no clock and no HTTP.
    // -----------------------------------------------------------------------

    fn cockpit_policy() -> DaemonPolicy {
        DaemonPolicy::Cockpit(CockpitPolicy {
            last_build_label: None,
            daemon_source_mtime: None,
        })
    }

    /// AT4 — a single transient not-ready poll must not trigger anything.
    ///
    /// Not a hypothetical: on 2026-08-24T23:58Z the cockpit daemon was observed
    /// at `db: "degraded"` with `consecutiveDegraded: 1` and was back to `ok`
    /// within 30s, no recycle, no intervention. A watchdog that acted on one
    /// poll would have restarted a daemon that was already recovering.
    #[test]
    fn a_single_not_ready_poll_does_nothing() {
        let outcome = assess_not_ready(1, true, true);
        assert!(!outcome.alert);
        assert!(!outcome.restart);
    }

    /// The threshold is a STRICT crossing: at the threshold nothing fires, one
    /// poll past it both fire. Pinning the boundary keeps a later refactor from
    /// turning `>` into `>=` unnoticed and halving the detection window.
    #[test]
    fn the_threshold_is_crossed_not_reached() {
        let at = assess_not_ready(NOT_READY_POLL_THRESHOLD, true, true);
        assert!(!at.alert, "at the threshold nothing fires");
        assert!(!at.restart);

        let past = assess_not_ready(NOT_READY_POLL_THRESHOLD + 1, true, true);
        assert!(past.alert, "one poll past the threshold, both fire");
        assert!(past.restart);
    }

    /// AT3 — the rate limit. Past the threshold with the RESTART cooldown still
    /// running, the principal is still alerted but the daemon is not restarted
    /// again. This is what bounds a daemon whose not-ready cause a restart
    /// cannot fix (the spec's `## Does NOT cover`).
    #[test]
    fn the_restart_cooldown_suppresses_the_restart_but_not_the_alert() {
        let outcome = assess_not_ready(NOT_READY_POLL_THRESHOLD + 1, true, false);
        assert!(outcome.alert);
        assert!(!outcome.restart, "restart is rate-limited independently");
    }

    /// The two cooldowns are independent in both directions — an alert already
    /// sent this episode must not suppress a due restart.
    #[test]
    fn the_alert_cooldown_does_not_gate_the_restart() {
        let outcome = assess_not_ready(NOT_READY_POLL_THRESHOLD + 1, false, true);
        assert!(!outcome.alert);
        assert!(outcome.restart);
    }

    /// AT2 / SC5 — the negative control. The MCP daemon's offline/dev boot is
    /// `ready: false` BY DESIGN, and the CI bundle-boot-smoke gate depends on
    /// that 200. It must never be counted as a fault, or the tray would restart
    /// a correctly-behaving daemon forever.
    #[test]
    fn an_unconfigured_mcp_daemon_is_never_counted_not_ready() {
        let body = serde_json::json!({
            "service": "minsky-mcp",
            "ready": false,
            "persistence": { "mode": "unconfigured" },
        });
        assert_eq!(
            readiness_from_body(&DaemonPolicy::Mcp, Some(&body)),
            Readiness::Abstain,
        );
    }

    /// A daemon built before mt#4471 publishes no `ready` field at all. Absent
    /// is not false: reading it as not-ready would restart-loop every older
    /// build, which is the failure mode that makes an over-eager watchdog worse
    /// than none.
    #[test]
    fn a_health_body_without_ready_abstains_rather_than_faulting() {
        let body = serde_json::json!({ "service": "minsky-mcp", "status": "ok" });
        assert_eq!(
            readiness_from_body(&DaemonPolicy::Mcp, Some(&body)),
            Readiness::Abstain,
        );
        assert_eq!(
            readiness_from_body(&DaemonPolicy::Mcp, None),
            Readiness::Abstain
        );
    }

    /// The MCP entry participates at all — the half of mt#4472 that the
    /// pre-existing cockpit-only watchdog could not do, and the entry where the
    /// 2026-08-23 incident actually happened.
    #[test]
    fn the_mcp_entry_reports_readiness_from_its_ready_field() {
        let serving = serde_json::json!({
            "service": "minsky-mcp",
            "ready": true,
            "persistence": { "mode": "connected" },
        });
        assert_eq!(
            readiness_from_body(&DaemonPolicy::Mcp, Some(&serving)),
            Readiness::Serving,
        );

        let wedged = serde_json::json!({
            "service": "minsky-mcp",
            "ready": false,
            "db": "degraded",
            "persistence": { "mode": "connected" },
        });
        assert!(matches!(
            readiness_from_body(&DaemonPolicy::Mcp, Some(&wedged)),
            Readiness::NotServing(_),
        ));
    }

    /// The cockpit entry keeps reading `db`, which is the signal it actually
    /// publishes — it has no `ready` field (verified live 2026-08-24).
    #[test]
    fn the_cockpit_entry_reports_readiness_from_its_db_field() {
        let serving = serde_json::json!({ "service": "minsky-cockpit", "db": "ok" });
        assert_eq!(
            readiness_from_body(&cockpit_policy(), Some(&serving)),
            Readiness::Serving,
        );

        let degraded = serde_json::json!({ "service": "minsky-cockpit", "db": "degraded" });
        assert!(matches!(
            readiness_from_body(&cockpit_policy(), Some(&degraded)),
            Readiness::NotServing(_),
        ));

        // No `db` key at all — abstain, not fault.
        let silent = serde_json::json!({ "service": "minsky-cockpit" });
        assert_eq!(
            readiness_from_body(&cockpit_policy(), Some(&silent)),
            Readiness::Abstain,
        );
    }

    /// mt#3990: the cockpit's argv is now DATA handed to the daemon-agnostic
    /// spawn rather than a literal inside it, so the thing the extraction could
    /// silently have changed — what the daemon is actually started with — is
    /// asserted here rather than left to a live launch.
    #[test]
    fn cockpit_spawn_args_are_the_source_entry_with_an_explicit_port() {
        assert_eq!(
            cockpit_spawn_args(DEFAULT_COCKPIT_PORT),
            vec![
                "run",
                "src/cli.ts",
                "cockpit",
                "start",
                "--no-dev-chromium",
                "--port",
                "3737",
            ]
        );
        // The port is the CONFIGURED one, not a constant baked in beside it
        // (mt#3988) — the same invariant the lsof-args cases pin for the probe.
        let args = cockpit_spawn_args(CONFIGURED_PORT);
        assert_eq!(args.last().expect("a port argument"), "4317");
    }

    #[test]
    fn repo_root_from_bin_path_strips_scripts_and_entry() {
        let real = Path::new("/Users/x/Projects/minsky/scripts/cli-entry.ts");
        assert_eq!(
            repo_root_from_bin_path(real),
            Some(PathBuf::from("/Users/x/Projects/minsky"))
        );
        // Too shallow to have a <repo>/scripts/<file> shape.
        assert_eq!(repo_root_from_bin_path(Path::new("/minsky")), None);
    }

    #[test]
    fn repo_root_from_bin_path_rejects_unexpected_shape() {
        // A system-installed binary must NOT resolve a repo root.
        assert_eq!(
            repo_root_from_bin_path(Path::new("/usr/local/bin/minsky")),
            None
        );
        // Right filename, wrong parent dir.
        assert_eq!(
            repo_root_from_bin_path(Path::new("/Users/x/elsewhere/cli-entry.ts")),
            None
        );
    }

    #[test]
    fn has_cli_source_detects_src_cli_ts() {
        let dir = std::env::temp_dir().join(format!("mt2282-hcs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).expect("mkdir");
        assert!(!has_cli_source(&dir));
        std::fs::write(dir.join("src/cli.ts"), b"// test").expect("write");
        assert!(has_cli_source(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    // --- mt#4233: lifecycle-entry naming + the class-word suffix ---

    /// The rename's whole point: `display_name` now CARRIES the class word, so
    /// alert prose must not append it. The title format was
    /// `"{display_name} daemon unhealthy"`, which was fine while the name was
    /// bare — but mt#4472 let the MCP entry raise these, and that entry was
    /// already called "MCP daemon", so every toast it raised in production from
    /// then until mt#4233 was titled "MCP daemon daemon unhealthy".
    #[test]
    fn the_unhealthy_title_says_daemon_exactly_once_for_every_entry() {
        for labels in [COCKPIT_LABELS, registry::MCP_LABELS] {
            let title = unhealthy_title(labels.display_name);
            assert_eq!(
                title.to_lowercase().matches("daemon").count(),
                1,
                "the class word must appear once, carried by the name itself: {title}"
            );
            assert!(
                title.starts_with(labels.display_name),
                "the toast must name the daemon it is about: {title}"
            );
        }
    }

    /// Every cockpit status line derives from the one name literal — including
    /// `LABEL_BUILDING`, which sits outside `DaemonLabels` because nothing else
    /// has a web bundle, and is therefore the single place the literal is still
    /// written twice. This test is what makes that duplication safe: a rename
    /// touching only one of the two fails here.
    #[test]
    fn every_cockpit_status_line_carries_the_daemon_name() {
        let prefix = format!("{}: ", COCKPIT_LABELS.display_name);
        for line in [
            COCKPIT_LABELS.running,
            COCKPIT_LABELS.stopped,
            COCKPIT_LABELS.starting,
            LABEL_BUILDING,
        ] {
            assert!(
                line.starts_with(&prefix),
                "a status line must read `<name>: <state>`, got: {line}"
            );
        }
    }

    /// The status lines two surfaces outside this crate assert VERBATIM, pinned
    /// so a rename cannot silently desync them: `scripts/smoke-status.sh` locates
    /// the tray's status row by the `"Cockpit daemon: "` title prefix and then
    /// compares the running/stopped lines exactly, and `README.md`'s status table
    /// lists all four. Neither is reachable from `cargo test`, so this is the
    /// only thing standing between a rename and a smoke check that SKIPs
    /// forever with "status menu item not found".
    #[test]
    fn the_cockpit_status_lines_are_pinned() {
        assert_eq!(COCKPIT_LABELS.display_name, "Cockpit daemon");
        assert_eq!(COCKPIT_LABELS.running, "Cockpit daemon: running");
        assert_eq!(COCKPIT_LABELS.stopped, "Cockpit daemon: stopped");
        assert_eq!(COCKPIT_LABELS.starting, "Cockpit daemon: starting...");
        assert_eq!(LABEL_BUILDING, "Cockpit daemon: rebuilding bundle...");
    }

    // --- mt#2299: adopt-decision + uptime + conflict + error-tail helpers ---

    #[test]
    fn uptime_label_renders_duration_and_source() {
        let now = UNIX_EPOCH + Duration::from_secs(1_000);
        let started = UNIX_EPOCH + Duration::from_secs(940); // 60s ago
        let src = UNIX_EPOCH + Duration::from_secs(3661);
        let l = uptime_label("Cockpit", Some(started), Some(src), now);
        assert!(l.starts_with("Cockpit uptime: 1m 0s"), "got: {l}");
        assert!(l.contains("src @ 01:01:01 UTC"), "got: {l}");
        assert_eq!(
            uptime_label("Cockpit", None, None, now),
            "Cockpit uptime: —"
        );
    }

    /// mt#3815: each daemon's line names itself, and an entry with no watched
    /// source tree renders no `(src @ …)` clause rather than `(src @ unknown)`
    /// — there is nothing to report there, and reporting "unknown" would make
    /// the absence look like a lookup that failed.
    #[test]
    fn uptime_label_is_per_daemon_and_omits_an_absent_source() {
        let now = UNIX_EPOCH + Duration::from_secs(1_000);
        let started = UNIX_EPOCH + Duration::from_secs(940);
        assert_eq!(
            uptime_label("MCP daemon", Some(started), None, now),
            "MCP daemon uptime: 1m 0s"
        );
        assert_eq!(
            uptime_label("MCP daemon", None, None, now),
            "MCP daemon uptime: —"
        );
    }

    #[test]
    fn conflict_label_names_holder_pid() {
        assert_eq!(
            conflict_label_for("Cockpit", "cockpit", DEFAULT_COCKPIT_PORT, Some(4242)),
            "Cockpit: :3737 held by pid 4242 (not started by tray)"
        );
        assert_eq!(
            conflict_label_for("Cockpit", "cockpit", DEFAULT_COCKPIT_PORT, None),
            "Cockpit: :3737 in use (not cockpit)"
        );
    }

    /// mt#3988: the label names the port the tray is actually supervising.
    /// Reporting `:3737 held by ...` on a tray configured to 4317 would be a
    /// diagnostic pointing at the wrong port during exactly the situation the
    /// label exists for.
    #[test]
    fn conflict_label_names_the_configured_port() {
        assert_eq!(
            conflict_label_for("Cockpit", "cockpit", CONFIGURED_PORT, Some(4242)),
            "Cockpit: :4317 held by pid 4242 (not started by tray)"
        );
        assert_eq!(
            conflict_label_for("Cockpit", "cockpit", CONFIGURED_PORT, None),
            "Cockpit: :4317 in use (not cockpit)"
        );
    }

    /// mt#3815: with two entries, a conflict label that said only "Cockpit"
    /// would attribute the MCP daemon's contended port to the wrong daemon.
    #[test]
    fn conflict_label_names_which_daemon_is_blocked() {
        assert_eq!(
            conflict_label_for("MCP daemon", "mcp", registry::MCP_PORT, Some(4242)),
            "MCP daemon: :48765 held by pid 4242 (not started by tray)"
        );
        assert_eq!(
            conflict_label_for("MCP daemon", "mcp", registry::MCP_PORT, None),
            "MCP daemon: :48765 in use (not mcp)"
        );
    }

    /// Every registered daemon must be expressible as a `Sup`, and each must get
    /// its OWN identity — a shared health path or service would make one entry's
    /// probe answer for the other. Checked over `DaemonId::ALL` rather than the
    /// two known entries, so a third one is covered the day it is added.
    #[test]
    fn the_registry_gives_every_daemon_a_distinct_identity() {
        let entries = build_registry();
        assert_eq!(entries.len(), DaemonId::ALL.len());
        for (entry, id) in entries.iter().zip(DaemonId::ALL) {
            assert_eq!(entry.id, id, "registry order follows DaemonId::ALL");
            assert!(entry.daemon.port > 0);
            assert!(entry.daemon.health_path.starts_with('/'));
            assert!(!entry.daemon.expected_service.is_empty());
        }
        for (i, a) in entries.iter().enumerate() {
            for b in entries.iter().skip(i + 1) {
                assert_ne!(a.daemon.port, b.daemon.port, "one port per daemon");
                assert_ne!(
                    a.daemon.expected_service, b.daemon.expected_service,
                    "one identity per daemon"
                );
                assert_ne!(
                    a.daemon.labels.display_name, b.daemon.labels.display_name,
                    "one name per daemon, or the menu lines are ambiguous"
                );
            }
        }
    }

    /// The policy split is the load-bearing half of mt#3990's extraction: the
    /// cockpit carries build/source/db state and the MCP entry carries none.
    #[test]
    fn only_the_cockpit_entry_carries_cockpit_policy() {
        let mut entries = build_registry();
        for entry in entries.iter_mut() {
            match entry.id {
                DaemonId::Cockpit => assert!(
                    entry.cockpit_mut().is_some(),
                    "the cockpit entry owns the bundle/source/db state"
                ),
                DaemonId::Mcp => assert!(
                    entry.cockpit_mut().is_none(),
                    "a second daemon must not inherit a build label or a db counter"
                ),
            }
        }
    }

    /// Each entry writes its own log files — a shared stderr filename would
    /// interleave two daemons' output into one status line's error tail.
    #[test]
    fn each_entry_spawns_its_own_command_and_logs() {
        let entries = build_registry();
        let plans: Vec<_> = entries.iter().map(spawn_plan).collect();
        for (i, (args_a, out_a, err_a, _)) in plans.iter().enumerate() {
            assert!(!args_a.is_empty());
            for (args_b, out_b, err_b, _) in plans.iter().skip(i + 1) {
                assert_ne!(args_a, args_b);
                assert_ne!(out_a, out_b);
                assert_ne!(err_a, err_b);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Health-shape contract pin (mt#2629).
//
// `poll_health_detail` above parses `db` and `processStartedAtMs` out of the
// `/api/health` JSON body emitted by `src/cockpit/routes/health.ts`. There is
// no shared schema-generation tooling between the Rust supervisor and the TS
// server, so this module pins the contract two ways against the single
// checked-in fixture `contract/cockpit-health-shape.json` (repo root):
//
//   1. `fixture_declares_fields_rust_depends_on` — the fixture's own
//      `rustConsumedFields` list is included as fields in `fields`. Catches a
//      fixture edited out of sync with itself.
//   2. `health_route_source_still_emits_fields_rust_depends_on` — greps the
//      LIVE TypeScript source of health.ts (pulled in via `include_str!`, so
//      this re-reads on every compile) for each rustConsumedFields name. This
//      is what makes a same-PR rename in health.ts fail THIS cargo test
//      immediately, without needing the fixture regenerated first — the bun
//      side (`src/cockpit/health-contract.test.ts`) independently pins the
//      full field set + types against the same fixture by asserting the
//      LIVE server response matches it.
//
// See contract/README.md for the full contract note, including the
// port/process-detection semantics documented alongside this fixture.
#[cfg(test)]
mod health_contract {
    const HEALTH_SHAPE_FIXTURE: &str = include_str!("../../../contract/cockpit-health-shape.json");
    const HEALTH_ROUTE_SOURCE: &str = include_str!("../../../src/cockpit/routes/health.ts");

    /// Pull `rustConsumedFields` out of the fixture without a full serde
    /// struct — the fixture is a flat, hand-authored JSON doc and a tiny
    /// manual parse keeps this test from needing a schema type of its own.
    fn rust_consumed_fields(fixture_json: &serde_json::Value) -> Vec<String> {
        fixture_json
            .get("rustConsumedFields")
            .and_then(|v| v.as_array())
            .expect("fixture must declare a `rustConsumedFields` array")
            .iter()
            .map(|v| {
                v.as_str()
                    .expect("rustConsumedFields entries must be strings")
                    .to_string()
            })
            .collect()
    }

    #[test]
    fn fixture_declares_fields_rust_depends_on() {
        let fixture: serde_json::Value =
            serde_json::from_str(HEALTH_SHAPE_FIXTURE).expect("fixture must be valid JSON");
        let fields = fixture
            .get("fields")
            .and_then(|v| v.as_object())
            .expect("fixture must declare a `fields` object");
        for name in rust_consumed_fields(&fixture) {
            assert!(
                fields.contains_key(&name),
                "contract/cockpit-health-shape.json's rustConsumedFields names `{name}`, \
                 but `fields` has no such key — the fixture is internally inconsistent"
            );
        }
    }

    #[test]
    fn health_route_source_still_emits_fields_rust_depends_on() {
        let fixture: serde_json::Value =
            serde_json::from_str(HEALTH_SHAPE_FIXTURE).expect("fixture must be valid JSON");
        for name in rust_consumed_fields(&fixture) {
            // health.ts emits fields as `res.json({ ..., <name>: <expr>, ... })` —
            // the literal `<name>:` token is a stable enough signature for this
            // source-text pin without parsing TypeScript.
            let needle = format!("{name}:");
            assert!(
                HEALTH_ROUTE_SOURCE.contains(&needle),
                "src/cockpit/routes/health.ts no longer appears to emit field `{name}` \
                 (searched for literal `{needle}`) — the Rust supervisor's \
                 poll_health_detail() parses this field. If you renamed it in health.ts, \
                 update supervisor.rs's parsing AND contract/cockpit-health-shape.json \
                 together (see contract/README.md)."
            );
        }
    }

    #[test]
    fn poll_health_detail_parsing_matches_fixture_sample() {
        // End-to-end (minus the HTTP hop): the fixture's `sample` object is
        // exactly the kind of JSON body `poll_health_detail` parses at
        // runtime. Exercise the same field-extraction logic here so a change
        // to that logic's field names is caught alongside the source-text
        // scan above.
        let fixture: serde_json::Value =
            serde_json::from_str(HEALTH_SHAPE_FIXTURE).expect("fixture must be valid JSON");
        let sample = fixture
            .get("sample")
            .expect("fixture must declare a `sample` object");

        let db = match sample.get("db").and_then(|v| v.as_str()) {
            Some("ok") => super::DbStatus::Ok,
            Some("degraded") => super::DbStatus::Degraded,
            Some("unreachable") => super::DbStatus::Unreachable,
            _ => super::DbStatus::Unknown,
        };
        assert_eq!(
            db,
            super::DbStatus::Ok,
            "fixture sample's `db` should decode to Ok"
        );

        let process_started_at_ms = sample.get("processStartedAtMs").and_then(|v| v.as_u64());
        assert_eq!(
            process_started_at_ms,
            Some(1_735_689_600_000),
            "fixture sample's `processStartedAtMs` should round-trip through the same \
             `.and_then(|v| v.as_u64())` extraction poll_health_detail() uses"
        );
    }
}
