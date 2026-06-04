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
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use tauri::menu::{MenuBuilder, MenuItem, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, Wry};
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
    OpenOptions::new().create(true).append(true).open(dir.join(name))
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
    let plutil = resolve_program("plutil", path).unwrap_or_else(|| PathBuf::from("/usr/bin/plutil"));
    let out = Command::new(plutil)
        .args(["-extract", "WorkingDirectory", "raw", "-o", "-", plist.to_str()?])
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
    last_status: Option<&'static str>,
    /// Last value pushed to the build-status menu line (mt#2297), for dedupe.
    last_build_label: Option<String>,
}

/// Update the visible status label (dropdown line + tray tooltip), skipping
/// the UI round-trip when the label hasn't changed.
fn set_status(app: &AppHandle, sup: &mut Sup, label: &'static str) {
    if sup.last_status == Some(label) {
        return;
    }
    sup.last_status = Some(label);
    let _ = update_status(app, label);
}

fn do_spawn(app: &AppHandle, sup: &mut Sup, spawned: &SpawnedPgid, path: &str) {
    let bun = match resolve_program("bun", path) {
        Some(b) => b,
        None => {
            eprintln!("[cockpit-tray] bun not found on PATH — cannot spawn daemon");
            set_status(app, sup, LABEL_NO_BUN);
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
            return;
        }
    };
    // mt#2297: source-gated pre-flight rebuild. Only when the web source is
    // present (developer/source operator); a no-source install skips this and
    // serves whatever bundle ships with the app.
    if cockpit_web_src(&repo_root).is_dir() {
        if let PreflightResult::Refuse = preflight_rebuild(app, sup, &bun, &repo_root, path) {
            set_status(app, sup, LABEL_START_FAILED);
            return;
        }
    }
    match spawn_daemon(&bun, &repo_root, DAEMON_PORT, path) {
        Ok((child, pid)) => {
            sup.child = Some(child);
            sup.last_spawn = Some(Instant::now());
            if let Ok(mut g) = spawned.lock() {
                *g = Some(pid);
            }
            set_status(app, sup, LABEL_STARTING);
        }
        Err(e) => {
            eprintln!("[cockpit-tray] daemon spawn failed: {e}");
            set_status(app, sup, LABEL_START_FAILED);
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

fn run_supervisor(app: AppHandle, mut rx: mpsc::UnboundedReceiver<SupervisorCmd>, spawned: SpawnedPgid) {
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
        };

        // Initial adoption-or-spawn.
        match decide_action(health_ok(&client).await, port_in_use(DAEMON_PORT, &path)) {
            DaemonAction::Adopt => set_status(&app, &mut sup, LABEL_RUNNING),
            DaemonAction::Conflict => set_status(&app, &mut sup, LABEL_CONFLICT),
            DaemonAction::Spawn => do_spawn(&app, &mut sup, &spawned, &path),
        }

        loop {
            tokio::select! {
                cmd = rx.recv() => match cmd {
                    Some(SupervisorCmd::Start) => {
                        match decide_action(health_ok(&client).await, port_in_use(DAEMON_PORT, &path)) {
                            DaemonAction::Adopt => set_status(&app, &mut sup, LABEL_RUNNING),
                            DaemonAction::Conflict => set_status(&app, &mut sup, LABEL_CONFLICT),
                            DaemonAction::Spawn => do_spawn(&app, &mut sup, &spawned, &path),
                        }
                    }
                    Some(SupervisorCmd::Stop) => {
                        let had_child = sup.child.is_some();
                        let h = health_ok(&client).await;
                        do_stop(&mut sup, &spawned, &path, h);
                        if !had_child && !h && port_in_use(DAEMON_PORT, &path) {
                            // A foreign process owns :3737 — we didn't (and won't) kill it.
                            set_status(&app, &mut sup, LABEL_CONFLICT);
                        } else {
                            set_status(&app, &mut sup, LABEL_STOPPED);
                        }
                    }
                    Some(SupervisorCmd::Restart) => {
                        let h = health_ok(&client).await;
                        if sup.child.is_none() && !h && port_in_use(DAEMON_PORT, &path) {
                            // Foreign listener owns the port — refuse to restart over it.
                            set_status(&app, &mut sup, LABEL_CONFLICT);
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
                            set_build_status(
                                &app,
                                &mut sup,
                                build_label_for(&result, SystemTime::now(), true),
                            );
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
                    if health_ok(&client).await {
                        set_status(&app, &mut sup, LABEL_RUNNING);
                        continue;
                    }
                    // Health is down. Only a daemon WE spawned is respawned.
                    match sup.child.as_mut().map(|c| c.try_wait()) {
                        Some(Ok(Some(_status))) => {
                            // Our child exited — respawn (throttled).
                            sup.child = None;
                            if let Ok(mut g) = spawned.lock() {
                                *g = None;
                            }
                            if throttle_ok(sup.last_spawn, Instant::now(), RESPAWN_THROTTLE) {
                                do_spawn(&app, &mut sup, &spawned, &path);
                            } else {
                                set_status(&app, &mut sup, LABEL_STOPPED);
                            }
                        }
                        Some(Ok(None)) => {
                            // Child alive but not yet serving — still booting.
                            set_status(&app, &mut sup, LABEL_STARTING);
                        }
                        Some(Err(_)) | None => {
                            // No child of ours (adopted daemon down, or never
                            // spawned). Don't auto-spawn over an adopted daemon.
                            set_status(&app, &mut sup, LABEL_STOPPED);
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
    let secs = t.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let sod = secs % 86_400;
    format!("{:02}:{:02}:{:02} UTC", sod / 3600, (sod % 3600) / 60, sod % 60)
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
            if output.status.success() { "OK" } else { "FAILED" },
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
            set_build_status(app, sup, build_label_for(&result, SystemTime::now(), servable_prior));
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
fn start_web_watcher(
    app: &AppHandle,
    web_src: &Path,
) -> Option<Debouncer<RecommendedWatcher>> {
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
    let mut builder = tauri::Builder::default().plugin(tauri_plugin_shell::init());
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
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            // Synchronous teardown of the daemon we spawned. Idempotent, so it's
            // safe to also fire from the "quit" menu path and on both events.
            teardown(&spawned);
        }
    });
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        "open_window" => open_cockpit_window(app),
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

    if let Err(e) = WebviewWindowBuilder::new(app, COCKPIT_WINDOW_LABEL, WebviewUrl::External(url))
        .title("Minsky Cockpit")
        .inner_size(1200.0, 800.0)
        .build()
    {
        eprintln!("[cockpit-tray] failed to create cockpit window: {e}");
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
        assert_eq!(repo_root_from_bin_path(Path::new("/usr/local/bin/minsky")), None);
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
        touch(&dir.join("node_modules/pkg/x.js"), base + Duration::from_secs(100));
        touch(&dir.join("dist/assets/app.js"), base + Duration::from_secs(100));
        touch(&dir.join(".git/HEAD"), base + Duration::from_secs(100));
        assert_eq!(dist_staleness(&dir), Staleness::Fresh);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn path_is_excluded_matches_excluded_dirs() {
        assert!(path_is_excluded(Path::new("/r/src/cockpit/web/dist/index.html")));
        assert!(path_is_excluded(Path::new("/r/src/cockpit/web/node_modules/x/y.js")));
        assert!(path_is_excluded(Path::new("/r/src/cockpit/web/.git/HEAD")));
        assert!(!path_is_excluded(Path::new("/r/src/cockpit/web/widgets/Foo.tsx")));
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
        assert!(!is_relevant_source_change(Path::new("widgets/.Foo.tsx.swp")));
        assert!(!is_relevant_source_change(Path::new("widgets/Foo.tsx~")));
        assert!(!is_relevant_source_change(Path::new("widgets/#Foo.tsx#")));
    }

    #[test]
    fn format_hms_utc_formats_seconds_of_day() {
        assert_eq!(format_hms_utc(UNIX_EPOCH + Duration::from_secs(3661)), "01:01:01 UTC");
        assert_eq!(format_hms_utc(UNIX_EPOCH + Duration::from_secs(86_400 * 100)), "00:00:00 UTC");
    }

    #[test]
    fn build_error_summary_takes_last_nonempty_line() {
        assert_eq!(build_error_summary(b"warn\n\nError: boom\n\n", b""), "Error: boom");
        assert_eq!(build_error_summary(b"", b"out line\n"), "out line");
        assert_eq!(build_error_summary(b"", b""), "build failed");
    }

    #[test]
    fn build_label_for_renders_states() {
        let t = UNIX_EPOCH + Duration::from_secs(3661);
        assert_eq!(build_label_for(&Ok(()), t, false), "Last build: 01:01:01 UTC");
        assert_eq!(
            build_label_for(&Err("E".to_string()), t, true),
            "Build FAILED (E) - serving prior bundle"
        );
        assert_eq!(
            build_label_for(&Err("E".to_string()), t, false),
            "Build FAILED (E) - nothing to serve"
        );
    }
}