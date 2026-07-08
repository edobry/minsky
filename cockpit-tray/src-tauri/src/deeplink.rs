// minsky:// deep-link handling (mt#2528, ADR-023) + cockpit-window recovery
// (mt#2688).
//
// `register` wires the tauri-plugin-deep-link cold-start + hot-start hooks
// (called once from `main()`'s setup closure); `handle_deep_link` brings up
// the cockpit window and forwards the URL into the SPA via eval. Both ride
// the shared recovery loop (`run_recovery`), which also heals dead
// (never-loaded) cockpit windows for menu-driven opens. Split out of main.rs
// (mt#2628).

use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Duration;

use tauri::webview::WebviewWindow;
use tauri::{AppHandle, Manager, Url, Wry};

use crate::menu::{ensure_cockpit_window_visible, COCKPIT_URL, COCKPIT_WINDOW_LABEL};
use crate::supervisor::DAEMON_PORT;

// Recovery-loop constants (mt#2528, ADR-023 cold-start handling; reworked
// mt#2688). The loop ticks until the deep link is delivered onto a LIVE
// cockpit document (or, for menu-driven recovery, until the document is
// live), giving up only when the budget expires. 400 x 150 ms = 60 s nominal
// window -- generous enough to cover a cold daemon boot + webview load on a
// slow machine (DOM-probe timeouts can stretch unhealthy ticks somewhat).
/// Max recovery ticks before giving up (cockpit never came up).
const DEEP_LINK_RETRY_MAX: u32 = 400;
/// Interval between recovery ticks (ms).
const DEEP_LINK_RETRY_INTERVAL_MS: u64 = 150;
/// TCP connect timeout for the daemon-accepting probe (ms). Localhost
/// refusals answer in <1 ms; the timeout only bounds pathological stalls.
const DAEMON_PROBE_TIMEOUT_MS: u64 = 100;
/// How long to wait for the DOM probe's eval callback before treating the
/// document as unscriptable -- which callers treat as dead (ms).
const DOM_PROBE_TIMEOUT_MS: u64 = 400;
/// Ticks to wait for an issued rescue navigation to commit before re-issuing
/// it (40 x 150 ms = 6 s). Re-navigating every tick would restart the load
/// before it can commit; never re-arming would strand the flow if a single
/// navigation is silently dropped by the webview.
const RESCUE_REARM_TICKS: u32 = 40;

/// JS liveness probe, evaluated WITH a result callback: is the cockpit SPA
/// shell present in the current document? The `#root` div is in the served
/// HTML shell, so this turns true as soon as a cockpit document commits --
/// before React mounts (the pending-deep-link hand-off covers that gap).
const DOM_PROBE_JS: &str = "!!(document && document.getElementById('root'))";

/// What a single recovery tick should do, given the observable state.
/// Pure decision logic, kept free of tauri types so `cargo test` covers it
/// (mt#2226 tier 1 -- the GUI behavior itself is tier-3 manual).
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum TickAction {
    /// No cockpit window exists -- schedule the deferred create. Creation is
    /// NOT gated on the daemon: the window appears immediately (instant
    /// feedback), and a failed initial load is healed by RescueNavigate once
    /// the daemon accepts connections.
    CreateWindow,
    /// Window exists on a live cockpit document -- deliver the deep link
    /// (or, for menu-driven recovery with nothing to deliver, finish).
    Deliver,
    /// Document is dead but the daemon isn't accepting connections yet;
    /// navigating would just fail again. Wait.
    AwaitDaemon,
    /// Document is dead (or unscriptable) and the daemon is up -- re-navigate
    /// the webview to the cockpit URL. mt#2688: recovery must NAVIGATE, not
    /// reload(); reload() on a never-loaded document reloads the blank page.
    RescueNavigate,
    /// A rescue navigation was recently issued; give it time to commit.
    AwaitNavigation,
}

impl TickAction {
    /// Stable label for state-transition logging.
    fn label(&self) -> &'static str {
        match self {
            TickAction::CreateWindow => "create-window",
            TickAction::Deliver => "deliver",
            TickAction::AwaitDaemon => "await-daemon",
            TickAction::RescueNavigate => "rescue-navigate",
            TickAction::AwaitNavigation => "await-navigation",
        }
    }
}

