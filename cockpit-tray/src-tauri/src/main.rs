// Minsky Cockpit menu bar app (mt#2140, supervisor model mt#2241)
//
// A macOS system-tray application that owns the cockpit daemon's lifecycle:
// it spawns the daemon as a managed child, supervises it (respawn-on-crash +
// throttle), ADOPTS an already-running daemon on :3737 instead of double-
// spawning, tears down what it spawned on quit, and registers itself as a
// macOS Login Item for auto-start. launchd (`minsky cockpit install`) is
// retained as an optional opt-in headless mode. See
// docs/architecture/adr-014-cockpit-daemon-lifecycle-ownership.md.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{File, OpenOptions};
use std::io;
#[cfg(unix)]
use std::os::unix::process::CommandExt; // process_group
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use tauri::menu::{MenuBuilder, MenuItem, MenuItemBuilder, SubmenuBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, Wry};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::mpsc;

const DAEMON_PORT: u16 = 3737;
const HEALTH_URL: &str = "http://localhost:3737/api/health";
const COCKPIT_URL: &str = "http://localhost:3737";
const COCKPIT_WINDOW_LABEL: &str = "cockpit";
const POLL_INTERVAL: Duration = Duration::from_secs(5);
/// Minimum gap between successive respawns of a crashed daemon. Mirrors the
/// launchd plist's `ThrottleInterval: 5` so a crash-loop doesn't spawn-storm.
const RESPAWN_THROTTLE: Duration = Duration::from_secs(5);
const STATUS_MENU_ID: &str = "status";
/// Dropdown line showing the cockpit-web bundle's last-build state (mt#2297).
const BUILD_MENU_ID: &str = "build_status";
/// Debounce window for coalescing bursty editor-save events before a rebuild.
const BUILD_DEBOUNCE: Duration = Duration::from_millis(500);
/// Dropdown line showing daemon uptime + the source mtime it was started against (mt#2299).
const UPTIME_MENU_ID: &str = "uptime";
/// Debounce window for the backend-source watcher (mt#2299). Larger than
/// `BUILD_DEBOUNCE` because a process restart is more disruptive than a bundle
/// rebuild (it drops websocket connections + in-memory caches), so we coalesce a
/// burst of backend edits into a single restart.
const RESTART_DEBOUNCE: Duration = Duration::from_secs(2);

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
/// Minimum gap between repeated toasts for the SAME ACTIVE condition.
/// Resets when the condition clears so the NEXT episode re-alerts immediately.
const ALERT_COOLDOWN: Duration = Duration::from_secs(900); // 15 min

// Deep-link retry constants (mt#2528, ADR-023 cold-start handling).
// After a minsky:// URL is opened we retry window.eval(...) until the webview
// FIRST accepts the script. Each successful eval sets window.__minskyPendingDeepLink
// (the durable hand-off the SPA drains on mount) AND calls window.__minskyDeepLink
// if it is already defined. We retry until the first success rather than a short
// fixed count, so a slow cold start (daemon boot + webview load) never drops the
// link; we only give up if the cockpit genuinely never comes up.
/// Max retry attempts before giving up (cockpit never came up).
const DEEP_LINK_RETRY_MAX: u32 = 400;
/// Interval between retry attempts (ms). 400 × 150 ms = 60 s total window —
/// generous enough to cover a cold daemon + webview start on a slow machine.
const DEEP_LINK_RETRY_INTERVAL_MS: u64 = 150;

const LABEL_RUNNING: &str = "Cockpit: running";
const LABEL_STOPPED: &str = "Cockpit: stopped";
const LABEL_STARTING: &str = "Cockpit: starting...";
/// Daemon status line while a pre-flight bundle rebuild runs before spawn (mt#2297).
const LABEL_BUILDING: &str = "Cockpit: rebuilding bundle...";
const LABEL_CONFLICT: &str = "Cockpit: :3737 in use (not cockpit)";
const LABEL_START_FAILED: &str = "Cockpit: start failed (see logs)";
const LABEL_NO_REPO: &str = "Cockpit: repo not found";
const LABEL_NO_BUN: &str = "Cockpit: bun not found";

/// Handle to the dropdown status `MenuItem`, stored in Tauri managed state so
/// the supervisor loop can update its text directly.
///
/// The menu is attached to the TRAY (`TrayIconBuilder::menu(&menu)`), not to the
/// app, so `app.menu()` returns `None`. Holding the item handle is the reliable
/// path (mt#2240).
struct StatusMenuItem(MenuItem<Wry>);

/// Handle to the build-status dropdown `MenuItem` (mt#2297), held in managed
/// state like `StatusMenuItem` so the supervisor loop can update it directly.
struct BuildMenuItem(MenuItem<Wry>);

/// Current webview zoom factor for the cockpit window (mt#2334). Menu-driven
/// zoom (Cmd +/-/0) applies this via `WebviewWindow::set_zoom`, which takes an
/// ABSOLUTE factor — so we track the current value here in order to step it.
struct ZoomLevel(Mutex<f64>);

/// Sender for lifecycle commands from the (main-thread) menu handler to the
/// supervisor thread that owns the daemon `Child`.
struct SupervisorHandle(mpsc::UnboundedSender<SupervisorCmd>);


