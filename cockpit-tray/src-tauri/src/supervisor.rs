// Daemon supervisor: spawn/detect/kill/health-poll, the self-health watchdog
// (mt#2578), and the process-management + repo/PATH-resolution primitives it's
// built from. Owns `Sup`, the mutable state driven by `run_supervisor` on its
// own OS thread, and the menu-item handles the supervisor pushes status text
// to (constructed by `menu::build`). Split out of main.rs (mt#2628); see
// docs/architecture/adr-014-cockpit-daemon-lifecycle-ownership.md.

use std::fs::{File, OpenOptions};
use std::io;
#[cfg(unix)]
use std::os::unix::process::CommandExt; // process_group
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use tauri::menu::MenuItem;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::mpsc;

use crate::launchd::try_evict_legacy_launchd;
use crate::watcher_backend::{
    cockpit_backend_root, cockpit_backend_src, newest_backend_mtime, start_backend_watcher,
};
use crate::watcher_web::{
    cockpit_source_root, cockpit_web_src, format_hms_utc, preflight_rebuild, report_build_result,
    run_cockpit_build, set_build_status, start_web_watcher, PreflightResult,
};

pub(crate) const DAEMON_PORT: u16 = 3737;
pub(crate) const HEALTH_URL: &str = "http://localhost:3737/api/health";
const POLL_INTERVAL: Duration = Duration::from_secs(5);
/// Minimum gap between successive respawns of a crashed daemon. Mirrors the
/// launchd plist's `ThrottleInterval: 5` so a crash-loop doesn't spawn-storm.
const RESPAWN_THROTTLE: Duration = Duration::from_secs(5);

// ---------------------------------------------------------------------------
// Self-health watchdog constants (mt#2578).
//
// Calibrated per CLAUDE.md §MCP disconnect cadence: the session threshold is
// >1 eligible disconnect per MCP connection, daily >3 in 24h.  The watchdog
// intentionally uses a tighter window / lower count because the 2026-06-27
// incident hit 49,650 launchd restarts before any alert fired — early warning
// is the explicit design goal.
// ---------------------------------------------------------------------------

/// Rolling window for daemon restart-storm detection.
const RESTART_STORM_WINDOW: Duration = Duration::from_secs(600); // 10 min
/// Daemon-crash restarts within RESTART_STORM_WINDOW that trigger a principal alert.
const RESTART_STORM_THRESHOLD: usize = 3;
/// Consecutive /api/health polls with db != "ok" before a principal alert fires.
/// At POLL_INTERVAL = 5s → 24 polls ≈ 2 min (spec requirement: "DB degraded > 2 min").
const DB_DEGRADED_POLL_THRESHOLD: u32 = 24;
/// Consecutive /api/health polls returning HTTP failure while the daemon child is
/// alive (or an adopted daemon is expected) but the endpoint is unresponsive. This
/// targets the unhealthy-but-not-exiting case (slow start, persistent hang, adopted
/// daemon silently stopped) — distinct from the restart-storm path which handles
/// the crash-and-exit case. At 5s/poll → 12 polls ≈ 1 min.
const HTTP_FAILURE_POLL_THRESHOLD: u32 = 12;
/// mt#2786: consecutive failed polls with NO child of ours before the supervisor
/// TAKES OVER a dead adopted daemon (spawns its own). 2× the alert threshold
/// (≈ 2 min at 5s/poll): the alert fires first, and an operator mid-manual-restart
/// has a comfortable window before the tray steps in — plus the port-free check
/// below, which is the real operator-race guard.
const ADOPTED_TAKEOVER_POLL_THRESHOLD: u32 = HTTP_FAILURE_POLL_THRESHOLD * 2;
/// Minimum gap between repeated toasts for the SAME ACTIVE condition.
/// Resets when the condition clears so the NEXT episode re-alerts immediately.
const ALERT_COOLDOWN: Duration = Duration::from_secs(900); // 15 min

pub(crate) const LABEL_RUNNING: &str = "Cockpit: running";
const LABEL_STOPPED: &str = "Cockpit: stopped";
const LABEL_STARTING: &str = "Cockpit: starting...";
/// Daemon status line while a pre-flight bundle rebuild runs before spawn (mt#2297).
pub(crate) const LABEL_BUILDING: &str = "Cockpit: rebuilding bundle...";
const LABEL_CONFLICT: &str = "Cockpit: :3737 in use (not cockpit)";
const LABEL_START_FAILED: &str = "Cockpit: start failed (see logs)";
const LABEL_NO_REPO: &str = "Cockpit: repo not found";
const LABEL_NO_BUN: &str = "Cockpit: bun not found";

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

/// Process-group id of the daemon WE spawned (`None` if adopted or not
/// running). Shared so the quit / `RunEvent::Exit` path can tear it down
/// synchronously even if the supervisor thread doesn't get to process a
/// Shutdown command before the process exits.
pub(crate) type SpawnedPgid = Arc<Mutex<Option<u32>>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SupervisorCmd {
    Start,
    Stop,
    Restart,
    Shutdown,
    /// A cockpit-web source file changed at runtime — rebuild the bundle
    /// without disturbing the running daemon (mt#2297).
    Rebuild,
}

/// What to do for a port that may or may not already be serving our daemon.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DaemonAction {
    /// Our health endpoint answers — monitor the existing daemon, don't spawn.
    Adopt,
    /// Nothing is listening — safe to spawn.
    Spawn,
    /// Something is listening but it's not our daemon — don't spawn, surface it.
    Conflict,
}

// ---------------------------------------------------------------------------
// Pure logic (unit-tested without the Tauri runtime — mt#2226).
// ---------------------------------------------------------------------------

