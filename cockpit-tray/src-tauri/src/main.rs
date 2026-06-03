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
use std::os::unix::process::CommandExt; // process_group
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::menu::{MenuBuilder, MenuItem, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, Wry};
use tauri_plugin_autostart::MacosLauncher;
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

const LABEL_RUNNING: &str = "Cockpit: running";
const LABEL_STOPPED: &str = "Cockpit: stopped";
const LABEL_STARTING: &str = "Cockpit: starting...";
const LABEL_CONFLICT: &str = "Cockpit: :3737 in use (not cockpit)";
const LABEL_START_FAILED: &str = "Cockpit: start failed (see logs)";

/// Handle to the dropdown status `MenuItem`, stored in Tauri managed state so
/// the supervisor loop can update its text directly.
///
/// The menu is attached to the TRAY (`TrayIconBuilder::menu(&menu)`), not to the
/// app, so `app.menu()` returns `None`. Holding the item handle is the reliable
/// path (mt#2240).
struct StatusMenuItem(MenuItem<Wry>);

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
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

fn lsof_bin(path: &str) -> PathBuf {
    resolve_program("lsof", path).unwrap_or_else(|| PathBuf::from("/usr/sbin/lsof"))
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

/// Spawn `minsky cockpit start --port <port> --no-dev-chromium` as a managed
/// child in its own process group, with stdout/stderr appended to the cockpit
/// log files. Returns the child and its pgid (== child pid, since
/// `process_group(0)` makes it a new group leader).
fn spawn_daemon(port: u16, path: &str) -> io::Result<(Child, u32)> {
    let minsky = resolve_program("minsky", path).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "minsky not found on PATH — install the CLI or run the daemon manually",
        )
    })?;
    let out = open_log("cockpit-stdout.log")?;
    let err = open_log("cockpit-stderr.log")?;
    let mut cmd = Command::new(minsky);
    cmd.args([
        "cockpit",
        "start",
        "--port",
        &port.to_string(),
        "--no-dev-chromium",
    ])
    .env("PATH", path)
    .stdin(Stdio::null())
    .stdout(Stdio::from(out))
    .stderr(Stdio::from(err))
    .process_group(0);
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
    match spawn_daemon(DAEMON_PORT, path) {
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

/// Stop the running daemon. If we spawned it, kill our process group; if it was
/// adopted (externally started), kill the PID listening on the port. We only
/// reap a child we own — an adopted daemon's process is not ours to `wait`.
fn do_stop(sup: &mut Sup, spawned: &SpawnedPgid, path: &str) {
    if let Some(mut child) = sup.child.take() {
        let pgid = spawned.lock().ok().and_then(|mut g| g.take());
        if let Some(pgid) = pgid {
            kill_group(pgid);
        }
        let _ = child.kill();
        let _ = child.wait();
    } else if let Some(pid) = pid_on_port(DAEMON_PORT, path) {
        kill_pid(pid);
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
                        do_stop(&mut sup, &spawned, &path);
                        set_status(&app, &mut sup, LABEL_STOPPED);
                    }
                    Some(SupervisorCmd::Restart) => {
                        do_stop(&mut sup, &spawned, &path);
                        tokio::time::sleep(Duration::from_millis(500)).await;
                        do_spawn(&app, &mut sup, &spawned, &path);
                    }
                    Some(SupervisorCmd::Shutdown) | None => {
                        do_stop(&mut sup, &spawned, &path);
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

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        // LaunchAgent mode registers a per-user Login Item that starts THIS app
        // (com.minsky.cockpit-tray) at login — the RunAtLoad replacement from
        // ADR-014. Distinct from the daemon's own com.minsky.cockpit launchd
        // plist (the optional headless path).
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
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
}