/// Process-group id of the daemon WE spawned (`None` if adopted or not
/// running). Shared so the quit / `RunEvent::Exit` path can tear it down
/// synchronously even if the supervisor thread doesn't get to process a
/// Shutdown command before the process exits.
type SpawnedPgid = Arc<Mutex<Option<u32>>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SupervisorCmd {
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

fn open_log(name: &str) -> io::Result<File> {
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
fn resolve_repo_root(path: &str) -> Option<PathBuf> {
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

/// Tear down the daemon we spawned, if any. Idempotent.
fn teardown(spawned: &SpawnedPgid) {
    let pgid = spawned.lock().ok().and_then(|mut g| g.take());
    if let Some(pgid) = pgid {
        kill_group(pgid);
    }
}

// ---------------------------------------------------------------------------
// Supervisor thread.
// ---------------------------------------------------------------------------

/// Mutable state owned by the supervisor loop.
struct Sup {
    child: Option<Child>,
    last_spawn: Option<Instant>,
    /// Last status-line text. Owned `String` (not `&'static str`) so dynamic
    /// messages — port-conflict holder pid, restart-failure summary — can be
    /// shown alongside the static `LABEL_*` constants (mt#2299).
    last_status: Option<String>,
    /// Last value pushed to the build-status menu line (mt#2297), for dedupe.
    last_build_label: Option<String>,
    /// Wall-clock start time of the daemon currently being supervised (mt#2299):
    /// `SystemTime::now()` for a tray-spawned daemon, or `now − ps(etime)` for an
    /// adopted one. `None` when no daemon is running. Drives the uptime line.
    daemon_started_at: Option<SystemTime>,
    /// Newest backend-source mtime at the moment the daemon was (re)started — the
    /// "source version" the running daemon reflects (mt#2299).
    daemon_source_mtime: Option<SystemTime>,
    /// Last value pushed to the uptime menu line (mt#2299), for dedupe.
    last_uptime_label: Option<String>,

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
fn set_status(app: &AppHandle, sup: &mut Sup, label: &str) {
    if sup.last_status.as_deref() == Some(label) {
        return;
    }
    sup.last_status = Some(label.to_string());
    let _ = update_status(app, label);
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
                            // Don't auto-spawn over an adopted daemon. Apply the same
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
                            set_status(&app, &mut sup, LABEL_STOPPED);
                            clear_uptime(&app, &mut sup);
                        }
                    }
                }
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Cockpit-web bundle freshness + auto-rebuild (mt#2297).
//
// The tray serves the pre-built production bundle (src/cockpit/web/dist). When
// the operator runs from a source checkout, source files drift ahead of dist
// (e.g. after `git pull`), so the daemon silently serves a stale UI. These
// helpers keep dist fresh: a startup pre-flight rebuild + a runtime filesystem
// watcher. ALL of it is gated on source presence (`cockpit_source_root`); a
// packaged/no-source install skips every path and serves the shipped bundle.
// ---------------------------------------------------------------------------

/// Path to the cockpit web source dir under a repo root.
fn cockpit_web_src(repo_root: &Path) -> PathBuf {
    repo_root.join("src/cockpit/web")
}

/// The built SPA entry whose mtime stands for "when the bundle was last built".
fn dist_index(web_src: &Path) -> PathBuf {
    web_src.join("dist/index.html")
}

/// Directory names excluded from the freshness walk AND the runtime watcher:
/// the build OUTPUT (`dist` — counting it would make a rebuild re-trigger
/// itself), installed deps (`node_modules`), and git internals (`.git`).
const WALK_EXCLUDES: [&str; 3] = ["dist", "node_modules", ".git"];

fn is_excluded_dir(name: &std::ffi::OsStr) -> bool {
    WALK_EXCLUDES.iter().any(|e| name == *e)
}

/// True if `path` lies inside any excluded directory. Used by the watcher's
/// event filter so our own `dist/` writes don't loop the rebuild.
fn path_is_excluded(path: &Path) -> bool {
    path.components().any(|c| match c {
        std::path::Component::Normal(name) => is_excluded_dir(name),
        _ => false,
    })
}

/// Editor temp/backup/hidden files that shouldn't trigger a rebuild (vim `.swp`,
/// emacs `#file#`, `~` backups, `.tmp`, dotfiles like `.DS_Store`). Keyed on the
/// file name only.
fn is_editor_temp_file(name: &str) -> bool {
    name.starts_with('.')
        || name.starts_with('#')
        || name.ends_with('~')
        || name.ends_with(".tmp")
        || name.ends_with(".swp")
}

/// True if a path **relative to the cockpit-web source root** is a real source
/// change worth a rebuild: not under an excluded dir, and not an editor temp
/// file. Callers pass a `web_src`-relative path so an ANCESTOR dir named
/// `dist`/`node_modules`/`.git` (e.g. the repo lives under one) can't suppress
/// every event (reviewer R1, PR #1558).
fn is_relevant_source_change(rel: &Path) -> bool {
    if path_is_excluded(rel) {
        return false;
    }
    match rel.file_name().and_then(|n| n.to_str()) {
        Some(name) => !is_editor_temp_file(name),
        None => false,
    }
}

/// Recursively find the newest mtime under `root`, skipping excluded dirs.
/// Returns `None` if `root` doesn't exist or has no readable entries. The
/// cockpit-web source tree is small (~60 files), so this completes well under
/// the 200ms fast-path budget; excluded dirs (dist/node_modules/.git) are
/// pruned before descent so the walk never touches the large subtrees.
fn newest_mtime_excluding(root: &Path) -> Option<SystemTime> {
    fn walk(dir: &Path, newest: &mut Option<SystemTime>) {
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let file_type = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if file_type.is_dir() {
                if entry.file_name().is_empty() || is_excluded_dir(&entry.file_name()) {
                    continue;
                }
                walk(&entry.path(), newest);
            } else if let Ok(mtime) = entry.metadata().and_then(|m| m.modified()) {
                if newest.map_or(true, |n| mtime > n) {
                    *newest = Some(mtime);
                }
            }
        }
    }
    let mut newest = None;
    walk(root, &mut newest);
    newest
}

/// Staleness verdict for the built bundle vs the source tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Staleness {
    /// No built bundle (dist/index.html missing) — must build before serving.
    NoDist,
    /// A bundle exists but source is newer — rebuild; the prior bundle can serve.
    Stale,
    /// Bundle is at least as new as every source file — serve as-is.
    Fresh,
}

/// Compare the built bundle's mtime against the newest source mtime.
fn dist_staleness(web_src: &Path) -> Staleness {
    let dist_mtime = match std::fs::metadata(dist_index(web_src)).and_then(|m| m.modified()) {
        Ok(t) => t,
        Err(_) => return Staleness::NoDist,
    };
    match newest_mtime_excluding(web_src) {
        Some(src) if src > dist_mtime => Staleness::Stale,
        _ => Staleness::Fresh,
    }
}

/// Format a wall-clock instant as `HH:MM:SS UTC` without a date crate.
fn format_hms_utc(t: SystemTime) -> String {
    let secs = t
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let sod = secs % 86_400;
    format!(
        "{:02}:{:02}:{:02} UTC",
        sod / 3600,
        (sod % 3600) / 60,
        sod % 60
    )
}

/// The repo root IF it both resolves (has `src/cli.ts`) AND contains the cockpit
/// web source. `None` for a no-source/packaged install — the signal that all
/// auto-rebuild machinery must no-op (mt#2297 source-presence gate).
fn cockpit_source_root(path: &str) -> Option<PathBuf> {
    let root = resolve_repo_root(path)?;
    if cockpit_web_src(&root).is_dir() {
        Some(root)
    } else {
        None
    }
}

/// Pick a short human summary from a failed build's output: the last non-empty
/// stderr line (vite/esbuild errors go to stderr), falling back to stdout,
/// capped for a menu item.
fn build_error_summary(stderr: &[u8], stdout: &[u8]) -> String {
    let pick = |bytes: &[u8]| -> Option<String> {
        String::from_utf8_lossy(bytes)
            .lines()
            .rev()
            .map(|l| l.trim())
            .find(|l| !l.is_empty())
            .map(|l| l.to_string())
    };
    let mut s = pick(stderr)
        .or_else(|| pick(stdout))
        .unwrap_or_else(|| "build failed".to_string());
    const MAX: usize = 120;
    if s.chars().count() > MAX {
        s = s.chars().take(MAX).collect::<String>() + "...";
    }
    s
}

/// Run `bun run cockpit:build` in `repo_root`. Returns `Ok` on success, or
/// `Err(summary)` with the tail of the build output. Full output is appended to
/// the cockpit build log for diagnostics regardless of outcome.
fn run_cockpit_build(bun: &Path, repo_root: &Path, path: &str) -> Result<(), String> {
    let output = Command::new(bun)
        .args(["run", "cockpit:build"])
        .current_dir(repo_root)
        .env("PATH", path)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("could not launch bun: {e}"))?;
    if let Ok(mut log) = open_log("cockpit-build.log") {
        use std::io::Write;
        let _ = writeln!(
            log,
            "--- cockpit:build {} ---\n{}{}",
            if output.status.success() {
                "OK"
            } else {
                "FAILED"
            },
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
    }
    if output.status.success() {
        Ok(())
    } else {
        Err(build_error_summary(&output.stderr, &output.stdout))
    }
}

/// Outcome of a pre-spawn freshness check + rebuild.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PreflightResult {
    /// Safe to spawn the daemon (bundle fresh, rebuilt OK, or stale-but-serving).
    Proceed,
    /// Refuse to spawn — no servable bundle and the build failed.
    Refuse,
}

/// Compute the build-status menu label for a finished/failed/in-progress build.
fn build_label_for(result: &Result<(), String>, now: SystemTime, servable_prior: bool) -> String {
    match result {
        Ok(()) => format!("Last build: {}", format_hms_utc(now)),
        Err(e) if servable_prior => format!("Build FAILED ({e}) - serving prior bundle"),
        Err(e) => format!("Build FAILED ({e}) - nothing to serve"),
    }
}