/// `document_live` is the DOM probe's verdict: `Some(true)` = cockpit shell
/// present; `Some(false)` = scriptable but blank/foreign document; `None` =
/// the webview couldn't answer (not ready / no JS context) -- treated as
/// dead, because a live cockpit document always answers.
pub(crate) fn decide_tick(
    window_exists: bool,
    daemon_accepting: bool,
    document_live: Option<bool>,
    rescue_armed: bool,
) -> TickAction {
    if !window_exists {
        return TickAction::CreateWindow;
    }
    if document_live == Some(true) {
        // The document wins over the daemon probe: a live SPA can outlive a
        // daemon blip, and delivering the route into it is always correct.
        return TickAction::Deliver;
    }
    if !daemon_accepting {
        return TickAction::AwaitDaemon;
    }
    if rescue_armed {
        TickAction::RescueNavigate
    } else {
        TickAction::AwaitNavigation
    }
}

/// Ask the webview whether the cockpit SPA shell is present, via
/// `eval_with_callback` (mt#2688).
///
/// WHY NOT `WebviewWindow::url()`: WKWebView keeps reporting the REQUESTED
/// URL for a navigation whose load FAILED (connection refused), so url()
/// cannot distinguish a live document from the mt#2688 white window. The
/// url()-based check shipped first and the white window survived it
/// (empirically confirmed 2026-07-08); only an in-document DOM read is a
/// reliable discriminator. (wry's url() also `unwrap()`s a nil URL --
/// another reason to stay away from it for possibly-never-loaded webviews.)
///
/// MUST be called OFF the main thread: script evaluation needs the main run
/// loop, so blocking the main thread here would turn every probe into a
/// timeout (and the menu path into a self-inflicted dead-window verdict).
fn probe_document_live(window: &WebviewWindow<Wry>) -> Option<bool> {
    let (tx, rx) = mpsc::channel::<String>();
    let sent = window.eval_with_callback(DOM_PROBE_JS, move |result| {
        let _ = tx.send(result);
    });
    if sent.is_err() {
        return None;
    }
    match rx.recv_timeout(Duration::from_millis(DOM_PROBE_TIMEOUT_MS)) {
        Ok(json) => Some(json.trim() == "true"),
        Err(_) => None,
    }
}

/// Can the cockpit page load right now? Raw TCP-accept probe, deliberately
/// NOT /api/health: the webview's initial load fails on CONNECTION REFUSED,
/// so "something is accepting on the port" is exactly the readiness signal a
/// page load needs. Gating recovery on /api/health would couple it to DB
/// health -- a degraded cockpit still renders its own error UI, which beats a
/// white window. (The supervisor's health poll, `supervisor::health_ok`,
/// owns the richer liveness signal.)
fn daemon_accepting(port: u16) -> bool {
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    TcpStream::connect_timeout(&addr, Duration::from_millis(DAEMON_PROBE_TIMEOUT_MS)).is_ok()
}

/// Deep-link delivery script, run via webview eval on a live cockpit document
/// (mt#2528, ADR-023). Always sets `window.__minskyPendingDeepLink` (the
/// durable hand-off the SPA drains on mount), then immediately calls
/// `window.__minskyDeepLink(uri)` if the SPA has already mounted.
///
/// `url_json` MUST be a JSON string literal (serde_json::to_string) -- never
/// a raw URL -- as a crafted minsky:// URL is otherwise a script-injection
/// vector.
pub(crate) fn build_deliver_script(url_json: &str) -> String {
    format!(
        "(function(){{ \
            window.__minskyPendingDeepLink = {url_json}; \
            if (typeof window.__minskyDeepLink === 'function') {{ \
                window.__minskyDeepLink({url_json}); \
                window.__minskyPendingDeepLink = null; \
            }} \
        }})()"
    )
}

