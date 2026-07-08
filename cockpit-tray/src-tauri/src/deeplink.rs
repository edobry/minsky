// minsky:// deep-link handling (mt#2528, ADR-023) + cockpit-window recovery
// (mt#2688).
//
// `register` wires the tauri-plugin-deep-link cold-start + hot-start hooks
// (called once from `main()`'s setup closure); `handle_deep_link` brings up
// the cockpit window and forwards the URL into the SPA via eval. Both ride
// `spawn_window_recovery`, the shared retry loop that also heals dead
// (never-loaded) cockpit windows for menu-driven opens. Split out of main.rs
// (mt#2628).

use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager, Url, Wry};

use crate::menu::{ensure_cockpit_window_visible, COCKPIT_URL, COCKPIT_WINDOW_LABEL};
use crate::supervisor::DAEMON_PORT;

// Recovery-loop constants (mt#2528, ADR-023 cold-start handling; reworked
// mt#2688). The loop ticks until the deep link is delivered onto a LIVE
// cockpit document (or, for menu-driven recovery, until the document is
// live), giving up only when the budget expires. 400 x 150 ms = 60 s nominal
// window -- generous enough to cover a cold daemon boot + webview load on a
// slow machine.
/// Max recovery ticks before giving up (cockpit never came up).
const DEEP_LINK_RETRY_MAX: u32 = 400;
/// Interval between recovery ticks (ms).
const DEEP_LINK_RETRY_INTERVAL_MS: u64 = 150;
/// TCP connect timeout for the daemon-accepting probe (ms). Localhost
/// refusals answer in <1 ms; the timeout only bounds pathological stalls.
const DAEMON_PROBE_TIMEOUT_MS: u64 = 100;
/// Ticks to wait for an issued rescue navigation to commit before re-issuing
/// it (40 x 150 ms = 6 s). Re-navigating every tick would restart the load
/// before it can commit; never re-arming would strand the flow if a single
/// navigation is silently dropped by the webview.
const RESCUE_REARM_TICKS: u32 = 40;

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
    /// Document is dead and the daemon is up -- re-navigate the webview to
    /// the cockpit URL. mt#2688: recovery must NAVIGATE, not reload();
    /// reload() on a never-loaded document reloads the blank page.
    RescueNavigate,
    /// A rescue navigation was recently issued; give it time to commit.
    AwaitNavigation,
}