/// Source-gated pre-flight rebuild, run inside `do_spawn` before the daemon is
/// spawned. Caller must have already confirmed the web source is present.
fn preflight_rebuild(
    app: &AppHandle,
    sup: &mut Sup,
    bun: &Path,
    repo_root: &Path,
    path: &str,
) -> PreflightResult {
    let web_src = cockpit_web_src(repo_root);
    match dist_staleness(&web_src) {
        Staleness::Fresh => PreflightResult::Proceed,
        staleness => {
            let servable_prior = staleness == Staleness::Stale;
            set_status(app, sup, LABEL_BUILDING);
            set_build_status(app, sup, "Rebuilding bundle...".to_string());
            let result = run_cockpit_build(bun, repo_root, path);
            let proceed = result.is_ok() || servable_prior;
            report_build_result(app, sup, &result, servable_prior);
            if proceed {
                PreflightResult::Proceed
            } else {
                PreflightResult::Refuse
            }
        }
    }
}

/// Start the runtime filesystem watcher on the cockpit-web source tree. Events
/// under excluded dirs (our own `dist/` writes, node_modules, .git) are filtered
/// out so a rebuild can't re-trigger itself. A relevant change sends a debounced
/// `Rebuild` command to the supervisor. The returned `Debouncer` must be held
/// alive for the watch to persist.
fn start_web_watcher(app: &AppHandle, web_src: &Path) -> Option<Debouncer<RecommendedWatcher>> {
    let tx = app.try_state::<SupervisorHandle>()?.0.clone();
    let root = web_src.to_path_buf();
    let mut debouncer = new_debouncer(BUILD_DEBOUNCE, move |res: DebounceEventResult| {
        if let Ok(events) = res {
            // Filter on the path RELATIVE to web_src so an ancestor dir named
            // dist/node_modules/.git can't suppress every event; also drop
            // editor temp files (reviewer R1, PR #1558).
            let relevant = events.iter().any(|e| {
                e.path
                    .strip_prefix(&root)
                    .map(is_relevant_source_change)
                    .unwrap_or(false)
            });
            if relevant {
                let _ = tx.send(SupervisorCmd::Rebuild);
            }
        }
    })
    .ok()?;
    debouncer
        .watcher()
        .watch(web_src, RecursiveMode::Recursive)
        .ok()?;
    Some(debouncer)
}

/// Update the build-status dropdown line on the main thread (mt#2297).
fn update_build_status(app: &AppHandle, label: &str) -> tauri::Result<()> {
    let app_handle = app.clone();
    let label = label.to_string();
    app.run_on_main_thread(move || {
        if let Some(item) = app_handle.try_state::<BuildMenuItem>() {
            let _ = item.0.set_text(&label);
        }
    })
}

/// Set the build-status label, skipping the UI round-trip when unchanged.
fn set_build_status(app: &AppHandle, sup: &mut Sup, label: String) {
    if sup.last_build_label.as_deref() == Some(label.as_str()) {
        return;
    }
    sup.last_build_label = Some(label.clone());
    let _ = update_build_status(app, &label);
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
/// Mirrors `notify_build_failure`; ignored if notification permission is unavailable.
fn notify_daemon_unhealthy(app: &AppHandle, reason: &str) {
    let _ = app
        .notification()
        .builder()
        .title("Cockpit daemon unhealthy")
        .body(reason)
        .show();
}

/// Fire a best-effort OS-toast on build failure (mt#2306). Additive to the
/// status label + "Last build" menu line; ignored if notification permission is
/// unavailable.
fn notify_build_failure(app: &AppHandle, summary: &str) {
    let _ = app
        .notification()
        .builder()
        .title("Cockpit bundle build failed")
        .body(summary)
        .show();
}

/// Set the build-status label AND fire an OS-toast when the build failed.
/// Success updates the label only (no toast).
fn report_build_result(
    app: &AppHandle,
    sup: &mut Sup,
    result: &Result<(), String>,
    servable_prior: bool,
) {
    let label = build_label_for(result, SystemTime::now(), servable_prior);
    set_build_status(app, sup, label.clone());
    if result.is_err() {
        notify_build_failure(app, &label);
    }
}

// ---------------------------------------------------------------------------
// Backend-source freshness + auto-restart (mt#2299).
//
// Complements the mt#2297 web-bundle auto-rebuild. When server-side cockpit
// source changes (server.ts, widget-registry.ts, widgets/**, config.ts,
// types.ts, ...), the RUNNING daemon's in-memory state is stale: the widget
// registry and route table are loaded at process start, so new widgets return
// "Widget not found" until the process restarts. The daemon spawns from SOURCE
// (`bun run src/cli.ts`), so a plain restart picks up backend changes with NO
// build step (unlike the web bundle). These helpers detect backend staleness
// (startup, for an ADOPTED daemon) and watch backend source at runtime,
// dispatching the existing `SupervisorCmd::Restart`. All gated on BACKEND source
// presence via `cockpit_backend_root` (NOT `cockpit_source_root`, which requires
// the web tree — reviewer R1 B1), like mt#2297 gates the rebuild on web presence.
// ---------------------------------------------------------------------------

/// Path to the cockpit server-side source dir under a repo root.
fn cockpit_backend_src(repo_root: &Path) -> PathBuf {
    repo_root.join("src/cockpit")
}

/// The repo root IF it resolves (has `src/cli.ts`) AND contains the backend
/// source dir (`src/cockpit`). Backend-restart analogue of `cockpit_source_root`
/// — gated on BACKEND source presence, NOT the web tree. A checkout with backend
/// source but no `src/cockpit/web` (relocated/removed frontend) still gets
/// auto-restart; `None` only on a no-backend-source/packaged install (reviewer
/// R1 B1, the originating cause of the silent no-op).
fn cockpit_backend_root(path: &str) -> Option<PathBuf> {
    let root = resolve_repo_root(path)?;
    if cockpit_backend_src(&root).is_dir() {
        Some(root)
    } else {
        None
    }
}

/// Directory names excluded from the backend freshness walk AND watcher: `web`
/// (mt#2297 owns the frontend → rebuild path; backend restart must NOT fire on
/// web edits — acceptance test 6), plus deps/build/git internals.
const BACKEND_WALK_EXCLUDES: [&str; 4] = ["web", "node_modules", ".git", "dist"];

fn is_backend_excluded_dir(name: &std::ffi::OsStr) -> bool {
    BACKEND_WALK_EXCLUDES.iter().any(|e| name == *e)
}

/// True if a path (relative to the backend source root) lies under an excluded dir.
fn backend_path_is_excluded(path: &Path) -> bool {
    path.components().any(|c| match c {
        std::path::Component::Normal(name) => is_backend_excluded_dir(name),
        _ => false,
    })
}

/// A TypeScript module file the daemon loads — `.ts`/`.mts`/`.cts`, excluding
/// test files (`*.test.{ts,mts,cts}`). The cockpit backend is currently all
/// `.ts`, but `.mts`/`.cts` are included so a future ESM/CJS module still
/// triggers a restart (reviewer R1 NB1). Operator config
/// (`~/.config/minsky/cockpit.json`) lives outside `src/cockpit` and is loaded
/// fresh per request, so it is intentionally not part of the watched tree.
fn is_backend_module_file(name: &str) -> bool {
    const EXTS: [&str; 3] = [".ts", ".mts", ".cts"];
    const TEST_EXTS: [&str; 3] = [".test.ts", ".test.mts", ".test.cts"];
    EXTS.iter().any(|e| name.ends_with(e)) && !TEST_EXTS.iter().any(|e| name.ends_with(e))
}

/// True if a path **relative to the backend source root** is a real server-side
/// change worth a daemon restart: a non-test TS module file, not under an
/// excluded dir (esp. `web/`), not an editor temp file. Callers pass a
/// `src/cockpit`-relative path (mirrors `is_relevant_source_change`, PR #1558).
fn is_relevant_backend_change(rel: &Path) -> bool {
    if backend_path_is_excluded(rel) {
        return false;
    }
    match rel.file_name().and_then(|n| n.to_str()) {
        Some(name) => is_backend_module_file(name) && !is_editor_temp_file(name),
        None => false,
    }
}

/// Newest mtime among relevant backend-source files under `root` (`src/cockpit`),
/// skipping excluded dirs. `None` if `root` is absent or has no relevant files.
fn newest_backend_mtime(root: &Path) -> Option<SystemTime> {
    fn walk(dir: &Path, root: &Path, newest: &mut Option<SystemTime>) {
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let file_type = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            let p = entry.path();
            if file_type.is_dir() {
                if entry.file_name().is_empty() || is_backend_excluded_dir(&entry.file_name()) {
                    continue;
                }
                walk(&p, root, newest);
            } else if let Ok(rel) = p.strip_prefix(root) {
                if is_relevant_backend_change(rel) {
                    if let Ok(mtime) = entry.metadata().and_then(|m| m.modified()) {
                        if newest.map_or(true, |n| mtime > n) {
                            *newest = Some(mtime);
                        }
                    }
                }
            }
        }
    }
    let mut newest = None;
    walk(root, root, &mut newest);
    newest
}

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

