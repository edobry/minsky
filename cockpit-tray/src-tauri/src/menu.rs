// Tray + app-menu construction and menu-event handling, plus the cockpit
// window presentation helpers menu clicks (and deep links) drive.
//
// `build` constructs the tray dropdown (status/build/uptime lines + daemon
// lifecycle actions) and the macOS application menu (mt#2327: gives the
// cockpit window standard shortcuts like Cmd+R / Cmd+C / zoom, which Tauri
// does not create by default). `handle_menu_event` is the single dispatch
// point both menus route through. Split out of main.rs (mt#2628).

use std::sync::Mutex;

use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, Wry};
use tauri_plugin_notification::NotificationExt;

use crate::supervisor::{
    registry, send_cmd, BuildMenuItem, DaemonId, DaemonMenuItems, SupervisorCmd,
};

/// Dropdown line showing the cockpit-web bundle's last-build state (mt#2297).
/// Still a single id: only the cockpit has a bundle.
const BUILD_MENU_ID: &str = "build_status";

/// The status / uptime / lifecycle menu-item ids are DERIVED from the daemon id
/// rather than spelled out (mt#3815), so a new registry entry cannot end up with
/// a menu item the dispatch below does not recognize.
fn status_menu_id(id: DaemonId) -> String {
    format!("status:{}", id.slug())
}

fn uptime_menu_id(id: DaemonId) -> String {
    format!("uptime:{}", id.slug())
}

fn lifecycle_menu_id(action: &str, id: DaemonId) -> String {
    format!("{action}:{}", id.slug())
}

/// Split a `<action>:<daemon>` menu id back into its parts. `None` for any id
/// that is not one — the dispatch's `_ => {}` arm handles those.
fn parse_lifecycle_menu_id(menu_id: &str) -> Option<(&str, DaemonId)> {
    let (action, slug) = menu_id.split_once(':')?;
    Some((action, DaemonId::from_slug(slug)?))
}

/// The name a daemon is shown under, taken from the same `DaemonLabels` the
/// supervisor renders its status line from, so the menu and the status text
/// cannot disagree about what a daemon is called.
fn display_name_for(id: DaemonId) -> &'static str {
    match id {
        DaemonId::Cockpit => crate::supervisor::COCKPIT_LABELS.display_name,
        DaemonId::Mcp => registry::MCP_LABELS.display_name,
    }
}

/// The cockpit origin: what the in-app webview loads and what "Open Cockpit"
/// hands to the OS browser.
///
/// Was a pair of constants (mt#3988): `COCKPIT_URL` plus a separately-declared
/// `COCKPIT_PORT` copy of its port for the `on_navigation` same-origin check,
/// with a doc comment asking a human to *"stay in sync with COCKPIT_URL's
/// port."* Both now derive from one resolved value, so the invariant is
/// structural rather than maintained by hand — and the pair follows a
/// configured port instead of pinning the webview to 3737.
pub(crate) fn cockpit_url() -> String {
    crate::port::cockpit_url(crate::port::cockpit_port())
}

/// Whether a navigation target is the cockpit SPA's own origin — the decision
/// `on_navigation` makes between "load in place" and "hand to the OS browser".
///
/// Split out of that closure so it is unit-testable at a configured port
/// without a live webview (mt#3988). The caller has ALREADY restricted the
/// scheme to http/https; this deliberately does not re-check it, preserving the
/// pre-mt#3988 behavior in which `https://localhost:<port>` also counted as the
/// cockpit origin.
///
/// Matches an EXPLICIT port only — `url.port()`, never
/// `url.port_or_known_default()`. This preserves the pre-mt#3988 semantics
/// exactly, and the distinction is security-relevant rather than stylistic: the
/// `port_or_known_default` form treats `http://localhost/` (no port) as the
/// cockpit origin when the configured port is 80, and `https://localhost/` when
/// it is 443, admitting into the webview URLs that the hardcoded check always
/// sent to the OS browser. It would have widened a security check to buy a
/// configuration nobody uses — the daemon serves plain HTTP on loopback, and 80
/// needs root on macOS. (PR #2882 R1.)
///
/// The consequence is pinned by test rather than left implicit: with
/// `cockpit.port` set to 80 or 443 the check matches NOTHING, so cockpit links
/// open in the OS browser instead of in the app. That is the fail-CLOSED
/// direction, and it is the same behavior this code had before the port became
/// configurable.
fn is_cockpit_origin(url: &tauri::Url, port: u16) -> bool {
    matches!(url.host_str(), Some("localhost") | Some("127.0.0.1")) && url.port() == Some(port)
}