/// Map a health-poll result to the status label.
fn status_label(healthy: bool) -> &'static str {
    if healthy {
        LABEL_RUNNING
    } else {
        LABEL_STOPPED
    }
}

/// Decide what to do at startup / on an explicit Start, given whether our
/// health endpoint answers and whether *anything* is listening on the port.
/// Health-OK always wins (it's the strongest signal it's our daemon), even if
/// the port also shows a listener.
fn decide_action(health_ok: bool, port_in_use: bool) -> DaemonAction {
    if health_ok {
        DaemonAction::Adopt
    } else if port_in_use {
        DaemonAction::Conflict
    } else {
        DaemonAction::Spawn
    }
}

/// True when enough time has elapsed since the last spawn to respawn again.
fn throttle_ok(last_spawn: Option<Instant>, now: Instant, min: Duration) -> bool {
    match last_spawn {
        Some(t) => now.duration_since(t) >= min,
        None => true,
    }
}

/// mt#2786: whether the supervisor should take over after an adopted (or
/// never-spawned) daemon has been unresponsive for a sustained window. The
/// original design NEVER respawned over an adopted daemon ("don't fight an
/// operator restarting it manually") — which left the cockpit down
/// indefinitely once an adopted daemon died (observed 2026-07-13: 9+ min dead
/// port, manual restart required). Takeover requires ALL of:
/// - the outage is sustained past ADOPTED_TAKEOVER_POLL_THRESHOLD (the 1-min
///   alert has already fired by then), AND
/// - the port is FREE — an operator mid-restart (or any replacement daemon)
///   holds the port, so this preserves the original conservatism, AND
/// - the respawn throttle permits.
fn should_takeover_adopted(consecutive_http_failed: u32, port_held: bool, throttle_ok: bool) -> bool {
    consecutive_http_failed > ADOPTED_TAKEOVER_POLL_THRESHOLD && !port_held && throttle_ok
}

/// Build a PATH that includes the common locations a GUI app (launched from
/// /Applications with a minimal PATH) won't otherwise have, so `minsky` / `bun`
/// / `lsof` resolve. Mirrors the launchd plist's PATH handling
/// (`src/cockpit/launchd.ts`). Existing entries are preserved and de-duped.
fn augmented_path(home: &str, existing: &str) -> String {
    let mut parts: Vec<String> = vec![
        format!("{home}/.bun/bin"),
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
        format!("{home}/.local/bin"),
        "/usr/bin".to_string(),
        "/bin".to_string(),
        "/usr/sbin".to_string(),
        "/sbin".to_string(),
    ];
    for p in existing.split(':') {
        if !p.is_empty() && !parts.iter().any(|x| x == p) {
            parts.push(p.to_string());
        }
    }
    parts.join(":")
}

/// Parse the first PID from `lsof -ti` output (newline-separated PIDs).
fn parse_lsof_pid(output: &str) -> Option<u32> {
    output
        .lines()
        .filter_map(|l| l.trim().parse::<u32>().ok())
        .next()
}

// ---------------------------------------------------------------------------
// Process helpers (use std::process; not unit-tested — exercised live).
// ---------------------------------------------------------------------------

fn home() -> String {
    std::env::var("HOME").unwrap_or_default()
}

/// Non-empty `$HOME`, or `None`. Used where an empty HOME must NOT degrade to a
/// relative/system path (e.g. resolving the per-user launchd plist).
fn home_dir() -> Option<String> {
    match std::env::var("HOME") {
        Ok(h) if !h.is_empty() => Some(h),
        _ => None,
    }
}

fn path_env() -> String {
    augmented_path(&home(), &std::env::var("PATH").unwrap_or_default())
}

fn log_dir() -> PathBuf {
    Path::new(&home()).join(".local/state/minsky/logs")
}

pub(crate) fn open_log(name: &str) -> io::Result<File> {
    let dir = log_dir();
    std::fs::create_dir_all(&dir)?;
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(name))
}

/// Find an executable by name on the given PATH string.
fn resolve_program(name: &str, path: &str) -> Option<PathBuf> {
    for dir in path.split(':') {
        if dir.is_empty() {
            continue;
        }
        let cand = Path::new(dir).join(name);
        if is_executable(&cand) {
            return Some(cand);
        }
    }
    None
}

/// True when `p` is a regular file with at least one execute bit set.
#[cfg(unix)]
fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    p.is_file()
        && std::fs::metadata(p)
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(p: &Path) -> bool {
    p.is_file()
}