/// Status line for a foreign listener on :3737, naming the holder pid (mt#2299,
/// narrow scope — message only, no kill). Pure.
fn conflict_label_for(pid: Option<u32>) -> String {
    match pid {
        Some(p) => format!("Cockpit: :3737 held by pid {p} (not started by tray)"),
        None => LABEL_CONFLICT.to_string(),
    }
}

/// The launchd label for the legacy daemon agent (gh#1761).
/// This is the plist Label that was generated by `minsky cockpit install` before
/// ADR-014 made the tray the canonical supervisor.  If still loaded it races the
/// tray — whichever wins keeps the port, leaving the loser in Conflict state.
const LEGACY_LAUNCHD_LABEL: &str = "com.minsky.cockpit";

/// Parse the PID from `launchctl list <label>` output (gh#1761 R1).
///
/// Returns `Some(pid)` when the service is running (has a "PID" field), `None`
/// when it is loaded-but-stopped (no "PID" field) or the output is malformed.
///
/// The output format is a plist-style text stream, one key/value per line:
/// ```text
/// {
///     "PID" = 12345;
///     "Label" = "com.minsky.cockpit";
///     ...
/// };
/// ```
fn parse_launchctl_pid(output: &str) -> Option<u32> {
    for line in output.lines() {
        let line = line.trim();
        // Match lines of the form: "PID" = <digits>;
        if let Some(rest) = line.strip_prefix("\"PID\"") {
            let rest = rest.trim();
            if let Some(val) = rest.strip_prefix('=') {
                let num = val.trim().trim_end_matches(';').trim();
                if let Ok(pid) = num.parse::<u32>() {
                    return Some(pid);
                }
            }
        }
    }
    None
}

