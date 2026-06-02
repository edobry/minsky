// Minsky Cockpit menu bar app (mt#2140)
//
// A macOS system-tray application that monitors the cockpit daemon's
// health endpoint and provides start/stop/open controls.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::menu::{MenuBuilder, MenuItem, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, Wry};

const HEALTH_URL: &str = "http://localhost:3737/api/health";
const COCKPIT_URL: &str = "http://localhost:3737";
const COCKPIT_WINDOW_LABEL: &str = "cockpit";
const POLL_INTERVAL: Duration = Duration::from_secs(5);
const STATUS_MENU_ID: &str = "status";

/// Handle to the dropdown status `MenuItem`, stored in Tauri managed state so
/// the poll loop and the menu-event handler can update its text directly.
///
/// The menu is attached to the TRAY (`TrayIconBuilder::menu(&menu)`), not to the
/// app, so `app.menu()` returns `None`. The previous implementation looked the
/// status item up via `app.menu()`, so `set_text` silently no-op'd and the
/// dropdown line stayed frozen on "Cockpit: checking..." while only the tooltip
/// updated. Holding the item handle is the reliable path (mt#2240).
struct StatusMenuItem(MenuItem<Wry>);

/// Pure mapping from a health-poll result to the status label. Extracted so the
/// label contract is unit-testable without the Tauri runtime (mt#2240 / mt#2226).
fn status_label(healthy: bool) -> &'static str {
    if healthy {
        "Cockpit: running"
    } else {
        "Cockpit: stopped"
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let is_running = Arc::new(AtomicBool::new(false));

            // Keep the app out of the Dock even though it now owns a window
            // (mt#2219). Without Accessory policy, creating the cockpit window
            // makes a Dock icon appear — a regression from the tray-only app.
            // mt#2202 owns the Info.plist LSUIElement path; the Tauri
            // activation policy achieves the same accessory behavior here
            // without touching that file.
            #[cfg(target_os = "macos")]
            let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let status_item = MenuItemBuilder::with_id(STATUS_MENU_ID, "Cockpit: checking...")
                .enabled(false)
                .build(app)?;
            // Hold the status item in managed state so update_status can mutate
            // it directly (the menu is on the tray, not app.menu()).
            app.manage(StatusMenuItem(status_item.clone()));
            let open_window_item =
                MenuItemBuilder::with_id("open_window", "Open Cockpit").build(app)?;
            let open_item =
                MenuItemBuilder::with_id("open", "Open in Browser").build(app)?;
            let separator1 = tauri::menu::PredefinedMenuItem::separator(app)?;
            let start_item =
                MenuItemBuilder::with_id("start", "Start Daemon").build(app)?;
            let stop_item =
                MenuItemBuilder::with_id("stop", "Stop Daemon").build(app)?;
            let restart_item =
                MenuItemBuilder::with_id("restart", "Restart Daemon").build(app)?;
            let separator2 = tauri::menu::PredefinedMenuItem::separator(app)?;
            let quit_item =
                MenuItemBuilder::with_id("quit", "Quit Cockpit Tray").build(app)?;

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

            // Spawn health-check polling loop
            let poll_handle = handle.clone();
            let poll_running = is_running.clone();
            std::thread::spawn(move || {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("tokio runtime");

                rt.block_on(async {
                    // pool_max_idle_per_host(0) disables keep-alive connection
                    // reuse: each poll opens a fresh connection. Without this the
                    // client reuses a pooled connection that can go stale (daemon
                    // idle-close / half-open socket), so every subsequent poll
                    // fails its 2s timeout and the status sticks on "stopped" even
                    // while the daemon is up and reachable on a fresh connection
                    // (mt#2225).
                    let client = reqwest::Client::builder()
                        .timeout(Duration::from_secs(2))
                        .pool_max_idle_per_host(0)
                        .build()
                        .unwrap();

                    let mut first_poll = true;
                    loop {
                        let healthy = client.get(HEALTH_URL).send().await.is_ok();
                        let was_running = poll_running.swap(healthy, Ordering::Relaxed);

                        if first_poll || healthy != was_running {
                            first_poll = false;
                            let _ = update_status(&poll_handle, status_label(healthy));
                        }

                        tokio::time::sleep(POLL_INTERVAL).await;
                    }
                });
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error running cockpit tray");
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        "open_window" => {
            open_cockpit_window(app);
        }
        "open" => {
            let _ = open::that(COCKPIT_URL);
        }
        "start" => {
            let _ = Command::new("launchctl")
                .args(["load", &get_plist_path()])
                .output();
            let _ = update_status(app, "Cockpit: starting...");
        }
        "stop" => {
            let _ = Command::new("launchctl")
                .args(["unload", &get_plist_path()])
                .output();
            let _ = update_status(app, "Cockpit: stopped");
        }
        "restart" => {
            let plist = get_plist_path();
            let _ = Command::new("launchctl")
                .args(["unload", &plist])
                .output();
            std::thread::sleep(Duration::from_millis(500));
            let _ = Command::new("launchctl")
                .args(["load", &plist])
                .output();
            let _ = update_status(app, "Cockpit: restarting...");
        }
        "quit" => {
            app.exit(0);
        }
        _ => {}
    }
}

fn get_plist_path() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    format!(
        "{}/Library/LaunchAgents/com.minsky.cockpit.plist",
        home
    )
}

/// Open the embedded cockpit window, or focus it if it already exists (mt#2219).
///
/// Created lazily on first request (the app stays tray-only until the operator
/// asks for the window) and reused thereafter — a single window, never
/// duplicated. On reuse we reload so the view recovers after a daemon
/// Start/Restart. A first open while the daemon is down shows the webview's
/// connection-error page and recovers on the next "Open Cockpit" (manual reload
/// is acceptable for v0). "Open in Browser" remains as the fallback.
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
    // Marshal the UI mutation onto the main thread. update_status is called from
    // the background poll thread, and on macOS AppKit menu/tray mutations want
    // the main thread; run_on_main_thread is the idiomatic Tauri way to ensure
    // that. (MenuItem<Wry> is Send + Sync — app.manage requires it, which is why
    // storing it in managed state compiles — but the UI op still wants
    // main-thread affinity.)
    //
    // The status item lives in managed state because the menu is attached to the
    // tray, not app.menu() (mt#2240); the main-thread closure reads it back via
    // try_state and updates both the dropdown line and the tray tooltip.
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
    use super::status_label;

    #[test]
    fn status_label_maps_health_to_text() {
        assert_eq!(status_label(true), "Cockpit: running");
        assert_eq!(status_label(false), "Cockpit: stopped");
    }
}