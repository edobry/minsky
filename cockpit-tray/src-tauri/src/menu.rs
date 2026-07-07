// Tray + app-menu construction and menu-event handling, plus the cockpit
// window presentation helpers menu clicks (and deep links) drive.
//
// `build` constructs the tray dropdown (status/build/uptime lines + daemon
// lifecycle actions) and the macOS application menu (mt#2327: gives the
// cockpit window standard shortcuts like Cmd+R / Cmd+W / zoom, which Tauri
// does not create by default). `handle_menu_event` is the single dispatch
// point both menus route through. Split out of main.rs (mt#2628).

use std::sync::Mutex;

use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, Wry};
use tauri_plugin_notification::NotificationExt;

use crate::supervisor::{send_cmd, BuildMenuItem, StatusMenuItem, SupervisorCmd, UptimeMenuItem};

const STATUS_MENU_ID: &str = "status";
/// Dropdown line showing the cockpit-web bundle's last-build state (mt#2297).
const BUILD_MENU_ID: &str = "build_status";
/// Dropdown line showing daemon uptime + the source mtime it was started against (mt#2299).
const UPTIME_MENU_ID: &str = "uptime";

pub(crate) const COCKPIT_URL: &str = "http://localhost:3737";
pub(crate) const COCKPIT_WINDOW_LABEL: &str = "cockpit";

/// Current webview zoom factor for the cockpit window (mt#2334). Menu-driven
/// zoom (Cmd +/-/0) applies this via `WebviewWindow::set_zoom`, which takes an
/// ABSOLUTE factor — so we track the current value here in order to step it.
pub(crate) struct ZoomLevel(pub(crate) Mutex<f64>);

/// Build the tray dropdown menu + macOS application menu and wire their event
/// handlers. Registers `ZoomLevel`, `StatusMenuItem`, `BuildMenuItem`, and
/// `UptimeMenuItem` as managed state so the supervisor loop (which runs on a
/// separate OS thread, spawned afterward by `supervisor::spawn`) can push
/// status text to them. Called once from `main()`'s setup closure.
pub(crate) fn build(app: &tauri::App<Wry>) -> tauri::Result<()> {
    // Register zoom state before any menu handler that can read it (mt#2334
    // review): menu events fire post-setup, but managing it up front
    // guarantees `try_state::<ZoomLevel>()` is always populated.
    app.manage(ZoomLevel(Mutex::new(1.0)));

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
    let open_window_item = MenuItemBuilder::with_id("open_window", "Open Cockpit").build(app)?;
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
    app.on_menu_event(move |app, event| match event.id().as_ref() {
        "reload" | "quit" | "zoom_in" | "zoom_out" | "zoom_reset" => {
            handle_menu_event(app, event.id().as_ref())
        }
        _ => {}
    });

    Ok(())
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
pub(crate) fn ensure_cockpit_window_visible(app: &AppHandle) {
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
