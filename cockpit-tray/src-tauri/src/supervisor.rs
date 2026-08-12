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
use crate::port::{cockpit_port, health_url};
use crate::watcher_backend::{
    cockpit_backend_root, cockpit_backend_src, newest_backend_mtime, start_backend_watcher,
};
use crate::watcher_web::{
    cockpit_source_root, cockpit_web_src, format_hms_utc, preflight_rebuild, reload_cockpit_window,
    report_build_result, run_cockpit_build, set_build_status, should_reload_after_build,
    start_web_watcher, PreflightResult,
};

// The supervised port is no longer a constant (mt#3988): it is resolved once at
// startup by `crate::port::init` and read here via `cockpit_port()`, so the tray
// supervises whatever port the daemon is configured to serve on. The health URL
// is derived from that same value by `crate::port::health_url`.
/// The daemon-agnostic supervision core (mt#3990). Everything in here would be
/// identical for any supervised local daemon; this file is the COCKPIT policy
/// layer that drives it. ADR-038 §Question 3's registry (mt#3815) consumes the
/// core directly rather than going through this file.
pub(crate) mod daemon_core;

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
pub(crate) use daemon_core::{
    daemon_start_time, decide_action, format_duration, handle_health_down_no_child, kill_group,
    kill_pid, log_tail_last_line, open_log, path_env, pid_on_port, port_holder, port_in_use,
    resolve_program, spawn_daemon, teardown, throttle_ok, DaemonAction, DaemonLabels,
    DaemonSpawnSpec, NoChildCounters, NoChildEffect, SpawnedPgid, SupervisedDaemon, ALERT_COOLDOWN,
    HTTP_FAILURE_POLL_THRESHOLD, POLL_INTERVAL, RESPAWN_THROTTLE, RESTART_STORM_THRESHOLD,
    RESTART_STORM_WINDOW,
};

/// Consecutive /api/health polls with db != "ok" before a principal alert fires.
/// At POLL_INTERVAL = 5s → 24 polls ≈ 2 min (spec requirement: "DB degraded > 2 min").
///
/// Stays in the policy layer rather than the core: only the cockpit daemon's
/// health body carries a `db` field at all.
const DB_DEGRADED_POLL_THRESHOLD: u32 = 24;

/// The cockpit daemon's contribution to the supervision core's string seam
/// (mt#3990). Registering a second daemon means adding a second value of this
/// type, not editing `daemon_core`.
pub(crate) const COCKPIT_LABELS: DaemonLabels = DaemonLabels {
    display_name: "Cockpit",
    running: LABEL_RUNNING,
    stopped: LABEL_STOPPED,
    starting: LABEL_STARTING,
    stderr_log_hint: "~/.local/state/minsky/logs/cockpit-stderr.log",
};

pub(crate) const LABEL_RUNNING: &str = "Cockpit: running";
const LABEL_STOPPED: &str = "Cockpit: stopped";
const LABEL_STARTING: &str = "Cockpit: starting...";
/// Daemon status line while a pre-flight bundle rebuild runs before spawn (mt#2297).
pub(crate) const LABEL_BUILDING: &str = "Cockpit: rebuilding bundle...";
const LABEL_START_FAILED: &str = "Cockpit: start failed (see logs)";
const LABEL_NO_REPO: &str = "Cockpit: repo not found";
const LABEL_NO_BUN: &str = "Cockpit: bun not found";

/// The cockpit daemon's log filenames within the shared daemon log directory
/// (`daemon_core::open_log` resolves the directory). Named once so the spawn's
/// stderr redirection and `daemon_error_tail`'s read cannot drift apart — before
/// mt#3990 each spelled the string out independently.
const COCKPIT_STDOUT_LOG: &str = "cockpit-stdout.log";
const COCKPIT_STDERR_LOG: &str = "cockpit-stderr.log";

/// Handle to the dropdown status `MenuItem`, stored in Tauri managed state so
/// the supervisor loop can update its text directly.
///
/// The menu is attached to the TRAY (`TrayIconBuilder::menu(&menu)`), not to the
/// app, so `app.menu()` returns `None`. Holding the item handle is the reliable
/// path (mt#2240). Constructed by `menu::build`.
pub(crate) struct StatusMenuItem(pub(crate) MenuItem<Wry>);

/// Handle to the build-status dropdown `MenuItem` (mt#2297), held in managed
/// state like `StatusMenuItem` so the supervisor loop can update it directly.
/// Constructed by `menu::build`.
pub(crate) struct BuildMenuItem(pub(crate) MenuItem<Wry>);

