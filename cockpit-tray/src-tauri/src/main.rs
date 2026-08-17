// Minsky Cockpit menu bar app (mt#2140, supervisor model mt#2241)
//
// A macOS system-tray application that owns the cockpit daemon's lifecycle:
// it spawns the daemon as a managed child, supervises it (respawn-on-crash +
// throttle), ADOPTS an already-running daemon on the configured cockpit port
// (`cockpit.port`, default 3737 — mt#3988) instead of double-
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
mod hotkey;
mod launchd;
mod menu;
mod mouse_nav;
mod port;
mod single_instance;
mod supervisor;
mod watcher_backend;
mod watcher_web;

use std::sync::{Arc, Mutex};

use tauri::RunEvent;

use supervisor::SpawnedPgids;

fn main() {
    // Before anything that can observe it: the single-instance callback reads
    // this to tell the login-time launch race from a deliberate re-launch.
    single_instance::mark_started();

    // One slot per daemon the tray spawns (mt#3815): a single `Option` could
    // only remember the last one, so quitting would have left the other running.
    let spawned: SpawnedPgids = Arc::new(Mutex::new(Vec::new()));
    let spawned_setup = spawned.clone();

    let mut builder = tauri::Builder::default();

    // Single-instance guard (mt#3770). Registered FIRST, per the plugin's own
    // documentation ("must be the first one to be registered to work well" --
    // https://v2.tauri.app/plugin/single-instance/).
    //
    // Release-only, for the same class of reason autostart is: the debug and
    // release builds share the `com.minsky.cockpit-tray` identifier, and the
    // guard keys its rendezvous socket on that identifier. Enabled in debug,
    // `bun run dev` would exit on launch whenever the installed /Applications
    // app is running -- which it nearly always is -- breaking the tray dev loop
    // documented in cockpit-tray/CLAUDE.md. The duplicate this closes is a
    // release-build phenomenon (both processes in the originating incident were
    // `/Applications/Minsky Cockpit.app`).
    #[cfg(not(debug_assertions))]
    {
        builder = builder.plugin(single_instance::plugin());
    }

    builder = builder
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        // minsky:// URL-scheme handler (mt#2528, ADR-023).
        // The deep-link plugin registers the OS scheme (CFBundleURLTypes on macOS)
        // and delivers opened URLs to on_open_url. Navigation is Rust→webview eval
        // because the SPA is an untrusted external-URL webview (no IPC bridge).
        .plugin(tauri_plugin_deep_link::init())
        // Global summon hotkey (mt#2676): registers the plugin + press
        // handler here; actual OS-level shortcut registration happens in
        // setup() via hotkey::register, which needs a live AppHandle to log
        // failures against.
        .plugin(hotkey::plugin());
    // LaunchAgent mode registers a per-user Login Item that starts THIS app
    // (com.minsky.cockpit-tray) at login — the RunAtLoad replacement from
    // ADR-014. Distinct from the daemon's own com.minsky.cockpit launchd plist
    // (the optional headless path). Release-only so dev runs stay pristine.
    //
    // This LaunchAgent is what RACED LaunchServices in mt#3770's incident, and
    // it is deliberately KEPT: the guard above absorbs the duplicate, and no
    // change here could close the general case anyway (a user double-clicking
    // the app while it runs is the same collision from a different direction).
    // The considered alternative -- switching to `MacosLauncher::AppleScript`,
    // so login goes through LaunchServices like every other launch and dedupes
    // there -- was rejected as a larger, riskier change than the defect
    // warrants: it needs System Events automation permission, which prompts.
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

            // Resolve the cockpit port BEFORE anything that consumes it
            // (mt#3988): the tray menu, the webview's same-origin check, the
            // deep-link recovery loop and the supervisor all read
            // `port::cockpit_port()`, and resolving first is what guarantees
            // none of them can observe a different value than the others.
            // Synchronous on purpose — see `port::init` for the cost and why it
            // is paid here rather than raced against.
            //
            // Inside setup(), not main(), so a second instance rejected by the
            // single-instance guard does not pay for a lookup it will never use.
            port::init(&supervisor::path_env());
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

            // Register the global summon hotkey (mt#2676) BEFORE building
            // the tray menu, so "Open Cockpit" can reflect whether the OS
            // actually accepted the binding rather than unconditionally
            // advertising a shortcut that may silently do nothing (PR #2051
            // review R1). Registration failure (e.g. already bound by
            // another app) is logged + a one-time notification is fired
            // inside hotkey::register -- it never crashes the tray (success
            // criterion 2).
            let hotkey_registered = hotkey::register(&handle);

            menu::build(app, hotkey_registered)?;

            // Mouse back/forward -> cockpit history (mt#3570). Installed after
            // the menu so both navigation surfaces share one seam; must be
            // native because WKWebView never surfaces these buttons to the DOM
            // (tauri#10936 -- see mouse_nav.rs for the measurement).
            mouse_nav::install(&handle);

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
            RunEvent::ExitRequested {
                code: None, api, ..
            } => api.prevent_exit(),
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