pub(crate) const COCKPIT_WINDOW_LABEL: &str = "cockpit";

/// Init script injected into the cockpit webview so external-link clicks reach
/// the `on_navigation` handler below (mt#2942). Only anchors that open a NEW
/// window/tab need help: WKWebView routes a `target="_blank"` click to a
/// new-window request Tauri drops, so `on_navigation` never sees it. A plain
/// same-frame anchor already navigates the top frame (which `on_navigation`
/// intercepts directly), so the shim deliberately leaves those alone. For a
/// new-window-targeted EXTERNAL link it rewrites the click into a top-frame
/// navigation so `on_navigation` can open it in the OS browser -- the only way
/// to honor "open elsewhere" intent in a tab-less WKWebView. Injected ONLY into
/// the tray webview, so a browser-viewed cockpit keeps native `target="_blank"`
/// behavior.
const EXTERNAL_LINK_SHIM: &str = r#"
(function () {
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var target = a.getAttribute('target');
    if (!target || target === '_self') return;
    var href = a.getAttribute('href');
    if (!href) return;
    var url;
    try { url = new URL(href, window.location.href); } catch (_) { return; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    if (url.origin === window.location.origin) return;
    e.preventDefault();
    window.location.href = url.href;
  }, true);
})();
"#;

// mt#3535's HISTORY_NAV_SHIM lived here: a tray-only init script listening for
// `mousedown` with `event.button` 3/4. It was removed in mt#3570 as verified
// DEAD CODE, not merely redundant. WKWebView only converts
// `NSEventTypeOtherMouseDown` into a DOM `mousedown`, and the mice that matter
// here (the MX Master line) emit `NSEventTypeSwipe` instead -- measured, with
// `otherMouseDown` never firing once. Upstream: tauri-apps/tauri#10936.
// The replacement is the native monitor in `mouse_nav.rs`.

/// Current webview zoom factor for the cockpit window (mt#2334). Menu-driven
/// zoom (Cmd +/-/0) applies this via `WebviewWindow::set_zoom`, which takes an
/// ABSOLUTE factor — so we track the current value here in order to step it.
pub(crate) struct ZoomLevel(pub(crate) Mutex<f64>);

/// Register zoom state (mt#2334 review). Called FIRST from `main()`'s setup
/// closure, before deep-link registration or menu construction, so
/// `try_state::<ZoomLevel>()` is always populated by the time any menu
/// handler or deferred window-creation closure can read it.
pub(crate) fn init_zoom_state(app: &tauri::App<Wry>) {
    app.manage(ZoomLevel(Mutex::new(1.0)));
}