fn lsof_bin(path: &str) -> PathBuf {
    resolve_program("lsof", path)
        .or_else(|| {
            ["/usr/sbin/lsof", "/usr/bin/lsof", "/sbin/lsof"]
                .iter()
                .map(PathBuf::from)
                .find(|p| p.is_file())
        })
        .unwrap_or_else(|| PathBuf::from("/usr/sbin/lsof"))
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

/// The PID of whatever is LISTENing on `port`, if any.
///
/// Independent re-implementation of `findPortHolder` in
/// `src/cockpit/port-recovery.ts` (mt#2629) — the TS side additionally
/// resolves the holder's command line for zombie-recognition and uses `-i
/// :<port>` instead of `-ti tcp:<port>`, but both filter to LISTEN-state
/// sockets only and both treat "no matching PID" as "port free". Not
/// unified: the Rust supervisor must keep working with no Minsky
/// CLI/MCP process running at all. See `contract/README.md` §2 for the
/// documented semantics both implementations share.
fn pid_on_port(port: u16, path: &str) -> Option<u32> {
    let out = Command::new(lsof_bin(path))
        .args(["-ti", &format!("tcp:{port}"), "-sTCP:LISTEN"])
        .env("PATH", path)
        .output()
        .ok()?;
    parse_lsof_pid(&String::from_utf8_lossy(&out.stdout))
}

fn port_in_use(port: u16, path: &str) -> bool {
    pid_on_port(port, path).is_some()
}

fn kill_pid(pid: u32) {
    let _ = Command::new("/bin/kill")
        .args(["-TERM", &pid.to_string()])
        .output();
}

/// Send SIGTERM to an entire process group (negative pid).
fn kill_group(pgid: u32) {
    let _ = Command::new("/bin/kill")
        .args(["-TERM", &format!("-{pgid}")])
        .output();
}

/// Spawn `bun run src/cli.ts cockpit start --no-dev-chromium --port <port>` as a
/// managed child in its own process group, in `repo_root` (source entry, matching
/// the launchd plist; resolves the web bundle + git repo-backend correctly —
/// mt#2282/mt#2283), with stdout/stderr appended to the cockpit log files.
/// Returns the child and its pgid (== child pid under `process_group(0)`).
fn spawn_daemon(bun: &Path, repo_root: &Path, port: u16, path: &str) -> io::Result<(Child, u32)> {
    let out = open_log("cockpit-stdout.log")?;
    let err = open_log("cockpit-stderr.log")?;
    let mut cmd = Command::new(bun);
    cmd.args([
        "run",
        "src/cli.ts",
        "cockpit",
        "start",
        "--no-dev-chromium",
        "--port",
        &port.to_string(),
    ])
    .current_dir(repo_root)
    .env("PATH", path)
    .stdin(Stdio::null())
    .stdout(Stdio::from(out))
    .stderr(Stdio::from(err));
    // New process group (pgid == child pid) so teardown can SIGTERM the whole
    // group. Unix-only; on other targets the child is spawned without a group.
    #[cfg(unix)]
    cmd.process_group(0);
    let child = cmd.spawn()?;
    let pid = child.id();
    Ok((child, pid))
}

/// Tear down the daemon we spawned, if any. Idempotent. Called from `main()`'s
/// `RunEvent::Exit` handler.
pub(crate) fn teardown(spawned: &SpawnedPgid) {
    let pgid = spawned.lock().ok().and_then(|mut g| g.take());
    if let Some(pgid) = pgid {
        kill_group(pgid);
    }
}

// ---------------------------------------------------------------------------
// Supervisor thread.
// ---------------------------------------------------------------------------

/// Mutable state owned by the supervisor loop.
pub(crate) struct Sup {
    pub(crate) child: Option<Child>,
    pub(crate) last_spawn: Option<Instant>,
    /// Last status-line text. Owned `String` (not `&'static str`) so dynamic
    /// messages — port-conflict holder pid, restart-failure summary — can be
    /// shown alongside the static `LABEL_*` constants (mt#2299).
    pub(crate) last_status: Option<String>,
    /// Last value pushed to the build-status menu line (mt#2297), for dedupe.
    pub(crate) last_build_label: Option<String>,
    /// Wall-clock start time of the daemon currently being supervised (mt#2299):
    /// `SystemTime::now()` for a tray-spawned daemon, or `now − ps(etime)` for an
    /// adopted one. `None` when no daemon is running. Drives the uptime line.
    pub(crate) daemon_started_at: Option<SystemTime>,
    /// Newest backend-source mtime at the moment the daemon was (re)started — the
    /// "source version" the running daemon reflects (mt#2299).
    pub(crate) daemon_source_mtime: Option<SystemTime>,
    /// Last value pushed to the uptime menu line (mt#2299), for dedupe.
    pub(crate) last_uptime_label: Option<String>,

    // --- Self-health watchdog state (mt#2578) ---
    /// Ring buffer of daemon-crash restart timestamps (child-exited or
    /// processStartedAtMs changed) within RESTART_STORM_WINDOW.
    /// Pruned every poll to evict entries older than the window.
    restart_timestamps: Vec<Instant>,
    /// Number of consecutive POLL_INTERVAL polls where db != "ok".
    /// Reset to 0 on the first "ok" poll.
    consecutive_db_degraded: u32,
    /// Instant of the last restart-storm alert toast; `None` when the condition
    /// is clear (cooldown reset so the next episode fires immediately).
    last_restart_alert: Option<Instant>,
    /// Instant of the last DB-degraded alert toast; reset to `None` when
    /// condition clears.
    last_db_alert: Option<Instant>,
    /// `processStartedAtMs` from the daemon's most recent successful health
    /// response; `None` before the first successful poll.  A change between
    /// polls means the daemon restarted (for adopted-daemon restart detection).
    last_process_started_at_ms: Option<u64>,
    /// Consecutive polls where http_ok = false while the daemon child is alive
    /// or an adopted daemon is expected (the unhealthy-but-not-exiting case).
    /// Reset to 0 on the first successful health poll; also reset in the
    /// crash-exit arm (that path's alerting is owned by restart_timestamps).
    consecutive_http_failed: u32,
    /// Last time a sustained-HTTP-failure alert was fired; reset when health
    /// returns (condition cleared → next episode re-alerts immediately).
    last_http_alert: Option<Instant>,
}

/// Update the visible status label (dropdown line + tray tooltip), skipping
/// the UI round-trip when the label hasn't changed.
pub(crate) fn set_status(app: &AppHandle, sup: &mut Sup, label: &str) {
    if sup.last_status.as_deref() == Some(label) {
        return;
    }
    sup.last_status = Some(label.to_string());
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

fn do_spawn(app: &AppHandle, sup: &mut Sup, spawned: &SpawnedPgid, path: &str) {
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
    match spawn_daemon(&bun, &repo_root, DAEMON_PORT, path) {
        Ok((child, pid)) => {
            sup.child = Some(child);
            sup.last_spawn = Some(Instant::now());
            // mt#2299: a fresh tray-spawn is current as of now; record the
            // wall-clock start + the backend-source version it reflects so the
            // uptime line can render "running Xs, started against src @ HH:MM:SS".
            // Gate the source-mtime capture on the BACKEND source root, not the
            // web root (reviewer R1 B1).
            sup.daemon_started_at = Some(SystemTime::now());
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
/// fresh health probe so a conflict (someone else on :3737) is left untouched.
fn do_stop(sup: &mut Sup, spawned: &SpawnedPgid, path: &str, adopted_ok: bool) {
    if let Some(mut child) = sup.child.take() {
        let pgid = spawned.lock().ok().and_then(|mut g| g.take());
        #[cfg(unix)]
        if let Some(pgid) = pgid {
            kill_group(pgid);
        }
        let _ = child.kill();
        let _ = child.wait();
    } else if adopted_ok {
        if let Some(pid) = pid_on_port(DAEMON_PORT, path) {
            kill_pid(pid);
        }
    }
}

async fn health_ok(client: &reqwest::Client) -> bool {
    client
        .get(HEALTH_URL)
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

        let mut sup = Sup {
            child: None,
            last_spawn: None,
            last_status: None,
            last_build_label: None,
            daemon_started_at: None,
            daemon_source_mtime: None,
            last_uptime_label: None,
            // Watchdog state (mt#2578).
            restart_timestamps: Vec::new(),
            consecutive_db_degraded: 0,
            last_restart_alert: None,
            last_db_alert: None,
            last_process_started_at_ms: None,
            consecutive_http_failed: 0,
            last_http_alert: None,
        };

        // Initial adoption-or-spawn.
        match decide_action(health_ok(&client).await, port_in_use(DAEMON_PORT, &path)) {
            DaemonAction::Adopt => match adopt_decision(&path) {
                AdoptDecision::Stale => {
                    // Adopted daemon predates the current backend source (the
                    // 2026-06-04 8-day-stale case) — restart it (kill the
                    // health-confirmed daemon, respawn fresh) so new widget
                    // registrations / routes load before we report ready (mt#2299).
                    do_stop(&mut sup, &spawned, &path, true);
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    do_spawn(&app, &mut sup, &spawned, &path);
                }
                AdoptDecision::Fresh { started, source_mtime } => {
                    sup.daemon_started_at = started;
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
                if try_evict_legacy_launchd(pid_on_port(DAEMON_PORT, &path)) {
                    // Give the OS ~1 s to release the port, then re-check.
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    match decide_action(health_ok(&client).await, port_in_use(DAEMON_PORT, &path)) {
                        DaemonAction::Adopt => match adopt_decision(&path) {
                            AdoptDecision::Stale => {
                                do_stop(&mut sup, &spawned, &path, true);
                                tokio::time::sleep(Duration::from_millis(500)).await;
                                do_spawn(&app, &mut sup, &spawned, &path);
                            }
                            AdoptDecision::Fresh { started, source_mtime } => {
                                sup.daemon_started_at = started;
                                sup.daemon_source_mtime = source_mtime;
                                set_status(&app, &mut sup, LABEL_RUNNING);
                                refresh_uptime(&app, &mut sup);
                            }
                        },
                        DaemonAction::Conflict => {
                            // Still blocked even after eviction — show label.
                            set_status(&app, &mut sup, &conflict_label_for(pid_on_port(DAEMON_PORT, &path)));
                            clear_uptime(&app, &mut sup);
                        }
                        DaemonAction::Spawn => do_spawn(&app, &mut sup, &spawned, &path),
                    }
                } else {
                    set_status(&app, &mut sup, &conflict_label_for(pid_on_port(DAEMON_PORT, &path)));
                    clear_uptime(&app, &mut sup);
                }
            }
            DaemonAction::Spawn => do_spawn(&app, &mut sup, &spawned, &path),
        }

        loop {
            tokio::select! {
                cmd = rx.recv() => match cmd {
                    Some(SupervisorCmd::Start) => {
                        match decide_action(health_ok(&client).await, port_in_use(DAEMON_PORT, &path)) {
                            DaemonAction::Adopt => match adopt_decision(&path) {
                                AdoptDecision::Stale => {
                                    do_stop(&mut sup, &spawned, &path, true);
                                    tokio::time::sleep(Duration::from_millis(500)).await;
                                    do_spawn(&app, &mut sup, &spawned, &path);
                                }
                                AdoptDecision::Fresh { started, source_mtime } => {
                                    sup.daemon_started_at = started;
                                    sup.daemon_source_mtime = source_mtime;
                                    set_status(&app, &mut sup, LABEL_RUNNING);
                                    refresh_uptime(&app, &mut sup);
                                }
                            },
                            DaemonAction::Conflict => {
                                // gh#1761: same eviction path as the boot-time Conflict arm.
                                if try_evict_legacy_launchd(pid_on_port(DAEMON_PORT, &path)) {
                                    tokio::time::sleep(Duration::from_secs(1)).await;
                                    match decide_action(health_ok(&client).await, port_in_use(DAEMON_PORT, &path)) {
                                        DaemonAction::Adopt => match adopt_decision(&path) {
                                            AdoptDecision::Stale => {
                                                do_stop(&mut sup, &spawned, &path, true);
                                                tokio::time::sleep(Duration::from_millis(500)).await;
                                                do_spawn(&app, &mut sup, &spawned, &path);
                                            }
                                            AdoptDecision::Fresh { started, source_mtime } => {
                                                sup.daemon_started_at = started;
                                                sup.daemon_source_mtime = source_mtime;
                                                set_status(&app, &mut sup, LABEL_RUNNING);
                                                refresh_uptime(&app, &mut sup);
                                            }
                                        },
                                        DaemonAction::Conflict => {
                                            set_status(&app, &mut sup, &conflict_label_for(pid_on_port(DAEMON_PORT, &path)));
                                            clear_uptime(&app, &mut sup);
                                        }
                                        DaemonAction::Spawn => do_spawn(&app, &mut sup, &spawned, &path),
                                    }
                                } else {
                                    set_status(&app, &mut sup, &conflict_label_for(pid_on_port(DAEMON_PORT, &path)));
                                    clear_uptime(&app, &mut sup);
                                }
                            }
                            DaemonAction::Spawn => do_spawn(&app, &mut sup, &spawned, &path),
                        }
                    }
                    Some(SupervisorCmd::Stop) => {
                        let had_child = sup.child.is_some();
                        let h = health_ok(&client).await;
                        do_stop(&mut sup, &spawned, &path, h);
                        if !had_child && !h && port_in_use(DAEMON_PORT, &path) {
                            // A foreign process owns :3737 — we didn't (and won't) kill it.
                            set_status(&app, &mut sup, &conflict_label_for(pid_on_port(DAEMON_PORT, &path)));
                        } else {
                            set_status(&app, &mut sup, LABEL_STOPPED);
                        }
                        clear_uptime(&app, &mut sup);
                    }
                    Some(SupervisorCmd::Restart) => {
                        let h = health_ok(&client).await;
                        if sup.child.is_none() && !h && port_in_use(DAEMON_PORT, &path) {
                            // Foreign listener owns the port — refuse to restart over it.
                            set_status(&app, &mut sup, &conflict_label_for(pid_on_port(DAEMON_PORT, &path)));
                        } else {
                            do_stop(&mut sup, &spawned, &path, h);
                            tokio::time::sleep(Duration::from_millis(500)).await;
                            do_spawn(&app, &mut sup, &spawned, &path);
                        }
                    }
                    Some(SupervisorCmd::Rebuild) => {
                        // Runtime source change. Rebuild WITHOUT touching the
                        // daemon — Express serves dist from disk per request, so
                        // a fresh bundle is picked up on the next browser
                        // refresh; a failed rebuild leaves the prior bundle.
                        if let (Some(root), Some(bun)) =
                            (cockpit_source_root(&path), resolve_program("bun", &path))
                        {
                            set_build_status(&app, &mut sup, "Rebuilding bundle...".to_string());
                            let result = run_cockpit_build(&bun, &root, &path);
                            report_build_result(&app, &mut sup, &result, true);
                        }
                    }
                    Some(SupervisorCmd::Shutdown) | None => {
                        // Pass a fresh health probe as adopted_ok (matching the
                        // Stop arm) so quitting the app never kills a FOREIGN
                        // :3737 listener — only our spawned child (via the
                        // process group inside do_stop) or our health-confirmed
                        // adopted daemon. (mt#2305; PR #1558 reviewer R3.)
                        let h = health_ok(&client).await;
                        do_stop(&mut sup, &spawned, &path, h);
                        break;
                    }
                },
                _ = tokio::time::sleep(POLL_INTERVAL) => {
                    // mt#2578: use poll_health_detail so we get DB status + restart
                    // signal, not just a bool. health_ok() is still used for the
                    // shutdown path (adopt_ok check) where we only need the bool.
                    let health = poll_health_detail(&client).await;
                    let poll_now = Instant::now();

                    // --- Watchdog: restart-storm detection ---
                    // Prune timestamps older than the rolling window.
                    sup.restart_timestamps.retain(|t| poll_now.duration_since(*t) < RESTART_STORM_WINDOW);

                    if sup.restart_timestamps.len() > RESTART_STORM_THRESHOLD {
                        let cooldown_elapsed = sup.last_restart_alert
                            .map(|t| poll_now.duration_since(t) >= ALERT_COOLDOWN)
                            .unwrap_or(true);
                        if cooldown_elapsed {
                            let reason = format!(
                                "{} daemon restarts in the last {}m — possible crash-loop. \
                                 Check logs: ~/.local/state/minsky/logs/cockpit-stderr.log",
                                sup.restart_timestamps.len(),
                                RESTART_STORM_WINDOW.as_secs() / 60
                            );
                            notify_daemon_unhealthy(&app, &reason);
                            sup.last_restart_alert = Some(poll_now);
                            eprintln!("[watchdog] restart-storm alert: {}", reason);
                        }
                    } else {
                        // Condition cleared — next episode re-alerts immediately.
                        sup.last_restart_alert = None;
                    }

                    if health.http_ok {
                        // HTTP health restored — reset failure counter + cooldown.
                        if sup.consecutive_http_failed > 0 {
                            eprintln!(
                                "[watchdog] HTTP health restored after {} failed polls",
                                sup.consecutive_http_failed
                            );
                        }
                        sup.consecutive_http_failed = 0;
                        sup.last_http_alert = None;

                        // Detect adopted-daemon restarts via processStartedAtMs change.
                        if let (Some(prev), Some(curr)) = (sup.last_process_started_at_ms, health.process_started_at_ms) {
                            if curr != prev {
                                sup.restart_timestamps.push(poll_now);
                                eprintln!("[watchdog] adopted-daemon restart detected via processStartedAtMs: {prev} → {curr}");
                            }
                        }
                        if health.process_started_at_ms.is_some() {
                            sup.last_process_started_at_ms = health.process_started_at_ms;
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
                    sup.consecutive_http_failed += 1;

                    // Health is down. Only a daemon WE spawned is respawned.
                    match sup.child.as_mut().map(|c| c.try_wait()) {
                        Some(Ok(Some(_status))) => {
                            // Our child exited — record crash for storm detection, respawn (throttled).
                            // The crash-exit path (restart-storm) owns the alerting for this case;
                            // reset the HTTP-failure counter so the two paths don't double-alert.
                            sup.consecutive_http_failed = 0;
                            sup.last_http_alert = None;
                            sup.child = None;
                            if let Ok(mut g) = spawned.lock() {
                                *g = None;
                            }
                            clear_uptime(&app, &mut sup);
                            // Record this crash; the next poll will prune + check the threshold.
                            sup.restart_timestamps.push(poll_now);
                            // Clear last_process_started_at_ms so the first successful health
                            // poll after respawn does NOT double-count a restart via the
                            // adopted-daemon change-detection path above.
                            sup.last_process_started_at_ms = None;
                            eprintln!(
                                "[watchdog] child crash: {} restarts in window",
                                sup.restart_timestamps.len()
                            );
                            if throttle_ok(sup.last_spawn, Instant::now(), RESPAWN_THROTTLE) {
                                do_spawn(&app, &mut sup, &spawned, &path);
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
                            if sup.consecutive_http_failed > HTTP_FAILURE_POLL_THRESHOLD {
                                let cooldown_elapsed = sup.last_http_alert
                                    .map(|t| poll_now.duration_since(t) >= ALERT_COOLDOWN)
                                    .unwrap_or(true);
                                if cooldown_elapsed {
                                    let sustained_secs = sup.consecutive_http_failed as u64
                                        * POLL_INTERVAL.as_secs();
                                    let reason = format!(
                                        "Cockpit daemon has been unresponsive for {sustained_secs}s \
                                         while its process is still alive — possible hang. \
                                         Check logs: ~/.local/state/minsky/logs/cockpit-stderr.log",
                                    );
                                    notify_daemon_unhealthy(&app, &reason);
                                    sup.last_http_alert = Some(poll_now);
                                    eprintln!("[watchdog] sustained HTTP-failure (child alive) alert: {}", reason);
                                }
                            }
                            set_status(&app, &mut sup, LABEL_STARTING);
                        }
                        Some(Err(_)) | None => {
                            // No child of ours (adopted daemon down, or never spawned).
                            // Don't IMMEDIATELY spawn over an adopted daemon — but see the
                            // mt#2786 takeover below. Apply the same
                            // sustained-HTTP-failure alert here: an expected adopted daemon
                            // that stops responding is an alert-worthy condition.
                            if sup.consecutive_http_failed > HTTP_FAILURE_POLL_THRESHOLD {
                                let cooldown_elapsed = sup.last_http_alert
                                    .map(|t| poll_now.duration_since(t) >= ALERT_COOLDOWN)
                                    .unwrap_or(true);
                                if cooldown_elapsed {
                                    let sustained_secs = sup.consecutive_http_failed as u64
                                        * POLL_INTERVAL.as_secs();
                                    let reason = format!(
                                        "Cockpit health endpoint has been unreachable for {sustained_secs}s — \
                                         daemon may be down. Check logs: ~/.local/state/minsky/logs/cockpit-stderr.log",
                                    );
                                    notify_daemon_unhealthy(&app, &reason);
                                    sup.last_http_alert = Some(poll_now);
                                    eprintln!("[watchdog] sustained HTTP-failure (no child) alert: {}", reason);
                                }
                            }
                            // mt#2786: takeover-respawn. Once the outage is sustained
                            // (2× the alert threshold) and nobody holds the port (an
                            // operator's replacement daemon would), convert from
                            // adopted to spawned supervision instead of staying
                            // "stopped" forever. Counts toward restart-storm
                            // accounting so a flapping takeover still alerts.
                            let port_held = port_in_use(DAEMON_PORT, &path);
                            if should_takeover_adopted(
                                sup.consecutive_http_failed,
                                port_held,
                                throttle_ok(sup.last_spawn, Instant::now(), RESPAWN_THROTTLE),
                            ) {
                                let sustained_secs = sup.consecutive_http_failed as u64
                                    * POLL_INTERVAL.as_secs();
                                eprintln!(
                                    "[watchdog] adopted daemon gone for {sustained_secs}s and port {DAEMON_PORT} is free — taking over supervision (mt#2786)"
                                );
                                sup.consecutive_http_failed = 0;
                                sup.last_http_alert = None;
                                sup.restart_timestamps.push(poll_now);
                                sup.last_process_started_at_ms = None;
                                do_spawn(&app, &mut sup, &spawned, &path);
                            } else {
                                set_status(&app, &mut sup, LABEL_STOPPED);
                                clear_uptime(&app, &mut sup);
                            }
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
async fn poll_health_detail(client: &reqwest::Client) -> HealthDetail {
    let resp = match client.get(HEALTH_URL).send().await {
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
    HealthDetail { http_ok: true, db, process_started_at_ms }
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

/// Parse macOS `ps -o etime=` (`[[dd-]hh:]mm:ss`) into elapsed seconds. Pure.
fn parse_etime_to_secs(s: &str) -> Option<u64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let (days, hms) = match s.split_once('-') {
        Some((d, rest)) => (d.trim().parse::<u64>().ok()?, rest),
        None => (0u64, s),
    };
    let mut h = 0u64;
    let parts: Vec<&str> = hms.split(':').collect();
    let (m, sec) = match parts.as_slice() {
        [m, sec] => (m.parse::<u64>().ok()?, sec.parse::<u64>().ok()?),
        [hh, m, sec] => {
            h = hh.parse::<u64>().ok()?;
            (m.parse::<u64>().ok()?, sec.parse::<u64>().ok()?)
        }
        _ => return None,
    };
    Some(days * 86_400 + h * 3_600 + m * 60 + sec)
}

/// Wall-clock start time of the process on `pid`, derived from `ps -o etime=`
/// (elapsed) subtracted from now. Used for an ADOPTED daemon the tray didn't
/// spawn (so it has no `Instant`). `None` if `ps` fails or the pid is gone.
fn daemon_start_time(pid: u32) -> Option<SystemTime> {
    let out = Command::new("/bin/ps")
        .args(["-o", "etime=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let secs = parse_etime_to_secs(&String::from_utf8_lossy(&out.stdout))?;
    SystemTime::now().checked_sub(Duration::from_secs(secs))
}

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
fn adopt_decision(path: &str) -> AdoptDecision {
    let source_mtime =
        cockpit_backend_root(path).and_then(|r| newest_backend_mtime(&cockpit_backend_src(&r)));
    let started = pid_on_port(DAEMON_PORT, path).and_then(daemon_start_time);
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

/// Humanize a duration for the uptime line: `5s`, `1m 30s`, `2h 5m`, `8d 3h`. Pure.
fn format_duration(d: Duration) -> String {
    let s = d.as_secs();
    if s < 60 {
        format!("{s}s")
    } else if s < 3_600 {
        format!("{}m {}s", s / 60, s % 60)
    } else if s < 86_400 {
        format!("{}h {}m", s / 3_600, (s % 3_600) / 60)
    } else {
        format!("{}d {}h", s / 86_400, (s % 86_400) / 3_600)
    }
}

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
    if sup.last_uptime_label.as_deref() == Some(label.as_str()) {
        return;
    }
    sup.last_uptime_label = Some(label.clone());
    let _ = update_uptime_status(app, &label);
}

/// Recompute + push the uptime line from the current daemon-start/source state.
fn refresh_uptime(app: &AppHandle, sup: &mut Sup) {
    let label = uptime_label(
        sup.daemon_started_at,
        sup.daemon_source_mtime,
        SystemTime::now(),
    );
    set_uptime_status(app, sup, label);
}

/// Clear the uptime line + recorded start state (daemon no longer running).
fn clear_uptime(app: &AppHandle, sup: &mut Sup) {
    sup.daemon_started_at = None;
    sup.daemon_source_mtime = None;
    set_uptime_status(app, sup, uptime_label(None, None, SystemTime::now()));
}

/// Status line for a foreign listener on :3737, naming the holder pid (mt#2299,
/// narrow scope — message only, no kill). Pure.
fn conflict_label_for(pid: Option<u32>) -> String {
    match pid {
        Some(p) => format!("Cockpit: :3737 held by pid {p} (not started by tray)"),
        None => LABEL_CONFLICT.to_string(),
    }
}

/// Extract the last non-empty line from a byte buffer, trimmed and capped for a
/// menu item. Pure (unit-tested); the bounded read happens in `daemon_error_tail`.
fn last_nonempty_capped(bytes: &[u8]) -> Option<String> {
    let line = String::from_utf8_lossy(bytes)
        .lines()
        .rev()
        .map(|l| l.trim())
        .find(|l| !l.is_empty())?
        .to_string();
    const MAX: usize = 120;
    Some(if line.chars().count() > MAX {
        line.chars().take(MAX).collect::<String>() + "..."
    } else {
        line
    })
}

/// Last non-empty line of the daemon stderr log, capped — used to summarize a
/// restart/start failure in the status line (mt#2299, criterion 5). Reads only
/// the final ~8 KiB (seek from end) so a large or flapping log can't block the
/// supervisor loop on each crash within the throttle window (reviewer R1 NB2).
fn daemon_error_tail() -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    const TAIL_BYTES: u64 = 8 * 1024;
    let mut file = File::open(log_dir().join("cockpit-stderr.log")).ok()?;
    let len = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(len.saturating_sub(TAIL_BYTES)))
        .ok()?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).ok()?;
    // A partial first line in the window is harmless: we take the LAST non-empty
    // line, and the final line is always intact.
    last_nonempty_capped(&buf)
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
    use std::time::UNIX_EPOCH;

    // mt#2786 — takeover-respawn decision for a dead adopted daemon.
    #[test]
    fn takeover_fires_when_sustained_port_free_and_throttle_ok() {
        assert!(should_takeover_adopted(
            ADOPTED_TAKEOVER_POLL_THRESHOLD + 1,
            false,
            true
        ));
    }

    #[test]
    fn takeover_waits_below_the_sustained_threshold() {
        // At the alert threshold (half the takeover threshold) we alert but do NOT spawn.
        assert!(!should_takeover_adopted(
            HTTP_FAILURE_POLL_THRESHOLD + 1,
            false,
            true
        ));
        assert!(!should_takeover_adopted(ADOPTED_TAKEOVER_POLL_THRESHOLD, false, true));
    }

    #[test]
    fn takeover_never_fights_a_port_holder() {
        // An operator's replacement daemon (or anything else) holding the port
        // suppresses takeover no matter how long the outage.
        assert!(!should_takeover_adopted(
            ADOPTED_TAKEOVER_POLL_THRESHOLD * 10,
            true,
            true
        ));
    }

    #[test]
    fn takeover_respects_the_respawn_throttle() {
        assert!(!should_takeover_adopted(
            ADOPTED_TAKEOVER_POLL_THRESHOLD + 1,
            false,
            false
        ));
    }

    #[test]
    fn status_label_maps_health_to_text() {
        assert_eq!(status_label(true), LABEL_RUNNING);
        assert_eq!(status_label(false), LABEL_STOPPED);
    }

    #[test]
    fn decide_action_adopts_when_healthy() {
        // Health-OK wins regardless of the port-in-use signal.
        assert_eq!(decide_action(true, true), DaemonAction::Adopt);
        assert_eq!(decide_action(true, false), DaemonAction::Adopt);
    }

    #[test]
    fn decide_action_conflict_when_port_taken_but_unhealthy() {
        assert_eq!(decide_action(false, true), DaemonAction::Conflict);
    }

    #[test]
    fn decide_action_spawn_when_free() {
        assert_eq!(decide_action(false, false), DaemonAction::Spawn);
    }

    #[test]
    fn throttle_allows_first_spawn() {
        assert!(throttle_ok(None, Instant::now(), RESPAWN_THROTTLE));
    }

    #[test]
    fn throttle_blocks_within_window() {
        let now = Instant::now();
        assert!(!throttle_ok(Some(now), now, RESPAWN_THROTTLE));
    }

    #[test]
    fn throttle_allows_after_window() {
        let now = Instant::now();
        let long_ago = now
            .checked_sub(RESPAWN_THROTTLE + Duration::from_secs(1))
            .expect("instant arithmetic");
        assert!(throttle_ok(Some(long_ago), now, RESPAWN_THROTTLE));
    }

    #[test]
    fn parse_lsof_pid_takes_first_numeric_line() {
        assert_eq!(parse_lsof_pid("12345\n67890\n"), Some(12345));
        assert_eq!(parse_lsof_pid("  4242 \n"), Some(4242));
        assert_eq!(parse_lsof_pid(""), None);
        assert_eq!(parse_lsof_pid("\n\n"), None);
        assert_eq!(parse_lsof_pid("not-a-pid\n"), None);
    }

    #[test]
    fn augmented_path_prepends_common_dirs_and_dedupes() {
        let p = augmented_path("/Users/x", "/usr/bin:/custom/bin");
        assert!(p.starts_with("/Users/x/.bun/bin:"));
        assert!(p.contains(":/custom/bin"));
        // /usr/bin is in the prepend list, so it must not be duplicated.
        assert_eq!(p.matches("/usr/bin").count(), 1);
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
    fn parse_etime_handles_all_ps_formats() {
        assert_eq!(parse_etime_to_secs("00:00"), Some(0));
        assert_eq!(parse_etime_to_secs("01:30"), Some(90));
        assert_eq!(parse_etime_to_secs("01:01:01"), Some(3661));
        assert_eq!(
            parse_etime_to_secs("2-03:00:00"),
            Some(2 * 86_400 + 3 * 3_600)
        );
        // ps right-pads/space-pads; trim tolerated.
        assert_eq!(parse_etime_to_secs("  05:00 "), Some(300));
        assert_eq!(parse_etime_to_secs(""), None);
        assert_eq!(parse_etime_to_secs("garbage"), None);
        assert_eq!(parse_etime_to_secs("1:2:3:4"), None);
    }

    #[test]
    fn format_duration_picks_unit_by_magnitude() {
        assert_eq!(format_duration(Duration::from_secs(5)), "5s");
        assert_eq!(format_duration(Duration::from_secs(90)), "1m 30s");
        assert_eq!(format_duration(Duration::from_secs(3_700)), "1h 1m");
        assert_eq!(format_duration(Duration::from_secs(90_000)), "1d 1h");
    }

    #[test]
    fn last_nonempty_capped_picks_last_line_and_caps() {
        assert_eq!(
            last_nonempty_capped(b"warn\n\nError: boom\n\n"),
            Some("Error: boom".to_string())
        );
        assert_eq!(last_nonempty_capped(b""), None);
        assert_eq!(last_nonempty_capped(b"\n  \n"), None);
        // Capped at 120 chars + ellipsis.
        let long = "x".repeat(200);
        let out = last_nonempty_capped(long.as_bytes()).expect("some");
        assert_eq!(out.chars().count(), 123); // 120 + "..."
        assert!(out.ends_with("..."));
    }

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
            conflict_label_for(Some(4242)),
            "Cockpit: :3737 held by pid 4242 (not started by tray)"
        );
        assert_eq!(conflict_label_for(None), LABEL_CONFLICT);
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
    const HEALTH_SHAPE_FIXTURE: &str =
        include_str!("../../../contract/cockpit-health-shape.json");
    const HEALTH_ROUTE_SOURCE: &str =
        include_str!("../../../src/cockpit/routes/health.ts");

    /// Pull `rustConsumedFields` out of the fixture without a full serde
    /// struct — the fixture is a flat, hand-authored JSON doc and a tiny
    /// manual parse keeps this test from needing a schema type of its own.
    fn rust_consumed_fields(fixture_json: &serde_json::Value) -> Vec<String> {
        fixture_json
            .get("rustConsumedFields")
            .and_then(|v| v.as_array())
            .expect("fixture must declare a `rustConsumedFields` array")
            .iter()
            .map(|v| v.as_str().expect("rustConsumedFields entries must be strings").to_string())
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
        assert_eq!(db, super::DbStatus::Ok, "fixture sample's `db` should decode to Ok");

        let process_started_at_ms = sample.get("processStartedAtMs").and_then(|v| v.as_u64());
        assert_eq!(
            process_started_at_ms,
            Some(1_735_689_600_000),
            "fixture sample's `processStartedAtMs` should round-trip through the same \
             `.and_then(|v| v.as_u64())` extraction poll_health_detail() uses"
        );
    }
}