/// Register the minsky:// URL-scheme handler (mt#2528, ADR-023).
///
/// macOS routes clicked minsky:// links to the running instance via Apple
/// Event kAEGetURL (no tauri-plugin-single-instance needed); if the app
/// is closed, Launch Services launches it first, then delivers the URL.
///
/// Navigation shape (ADR-023): the SPA is an untrusted external-URL
/// webview, so we forward the URL via Rust->webview eval of the SPA-
/// exposed global window.__minskyDeepLink(uri).
///
/// Also check for a URL passed via command-line on cold start (the
/// get_current() path). macOS handles cold-start via Apple Events so
/// get_current() returns None on macOS, but we call it defensively for
/// portability (future Windows/Linux support).
pub(crate) fn register(app: &tauri::App<Wry>, handle: &AppHandle) {
    use tauri_plugin_deep_link::DeepLinkExt;
    // Cold-start: check if the app was launched via a deep link.
    // On macOS this is always None (handled via on_open_url below);
    // on Windows/Linux this returns the URL from the CLI argument.
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        for url in urls {
            handle_deep_link(handle, url.as_str().to_owned());
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

/// Handle a `minsky://` deep-link URL (mt#2528, ADR-023).
///
/// Shows/focuses an existing window synchronously (unlike window CREATION
/// (`build()`), `show()`/`set_focus()` don't block on the run loop, so
/// they're safe to call directly from the `on_open_url` callback), then
/// hands the URL to the recovery loop, which creates a missing window,
/// heals a dead document, and delivers the link (mt#2688).
pub(crate) fn handle_deep_link(app: &AppHandle, url: String) {
    if let Some(window) = app.get_webview_window(COCKPIT_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
    }
    spawn_window_recovery(app, Some(url));
}

/// Spawn the recovery loop on a background thread (mt#2528 + mt#2688): bring
/// the cockpit window to a LIVE document -- creating it if missing, waiting
/// out a booting daemon, re-navigating a dead document -- and, when
/// `deep_link_url` is set, deliver it into the SPA via eval.
///
/// **Security:** the URL is JSON-encoded via `serde_json::to_string` before
/// being interpolated into the eval script -- never raw string-interpolated.
pub(crate) fn spawn_window_recovery(app: &AppHandle, deep_link_url: Option<String>) {
    let script = match deep_link_url.as_deref() {
        Some(url) => match serde_json::to_string(url) {
            Ok(json) => Some(build_deliver_script(&json)),
            Err(e) => {
                eprintln!("[cockpit-tray] deep-link: failed to JSON-encode URL {url:?}: {e}");
                return;
            }
        },
        None => None,
    };
    let cockpit: Url = match COCKPIT_URL.parse() {
        Ok(u) => u,
        Err(e) => {
            eprintln!("[cockpit-tray] invalid cockpit URL {COCKPIT_URL:?}: {e}");
            return;
        }
    };
    let app_clone = app.clone();
    std::thread::spawn(move || run_recovery(&app_clone, script, cockpit));
}

/// Menu reopen path (mt#2688): refresh a LIVE document (the daemon-restart
/// recovery reload this branch has always done) or heal a dead one via the
/// recovery loop. Off-main because the DOM probe blocks on the webview's
/// eval callback, which needs the main run loop.
pub(crate) fn refresh_or_heal_window(app: &AppHandle) {
    let cockpit: Url = match COCKPIT_URL.parse() {
        Ok(u) => u,
        Err(e) => {
            eprintln!("[cockpit-tray] invalid cockpit URL {COCKPIT_URL:?}: {e}");
            return;
        }
    };
    let app_clone = app.clone();
    std::thread::spawn(move || {
        if let Some(window) = app_clone.get_webview_window(COCKPIT_WINDOW_LABEL) {
            if probe_document_live(&window) == Some(true) {
                // Live document: reload so the view recovers after a daemon
                // Start/Restart (mt#2219 behavior, unchanged).
                if let Err(e) = window.eval("window.location.reload()") {
                    eprintln!("[cockpit-tray] failed to reload cockpit window: {e}");
                }
                return;
            }
        }
        // Dead, unscriptable, or missing: the recovery loop handles all three.
        run_recovery(&app_clone, None, cockpit);
    });
}

/// The shared recovery loop. See `spawn_window_recovery` /
/// `refresh_or_heal_window`; runs on a background thread.
///
/// Window CREATION is deferred onto the main run loop (mt#2546;
/// `WebviewWindowBuilder::build()` deadlocks if called directly from the
/// synchronous `on_open_url` callback, which holds the run loop).
/// `create_in_flight` (mt#2551) makes the deferred create resilient WITHOUT
/// a double-create race: the flag is set BEFORE enqueueing and cleared only
/// INSIDE the closure, so a slow `build()` is never double-scheduled, and a
/// failed create re-schedules on a later tick.
///
/// Rescue NAVIGATION (mt#2688): when the DOM probe says the document is not
/// a live cockpit document and the daemon is accepting connections, the loop
/// re-navigates via `WebviewWindow::navigate`. Rust-side deliberately: a
/// dead document's JS context cannot be relied on to execute a JS-side
/// `location.replace`, and `location.reload()` reloads the blank document.
/// At most one navigation is issued per `RESCUE_REARM_TICKS` so an in-flight
/// load isn't restarted every tick.
fn run_recovery(app: &AppHandle, script: Option<String>, cockpit: Url) {
    let create_in_flight = Arc::new(AtomicBool::new(false));
    let mut schedule_count: u32 = 0;
    let mut last_rescue_tick: Option<u32> = None;
    let mut navigate_err_logged = false;
    let mut last_logged: Option<&'static str> = None;

    for attempt in 0..DEEP_LINK_RETRY_MAX {
        std::thread::sleep(Duration::from_millis(DEEP_LINK_RETRY_INTERVAL_MS));

        let window = app.get_webview_window(COCKPIT_WINDOW_LABEL);
        let document_live = window.as_ref().and_then(probe_document_live);
        let daemon_up = daemon_accepting(DAEMON_PORT);
        let rescue_armed =
            last_rescue_tick.map_or(true, |t| attempt.saturating_sub(t) >= RESCUE_REARM_TICKS);

        let action = decide_tick(window.is_some(), daemon_up, document_live, rescue_armed);

        // State-transition log (not per-tick): a field-diagnosable trace when
        // the binary is run from a terminal, silent steady-state otherwise.
        if last_logged != Some(action.label()) {
            eprintln!(
                "[cockpit-tray] recovery[t{attempt}]: {} (daemon_up={daemon_up}, doc_live={document_live:?})",
                action.label()
            );
            last_logged = Some(action.label());
        }

        match action {
            TickAction::CreateWindow => {
                if !create_in_flight.swap(true, Ordering::AcqRel) {
                    let app_for_window = app.clone();
                    let flag = create_in_flight.clone();
                    match app.run_on_main_thread(move || {
                        ensure_cockpit_window_visible(&app_for_window);
                        flag.store(false, Ordering::Release);
                    }) {
                        Ok(()) => {
                            schedule_count += 1;
                            // Log once, on the first RE-schedule (a prior
                            // deferred create produced no window) -- a useful
                            // field signal without spamming the happy path.
                            if schedule_count == 2 {
                                eprintln!("[cockpit-tray] recovery: re-scheduling window creation (prior deferred create produced no window)");
                            }
                        }
                        Err(e) => {
                            create_in_flight.store(false, Ordering::Release);
                            if attempt == 0 {
                                eprintln!("[cockpit-tray] recovery: run_on_main_thread (window create) failed, will retry: {e}");
                            }
                        }
                    }
                }
            }
            TickAction::AwaitDaemon | TickAction::AwaitNavigation => {}
            TickAction::RescueNavigate => {
                if let Some(w) = window.as_ref() {
                    match w.navigate(cockpit.clone()) {
                        Ok(()) => {
                            last_rescue_tick = Some(attempt);
                        }
                        Err(e) => {
                            if !navigate_err_logged {
                                navigate_err_logged = true;
                                eprintln!("[cockpit-tray] recovery: navigate to cockpit failed, will retry: {e}");
                            }
                        }
                    }
                }
            }
            TickAction::Deliver => {
                let Some(script) = script.as_ref() else {
                    // Menu-driven recovery: the document is live; done.
                    return;
                };
                if let Some(w) = window.as_ref() {
                    match w.eval(script.as_str()) {
                        Ok(_) => {
                            // Pending var set on the live document (and
                            // __minskyDeepLink called if mounted). Done.
                            return;
                        }
                        Err(e) => {
                            if attempt == 0 {
                                eprintln!("[cockpit-tray] deep-link: eval attempt 0 failed (webview not ready?): {e}");
                            }
                            // Webview not ready yet -- keep retrying.
                        }
                    }
                }
            }
        }
    }
    eprintln!(
        "[cockpit-tray] recovery: gave up after {DEEP_LINK_RETRY_MAX} ticks{}",
        if script.is_some() { " (deep link dropped)" } else { "" }
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- decide_tick -------------------------------------------------------

    #[test]
    fn no_window_creates_even_while_daemon_boots() {
        // Creation is not gated on the daemon: instant window, healed later.
        assert_eq!(
            decide_tick(false, false, None, true),
            TickAction::CreateWindow
        );
        assert_eq!(
            decide_tick(false, true, None, true),
            TickAction::CreateWindow
        );
    }

    #[test]
    fn live_document_delivers_without_navigation() {
        // Hot start: SPA already up -- no rescue, no reload (success
        // criterion: no gratuitous reload on the hot path).
        assert_eq!(
            decide_tick(true, true, Some(true), true),
            TickAction::Deliver
        );
        // Even mid-rescue-cooldown a live document delivers.
        assert_eq!(
            decide_tick(true, true, Some(true), false),
            TickAction::Deliver
        );
        // The document wins over a lagging daemon probe.
        assert_eq!(
            decide_tick(true, false, Some(true), true),
            TickAction::Deliver
        );
    }

    #[test]
    fn dead_document_waits_for_daemon() {
        // The mt#2688 cold-start race: window up, daemon still booting.
        // Navigating now would fail again; wait for the TCP accept.
        assert_eq!(
            decide_tick(true, false, Some(false), true),
            TickAction::AwaitDaemon
        );
        // An unscriptable webview (probe timeout) is treated as dead too.
        assert_eq!(decide_tick(true, false, None, true), TickAction::AwaitDaemon);
    }

    #[test]
    fn dead_document_with_daemon_up_rescues_when_armed() {
        assert_eq!(
            decide_tick(true, true, Some(false), true),
            TickAction::RescueNavigate
        );
        // Unscriptable counts as dead: WKWebView reports the REQUESTED url
        // for failed loads, so the DOM probe (not url()) is the authority.
        assert_eq!(decide_tick(true, true, None, true), TickAction::RescueNavigate);
        // An issued navigation gets RESCUE_REARM_TICKS to commit before a
        // re-issue restarts the load.
        assert_eq!(
            decide_tick(true, true, Some(false), false),
            TickAction::AwaitNavigation
        );
    }

    // --- DOM probe script ---------------------------------------------------

    #[test]
    fn dom_probe_targets_the_spa_shell_root() {
        // The probe must key on the #root div in the served HTML shell (live
        // as soon as a cockpit document commits) and be a bare boolean
        // expression so eval_with_callback serializes "true"/"false".
        assert!(DOM_PROBE_JS.contains("getElementById('root')"));
        assert!(DOM_PROBE_JS.starts_with("!!"));
    }

    // --- build_deliver_script ----------------------------------------------

    #[test]
    fn deliver_script_embeds_json_encoded_url_and_pending_handoff() {
        let json = serde_json::to_string("minsky://task/mt%232688").unwrap();
        let script = build_deliver_script(&json);
        // JSON-encoded (quoted) -- not raw-interpolated.
        assert!(script.contains(r#""minsky://task/mt%232688""#));
        // Durable hand-off for a not-yet-mounted SPA...
        assert!(script.contains("window.__minskyPendingDeepLink ="));
        // ...and immediate dispatch when the SPA is already mounted.
        assert!(script.contains("typeof window.__minskyDeepLink === 'function'"));
    }

    #[test]
    fn deliver_script_json_encoding_neutralizes_injection() {
        // A crafted URL trying to break out of the JS string context must
        // stay inside a JSON string literal (quotes escaped, not terminated).
        let evil = r#"minsky://task/x"); window.evil("pwned"#;
        let json = serde_json::to_string(evil).unwrap();
        let script = build_deliver_script(&json);
        assert!(script.contains(r#"\""#));
        assert!(!script.contains(r#"x"); window.evil"#));
    }
}