/// Build the tray dropdown menu + macOS application menu and wire their event
/// handlers. Registers `StatusMenuItem`, `BuildMenuItem`, and `UptimeMenuItem`
/// as managed state so the supervisor loop (which runs on a separate OS
/// thread, spawned afterward by `supervisor::spawn`) can push status text to
/// them. Called once from `main()`'s setup closure, after `init_zoom_state`
/// and `hotkey::register` -- `hotkey_registered` reflects whether the OS
/// actually accepted the summon-hotkey binding, so the "Open Cockpit" label
/// can advertise the shortcut only when it will actually fire (PR #2051
/// review R1: a label advertising a hotkey that silently failed to register
/// would mislead users).
pub(crate) fn build(app: &tauri::App<Wry>, hotkey_registered: bool) -> tauri::Result<()> {
    // One status + uptime line PER REGISTERED DAEMON (mt#3815), built from
    // `DaemonId::ALL` so the dropdown cannot silently omit an entry the
    // supervisor is actually watching.
    let mut status_items = Vec::new();
    let mut uptime_items = Vec::new();
    let mut status_lines = Vec::new();
    for id in DaemonId::ALL {
        let name = display_name_for(id);
        let status_item =
            MenuItemBuilder::with_id(status_menu_id(id), format!("{name}: checking..."))
                .enabled(false)
                .build(app)?;
        let uptime_item = MenuItemBuilder::with_id(uptime_menu_id(id), format!("{name} uptime: —"))
            .enabled(false)
            .build(app)?;
        status_lines.push(status_item.clone());
        status_lines.push(uptime_item.clone());
        status_items.push((id, status_item));
        uptime_items.push((id, uptime_item));
    }
    // The build line is cockpit-only and sits with the cockpit's own lines —
    // between its status and uptime rows, where it has always been.
    let build_item = MenuItemBuilder::with_id(BUILD_MENU_ID, "Last build: never")
        .enabled(false)
        .build(app)?;
    app.manage(BuildMenuItem(build_item.clone()));
    status_lines.insert(1, build_item.clone());
    app.manage(DaemonMenuItems {
        status: status_items,
        uptime: uptime_items,
    });
    // Best-effort: request notification permission so build-failure
    // toasts can appear (mt#2306). Ignored if denied/unavailable.
    let _ = app.notification().request_permission();
    let open_window_label = if hotkey_registered {
        format!("Open Cockpit  ({})", crate::hotkey::SUMMON_SHORTCUT_LABEL)
    } else {
        "Open Cockpit".to_string()
    };
    let open_window_item = MenuItemBuilder::with_id("open_window", open_window_label).build(app)?;
    let open_item = MenuItemBuilder::with_id("open", "Open in Browser").build(app)?;
    let separator1 = tauri::menu::PredefinedMenuItem::separator(app)?;
    // Start/Stop/Restart PER DAEMON, grouped in a submenu named for it
    // (mt#3815). A flat list of six verbs would not say which daemon each
    // one acts on, and the ids the handler parses carry the daemon
    // (`start:cockpit`) rather than relying on menu position.
    let mut lifecycle_submenus = Vec::new();
    for id in DaemonId::ALL {
        let name = display_name_for(id);
        let start_item =
            MenuItemBuilder::with_id(lifecycle_menu_id("start", id), "Start").build(app)?;
        let stop_item =
            MenuItemBuilder::with_id(lifecycle_menu_id("stop", id), "Stop").build(app)?;
        let restart_item =
            MenuItemBuilder::with_id(lifecycle_menu_id("restart", id), "Restart").build(app)?;
        lifecycle_submenus.push(
            SubmenuBuilder::new(app, name)
                .item(&start_item)
                .item(&stop_item)
                .item(&restart_item)
                .build()?,
        );
    }
    let separator2 = tauri::menu::PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", "Quit Cockpit Tray").build(app)?;

    let mut menu_builder = MenuBuilder::new(app);
    for item in &status_lines {
        menu_builder = menu_builder.item(item);
    }
    menu_builder = menu_builder
        .item(&separator1)
        .item(&open_window_item)
        .item(&open_item);
    for submenu in &lifecycle_submenus {
        menu_builder = menu_builder.item(submenu);
    }
    let menu = menu_builder.item(&separator2).item(&quit_item).build()?;

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
    // not create by default — so Cmd+R / Cmd+C / close &c. were dead in the
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
    // History items (mt#3535), applied via `WebviewWindow::eval` in
    // handle_menu_event -- the ADR-023 native->SPA seam, same as "reload".
    // Plain Cmd+[ / Cmd+] (browser convention); the SHIFTED forms stay free for
    // TabKeyboardNav's strip-order tab switching, which the SPA handles itself.
    let history_back_item = MenuItemBuilder::with_id("history_back", "Back")
        .accelerator("CmdOrCtrl+[")
        .build(app)?;
    let history_forward_item = MenuItemBuilder::with_id("history_forward", "Forward")
        .accelerator("CmdOrCtrl+]")
        .build(app)?;
    let history_submenu = SubmenuBuilder::new(app, "History")
        .item(&history_back_item)
        .item(&history_forward_item)
        .build()?;
    // Close Tab / Close Window (mt#4059). `⌘W` addresses the ENTITY TAB, and
    // window-close moves to `⌘⇧W` -- the mapping every tabbed macOS app uses
    // (Safari, Chrome, Terminal, iTerm), and the one an operator arriving from
    // a browser already has in their fingers.
    //
    // `CmdOrCtrl` is deliberate, not inherited by accident (PR #2936 R1): the
    // same relocation is correct off-mac, because browsers there also bind
    // Ctrl+W to close-tab and Ctrl+Shift+W to close-window. The tray ships as a
    // macOS menu-bar app today, so this is currently theoretical -- but the
    // theoretical behavior is the RIGHT one, and every other accelerator in
    // this file already uses the same modifier token.
    //
    // Both are CUSTOM items rather than `SubmenuBuilder::close_window()`,
    // because a `PredefinedMenuItem`'s accelerator cannot be changed: only
    // MenuItem/CheckMenuItem/IconMenuItem expose `set_accelerator`, and the
    // predefined variant's chord comes from a fixed table (muda
    // `items/predefined.rs`, which binds CloseWindow to CmdOrCtrl+W on macOS).
    // Same substitution, for the same reason, that Quit above already makes.
    //
    // `close_window` calls `WebviewWindow::close()` rather than hiding
    // directly, so it lands on the mt#2675 hide-on-close `CloseRequested`
    // handler in `create_cockpit_window` -- identical behavior to the red
    // button, with one definition of what closing means.
    let close_tab_item = MenuItemBuilder::with_id("close_tab", "Close Tab")
        .accelerator("CmdOrCtrl+W")
        .build(app)?;
    let close_window_item = MenuItemBuilder::with_id("close_window", "Close Window")
        .accelerator("CmdOrCtrl+Shift+W")
        .build(app)?;
    let window_submenu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .item(&close_tab_item)
        .item(&close_window_item)
        .build()?;
    let app_menu = MenuBuilder::new(app)
        .item(&app_submenu)
        .item(&edit_submenu)
        .item(&view_submenu)
        .item(&history_submenu)
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
        "reload" | "quit" | "zoom_in" | "zoom_out" | "zoom_reset" | "history_back"
        | "history_forward" | "close_tab" | "close_window" => {
            handle_menu_event(app, event.id().as_ref())
        }
        _ => {}
    });

    Ok(())
}