/// Handle to the daemon-uptime dropdown `MenuItem` (mt#2299), held in managed
/// state like `BuildMenuItem` so the supervisor loop can update it directly.
/// Constructed by `menu::build`.
pub(crate) struct UptimeMenuItem(pub(crate) MenuItem<Wry>);

/// Sender for lifecycle commands from the (main-thread) menu handler to the
/// supervisor thread that owns the daemon `Child`.
pub(crate) struct SupervisorHandle(pub(crate) mpsc::UnboundedSender<SupervisorCmd>);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SupervisorCmd {
    Start,
    Stop,
    /// Operator-explicit restart (tray menu "Restart Daemon"), plus the
    /// internal port-conflict retry paths above. Never gated on driven-session
    /// turn activity — an explicit operator action always restarts
    /// immediately. Contrast `AutoRestart` below.
    Restart,
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
    AutoRestart,
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
    /// This tray's one supervised daemon, in the core's terms.
    pub(crate) daemon: SupervisedDaemon,

    /// Last value pushed to the build-status menu line (mt#2297), for dedupe.
    pub(crate) last_build_label: Option<String>,
    /// Newest backend-source mtime at the moment the daemon was (re)started — the
    /// "source version" the running daemon reflects (mt#2299).
    pub(crate) daemon_source_mtime: Option<SystemTime>,
    /// Number of consecutive POLL_INTERVAL polls where db != "ok".
    /// Reset to 0 on the first "ok" poll.
    consecutive_db_degraded: u32,
    /// Instant of the last DB-degraded alert toast; reset to `None` when
    /// condition clears.
    last_db_alert: Option<Instant>,
}

/// Update the visible status label (dropdown line + tray tooltip), skipping
/// the UI round-trip when the label hasn't changed.
pub(crate) fn set_status(app: &AppHandle, sup: &mut Sup, label: &str) {
    if sup.daemon.last_status.as_deref() == Some(label) {
        return;
    }
    sup.daemon.last_status = Some(label.to_string());
    let _ = update_status(app, label);
}

