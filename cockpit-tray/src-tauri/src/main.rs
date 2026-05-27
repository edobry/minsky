// Minsky Cockpit menu bar app (mt#2140)
//
// A macOS system-tray application that monitors the cockpit daemon's
// health endpoint and provides start/stop/open controls.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};

const HEALTH_URL: &str = "http://localhost:3737/api/health";
const COCKPIT_URL: &str = "http://localhost:3737";
const POLL_INTERVAL: Duration = Duration::from_secs(5);

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let is_running = Arc::new(AtomicBool::new(false));

            // Build the tray menu
            let status_item = MenuItemBuilder::with_id("status", "Cockpit: checking...")
                .enabled(false)
                .build(app)?;
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
                .item(&open_item)
                .item(&start_item)
                .item(&stop_item)
                .item(&restart_item)
                .item(&separator2)
                .item(&quit_item)
                .build()?;

            let _tray = TrayIconBuilder::new()
                .tooltip("Minsky Cockpit")
                .title("M")
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
                    let client = reqwest::Client::builder()
                        .timeout(Duration::from_secs(2))
                        .build()
                        .unwrap();

                    loop {
                        let healthy = client.get(HEALTH_URL).send().await.is_ok();
                        let was_running = poll_running.swap(healthy, Ordering::Relaxed);

                        if healthy != was_running {
                            let label = if healthy {
                                "Cockpit: running"
                            } else {
                                "Cockpit: stopped"
                            };
                            let _ = update_status_label(&poll_handle, label);
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
        "open" => {
            let _ = open::that(COCKPIT_URL);
        }
        "start" => {
            let _ = Command::new("launchctl")
                .args(["load", &get_plist_path()])
                .output();
            let _ = update_status_label(app, "Cockpit: starting...");
        }
        "stop" => {
            let _ = Command::new("launchctl")
                .args(["unload", &get_plist_path()])
                .output();
            let _ = update_status_label(app, "Cockpit: stopped");
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
            let _ = update_status_label(app, "Cockpit: restarting...");
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

fn update_status_label(app: &AppHandle, label: &str) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_tooltip(Some(label))?;
    }
    Ok(())
}