pub(crate) fn decide_tick(
    window_exists: bool,
    daemon_accepting: bool,
    on_cockpit_document: bool,
    rescue_armed: bool,
) -> TickAction {
    if !window_exists {
        return TickAction::CreateWindow;
    }
    if on_cockpit_document {
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

/// Is the webview currently showing a live cockpit document?
///
/// `current` is `WebviewWindow::url()` (None when the getter failed). A
/// never-loaded webview reports about:blank (opaque origin); a loaded cockpit
/// page reports an http://localhost:3737/... URL. Full-origin comparison, not
/// a string prefix -- "http://localhost:37370" must not match.
pub(crate) fn is_cockpit_document(current: Option<&Url>, cockpit: &Url) -> bool {
    current.map_or(false, |u| u.origin() == cockpit.origin())
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

/// Bring the cockpit window to a LIVE document -- creating it if missing,
/// waiting out a booting daemon, re-navigating a dead (never-loaded /
/// connection-refused) document -- and, when `deep_link_url` is set,
/// deliver it into the SPA via eval (mt#2528 + mt#2688).
///
/// Window CREATION is deferred onto the main run loop (mt#2546;
/// `WebviewWindowBuilder::build()` deadlocks if called directly from the
/// synchronous `on_open_url` callback, which holds the run loop).
/// `create_in_flight` (mt#2551) makes the deferred create resilient WITHOUT
/// a double-create race: the flag is set BEFORE enqueueing and cleared only
/// INSIDE the closure, so a slow `build()` is never double-scheduled, and a
/// failed create re-schedules on a later tick.
///
/// Rescue NAVIGATION (mt#2688): when the window's document is not a cockpit
/// document (about:blank / origin mismatch / url() error) and the daemon is
/// accepting connections, the loop re-navigates via
/// `WebviewWindow::navigate`. Rust-side deliberately: a dead document's JS
/// context cannot be relied on for eval, and JS `location.reload()` reloads
/// the blank document, not the cockpit. At most one navigation is issued per
/// `RESCUE_REARM_TICKS` so an in-flight load isn't restarted every tick.
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
    std::thread::spawn(move || {
        let create_in_flight = Arc::new(AtomicBool::new(false));
        let mut schedule_count: u32 = 0;
        let mut last_rescue_tick: Option<u32> = None;
        let mut navigate_err_logged = false;

        for attempt in 0..DEEP_LINK_RETRY_MAX {
            std::thread::sleep(Duration::from_millis(DEEP_LINK_RETRY_INTERVAL_MS));

            let window = app_clone.get_webview_window(COCKPIT_WINDOW_LABEL);
            let on_cockpit_document = window
                .as_ref()
                .map(|w| is_cockpit_document(w.url().ok().as_ref(), &cockpit))
                .unwrap_or(false);
            let rescue_armed = last_rescue_tick
                .map_or(true, |t| attempt.saturating_sub(t) >= RESCUE_REARM_TICKS);

            match decide_tick(
                window.is_some(),
                daemon_accepting(DAEMON_PORT),
                on_cockpit_document,
                rescue_armed,
            ) {
                TickAction::CreateWindow => {
                    if !create_in_flight.swap(true, Ordering::AcqRel) {
                        let app_for_window = app_clone.clone();
                        let flag = create_in_flight.clone();
                        match app_clone.run_on_main_thread(move || {
                            ensure_cockpit_window_visible(&app_for_window);
                            flag.store(false, Ordering::Release);
                        }) {
                            Ok(()) => {
                                schedule_count += 1;
                                // Log once, on the first RE-schedule (a prior
                                // deferred create produced no window) -- a
                                // useful field signal without spamming the
                                // happy path.
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
                        match w.eval(script) {
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
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        s.parse().expect("test URL parses")
    }

    // --- decide_tick -------------------------------------------------------

    #[test]
    fn no_window_creates_even_while_daemon_boots() {
        // Creation is not gated on the daemon: instant window, healed later.
        assert_eq!(
            decide_tick(false, false, false, true),
            TickAction::CreateWindow
        );
        assert_eq!(
            decide_tick(false, true, false, true),
            TickAction::CreateWindow
        );
    }

    #[test]
    fn live_document_delivers_without_navigation() {
        // Hot start: SPA already up -- no rescue, no reload (success
        // criterion: no gratuitous reload on the hot path).
        assert_eq!(decide_tick(true, true, true, true), TickAction::Deliver);
        // Even mid-rescue-cooldown a live document delivers.
        assert_eq!(decide_tick(true, true, true, false), TickAction::Deliver);
        // The document wins over a lagging daemon probe.
        assert_eq!(decide_tick(true, false, true, true), TickAction::Deliver);
    }

    #[test]
    fn dead_document_waits_for_daemon() {
        // The mt#2688 cold-start race: window up, daemon still booting.
        // Navigating now would fail again; wait for the TCP accept.
        assert_eq!(decide_tick(true, false, false, true), TickAction::AwaitDaemon);
    }

    #[test]
    fn dead_document_with_daemon_up_rescues_when_armed() {
        assert_eq!(
            decide_tick(true, true, false, true),
            TickAction::RescueNavigate
        );
        // An issued navigation gets RESCUE_REARM_TICKS to commit before a
        // re-issue restarts the load.
        assert_eq!(
            decide_tick(true, true, false, false),
            TickAction::AwaitNavigation
        );
    }

    // --- is_cockpit_document ----------------------------------------------

    #[test]
    fn cockpit_origin_urls_are_live() {
        let cockpit = u(COCKPIT_URL);
        assert!(is_cockpit_document(Some(&u("http://localhost:3737/")), &cockpit));
        assert!(is_cockpit_document(
            Some(&u("http://localhost:3737/task/mt%232688")),
            &cockpit
        ));
    }

    #[test]
    fn dead_or_foreign_documents_are_not_live() {
        let cockpit = u(COCKPIT_URL);
        // Never-loaded webview: url() failed.
        assert!(!is_cockpit_document(None, &cockpit));
        // Never-loaded webview: blank document (opaque origin).
        assert!(!is_cockpit_document(Some(&u("about:blank")), &cockpit));
        // Port-prefix trap: a string-prefix comparison would accept this.
        assert!(!is_cockpit_document(
            Some(&u("http://localhost:37370/")),
            &cockpit
        ));
        // Scheme mismatch.
        assert!(!is_cockpit_document(
            Some(&u("https://localhost:3737/")),
            &cockpit
        ));
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