/// Move the cockpit SPA's history by one entry (mt#3535, mt#3570).
///
/// The single navigation seam shared by BOTH surfaces -- the History menu /
/// `Cmd+[` accelerators and the native mouse-button monitor (`mouse_nav.rs`).
/// Driven by `eval` rather than WKWebView's own `goBack`/`goForward` so both
/// move the SAME history: the SPA's react-router entries, which are `pushState`
/// entries on the document's own history. This is the ADR-023 native->SPA seam.
///
/// `guard_editable` gates the focused-editable carve-out, which applies to the
/// KEYBOARD path only (PR #2522 R1): a menu accelerator fires no matter what
/// holds focus, and `Cmd+[` / `Cmd+]` are editing keys inside a text field, so
/// navigating mid-edit would discard what was typed. A MOUSE press is never a
/// text-editing keystroke, so it passes `false` and navigates unconditionally.
///
/// The guard lives in the evaluated script rather than Rust-side because focus
/// state lives in the DOM and `eval` is fire-and-forget: a separate predicate
/// eval would race the navigation.
pub(crate) fn eval_history_nav(app: &AppHandle, forward: bool, guard_editable: bool) {
    let Some(window) = app.get_webview_window(COCKPIT_WINDOW_LABEL) else {
        return;
    };
    let method = if forward { "forward" } else { "back" };
    // Only TEXT-ENTRY focus suppresses the keyboard path. mt#3535 tested
    // `tagName === 'INPUT'`, which was over-broad (PR #2547 R1): a focused
    // checkbox, radio, or button is an INPUT where Cmd+[ is not an editing
    // command, so navigation should still happen. SELECT is likewise not
    // text entry. Matching on the input TYPE keeps the carve-out to the case
    // it exists for -- losing typed text mid-edit.
    let guard = if guard_editable {
        "var a = document.activeElement;\n  \
         var textEntry = a && a.tagName === 'INPUT' && /^(text|search|url|tel|email|password|number|date|datetime-local|month|week|time)$/i.test(a.type || 'text');\n  \
         if (a && (a.isContentEditable || textEntry || a.tagName === 'TEXTAREA')) return;\n  "
    } else {
        ""
    };
    let script = format!("(function () {{\n  {guard}window.history.{method}();\n}})()");
    if let Err(e) = window.eval(&script) {
        eprintln!("[cockpit-tray] failed to run history.{method}() on cockpit window: {e}");
    }
}

