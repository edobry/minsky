// Minsky Cockpit menu bar app (mt#2140, supervisor model mt#2241)
//
// A macOS system-tray application that owns the cockpit daemon's lifecycle:
// it spawns the daemon as a managed child, supervises it (respawn-on-crash +
// throttle), ADOPTS an already-running daemon on :3737 instead of double-
// spawning, tears down what it spawned on quit, and registers itself as a
// macOS Login Item for auto-start. launchd (`minsky cockpit install`) is
// retained as an optional opt-in headless mode. See
// docs/architecture/adr-014-cockpit-daemon-lifecycle-ownership.md.
//
// This file is boot/composition only (mt#2628): it wires the Tauri app
// together from the per-concern modules below and owns the top-level
// RunEvent handling (window-close vs. quit teardown). See each module's own
// doc comment for its concern:
//   - menu: tray/app-menu construction + menu-event dispatch
//   - supervisor: daemon spawn/detect/kill/health-poll + self-health watchdog
//   - watcher_web / watcher_backend: source-freshness auto-rebuild/-restart
//   - deeplink: minsky:// URL-scheme handling
//   - launchd: legacy launchd-agent detection/eviction

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod deeplink;
mod launchd;
mod menu;
mod supervisor;
mod watcher_backend;
mod watcher_web;

use std::sync::{Arc, Mutex};

use tauri::RunEvent;

use supervisor::SpawnedPgid;

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
            menu::init_zoom_state(app);

            // Register the minsky:// URL-scheme handler (mt#2528, ADR-023).
            deeplink::register(app, &handle);

            // Keep the app out of the Dock at launch (mt#2219). This is the
            // SOLE owner of the menu-bar-only launch state: the declarative
            // Info.plist LSUIElement flag (mt#2202) was removed in mt#2675
            // because it pinned the app out of Cmd-Tab/Dock even after a
            // runtime Regular switch. tao applies this policy at
            // applicationDidFinishLaunching — before any window can exist —
            // so there is no Dock-icon flash. menu::set_dock_presence
            // (mt#2675) flips to Regular while the cockpit window is visible
            // so it is reachable via Cmd-Tab, and back to Accessory on hide.
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

            menu::build(app)?;

            // Command channel: menu handler (main thread) → supervisor thread.
            supervisor::spawn(handle, spawned_setup.clone());

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error building cockpit tray");

    app.run(move |_app_handle, event| {
        match event {
            // Backstop for window-close-driven exit requests (code None). The
            // normal close path never gets here since mt#2675: CloseRequested is
            // intercepted in menu.rs (hide-on-close), so the window survives and
            // no exit is requested. Should a close slip through anyway (e.g. a
            // destroy path that bypasses CloseRequested), this keeps the tray
            // app and the daemon alive — this is a menu-bar app; only an
            // explicit app.exit() (code Some — the Quit path) proceeds to
            // teardown.
            RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
            RunEvent::Exit => {
                // Synchronous teardown of the daemon we spawned. Idempotent, so
                // it's safe to fire here on the explicit-quit path.
                supervisor::teardown(&spawned);
            }
            // Dock-icon click / app reactivation with no visible window
            // (mt#2675): while the cockpit window is visible the app has Dock
            // presence (Regular activation policy), so the Dock icon is
            // clickable; if the window was hidden in the meantime, bring it
            // back. With a visible window macOS fronts it natively — no action
            // needed here.
            #[cfg(target_os = "macos")]
            RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } => {
                menu::ensure_cockpit_window_visible(_app_handle);
            }
            _ => {}
        }
    });
}