/// Try to evict the legacy `com.minsky.cockpit` launchd agent if it is the
/// process holding :3737 (gh#1761, ADR-014 single-ownership enforcement).
///
/// `port_holder` is the PID currently listening on DAEMON_PORT (from `lsof`).
/// If `None`, this function returns `false` immediately — without knowing who
/// holds the port we must NOT disable an agent that may not be the cause.
///
/// Algorithm:
/// 1. Early-exit when `port_holder` is `None` (port-holder unknown — safe to skip).
/// 2. `launchctl list com.minsky.cockpit` — exit 0 means the agent is loaded.
///    If absent (exit 1 / non-zero), return false immediately (not the cause).
/// 3. Parse the "PID" field from the launchctl output.  If absent (agent loaded
///    but not running) or the PID does not match `port_holder`, return false —
///    some other process holds the port and we must NOT evict the launchd agent.
/// 4. `launchctl bootout gui/<uid> com.minsky.cockpit` — unloads and stops it.
/// 5. `launchctl disable gui/<uid>/com.minsky.cockpit` — prevents re-load on
///    next login so the race does not recur.
///
/// Returns `true` if the agent was found, confirmed as the port holder, and
/// successfully evicted, `false` otherwise.
/// On return `true` the caller should wait briefly for the port to free, then
/// retry `decide_action`.
///
/// # Safety
///
/// Both launchctl calls are non-destructive to data (they only manage the
/// launchd job, not the repo or any cockpit state).  The disable step means the
/// operator's `minsky cockpit install` intent is overridden; they can re-enable
/// via `launchctl enable gui/<uid>/com.minsky.cockpit` if needed.
fn try_evict_legacy_launchd(port_holder: Option<u32>) -> bool {
    // Step 1: refuse to evict when the port holder is unknown.
    // Without this guard we might disable a legitimately-configured launchd agent
    // that is NOT the cause of the conflict (gh#1761 R1, ADR-014 safety gate).
    let Some(holder_pid) = port_holder else { return false; };

    // Step 2: probe whether the agent is loaded.
    let probe = Command::new("launchctl")
        .args(["list", LEGACY_LAUNCHD_LABEL])
        .output();
    let probe_out = match probe {
        Ok(out) if out.status.success() => out, // agent is loaded — continue
        _ => return false,                       // not found or launchctl unavailable
    };

    // Step 3: verify the launchd agent is the actual port holder.
    // `launchctl list` includes a "PID" = <n>; line only when the service is
    // running.  No "PID" field → agent loaded-but-stopped → cannot hold the port.
    // Mismatching PID → a different process holds :3737 → do NOT evict.
    let launchd_pid = parse_launchctl_pid(&String::from_utf8_lossy(&probe_out.stdout));
    if launchd_pid != Some(holder_pid) {
        eprintln!(
            "[tray] legacy agent present (pid {:?}) but port holder is pid {holder_pid} — skipping eviction",
            launchd_pid
        );
        return false;
    }

    // Step 4: derive the user id for the GUI domain.
    let uid = {
        let id_out = Command::new("id").arg("-u").output();
        match id_out {
            Ok(o) if o.status.success() => {
                String::from_utf8_lossy(&o.stdout).trim().to_string()
            }
            _ => return false,
        }
    };

    let domain = format!("gui/{uid}");

    // Step 5: bootout (unload + stop).
    let bootout = Command::new("launchctl")
        .args(["bootout", &domain, LEGACY_LAUNCHD_LABEL])
        .status();
    if !matches!(bootout, Ok(s) if s.success()) {
        // bootout failed — log but still attempt disable
        eprintln!("[tray] launchctl bootout {LEGACY_LAUNCHD_LABEL} failed");
        return false;
    }

    // Step 6: disable to prevent re-load on next login.
    let target = format!("{domain}/{LEGACY_LAUNCHD_LABEL}");
    let _ = Command::new("launchctl")
        .args(["disable", &target])
        .status();
    // disable failure is non-fatal: bootout already stopped the agent for this
    // session; the tray is running and will respawn the daemon itself.

    eprintln!("[tray] evicted legacy launchd agent {LEGACY_LAUNCHD_LABEL} (gh#1761)");
    true
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

/// Start the runtime backend-source watcher on `src/cockpit`. Mirrors
/// `start_web_watcher` but dispatches `SupervisorCmd::Restart` (not `Rebuild`) on
/// a larger debounce. `web/**` events are filtered out (mt#2297 owns them), so a
/// frontend edit never triggers a backend restart. Hold the returned `Debouncer`
/// alive for the watch to persist.
fn start_backend_watcher(
    app: &AppHandle,
    backend_src: &Path,
) -> Option<Debouncer<RecommendedWatcher>> {
    let tx = app.try_state::<SupervisorHandle>()?.0.clone();
    let root = backend_src.to_path_buf();
    let mut debouncer = new_debouncer(RESTART_DEBOUNCE, move |res: DebounceEventResult| {
        if let Ok(events) = res {
            let relevant = events.iter().any(|e| {
                e.path
                    .strip_prefix(&root)
                    .map(is_relevant_backend_change)
                    .unwrap_or(false)
            });
            if relevant {
                let _ = tx.send(SupervisorCmd::Restart);
            }
        }
    })
    .ok()?;
    debouncer
        .watcher()
        .watch(backend_src, RecursiveMode::Recursive)
        .ok()?;
    Some(debouncer)
}

/// Handle to the daemon-uptime dropdown `MenuItem` (mt#2299), held in managed
/// state like `BuildMenuItem` so the supervisor loop can update it directly.
struct UptimeMenuItem(MenuItem<Wry>);

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

// ---------------------------------------------------------------------------
// App wiring.
// ---------------------------------------------------------------------------

fn send_cmd(app: &AppHandle, cmd: SupervisorCmd) {
    if let Some(handle) = app.try_state::<SupervisorHandle>() {
        let _ = handle.0.send(cmd);
    }
}

fn main() {
    let spawned: SpawnedPgid = Arc::new(Mutex::new(None));
    let spawned_setup = spawned.clone();

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        // minsky:// URL-scheme handler (mt#2528, ADR-023).
        // The deep-link plugin registers the OS scheme (CFBundleURLTypes on macOS)
        // and delivers opened URLs to on_open_url. Navigation is Rust→webview eval
        // because the SPA is an untrusted external-URL webview (no IPC bridge).
        .plugin(tauri_plugin_deep_link::init());
    // LaunchAgent mode registers a per-user Login Item that starts THIS app
    // (com.minsky.cockpit-tray) at login — the RunAtLoad replacement from
    // ADR-014. Distinct from the daemon's own com.minsky.cockpit launchd plist
    // (the optional headless path). Release-only so dev runs stay pristine.
    #[cfg(not(debug_assertions))]
    {
        builder = builder.plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ));
    }

    let app = builder
        .setup(move |app| {
            let handle = app.handle().clone();
            // Register zoom state before any menu handler that can read it
            // (mt#2334 review): menu events fire post-setup, but managing it up
            // front guarantees `try_state::<ZoomLevel>()` is always populated.
            app.manage(ZoomLevel(Mutex::new(1.0)));

            // Register the minsky:// URL-scheme handler (mt#2528, ADR-023).
            // macOS routes clicked minsky:// links to the running instance via Apple
            // Event kAEGetURL (no tauri-plugin-single-instance needed); if the app
            // is closed, Launch Services launches it first, then delivers the URL.
            //
            // Navigation shape (ADR-023): the SPA is an untrusted external-URL
            // webview, so we forward the URL via Rust->webview eval of the SPA-
            // exposed global window.__minskyDeepLink(uri). The payload is JSON-
            // encoded (serde_json::to_string) -- never raw string-interpolated, as a
            // crafted minsky:// URL is otherwise a script-injection vector.
            //
            // Also check for a URL passed via command-line on cold start (the
            // get_current() path). macOS handles cold-start via Apple Events so
            // get_current() returns None on macOS, but we call it defensively for
            // portability (future Windows/Linux support).
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                // Cold-start: check if the app was launched via a deep link.
                // On macOS this is always None (handled via on_open_url below);
                // on Windows/Linux this returns the URL from the CLI argument.
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    for url in urls {
                        handle_deep_link(&handle, url.as_str().to_owned());
                    }
                }
                // Hot-start: handle deep links while the app is already running.
                let deep_link_handle = handle.clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        handle_deep_link(&deep_link_handle, url.as_str().to_owned());
                    }
                });
            }

            // Keep the app out of the Dock even though it can open a window
            // (mt#2219). mt#2202 owns the Info.plist LSUIElement path; the Tauri
            // activation policy achieves the same accessory behavior here.
            #[cfg(target_os = "macos")]
            let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Register as a Login Item (idempotent). Release-only: a dev build
            // would otherwise register a Login Item pointing at the dev binary.
            #[cfg(not(debug_assertions))]
            {
                use tauri_plugin_autostart::ManagerExt;
                if let Err(e) = app.autolaunch().enable() {
                    eprintln!("[cockpit-tray] could not register Login Item: {e}");
                }
            }

            let status_item = MenuItemBuilder::with_id(STATUS_MENU_ID, "Cockpit: checking...")
                .enabled(false)
                .build(app)?;
            app.manage(StatusMenuItem(status_item.clone()));
            let build_item = MenuItemBuilder::with_id(BUILD_MENU_ID, "Last build: never")
                .enabled(false)
                .build(app)?;
            app.manage(BuildMenuItem(build_item.clone()));
            // Best-effort: request notification permission so build-failure
            // toasts can appear (mt#2306). Ignored if denied/unavailable.
            let _ = app.notification().request_permission();
            let uptime_item = MenuItemBuilder::with_id(UPTIME_MENU_ID, "Daemon uptime: —")
                .enabled(false)
                .build(app)?;
            app.manage(UptimeMenuItem(uptime_item.clone()));
            let open_window_item =
                MenuItemBuilder::with_id("open_window", "Open Cockpit").build(app)?;
            let open_item = MenuItemBuilder::with_id("open", "Open in Browser").build(app)?;
            let separator1 = tauri::menu::PredefinedMenuItem::separator(app)?;
            let start_item = MenuItemBuilder::with_id("start", "Start Daemon").build(app)?;
            let stop_item = MenuItemBuilder::with_id("stop", "Stop Daemon").build(app)?;
            let restart_item = MenuItemBuilder::with_id("restart", "Restart Daemon").build(app)?;
            let separator2 = tauri::menu::PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Quit Cockpit Tray").build(app)?;

            let menu = MenuBuilder::new(app)
                .item(&status_item)
                .item(&build_item)
                .item(&uptime_item)
                .item(&separator1)
                .item(&open_window_item)
                .item(&open_item)
                .item(&start_item)
                .item(&stop_item)
                .item(&restart_item)
                .item(&separator2)
                .item(&quit_item)
                .build()?;

            let _tray = TrayIconBuilder::with_id("main")
                .tooltip("Minsky Cockpit")
                .icon(tauri::image::Image::from_bytes(include_bytes!(
                    "../icons/tray.png"
                ))?)
                .icon_as_template(true)
                .menu(&menu)
                .on_menu_event(move |app, event| {
                    handle_menu_event(app, event.id().as_ref());
                })
                .build(app)?;

            // Application menu (mt#2327): the tray menu above drives the daemon
            // lifecycle, but it does NOT give the cockpit *window* the standard
            // web-app keyboard shortcuts. On macOS those come from the
            // application menu's accelerators, which Tauri (unlike Electron) does
            // not create by default — so Cmd+R / Cmd+W / Cmd+C&c. were dead in the
            // cockpit window. Build a minimal app menu so they work when the
            // window is focused. Zoom (Cmd +/-/0) is driven by the View-menu
            // items below via `WebviewWindow::set_zoom` (mt#2334) — Tauri's
            // native `zoom_hotkeys_enabled` did not fire for Cmd on macOS.
            // Custom Quit item (NOT PredefinedMenuItem::quit): the predefined
            // quit is self-handled by the OS and never reaches handle_menu_event,
            // so it would bypass the supervisor-aware graceful shutdown
            // (SupervisorCmd::Shutdown) that the tray Quit uses — risking leaving
            // an adopted daemon running. Routing a custom "quit" id through
            // handle_menu_event keeps app-menu Quit and tray Quit identical.
            let quit_app_item = MenuItemBuilder::with_id("quit", "Quit Minsky Cockpit")
                .accelerator("CmdOrCtrl+Q")
                .build(app)?;
            let app_submenu = SubmenuBuilder::new(app, "Minsky Cockpit")
                .about(None)
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .item(&quit_app_item)
                .build()?;
            let edit_submenu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            let reload_item = MenuItemBuilder::with_id("reload", "Reload")
                .accelerator("CmdOrCtrl+R")
                .build(app)?;
            // Zoom items (mt#2334), applied via `WebviewWindow::set_zoom` in
            // handle_menu_event. Zoom In binds `CmdOrCtrl+=` — the `=`/`+`
            // physical key (muda has no "Plus" token).
            let zoom_in_item = MenuItemBuilder::with_id("zoom_in", "Zoom In")
                .accelerator("CmdOrCtrl+=")
                .build(app)?;
            let zoom_out_item = MenuItemBuilder::with_id("zoom_out", "Zoom Out")
                .accelerator("CmdOrCtrl+-")
                .build(app)?;
            let zoom_reset_item = MenuItemBuilder::with_id("zoom_reset", "Actual Size")
                .accelerator("CmdOrCtrl+0")
                .build(app)?;
            let view_submenu = SubmenuBuilder::new(app, "View")
                .item(&reload_item)
                .separator()
                .item(&zoom_in_item)
                .item(&zoom_out_item)
                .item(&zoom_reset_item)
                .build()?;
            let window_submenu = SubmenuBuilder::new(app, "Window")
                .minimize()
                .close_window()
                .build()?;
            let app_menu = MenuBuilder::new(app)
                .item(&app_submenu)
                .item(&edit_submenu)
                .item(&view_submenu)
                .item(&window_submenu)
                .build()?;
            app.set_menu(app_menu)?;
            // App-menu custom-id events. Predefined items (copy/paste/minimize/
            // etc.) are handled natively by the OS; only our custom "reload" and
            // "quit" items need forwarding. The filter also guards against
            // double-firing the tray's daemon lifecycle commands should this
            // global handler also receive tray-menu events on some platforms
            // (Shutdown + app.exit are idempotent, so a double "quit" is benign).
            app.on_menu_event(move |app, event| {
                match event.id().as_ref() {
                    "reload" | "quit" | "zoom_in" | "zoom_out" | "zoom_reset" => {
                        handle_menu_event(app, event.id().as_ref())
                    }
                    _ => {}
                }
            });

            // Command channel: menu handler (main thread) → supervisor thread.
            let (tx, rx) = mpsc::unbounded_channel::<SupervisorCmd>();
            app.manage(SupervisorHandle(tx));

            let sup_app = handle.clone();
            let sup_spawned = spawned_setup.clone();
            std::thread::spawn(move || run_supervisor(sup_app, rx, sup_spawned));

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error building cockpit tray");

    app.run(move |_app_handle, event| {
        match event {
            // A window-close (Cmd+W or the red close button) requests exit with
            // code None. This is a menu-bar app: closing the cockpit window must
            // NOT kill the tray app or the daemon — keep running headless so the
            // window can be reopened via "Open Cockpit". Only an explicit
            // app.exit() (code Some — the Quit path) proceeds to teardown.
            RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
            RunEvent::Exit => {
                // Synchronous teardown of the daemon we spawned. Idempotent, so
                // it's safe to fire here on the explicit-quit path.
                teardown(&spawned);
            }
            _ => {}
        }
    });
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        "open_window" => open_cockpit_window(app),
        "reload" => {
            if let Some(window) = app.get_webview_window(COCKPIT_WINDOW_LABEL) {
                if let Err(e) = window.eval("window.location.reload()") {
                    eprintln!("[cockpit-tray] failed to reload cockpit window: {e}");
                }
            }
        }
        "zoom_in" | "zoom_out" | "zoom_reset" => {
            // try_state (not state) so an early/edge invocation before the
            // managed value exists is a no-op rather than a panic (mt#2334 review).
            if let (Some(window), Some(zoom_state)) = (
                app.get_webview_window(COCKPIT_WINDOW_LABEL),
                app.try_state::<ZoomLevel>(),
            ) {
                let mut zoom = zoom_state.0.lock().unwrap();
                *zoom = match id {
                    "zoom_out" => (*zoom - 0.1).max(0.3),
                    "zoom_reset" => 1.0,
                    _ => (*zoom + 0.1).min(3.0), // zoom_in
                };
                if let Err(e) = window.set_zoom(*zoom) {
                    eprintln!("[cockpit-tray] failed to set cockpit window zoom: {e}");
                }
            }
        }
        "open" => {
            let _ = open::that(COCKPIT_URL);
        }
        "start" => send_cmd(app, SupervisorCmd::Start),
        "stop" => send_cmd(app, SupervisorCmd::Stop),
        "restart" => send_cmd(app, SupervisorCmd::Restart),
        "quit" => {
            // Ask the supervisor to stop the daemon, then exit. The
            // RunEvent::Exit handler tears the daemon down synchronously as the
            // reliable path (the process may exit before the supervisor reacts).
            send_cmd(app, SupervisorCmd::Shutdown);
            app.exit(0);
        }
        _ => {}
    }
}