/// Close the cockpit SPA's ACTIVE entity tab (mt#4059).
///
/// The ADR-023 native->SPA seam in its `eval`-a-global form -- the deep-link
/// shape (`deeplink.rs`), not the history shape. `history.back()` is a native
/// browser API the eval can call directly; a tab is SPA state with no native
/// equivalent, so the SPA installs `window.__minskyCloseActiveTab` and this
/// calls it.
///
/// The `typeof` guard makes a pre-mount or non-cockpit document a no-op rather
/// than a thrown ReferenceError, and the SPA side no-ops when no entity tab is
/// active -- so `⌘W` on a list page does nothing at all, and deliberately does
/// NOT fall through to closing the window. There is no payload, so ADR-023's
/// JSON-encoding requirement (a script-injection guard for interpolated
/// values) has nothing to encode: keep this script a literal.
pub(crate) fn eval_close_active_tab(app: &AppHandle) {
    let Some(window) = app.get_webview_window(COCKPIT_WINDOW_LABEL) else {
        return;
    };
    let script = "(function () {\n  \
         if (typeof window.__minskyCloseActiveTab === 'function') { window.__minskyCloseActiveTab(); }\n\
         })()";
    if let Err(e) = window.eval(script) {
        eprintln!("[cockpit-tray] failed to close the active cockpit tab: {e}");
    }
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
        // History navigation (mt#3535). The KEYBOARD/menu path, so the
        // focused-editable carve-out applies -- see eval_history_nav.
        "history_back" | "history_forward" => {
            eval_history_nav(app, id == "history_forward", true);
        }
        // Tab close (mt#4059) -- SPA state, so it goes through the ADR-023
        // eval-a-global seam. Window close keeps the pre-mt#4059 behavior at
        // its new chord: `close()` is intercepted by the hide-on-close handler.
        "close_tab" => eval_close_active_tab(app),
        "close_window" => {
            if let Some(window) = app.get_webview_window(COCKPIT_WINDOW_LABEL) {
                if let Err(e) = window.close() {
                    // "requested" because the request is what failed: a
                    // successful close() is intercepted and becomes a hide, so
                    // this line means the window neither closed NOR hid.
                    eprintln!("[cockpit-tray] failed to request cockpit window close (hide-on-close): {e}");
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
            let _ = open::that(cockpit_url());
        }
        "quit" => {
            // Ask the supervisor to stop the daemon, then exit. The
            // RunEvent::Exit handler tears the daemon down synchronously as the
            // reliable path (the process may exit before the supervisor reacts).
            send_cmd(app, SupervisorCmd::Shutdown);
            app.exit(0);
        }
        // Per-daemon lifecycle (mt#3815): `start:cockpit`, `stop:mcp`, &c. The
        // daemon comes out of the id rather than out of menu position, so a
        // reordered dropdown cannot send Stop to the wrong daemon.
        other => {
            if let Some((action, daemon)) = parse_lifecycle_menu_id(other) {
                match action {
                    "start" => send_cmd(app, SupervisorCmd::Start(daemon)),
                    "stop" => send_cmd(app, SupervisorCmd::Stop(daemon)),
                    // `OperatorRestart`, not `Restart` (mt#4233): this is the
                    // one restart path with a human behind it, and the only one
                    // that confirms itself with a notification.
                    "restart" => send_cmd(app, SupervisorCmd::OperatorRestart(daemon)),
                    // `status:` / `uptime:` ids belong to the disabled display
                    // rows, which cannot be clicked.
                    _ => {}
                }
            }
        }
    }
}

/// Toggle macOS Dock + Cmd-Tab presence via the activation policy (mt#2675).
///
/// The tray app launches as a menu-bar-only "agent" app via the setup-time
/// `Accessory` policy in main.rs (mt#2219; the former `LSUIElement` plist
/// flag was removed in mt#2675 — it pinned the app out of Cmd-Tab even after
/// a runtime `Regular` switch), and macOS excludes Accessory apps from both
/// the Dock and the Cmd-Tab switcher. While the cockpit window is visible we
/// switch to `Regular` so the window is reachable via Cmd-Tab (and the app
/// menu from mt#2327 becomes visible in the menu bar); when it hides we drop
/// back to `Accessory` to restore menu-bar-only behavior.
///
/// Call this with `present: true` BEFORE `show()`/`set_focus()` — macOS only
/// reliably fronts windows of apps with Dock presence (community pattern:
/// tauri-apps/tauri discussion #10774).
pub(crate) fn set_dock_presence(app: &AppHandle, present: bool) {
    #[cfg(target_os = "macos")]
    {
        let policy = if present {
            tauri::ActivationPolicy::Regular
        } else {
            tauri::ActivationPolicy::Accessory
        };
        if let Err(e) = app.set_activation_policy(policy) {
            eprintln!("[cockpit-tray] failed to set activation policy (present={present}): {e}");
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, present);
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
        set_dock_presence(app, true);
        if let Err(e) = window.show() {
            eprintln!("[cockpit-tray] deep-link: failed to show cockpit window: {e}");
        }
        if let Err(e) = window.set_focus() {
            eprintln!("[cockpit-tray] deep-link: failed to focus cockpit window: {e}");
        }
        return;
    }
    // Window doesn't exist yet -- create it. Creation ONLY: the caller (the
    // deep-link/recovery loop, mt#2688) owns liveness healing; spawning
    // another recovery watch here would double-navigate the same window.
    create_cockpit_window(app);
}

/// Hide the cockpit window and restore menu-bar-only presence (mt#2676: the
/// global-hotkey toggle's "visible+focused -> hide" direction). Mirrors the
/// hide-on-close `CloseRequested` handler in `create_cockpit_window` below --
/// same behavior, triggered by the hotkey instead of the window's close
/// button / Cmd+Shift+W (Cmd+W closes the active TAB since mt#4059).
pub(crate) fn hide_cockpit_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(COCKPIT_WINDOW_LABEL) {
        if let Err(e) = window.hide() {
            eprintln!("[cockpit-tray] failed to hide cockpit window: {e}");
        }
    }
    set_dock_presence(app, false);
}