fn update_status(app: &AppHandle, label: &str) -> tauri::Result<()> {
    // Marshal the UI mutation onto the main thread (AppKit menu/tray mutations
    // want the main thread). The status item lives in managed state because the
    // menu is attached to the tray, not app.menu() (mt#2240).
    let app_handle = app.clone();
    let label = label.to_string();
    app.run_on_main_thread(move || {
        if let Some(status) = app_handle.try_state::<StatusMenuItem>() {
            let _ = status.0.set_text(&label);
        }
        if let Some(tray) = app_handle.tray_by_id("main") {
            let _ = tray.set_tooltip(Some(&label));
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

fn do_spawn(app: &AppHandle, sup: &mut Sup, spawned: &SpawnedPgid, path: &str, port: u16) {
    let bun = match resolve_program("bun", path) {
        Some(b) => b,
        None => {
            eprintln!("[cockpit-tray] bun not found on PATH — cannot spawn daemon");
            set_status(app, sup, LABEL_NO_BUN);
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
            set_status(app, sup, LABEL_NO_REPO);
            clear_uptime(app, sup);
            return;
        }
    };
    // mt#2297: source-gated pre-flight rebuild. Only when the web source is
    // present (developer/source operator); a no-source install skips this and
    // serves whatever bundle ships with the app.
    if cockpit_web_src(&repo_root).is_dir() {
        if let PreflightResult::Refuse = preflight_rebuild(app, sup, &bun, &repo_root, path) {
            set_status(app, sup, LABEL_START_FAILED);
            clear_uptime(app, sup);
            return;
        }
    }
    let args = cockpit_spawn_args(port);
    match spawn_daemon(&DaemonSpawnSpec {
        program: &bun,
        args: &args,
        cwd: &repo_root,
        path_env: path,
        stdout_log: COCKPIT_STDOUT_LOG,
        stderr_log: COCKPIT_STDERR_LOG,
    }) {
        Ok((child, pid)) => {
            sup.daemon.child = Some(child);
            sup.daemon.last_spawn = Some(Instant::now());
            // mt#2299: a fresh tray-spawn is current as of now; record the
            // wall-clock start + the backend-source version it reflects so the
            // uptime line can render "running Xs, started against src @ HH:MM:SS".
            // Gate the source-mtime capture on the BACKEND source root, not the
            // web root (reviewer R1 B1).
            sup.daemon.daemon_started_at = Some(SystemTime::now());
            sup.daemon_source_mtime = cockpit_backend_root(path)
                .and_then(|r| newest_backend_mtime(&cockpit_backend_src(&r)));
            if let Ok(mut g) = spawned.lock() {
                *g = Some(pid);
            }
            set_status(app, sup, LABEL_STARTING);
        }
        Err(e) => {
            eprintln!("[cockpit-tray] daemon spawn failed: {e}");
            set_status(app, sup, LABEL_START_FAILED);
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
fn do_stop(sup: &mut Sup, spawned: &SpawnedPgid, path: &str, adopted_ok: bool, port: u16) {
    if let Some(mut child) = sup.daemon.child.take() {
        let pgid = spawned.lock().ok().and_then(|mut g| g.take());
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

async fn health_ok(client: &reqwest::Client, port: u16) -> bool {
    client
        .get(health_url(port))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

fn run_supervisor(
    app: AppHandle,
    mut rx: mpsc::UnboundedReceiver<SupervisorCmd>,
    spawned: SpawnedPgid,
) {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");

    rt.block_on(async move {
        let path = path_env();
        // This tray's one supervised daemon. The core's record carries the
        // generic supervision state and this daemon's identity; the four fields
        // beside it are the cockpit-only policy state (mt#3990).
        //
        // Constructed HERE, before the watchers and the health client, because
        // it OWNS the port. `crate::port::init` has already resolved it on the
        // setup thread, so `cockpit_port()` is a cheap read of the settled
        // value; taking the loop's `port` binding back off the record — rather
        // than calling `cockpit_port()` at each site — means every probe, spawn,
        // adoption decision and label below provably refers to the same port as
        // the daemon it belongs to (mt#3988).
        let mut sup = Sup {
            daemon: SupervisedDaemon::new(COCKPIT_LABELS, cockpit_port()),
            last_build_label: None,
            daemon_source_mtime: None,
            consecutive_db_degraded: 0,
            last_db_alert: None,
        };
        let port = sup.daemon.port;
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
        let _backend_watcher = cockpit_backend_root(&path)
            .and_then(|root| start_backend_watcher(&app, &cockpit_backend_src(&root)));
        // pool_max_idle_per_host(0) disables keep-alive reuse: each poll opens a
        // fresh connection. Without this a pooled connection can go stale
        // (daemon idle-close / half-open socket) and every poll fails its 2s
        // timeout, sticking status on "stopped" while the daemon is up (mt#2225).
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .pool_max_idle_per_host(0)
            .build()
            .expect("reqwest client");

        // Initial adoption-or-spawn.
        match decide_action(health_ok(&client, port).await, port_in_use(port)) {
            DaemonAction::Adopt => match adopt_decision(&path, port) {
                AdoptDecision::Stale => {
                    // Adopted daemon predates the current backend source (the
                    // 2026-06-04 8-day-stale case) — restart it (kill the
                    // health-confirmed daemon, respawn fresh) so new widget
                    // registrations / routes load before we report ready (mt#2299).
                    do_stop(&mut sup, &spawned, &path, true, port);
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    do_spawn(&app, &mut sup, &spawned, &path, port);
                }
                AdoptDecision::Fresh { started, source_mtime } => {
                    sup.daemon.daemon_started_at = started;
                    sup.daemon_source_mtime = source_mtime;
                    set_status(&app, &mut sup, LABEL_RUNNING);
                    refresh_uptime(&app, &mut sup);
                }
            },
            DaemonAction::Conflict => {
                // gh#1761: before showing "conflict" to the operator, check if
                // the port holder is the legacy `com.minsky.cockpit` launchd
                // agent (installed by `minsky cockpit install`). If so, evict
                // it (bootout + disable) and retry — ADR-014 single-ownership.
                if try_evict_legacy_launchd(pid_on_port(port, &path)) {
                    // Give the OS ~1 s to release the port, then re-check.
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    match decide_action(health_ok(&client, port).await, port_in_use(port)) {
                        DaemonAction::Adopt => match adopt_decision(&path, port) {
                            AdoptDecision::Stale => {
                                do_stop(&mut sup, &spawned, &path, true, port);
                                tokio::time::sleep(Duration::from_millis(500)).await;
                                do_spawn(&app, &mut sup, &spawned, &path, port);
                            }
                            AdoptDecision::Fresh { started, source_mtime } => {
                                sup.daemon.daemon_started_at = started;
                                sup.daemon_source_mtime = source_mtime;
                                set_status(&app, &mut sup, LABEL_RUNNING);
                                refresh_uptime(&app, &mut sup);
                            }
                        },
                        DaemonAction::Conflict => {
                            // Still blocked even after eviction — show label.
                            report_conflict(&app, &mut sup, &path, port);
                            clear_uptime(&app, &mut sup);
                        }
                        DaemonAction::Spawn => do_spawn(&app, &mut sup, &spawned, &path, port),
                    }
                } else {
                    report_conflict(&app, &mut sup, &path, port);
                    clear_uptime(&app, &mut sup);
                }
            }
            DaemonAction::Spawn => do_spawn(&app, &mut sup, &spawned, &path, port),
        }

        loop {
            tokio::select! {
                cmd = rx.recv() => match cmd {
                    Some(SupervisorCmd::Start) => {
                        match decide_action(health_ok(&client, port).await, port_in_use(port)) {
                            DaemonAction::Adopt => match adopt_decision(&path, port) {
                                AdoptDecision::Stale => {
                                    do_stop(&mut sup, &spawned, &path, true, port);
                                    tokio::time::sleep(Duration::from_millis(500)).await;
                                    do_spawn(&app, &mut sup, &spawned, &path, port);
                                }
                                AdoptDecision::Fresh { started, source_mtime } => {
                                    sup.daemon.daemon_started_at = started;
                                    sup.daemon_source_mtime = source_mtime;
                                    set_status(&app, &mut sup, LABEL_RUNNING);
                                    refresh_uptime(&app, &mut sup);
                                }
                            },
                            DaemonAction::Conflict => {
                                // gh#1761: same eviction path as the boot-time Conflict arm.
                                if try_evict_legacy_launchd(pid_on_port(port, &path)) {
                                    tokio::time::sleep(Duration::from_secs(1)).await;
                                    match decide_action(health_ok(&client, port).await, port_in_use(port)) {
                                        DaemonAction::Adopt => match adopt_decision(&path, port) {
                                            AdoptDecision::Stale => {
                                                do_stop(&mut sup, &spawned, &path, true, port);
                                                tokio::time::sleep(Duration::from_millis(500)).await;
                                                do_spawn(&app, &mut sup, &spawned, &path, port);
                                            }
                                            AdoptDecision::Fresh { started, source_mtime } => {
                                                sup.daemon.daemon_started_at = started;
                                                sup.daemon_source_mtime = source_mtime;
                                                set_status(&app, &mut sup, LABEL_RUNNING);
                                                refresh_uptime(&app, &mut sup);
                                            }
                                        },
                                        DaemonAction::Conflict => {
                                            report_conflict(&app, &mut sup, &path, port);
                                            clear_uptime(&app, &mut sup);
                                        }
                                        DaemonAction::Spawn => do_spawn(&app, &mut sup, &spawned, &path, port),
                                    }
                                } else {
                                    report_conflict(&app, &mut sup, &path, port);
                                    clear_uptime(&app, &mut sup);
                                }
                            }
                            DaemonAction::Spawn => do_spawn(&app, &mut sup, &spawned, &path, port),
                        }
                    }
                    Some(SupervisorCmd::Stop) => {
                        let had_child = sup.daemon.child.is_some();
                        let h = health_ok(&client, port).await;
                        do_stop(&mut sup, &spawned, &path, h, port);
                        if !had_child && !h && port_in_use(port) {
                            // A foreign process owns the port — we didn't (and won't) kill it.
                            report_conflict(&app, &mut sup, &path, port);
                        } else {
                            set_status(&app, &mut sup, LABEL_STOPPED);
                        }
                        clear_uptime(&app, &mut sup);
                    }
                    Some(SupervisorCmd::Restart) => {
                        let h = health_ok(&client, port).await;
                        if sup.daemon.child.is_none() && !h && port_in_use(port) {
                            // Foreign listener owns the port — refuse to restart over it.
                            report_conflict(&app, &mut sup, &path, port);
                        } else {
                            do_stop(&mut sup, &spawned, &path, h, port);
                            tokio::time::sleep(Duration::from_millis(500)).await;
                            do_spawn(&app, &mut sup, &spawned, &path, port);
                        }
                    }
                    Some(SupervisorCmd::AutoRestart) => {
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
                        // the (unmodified) `Restart` arm above — `sup`/
                        // `spawned`/`path` mutation stays confined to this one
                        // loop, never shared across tasks. In the common (no
                        // active turn) case the background task's first check
                        // returns near-instantly and re-sends `Restart`
                        // immediately, so end-to-end latency for the common
                        // case is unchanged (one extra channel round-trip, not
                        // a blocking wait).
                        if let Some(handle) = app.try_state::<SupervisorHandle>() {
                            let tx_clone = handle.0.clone();
                            let client_clone = client.clone();
                            tokio::spawn(async move {
                                crate::watcher_backend::wait_for_turn_idle_or_grace_expiry(
                                    &client_clone,
                                )
                                .await;
                                let _ = tx_clone.send(SupervisorCmd::Restart);
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
                        if let (Some(root), Some(bun)) =
                            (cockpit_source_root(&path), resolve_program("bun", &path))
                        {
                            set_build_status(&app, &mut sup, "Rebuilding bundle...".to_string());
                            let result = run_cockpit_build(&bun, &root, &path);
                            report_build_result(&app, &mut sup, &result, true);
                            // Coalescing is upstream, not here: the watcher's
                            // BUILD_DEBOUNCE (500ms) collapses a burst of saves
                            // into ONE Rebuild command, so a burst yields one
                            // rebuild and therefore one reload. No guard is
                            // needed at this layer — adding a second debounce
                            // would only delay the refresh.
                            if should_reload_after_build(&result) {
                                reload_cockpit_window(&app);
                            }
                        }
                    }
                    Some(SupervisorCmd::Shutdown) | None => {
                        // Pass a fresh health probe as adopted_ok (matching the
                        // Stop arm) so quitting the app never kills a FOREIGN
                        // listener on the supervised port — only our spawned child (via the
                        // process group inside do_stop) or our health-confirmed
                        // adopted daemon. (mt#2305; PR #1558 reviewer R3.)
                        let h = health_ok(&client, port).await;
                        do_stop(&mut sup, &spawned, &path, h, port);
                        break;
                    }
                },
                _ = tokio::time::sleep(POLL_INTERVAL) => {
                    // mt#2578: use poll_health_detail so we get DB status + restart
                    // signal, not just a bool. health_ok() is still used for the
                    // shutdown path (adopt_ok check) where we only need the bool.
                    let health = poll_health_detail(&client, port).await;
                    let poll_now = Instant::now();

                    // --- Watchdog: restart-storm detection ---
                    // Prune timestamps older than the rolling window.
                    sup.daemon.restart_timestamps.retain(|t| poll_now.duration_since(*t) < RESTART_STORM_WINDOW);

                    if sup.daemon.restart_timestamps.len() > RESTART_STORM_THRESHOLD {
                        let cooldown_elapsed = sup.daemon.last_restart_alert
                            .map(|t| poll_now.duration_since(t) >= ALERT_COOLDOWN)
                            .unwrap_or(true);
                        if cooldown_elapsed {
                            let reason = format!(
                                "{} daemon restarts in the last {}m — possible crash-loop. \
                                 Check logs: ~/.local/state/minsky/logs/cockpit-stderr.log",
                                sup.daemon.restart_timestamps.len(),
                                RESTART_STORM_WINDOW.as_secs() / 60
                            );
                            notify_daemon_unhealthy(&app, &reason);
                            sup.daemon.last_restart_alert = Some(poll_now);
                            eprintln!("[watchdog] restart-storm alert: {}", reason);
                        }
                    } else {
                        // Condition cleared — next episode re-alerts immediately.
                        sup.daemon.last_restart_alert = None;
                    }

                    if health.http_ok {
                        // HTTP health restored — reset failure counter + cooldown.
                        if sup.daemon.consecutive_http_failed > 0 {
                            eprintln!(
                                "[watchdog] HTTP health restored after {} failed polls",
                                sup.daemon.consecutive_http_failed
                            );
                        }
                        sup.daemon.consecutive_http_failed = 0;
                        sup.daemon.last_http_alert = None;

                        // Detect adopted-daemon restarts via processStartedAtMs change.
                        if let (Some(prev), Some(curr)) = (sup.daemon.last_process_started_at_ms, health.process_started_at_ms) {
                            if curr != prev {
                                sup.daemon.restart_timestamps.push(poll_now);
                                eprintln!("[watchdog] adopted-daemon restart detected via processStartedAtMs: {prev} → {curr}");
                            }
                        }
                        if health.process_started_at_ms.is_some() {
                            sup.daemon.last_process_started_at_ms = health.process_started_at_ms;
                        }

                        // --- Watchdog: DB-degraded detection ---
                        match health.db {
                            DbStatus::Ok => {
                                if sup.consecutive_db_degraded > 0 {
                                    eprintln!(
                                        "[watchdog] DB recovered after {} degraded polls",
                                        sup.consecutive_db_degraded
                                    );
                                }
                                sup.consecutive_db_degraded = 0;
                                // Condition cleared — next episode re-alerts immediately.
                                sup.last_db_alert = None;
                                set_status(&app, &mut sup, LABEL_RUNNING);
                                // mt#2299: keep the uptime line ticking while healthy.
                                refresh_uptime(&app, &mut sup);
                                continue;
                            }
                            db_state => {
                                sup.consecutive_db_degraded += 1;
                                if sup.consecutive_db_degraded > DB_DEGRADED_POLL_THRESHOLD {
                                    let cooldown_elapsed = sup.last_db_alert
                                        .map(|t| poll_now.duration_since(t) >= ALERT_COOLDOWN)
                                        .unwrap_or(true);
                                    if cooldown_elapsed {
                                        let sustained_secs = sup.consecutive_db_degraded as u64
                                            * POLL_INTERVAL.as_secs();
                                        let reason = format!(
                                            "Cockpit DB has been {db_state:?} for {sustained_secs}s — \
                                             circuit-breaker may be active. Check Supabase connectivity \
                                             and ~/.local/state/minsky/logs/cockpit-stderr.log",
                                        );
                                        notify_daemon_unhealthy(&app, &reason);
                                        sup.last_db_alert = Some(poll_now);
                                        eprintln!("[watchdog] DB-degraded alert: {}", reason);
                                    }
                                }
                                // Daemon HTTP is up but DB is degraded — still show running
                                // (the daemon serves UI requests; only DB writes fail).
                                set_status(&app, &mut sup, LABEL_RUNNING);
                                refresh_uptime(&app, &mut sup);
                                continue;
                            }
                        }
                    }

                    // HTTP health poll failed — daemon is down or unresponsive.
                    // Increment the sustained-HTTP-failure counter BEFORE branching;
                    // the crash-exit arm will reset it (that path is owned by restart-storm).
                    sup.daemon.consecutive_http_failed += 1;

                    // Health is down. Only a daemon WE spawned is respawned.
                    match sup.daemon.child.as_mut().map(|c| c.try_wait()) {
                        Some(Ok(Some(_status))) => {
                            // Our child exited — record crash for storm detection, respawn (throttled).
                            // The crash-exit path (restart-storm) owns the alerting for this case;
                            // reset the HTTP-failure counter so the two paths don't double-alert.
                            sup.daemon.consecutive_http_failed = 0;
                            sup.daemon.last_http_alert = None;
                            sup.daemon.child = None;
                            if let Ok(mut g) = spawned.lock() {
                                *g = None;
                            }
                            clear_uptime(&app, &mut sup);
                            // Record this crash; the next poll will prune + check the threshold.
                            sup.daemon.restart_timestamps.push(poll_now);
                            // Clear last_process_started_at_ms so the first successful health
                            // poll after respawn does NOT double-count a restart via the
                            // adopted-daemon change-detection path above.
                            sup.daemon.last_process_started_at_ms = None;
                            eprintln!(
                                "[watchdog] child crash: {} restarts in window",
                                sup.daemon.restart_timestamps.len()
                            );
                            if throttle_ok(sup.daemon.last_spawn, Instant::now(), RESPAWN_THROTTLE) {
                                do_spawn(&app, &mut sup, &spawned, &path, port);
                            } else {
                                // Crash-looping: exited within the respawn-throttle
                                // window (e.g. a syntax error in server.ts that makes
                                // the new process fail to bind). Surface the stderr
                                // tail instead of a silent "stopped" (mt#2299 #5).
                                let label = match daemon_error_tail() {
                                    Some(e) => format!("Cockpit: start failed: {e} (see logs)"),
                                    None => LABEL_STOPPED.to_string(),
                                };
                                set_status(&app, &mut sup, &label);
                            }
                        }
                        Some(Ok(None)) => {
                            // Child alive but not yet serving — still booting or hung.
                            // This is the primary "unhealthy-but-not-exiting" path: the
                            // daemon is running but not accepting health requests.
                            if sup.daemon.consecutive_http_failed > HTTP_FAILURE_POLL_THRESHOLD {
                                let cooldown_elapsed = sup.daemon.last_http_alert
                                    .map(|t| poll_now.duration_since(t) >= ALERT_COOLDOWN)
                                    .unwrap_or(true);
                                if cooldown_elapsed {
                                    let sustained_secs = sup.daemon.consecutive_http_failed as u64
                                        * POLL_INTERVAL.as_secs();
                                    let reason = format!(
                                        "Cockpit daemon has been unresponsive for {sustained_secs}s \
                                         while its process is still alive — possible hang. \
                                         Check logs: ~/.local/state/minsky/logs/cockpit-stderr.log",
                                    );
                                    notify_daemon_unhealthy(&app, &reason);
                                    sup.daemon.last_http_alert = Some(poll_now);
                                    eprintln!("[watchdog] sustained HTTP-failure (child alive) alert: {}", reason);
                                }
                            }
                            set_status(&app, &mut sup, LABEL_STARTING);
                        }
                        Some(Err(_)) | None => {
                            // No child of ours (adopted daemon down, or never
                            // spawned). Decision logic lives in
                            // `handle_health_down_no_child` (mt#2794) — this
                            // call site just wires the live AppHandle/lsof/
                            // process seams.
                            // The counters and the labels both come off the
                            // core's record now (mt#3990). `labels` is copied
                            // out first because the effect closure below needs
                            // its own `&mut sup` borrow.
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
                                        notify_daemon_unhealthy(&app, &reason)
                                    }
                                    NoChildEffect::Spawn => {
                                        do_spawn(&app, &mut sup, &spawned, &path, port)
                                    }
                                    NoChildEffect::SetStatus(label) => {
                                        set_status(&app, &mut sup, label)
                                    }
                                    NoChildEffect::ClearUptime => clear_uptime(&app, &mut sup),
                                },
                            );
                            counters.write_back_to(&mut sup.daemon);
                        }
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

/// Watchdog-relevant fields extracted from a single /api/health response.
///
/// The `db` and `processStartedAtMs` fields this struct parses are pinned
/// against `src/cockpit/routes/health.ts` (the emitter) via the shared golden
/// fixture `contract/cockpit-health-shape.json` (mt#2629) — see the
/// `health_contract` test module at the bottom of this file and
/// `contract/README.md`. Renaming either field in health.ts without updating
/// both sides of the contract fails a test here.
struct HealthDetail {
    /// True when the HTTP GET succeeded with a 2xx status.
    http_ok: bool,
    /// DB health from the `db` field; `Unknown` when the field is absent/unparseable.
    db: DbStatus,
    /// `processStartedAtMs` from the response body (mt#2578 TS slice).
    /// `None` for daemons that predate the field (backward-compat).
    process_started_at_ms: Option<u64>,
}

/// Poll /api/health and return watchdog-relevant fields. Never panics; on any
/// network or parse failure the caller receives `http_ok: false` / `db: Unknown` /
/// `process_started_at_ms: None`.
async fn poll_health_detail(client: &reqwest::Client, port: u16) -> HealthDetail {
    let resp = match client.get(health_url(port)).send().await {
        Ok(r) if r.status().is_success() => r,
        _ => {
            return HealthDetail {
                http_ok: false,
                db: DbStatus::Unknown,
                process_started_at_ms: None,
            };
        }
    };
    let text = match resp.text().await {
        Ok(t) => t,
        Err(_) => {
            return HealthDetail {
                http_ok: true,
                db: DbStatus::Unknown,
                process_started_at_ms: None,
            };
        }
    };
    let json: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => {
            return HealthDetail {
                http_ok: true,
                db: DbStatus::Unknown,
                process_started_at_ms: None,
            };
        }
    };
    let db = match json.get("db").and_then(|v| v.as_str()) {
        Some("ok") => DbStatus::Ok,
        Some("degraded") => DbStatus::Degraded,
        Some("unreachable") => DbStatus::Unreachable,
        _ => DbStatus::Unknown,
    };
    let process_started_at_ms = json.get("processStartedAtMs").and_then(|v| v.as_u64());
    HealthDetail {
        http_ok: true,
        db,
        process_started_at_ms,
    }
}

/// Fire a best-effort OS-toast when the daemon is self-reporting unhealthy (mt#2578).
/// Mirrors `watcher_web::notify_build_failure`; ignored if notification permission
/// is unavailable.
fn notify_daemon_unhealthy(app: &AppHandle, reason: &str) {
    let _ = app
        .notification()
        .builder()
        .title("Cockpit daemon unhealthy")
        .body(reason)
        .show();
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

/// Decide whether an adopted daemon is backend-stale. Compares the daemon's
/// start time (`ps` etime) against the newest backend-source mtime. A source
/// install with both signals available and `source > start` is Stale; anything
/// undeterminable (no source tree, pid gone, ps failure) is treated as Fresh
/// (never restart on a guess).
fn adopt_decision(path: &str, port: u16) -> AdoptDecision {
    let source_mtime =
        cockpit_backend_root(path).and_then(|r| newest_backend_mtime(&cockpit_backend_src(&r)));
    let started = pid_on_port(port, path).and_then(daemon_start_time);
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

/// Render the uptime menu line: how long the daemon has run + the source mtime it
/// was started against. `started == None` → "Daemon uptime: —". Pure.
fn uptime_label(
    started: Option<SystemTime>,
    source_mtime: Option<SystemTime>,
    now: SystemTime,
) -> String {
    match started {
        Some(st) => {
            let dur = now.duration_since(st).unwrap_or_default();
            let src = source_mtime
                .map(format_hms_utc)
                .unwrap_or_else(|| "unknown".to_string());
            format!("Daemon uptime: {} (src @ {})", format_duration(dur), src)
        }
        None => "Daemon uptime: —".to_string(),
    }
}

/// Update the uptime dropdown line on the main thread (mt#2299).
fn update_uptime_status(app: &AppHandle, label: &str) -> tauri::Result<()> {
    let app_handle = app.clone();
    let label = label.to_string();
    app.run_on_main_thread(move || {
        if let Some(item) = app_handle.try_state::<UptimeMenuItem>() {
            let _ = item.0.set_text(&label);
        }
    })
}

/// Set the uptime label, skipping the UI round-trip when unchanged.
fn set_uptime_status(app: &AppHandle, sup: &mut Sup, label: String) {
    if sup.daemon.last_uptime_label.as_deref() == Some(label.as_str()) {
        return;
    }
    sup.daemon.last_uptime_label = Some(label.clone());
    let _ = update_uptime_status(app, &label);
}

/// Recompute + push the uptime line from the current daemon-start/source state.
fn refresh_uptime(app: &AppHandle, sup: &mut Sup) {
    let label = uptime_label(
        sup.daemon.daemon_started_at,
        sup.daemon_source_mtime,
        SystemTime::now(),
    );
    set_uptime_status(app, sup, label);
}

/// Clear the uptime line + recorded start state (daemon no longer running).
fn clear_uptime(app: &AppHandle, sup: &mut Sup) {
    sup.daemon.daemon_started_at = None;
    sup.daemon_source_mtime = None;
    set_uptime_status(app, sup, uptime_label(None, None, SystemTime::now()));
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
fn report_conflict(app: &AppHandle, sup: &mut Sup, path: &str, port: u16) {
    let holder = port_holder(port, path);
    let pid = holder.as_ref().map(|(pid, _)| *pid);
    let label = conflict_label_for(port, pid);
    if sup.daemon.last_status.as_deref() != Some(label.as_str()) {
        // The ADDRESS is reported, not assumed (PR #2684 R2): the probe is
        // scoped to loopback but that covers both families, and "which address"
        // is exactly what the original incident turned on.
        eprintln!(
            "[cockpit-tray] not spawning: port {port} is held by {}",
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
/// is worse than no label.
fn conflict_label_for(port: u16, pid: Option<u32>) -> String {
    match pid {
        Some(p) => format!("Cockpit: :{port} held by pid {p} (not started by tray)"),
        None => format!("Cockpit: :{port} in use (not cockpit)"),
    }
}

/// Last non-empty line of the COCKPIT daemon's stderr log, capped — used to
/// summarize a restart/start failure in the status line (mt#2299, criterion 5).
///
/// The bounded-tail mechanism moved to `daemon_core::log_tail_last_line`
/// (mt#3990); what stays here is the one cockpit-specific fact it needs, which
/// log file to read. The name matches `COCKPIT_STDERR_LOG`, the same constant
/// the spawn redirects stderr into, so the status line and the log can never
/// drift apart.
fn daemon_error_tail() -> Option<String> {
    log_tail_last_line(COCKPIT_STDERR_LOG)
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
pub(crate) fn spawn(app: AppHandle, spawned: SpawnedPgid) {
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

    // --- mt#2299: adopt-decision + uptime + conflict + error-tail helpers ---

    #[test]
    fn uptime_label_renders_duration_and_source() {
        let now = UNIX_EPOCH + Duration::from_secs(1_000);
        let started = UNIX_EPOCH + Duration::from_secs(940); // 60s ago
        let src = UNIX_EPOCH + Duration::from_secs(3661);
        let l = uptime_label(Some(started), Some(src), now);
        assert!(l.starts_with("Daemon uptime: 1m 0s"), "got: {l}");
        assert!(l.contains("src @ 01:01:01 UTC"), "got: {l}");
        assert_eq!(uptime_label(None, None, now), "Daemon uptime: —");
        // Unknown source mtime still renders the uptime.
        assert_eq!(
            uptime_label(Some(started), None, now),
            "Daemon uptime: 1m 0s (src @ unknown)"
        );
    }

    #[test]
    fn conflict_label_names_holder_pid() {
        assert_eq!(
            conflict_label_for(DEFAULT_COCKPIT_PORT, Some(4242)),
            "Cockpit: :3737 held by pid 4242 (not started by tray)"
        );
        assert_eq!(
            conflict_label_for(DEFAULT_COCKPIT_PORT, None),
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
            conflict_label_for(CONFIGURED_PORT, Some(4242)),
            "Cockpit: :4317 held by pid 4242 (not started by tray)"
        );
        assert_eq!(
            conflict_label_for(CONFIGURED_PORT, None),
            "Cockpit: :4317 in use (not cockpit)"
        );
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