/// Show + focus the cockpit window without reloading, creating it if needed.
///
/// Used by the deep-link handler so the navigation eval can land on the CURRENT
/// SPA state rather than after a reload. Contrast with `open_cockpit_window`,
/// which always reloads to recover after a daemon restart — that reload would
/// race with the deep-link eval if used here.
fn ensure_cockpit_window_visible(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(COCKPIT_WINDOW_LABEL) {
        if let Err(e) = window.show() {
            eprintln!("[cockpit-tray] deep-link: failed to show cockpit window: {e}");
        }
        if let Err(e) = window.set_focus() {
            eprintln!("[cockpit-tray] deep-link: failed to focus cockpit window: {e}");
        }
        return;
    }
    // Window doesn't exist yet — create it (same as open_cockpit_window).
    // The retry loop will wait for the webview to load before eval-ing.
    open_cockpit_window(app);
}

/// Handle a `minsky://` deep-link URL (mt#2528, ADR-023).
///
/// Called from the `on_open_url` handler registered in `setup`. Brings up the
/// cockpit window — showing/focusing an existing one synchronously, or CREATING a
/// missing one deferred onto the main run loop (mt#2546; `WebviewWindowBuilder::build()`
/// deadlocks if called directly from the synchronous `on_open_url` callback, which
/// holds the run loop) — then forwards the URL to the SPA via eval.
///
/// **Navigation strategy (ADR-023, cold-start handling):**
/// A single eval script runs on each retry attempt. It always sets
/// `window.__minskyPendingDeepLink` (so the SPA can drain it on mount), then
/// immediately calls `window.__minskyDeepLink(uri)` if the global is already
/// defined (hot-start fast path). Once ANY eval attempt succeeds, we stop
/// retrying -- the pending variable is set and the SPA will pick it up.
///
/// Retries are needed because `eval()` fails with an error when the webview is
/// not yet ready to accept script (e.g., just after `open_cockpit_window` is
/// called on cold start). Each retry sleeps `DEEP_LINK_RETRY_INTERVAL_MS` ms;
/// total retry window = `DEEP_LINK_RETRY_MAX` x `DEEP_LINK_RETRY_INTERVAL_MS`.
///
/// **Security:** the URL is JSON-encoded via `serde_json::to_string` before being
/// interpolated into the eval script -- never raw string-interpolated. This prevents
/// a crafted `minsky://` URL from breaking out of the JS string context.
fn handle_deep_link(app: &AppHandle, url: String) {
    // If a cockpit window ALREADY exists, show + focus it synchronously. Unlike
    // window CREATION (`build()`), `show()`/`set_focus()` don't block on the run
    // loop, so they're safe to call directly from the `on_open_url` callback. A
    // MISSING window is created later, deferred onto the run loop (see below).
    if let Some(window) = app.get_webview_window(COCKPIT_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
    }

    // JSON-encode the URL once so all retry attempts can reuse it.
    // serde_json::to_string on a &str produces a valid JSON string literal
    // including the surrounding double-quotes -- safe to interpolate into JS.
    let url_json = match serde_json::to_string(&url) {
        Ok(j) => j,
        Err(e) => {
            eprintln!("[cockpit-tray] deep-link: failed to JSON-encode URL {url:?}: {e}");
            return;
        }
    };

    // Step 2: forward the URL to the SPA via eval, with retry for cold-start.
    // The webview may not accept eval() immediately after window creation.
    let app_clone = app.clone();
    std::thread::spawn(move || {
        // Script run on every attempt:
        //  1. Always sets window.__minskyPendingDeepLink = url so the SPA can
        //     drain it on mount even if it hasn't mounted yet.
        //  2. Immediately calls window.__minskyDeepLink(url) if already defined
        //     (hot-start: SPA is already mounted) and clears the pending var.
        let script = format!(
            "(function(){{ \
                window.__minskyPendingDeepLink = {url_json}; \
                if (typeof window.__minskyDeepLink === 'function') {{ \
                    window.__minskyDeepLink({url_json}); \
                    window.__minskyPendingDeepLink = null; \
                }} \
            }})()"
        );

        // Create a MISSING window from this background thread, DEFERRED onto the
        // main run loop (mt#2546): scheduling via `run_on_main_thread` lands on the
        // next run-loop tick (after the synchronous `on_open_url` callback returned),
        // so `build()` can complete instead of deadlocking.
        //
        // `create_in_flight` (mt#2551) makes the deferred create resilient WITHOUT a
        // double-create race. `run_on_main_thread` returning Ok means the create
        // closure was ENQUEUED, not that `open_cockpit_window`'s `build()` succeeded.
        // The flag is set BEFORE enqueueing and cleared only INSIDE the closure (once
        // `ensure_cockpit_window_visible` has returned and the window therefore either
        // exists or has definitively failed to build). So:
        //   - while a create is queued OR mid-flight, no second create is scheduled —
        //     even on a slow/back-pressured machine where `build()` outlasts any fixed
        //     grace window (the race flagged on PR #1741);
        //   - if the deferred create FAILS, the flag clears with the window still
        //     absent, and the next tick re-schedules — so a one-off transient failure
        //     doesn't spin out the whole retry budget with no window.
        // On `run_on_main_thread` Err the closure never runs, so the flag is cleared
        // here to allow a retry on the next tick.
        let create_in_flight = Arc::new(AtomicBool::new(false));
        let mut schedule_count: u32 = 0;
        for attempt in 0..DEEP_LINK_RETRY_MAX {
            std::thread::sleep(Duration::from_millis(DEEP_LINK_RETRY_INTERVAL_MS));

            let Some(window) = app_clone.get_webview_window(COCKPIT_WINDOW_LABEL) else {
                // No window yet — schedule creation unless one is already in flight.
                if !create_in_flight.swap(true, Ordering::AcqRel) {
                    let app_for_window = app_clone.clone();
                    let flag = create_in_flight.clone();
                    match app_clone.run_on_main_thread(move || {
                        ensure_cockpit_window_visible(&app_for_window);
                        flag.store(false, Ordering::Release);
                    }) {
                        Ok(()) => {
                            schedule_count += 1;
                            // Log once, on the first RE-schedule (a prior deferred
                            // create produced no window) — a useful field signal
                            // without spamming the happy path.
                            if schedule_count == 2 {
                                eprintln!("[cockpit-tray] deep-link: re-scheduling window creation (prior deferred create produced no window) for {url:?}");
                            }
                        }
                        Err(e) => {
                            create_in_flight.store(false, Ordering::Release);
                            if attempt == 0 {
                                eprintln!("[cockpit-tray] deep-link: run_on_main_thread (window create) failed, will retry: {e}");
                            }
                        }
                    }
                }
                continue;
            };

            match window.eval(&script) {
                Ok(_) => {
                    // eval succeeded: __minskyPendingDeepLink is now set and
                    // __minskyDeepLink was called if defined. Done.
                    return;
                }
                Err(e) => {
                    if attempt == 0 {
                        eprintln!(
                            "[cockpit-tray] deep-link: eval attempt 0 failed (webview not ready?): {e}"
                        );
                    }
                    // Webview not ready yet -- keep retrying.
                }
            }
        }
        eprintln!(
            "[cockpit-tray] deep-link: gave up after {DEEP_LINK_RETRY_MAX} attempts for {url:?}"
        );
    });
}