/// Open the embedded cockpit window, or focus it if it already exists (mt#2219).
///
/// Also the entry point the mt#2676 global hotkey's "show" direction reuses
/// (`hotkey::toggle_cockpit_window`) instead of the deep-link-oriented
/// `ensure_cockpit_window_visible`, so a cold summon gets the same
/// cold-start recovery loop as a menu click (PR #2051 review R1).
pub(crate) fn open_cockpit_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(COCKPIT_WINDOW_LABEL) {
        set_dock_presence(app, true);
        if let Err(e) = window.show() {
            eprintln!("[cockpit-tray] failed to show cockpit window: {e}");
        }
        if let Err(e) = window.set_focus() {
            eprintln!("[cockpit-tray] failed to focus cockpit window: {e}");
        }
        // Heal or refresh (mt#2688): a LIVE document is reloaded (the daemon
        // Start/Restart recovery this branch has always done); a dead
        // (never-loaded) document is re-navigated by the recovery loop --
        // reload() on a failed document just reloads the blank page. The
        // probe runs off-main (DOM probe blocks on the eval callback).
        crate::deeplink::refresh_or_heal_window(app);
        return;
    }

    create_cockpit_window(app);
    // Cold-start heal (mt#2688): if the daemon is still booting, the fresh
    // window's initial load fails (connection refused). The recovery watch
    // re-navigates it as soon as the daemon accepts connections.
    crate::deeplink::spawn_window_recovery(app, None);
}