/// Open the embedded cockpit window, or focus it if it already exists (mt#2219).
fn open_cockpit_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(COCKPIT_WINDOW_LABEL) {
        if let Err(e) = window.show() {
            eprintln!("[cockpit-tray] failed to show cockpit window: {e}");
        }
        if let Err(e) = window.set_focus() {
            eprintln!("[cockpit-tray] failed to focus cockpit window: {e}");
        }
        // Reload so the view recovers after a daemon Start/Restart.
        if let Err(e) = window.eval("window.location.reload()") {
            eprintln!("[cockpit-tray] failed to reload cockpit window: {e}");
        }
        return;
    }

    let url: tauri::Url = match COCKPIT_URL.parse() {
        Ok(url) => url,
        Err(e) => {
            eprintln!("[cockpit-tray] invalid cockpit URL {COCKPIT_URL:?}: {e}");
            return;
        }
    };

    match WebviewWindowBuilder::new(app, COCKPIT_WINDOW_LABEL, WebviewUrl::External(url))
        .title("Minsky Cockpit")
        .inner_size(1200.0, 800.0)
        .build()
    {
        // Re-apply the tracked zoom (mt#2334 review): closing the window
        // destroys it (prevent_exit keeps the *app* alive, not the window), so a
        // reopened window starts at the webview default — restore the stored
        // factor or the next zoom step would jump from 1.0 to the tracked value.
        Ok(window) => {
            if let Some(zoom_state) = app.try_state::<ZoomLevel>() {
                let factor = *zoom_state.0.lock().unwrap();
                if (factor - 1.0).abs() > f64::EPSILON {
                    if let Err(e) = window.set_zoom(factor) {
                        eprintln!("[cockpit-tray] failed to apply saved cockpit zoom: {e}");
                    }
                }
            }
        }
        Err(e) => eprintln!("[cockpit-tray] failed to create cockpit window: {e}"),
    }
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

#[cfg(test)]
mod tests {
    use super::*;

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

    // --- mt#2297: bundle-freshness + build helpers ---

    fn touch(path: &Path, mtime: SystemTime) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("mkdir");
        }
        File::create(path).expect("create");
        // Set mtime via `filetime` (a dev-dependency) for deterministic,
        // toolchain-version-independent control of the freshness comparison.
        filetime::set_file_mtime(path, filetime::FileTime::from_system_time(mtime))
            .expect("set mtime");
    }

    fn tmp(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mt2297-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn dist_staleness_no_dist_when_index_missing() {
        let dir = tmp("nodist");
        touch(&dir.join("App.tsx"), SystemTime::now());
        assert_eq!(dist_staleness(&dir), Staleness::NoDist);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn dist_staleness_fresh_when_dist_newer() {
        let dir = tmp("fresh");
        let base = UNIX_EPOCH + Duration::from_secs(1_000_000);
        touch(&dir.join("App.tsx"), base);
        touch(&dist_index(&dir), base + Duration::from_secs(10));
        assert_eq!(dist_staleness(&dir), Staleness::Fresh);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn dist_staleness_stale_when_source_newer() {
        let dir = tmp("stale");
        let base = UNIX_EPOCH + Duration::from_secs(1_000_000);
        touch(&dist_index(&dir), base);
        touch(&dir.join("widgets/Foo.tsx"), base + Duration::from_secs(10));
        assert_eq!(dist_staleness(&dir), Staleness::Stale);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn dist_staleness_ignores_excluded_dirs() {
        let dir = tmp("excl");
        let base = UNIX_EPOCH + Duration::from_secs(1_000_000);
        touch(&dir.join("App.tsx"), base);
        touch(&dist_index(&dir), base + Duration::from_secs(10));
        // Newer files under excluded dirs must NOT flip the verdict to Stale.
        touch(
            &dir.join("node_modules/pkg/x.js"),
            base + Duration::from_secs(100),
        );
        touch(
            &dir.join("dist/assets/app.js"),
            base + Duration::from_secs(100),
        );
        touch(&dir.join(".git/HEAD"), base + Duration::from_secs(100));
        assert_eq!(dist_staleness(&dir), Staleness::Fresh);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn path_is_excluded_matches_excluded_dirs() {
        assert!(path_is_excluded(Path::new(
            "/r/src/cockpit/web/dist/index.html"
        )));
        assert!(path_is_excluded(Path::new(
            "/r/src/cockpit/web/node_modules/x/y.js"
        )));
        assert!(path_is_excluded(Path::new("/r/src/cockpit/web/.git/HEAD")));
        assert!(!path_is_excluded(Path::new(
            "/r/src/cockpit/web/widgets/Foo.tsx"
        )));
        assert!(!path_is_excluded(Path::new("/r/src/cockpit/web/App.tsx")));
    }

    #[test]
    fn is_relevant_source_change_filters_excluded_and_temp() {
        // Real source edits (paths relative to web_src) trigger a rebuild.
        assert!(is_relevant_source_change(Path::new("widgets/Foo.tsx")));
        assert!(is_relevant_source_change(Path::new("App.tsx")));
        // Excluded dirs do not.
        assert!(!is_relevant_source_change(Path::new("dist/assets/app.js")));
        assert!(!is_relevant_source_change(Path::new("node_modules/x/y.js")));
        assert!(!is_relevant_source_change(Path::new(".git/HEAD")));
        // Editor temp/backup/hidden files do not.
        assert!(!is_relevant_source_change(Path::new(
            "widgets/.Foo.tsx.swp"
        )));
        assert!(!is_relevant_source_change(Path::new("widgets/Foo.tsx~")));
        assert!(!is_relevant_source_change(Path::new("widgets/#Foo.tsx#")));
    }

    #[test]
    fn format_hms_utc_formats_seconds_of_day() {
        assert_eq!(
            format_hms_utc(UNIX_EPOCH + Duration::from_secs(3661)),
            "01:01:01 UTC"
        );
        assert_eq!(
            format_hms_utc(UNIX_EPOCH + Duration::from_secs(86_400 * 100)),
            "00:00:00 UTC"
        );
    }

    #[test]
    fn build_error_summary_takes_last_nonempty_line() {
        assert_eq!(
            build_error_summary(b"warn\n\nError: boom\n\n", b""),
            "Error: boom"
        );
        assert_eq!(build_error_summary(b"", b"out line\n"), "out line");
        assert_eq!(build_error_summary(b"", b""), "build failed");
    }

    #[test]
    fn build_label_for_renders_states() {
        let t = UNIX_EPOCH + Duration::from_secs(3661);
        assert_eq!(
            build_label_for(&Ok(()), t, false),
            "Last build: 01:01:01 UTC"
        );
        assert_eq!(
            build_label_for(&Err("E".to_string()), t, true),
            "Build FAILED (E) - serving prior bundle"
        );
        assert_eq!(
            build_label_for(&Err("E".to_string()), t, false),
            "Build FAILED (E) - nothing to serve"
        );
    }

    // --- mt#2299: backend-source freshness + uptime + conflict helpers ---

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
    fn is_relevant_backend_change_filters_web_test_and_nonts() {
        // Real server-side .ts edits trigger a restart.
        assert!(is_relevant_backend_change(Path::new("server.ts")));
        assert!(is_relevant_backend_change(Path::new("widget-registry.ts")));
        assert!(is_relevant_backend_change(Path::new("widgets/agents.ts")));
        assert!(is_relevant_backend_change(Path::new("config.ts")));
        // web/** is mt#2297's territory — must NOT restart the daemon (test 6).
        assert!(!is_relevant_backend_change(Path::new("web/App.tsx")));
        assert!(!is_relevant_backend_change(Path::new(
            "web/dist/index.html"
        )));
        // deps/git internals excluded.
        assert!(!is_relevant_backend_change(Path::new(
            "node_modules/x/y.ts"
        )));
        assert!(!is_relevant_backend_change(Path::new(".git/HEAD")));
        // non-.ts, test files, and editor temp files excluded.
        assert!(!is_relevant_backend_change(Path::new("README.md")));
        assert!(!is_relevant_backend_change(Path::new("server.test.ts")));
        assert!(!is_relevant_backend_change(Path::new(
            "widgets/.agents.ts.swp"
        )));
        // .mts/.cts modules trigger; their test variants don't (reviewer R1 NB1).
        assert!(is_relevant_backend_change(Path::new("server.mts")));
        assert!(is_relevant_backend_change(Path::new("server.cts")));
        assert!(!is_relevant_backend_change(Path::new("server.test.mts")));
        assert!(!is_relevant_backend_change(Path::new("server.test.cts")));
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
    fn newest_backend_mtime_ignores_web_test_and_excluded() {
        let dir = tmp("backend");
        let base = UNIX_EPOCH + Duration::from_secs(1_000_000);
        touch(&dir.join("server.ts"), base);
        touch(
            &dir.join("widgets/agents.ts"),
            base + Duration::from_secs(10),
        );
        // Newer files that must NOT count: web/** (mt#2297), test files, deps.
        touch(&dir.join("web/App.tsx"), base + Duration::from_secs(100));
        touch(&dir.join("server.test.ts"), base + Duration::from_secs(100));
        touch(
            &dir.join("node_modules/x.ts"),
            base + Duration::from_secs(100),
        );
        assert_eq!(
            newest_backend_mtime(&dir),
            Some(base + Duration::from_secs(10))
        );
        let _ = std::fs::remove_dir_all(&dir);
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

    /// parse_launchctl_pid: running agent output contains PID line.
    #[test]
    fn parse_launchctl_pid_running_agent() {
        // Simulates `launchctl list com.minsky.cockpit` output when agent is running.
        let output = r#"{
	"LimitLoadToSessionType" = "Aqua";
	"Label" = "com.minsky.cockpit";
	"OnDemand" = true;
	"LastExitStatus" = 0;
	"PID" = 12345;
	"Program" = "/usr/local/bin/minsky";
};"#;
        assert_eq!(parse_launchctl_pid(output), Some(12345));
    }

    /// parse_launchctl_pid: stopped/loaded agent output has no PID line.
    #[test]
    fn parse_launchctl_pid_stopped_agent() {
        // Simulates output when agent is loaded but not running (stopped).
        let output = r#"{
	"LimitLoadToSessionType" = "Aqua";
	"Label" = "com.minsky.cockpit";
	"OnDemand" = true;
	"LastExitStatus" = 0;
	"Program" = "/usr/local/bin/minsky";
};"#;
        assert_eq!(parse_launchctl_pid(output), None);
    }

    /// parse_launchctl_pid: empty string yields None.
    #[test]
    fn parse_launchctl_pid_empty() {
        assert_eq!(parse_launchctl_pid(""), None);
    }

    /// Verify the constant value that launchctl queries / bootouts.
    #[test]
    fn legacy_launchd_label_constant() {
        assert_eq!(LEGACY_LAUNCHD_LABEL, "com.minsky.cockpit");
    }

    /// On a clean dev machine (no legacy agent loaded) the probe returns false.
    /// This is the common case after ADR-014 adoption.
    /// If the legacy agent IS loaded (old install), the function would attempt
    /// bootout and return true — that path requires a native smoke test.
    #[test]
    fn try_evict_returns_false_when_agent_absent() {
        // launchctl list com.minsky.cockpit exits non-zero if the agent is absent.
        // The test skips if the agent IS loaded to avoid clobbering a real install.
        let probe = std::process::Command::new("launchctl")
            .args(["list", LEGACY_LAUNCHD_LABEL])
            .output();
        match probe {
            Ok(out) if out.status.success() => {
                // Agent is loaded — skip rather than evict a real install.
                eprintln!("[test] legacy agent is loaded; skipping try_evict no-op assertion");
            }
            _ => {
                // Agent absent — function must return false (no bootout attempted).
                assert!(
                    !try_evict_legacy_launchd(None),
                    "should return false when the legacy launchd agent is absent"
                );
            }
        }
    }
}