/// Create the cockpit webview window (creation only -- no show-if-exists, no
/// recovery). Callers own recovery semantics: `open_cockpit_window` pairs
/// this with a recovery watch; the deep-link loop calls it via
/// `ensure_cockpit_window_visible` and runs its own loop (mt#2688).
fn create_cockpit_window(app: &AppHandle) {
    // Resolved once here and used for BOTH the window's URL and the
    // same-origin check below (mt#3988) — the window can no longer load one
    // port while the navigation guard admits another.
    let port = crate::port::cockpit_port();
    let cockpit = crate::port::cockpit_url(port);
    let url: tauri::Url = match cockpit.parse() {
        Ok(url) => url,
        Err(e) => {
            eprintln!("[cockpit-tray] invalid cockpit URL {cockpit:?}: {e}");
            return;
        }
    };

    // Regular BEFORE build (mt#2675): the window must appear with Dock
    // presence already in place or macOS may refuse to front it.
    set_dock_presence(app, true);

    match WebviewWindowBuilder::new(app, COCKPIT_WINDOW_LABEL, WebviewUrl::External(url))
        .title("Minsky Cockpit")
        .inner_size(1200.0, 800.0)
        // Open external (non-cockpit) links in the OS browser instead of
        // silently dropping them (mt#2942). The SPA is an untrusted external-URL
        // webview with NO IPC bridge (ADR-023), so the frontend cannot call an
        // opener plugin -- this lives entirely in the tray. Paired with
        // EXTERNAL_LINK_SHIM, which funnels new-window (target="_blank") clicks
        // here. Canonical Tauri pattern (on_navigation -> cancel -> opener); see
        // https://v2.tauri.app/plugin/opener/ and tauri-apps/tauri#4756.
        .on_navigation(move |url| {
            match url.scheme() {
                "http" | "https" => {
                    // The cockpit SPA's own origin loads in place (initial
                    // load, Cmd+R reload, deep-link recovery navigate);
                    // react-router nav is client-side and never reaches here.
                    // The port is pinned so a nav to any OTHER localhost port
                    // is treated as external, not loaded in the cockpit webview
                    // (review R2) — and since mt#3988 it is pinned to the
                    // RESOLVED port captured above, the same one this window
                    // was built on, rather than to a second constant.
                    if is_cockpit_origin(url, port) {
                        return true;
                    }
                    // Any other web origin is external: open in the OS default
                    // browser and CANCEL the in-webview nav so the SPA is never
                    // navigated away. `open::that` is synchronous (it spawns the
                    // platform opener and returns); on failure we log and still
                    // cancel -- navigating the webview to the external site
                    // would lose the cockpit, which is worse than a no-op.
                    if let Err(e) = open::that(url.as_str()) {
                        eprintln!(
                            "[cockpit-tray] failed to open external URL {url} in browser: {e}"
                        );
                    }
                    false
                }
                // Webview-internal schemes used during normal operation -- allow.
                "about" | "blob" => true,
                // javascript:/data:/file:/mailto:/tel:/custom schemes: neither
                // the cockpit origin nor a web link to hand to the OS browser.
                // REFUSE the in-webview navigation and do NOT shell it out
                // (review R1: never let javascript:/file:/data: navigate the
                // webview).
                _ => false,
            }
        })
        .initialization_script(EXTERNAL_LINK_SHIM)
        .build()
    {
        Ok(window) => {
            // Hide-on-close (mt#2675): intercept CloseRequested so the red
            // button / Cmd+Shift+W hides the window (preserving SPA state) instead
            // of destroying it, and drop Dock + Cmd-Tab presence while
            // hidden. Destroyed is the defensive fallback for any destroy
            // path that bypasses CloseRequested (e.g. app teardown).
            let handle = app.clone();
            let window_for_events = window.clone();
            window.on_window_event(move |event| match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    if let Err(e) = window_for_events.hide() {
                        eprintln!("[cockpit-tray] failed to hide cockpit window on close: {e}");
                    }
                    set_dock_presence(&handle, false);
                }
                tauri::WindowEvent::Destroyed => set_dock_presence(&handle, false),
                _ => {}
            });

            // Re-apply the tracked zoom (mt#2334 review): with hide-on-close
            // the window usually survives, but this create path still runs on
            // first open and after any genuine destroy — restore the stored
            // factor or the next zoom step would jump from 1.0 to the tracked
            // value.
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::port::DEFAULT_COCKPIT_PORT;

    /// The port from the 2026-06-04 incident this task fixes.
    const CONFIGURED_PORT: u16 = 4317;

    /// mt#4233 — the defect itself. The dropdown listed "Cockpit" and
    /// "MCP daemon", so exactly ONE entry contained the class word and it was
    /// the wrong one: "the tray menu → the daemon entry → Restart" therefore
    /// resolved deterministically to the MCP daemon on 2026-08-17. The
    /// instruction was ambiguous; the interface was not, and it resolved the
    /// ambiguity in the wrong direction.
    ///
    /// Asserted as a PROPERTY over the whole registry rather than over the two
    /// entries that exist today, so registering a third daemon without the class
    /// word fails here too — that is the shape the asymmetry would come back in.
    #[test]
    fn no_lifecycle_entry_is_the_unique_bearer_of_the_class_word() {
        let names: Vec<&str> = DaemonId::ALL.into_iter().map(display_name_for).collect();
        assert!(
            names.len() >= 2,
            "the asymmetry this pins is only meaningful with 2+ entries"
        );
        for name in &names {
            assert!(
                name.to_lowercase().contains("daemon"),
                "every lifecycle entry must carry the class word, got: {name}"
            );
        }
    }

    /// The exact names the operator picked — ask#9153, answered 2026-08-22:
    /// "Cockpit daemon / MCP daemon", no role gloss. Pinned separately from the
    /// property above, which on its own would happily accept "Daemon A" and
    /// "Daemon B".
    #[test]
    fn the_lifecycle_entry_names_are_pinned() {
        assert_eq!(display_name_for(DaemonId::Cockpit), "Cockpit daemon");
        assert_eq!(display_name_for(DaemonId::Mcp), "MCP daemon");
    }

    fn url(s: &str) -> tauri::Url {
        s.parse().expect("test URL must parse")
    }

    /// mt#3988 AT6. This is the security-relevant half of the change: before
    /// it, `on_navigation` compared against its own `COCKPIT_PORT` constant, so
    /// a tray configured to 4317 would have loaded its own SPA and then treated
    /// every subsequent in-app navigation as external — handing cockpit URLs to
    /// the OS browser instead of the webview.
    #[test]
    fn same_origin_check_follows_the_configured_port() {
        assert!(
            is_cockpit_origin(&url("http://localhost:4317/tasks"), CONFIGURED_PORT),
            "a cockpit navigation at the configured port must stay in the webview"
        );
        assert!(
            !is_cockpit_origin(&url("http://localhost:3737/tasks"), CONFIGURED_PORT),
            "the OLD default is external once another port is configured"
        );
    }

    /// The unconfigured case is unchanged — the half that proves this refactor
    /// preserved behavior rather than merely moving it.
    #[test]
    fn same_origin_check_at_the_default_port_is_unchanged() {
        assert!(is_cockpit_origin(
            &url("http://localhost:3737/tasks"),
            DEFAULT_COCKPIT_PORT
        ));
        assert!(is_cockpit_origin(
            &url("http://127.0.0.1:3737/"),
            DEFAULT_COCKPIT_PORT
        ));
        assert!(!is_cockpit_origin(
            &url("http://localhost:4317/"),
            DEFAULT_COCKPIT_PORT
        ));
    }

    /// The check must not widen: a different HOST on the right port, and the
    /// port-prefix case `:37370` that `deeplink.rs` also pins, stay external.
    #[test]
    fn same_origin_check_does_not_widen() {
        assert!(!is_cockpit_origin(
            &url("http://evil.example.com:4317/"),
            CONFIGURED_PORT
        ));
        assert!(
            !is_cockpit_origin(&url("http://localhost:43170/"), CONFIGURED_PORT),
            "a port with the configured port as a PREFIX is a different origin"
        );
        assert!(!is_cockpit_origin(
            &url("http://localhost/"),
            CONFIGURED_PORT
        ));
    }

    /// PR #2882 R1. The first draft used `url.port_or_known_default()`, which
    /// silently WIDENED this check: at a configured port of 80, a portless
    /// `http://localhost/…` would have become same-origin and loaded in the
    /// webview, where the hardcoded check had always sent it to the OS browser.
    /// These cases pin the reverted, explicit-port semantics in BOTH directions
    /// so the widening cannot come back unnoticed.
    #[test]
    fn scheme_default_ports_are_never_matched_implicitly() {
        // Rejection: a portless URL matches nothing, at either scheme default.
        assert!(
            !is_cockpit_origin(&url("http://localhost/tasks"), 80),
            "a portless http:// URL must not be same-origin at a configured 80"
        );
        assert!(
            !is_cockpit_origin(&url("https://localhost/tasks"), 443),
            "a portless https:// URL must not be same-origin at a configured 443"
        );
        // `:80` on http and `:443` on https are normalized away by the URL
        // parser, so these are the SAME case arriving spelled differently —
        // which is exactly why `port_or_known_default` was tempting.
        assert!(!is_cockpit_origin(&url("http://localhost:80/"), 80));
        assert!(!is_cockpit_origin(&url("https://localhost:443/"), 443));

        // Acceptance is unaffected for every port that is not a scheme default:
        // an explicit port still matches, which is the whole feature.
        assert!(is_cockpit_origin(&url("http://localhost:8080/"), 8080));
        assert!(!is_cockpit_origin(&url("http://localhost:80/"), 8080));
    }

    /// `cockpit_url()` and the check it is paired with read the SAME resolved
    /// value — the invariant the deleted "must stay in sync" comment used to
    /// ask a human for.
    #[test]
    fn the_window_url_and_the_navigation_check_agree() {
        let rendered = cockpit_url();
        let parsed = url(&rendered);
        assert!(
            is_cockpit_origin(&parsed, crate::port::cockpit_port()),
            "the origin the window loads ({rendered}) must pass its own same-origin check"
        );
    }
}
