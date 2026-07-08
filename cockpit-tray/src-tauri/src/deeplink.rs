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
use std::sync::{mpsc, Arc, Mutex};
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
/// How long to wait for the origin probe's eval callback before treating the
/// document as unscriptable -- which callers treat as dead (ms).
const DOM_PROBE_TIMEOUT_MS: u64 = 400;
/// Ticks to wait for an issued rescue navigation to commit before re-issuing
/// it (40 x 150 ms = 6 s). Re-navigating every tick would restart the load
/// before it can commit; never re-arming would strand the flow if a single
/// navigation is silently dropped by the webview.
const RESCUE_REARM_TICKS: u32 = 40;

/// JS liveness probe, evaluated WITH a result callback: the current
/// document's own origin. The IN-DOCUMENT location is the ground truth that
/// `WKWebView.URL` is not -- a never-loaded / connection-refused document
/// reports the opaque origin string "null" (or about:blank's), while a live
/// cockpit document reports the real http origin as soon as it commits,
/// before React mounts (the pending-deep-link hand-off covers that gap).
/// Deliberately independent of the SPA shell's DOM (no `#root` dependence --
/// PR #1843 review R1: shell markup can change; the document origin can't).
const DOM_PROBE_JS: &str = "window.location.origin";

/// Singleflight for the recovery loop (PR #1843 review R1): at most ONE loop
/// runs per process. Concurrent triggers (deep link during menu-open
/// recovery, two quick link clicks) would otherwise double-navigate the same
/// window and double-deliver links.
static RECOVERY_ACTIVE: AtomicBool = AtomicBool::new(false);
/// The deep link awaiting delivery, drained by the active recovery loop on a
/// live document. Newest-wins: a second link clicked before the first is
/// delivered replaces it (the SPA would have routed to the newest anyway).
static PENDING_DEEP_LINK: Mutex<Option<String>> = Mutex::new(None);

/// Clears `RECOVERY_ACTIVE` when the loop scope exits -- including on panic
/// unwind, so a crashed loop can never permanently strand future deep links
/// behind a stuck flag.
struct RecoveryFlagGuard;
impl Drop for RecoveryFlagGuard {
    fn drop(&mut self) {
        RECOVERY_ACTIVE.store(false, Ordering::Release);
    }
}

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
    /// (or, with nothing pending to deliver, finish).
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

/// `document_live` is the origin probe's verdict: `Some(true)` = the
/// document's own origin matches the cockpit origin; `Some(false)` =
/// scriptable but blank/foreign document ("null" origin etc.); `None` = the
/// webview couldn't answer (not ready / no JS context) -- treated as dead,
/// because a live cockpit document always answers.
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

/// Parse the origin probe's callback payload (a JSON-serialized string,
/// e.g. `"http://localhost:3737"` or `"null"`) into the origin string.
/// Returns None for malformed payloads (treated as unscriptable/dead).
pub(crate) fn parse_probe_origin(payload: &str) -> Option<String> {
    serde_json::from_str::<String>(payload.trim()).ok()
}

/// Does a probed in-document origin match the cockpit origin? Exact string
/// equality on the ascii origin serialization -- "http://localhost:37370"
/// must not match "http://localhost:3737", and blank documents report
/// "null".
pub(crate) fn origin_is_live(probed: Option<&str>, cockpit_origin: &str) -> Option<bool> {
    probed.map(|o| o == cockpit_origin)
}

/// Ask the webview for its document's own origin, via `eval_with_callback`
/// (mt#2688).
///
/// WHY NOT `WebviewWindow::url()`: WKWebView keeps reporting the REQUESTED
/// URL for a navigation whose load FAILED (connection refused), so url()
/// cannot distinguish a live document from the mt#2688 white window. The
/// url()-based check shipped first and the white window survived it
/// (empirically confirmed 2026-07-08); only an in-document read is a
/// reliable discriminator. (wry's url() also `unwrap()`s a nil URL --
/// another reason to stay away from it for possibly-never-loaded webviews.)
///
/// MUST be called OFF the main thread: script evaluation needs the main run
/// loop, so blocking the main thread here would turn every probe into a
/// timeout (and the menu path into a self-inflicted dead-window verdict).
fn probe_document_origin(window: &WebviewWindow<Wry>) -> Option<String> {
    let (tx, rx) = mpsc::channel::<String>();
    let sent = window.eval_with_callback(DOM_PROBE_JS, move |result| {
        let _ = tx.send(result);
    });
    if sent.is_err() {
        return None;
    }
    match rx.recv_timeout(Duration::from_millis(DOM_PROBE_TIMEOUT_MS)) {
        Ok(payload) => parse_probe_origin(&payload),
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

/// Trigger the recovery loop (mt#2528 + mt#2688): bring the cockpit window
/// to a LIVE document -- creating it if missing, waiting out a booting
/// daemon, re-navigating a dead document -- and deliver any pending deep
/// link into the SPA via eval.
///
/// SINGLEFLIGHT (PR #1843 review R1): the deep link (if any) is parked in
/// `PENDING_DEEP_LINK` (newest-wins) and at most one loop runs per process
/// -- a trigger arriving while a loop is active just hands its link to that
/// loop. The loop re-checks the slot after its natural exit (see
/// `run_recovery`) so a link that arrives during loop teardown is not
/// stranded.
pub(crate) fn spawn_window_recovery(app: &AppHandle, deep_link_url: Option<String>) {
    if let Some(url) = deep_link_url {
        *PENDING_DEEP_LINK.lock().unwrap() = Some(url);
    }
    if RECOVERY_ACTIVE.swap(true, Ordering::AcqRel) {
        // A loop is already running; it will drain the slot.
        return;
    }
    let app_clone = app.clone();
    std::thread::spawn(move || run_recovery(&app_clone));
}

/// Menu reopen path (mt#2688): refresh a LIVE document (the daemon-restart
/// recovery reload this branch has always done) or heal a dead one via the
/// recovery loop. Off-main because the origin probe blocks on the webview's
/// eval callback, which needs the main run loop.
pub(crate) fn refresh_or_heal_window(app: &AppHandle) {
    let cockpit_origin = match cockpit_origin() {
        Some(o) => o,
        None => return,
    };
    let app_clone = app.clone();
    std::thread::spawn(move || {
        if !RECOVERY_ACTIVE.load(Ordering::Acquire) {
            if let Some(window) = app_clone.get_webview_window(COCKPIT_WINDOW_LABEL) {
                let probed = probe_document_origin(&window);
                if origin_is_live(probed.as_deref(), &cockpit_origin) == Some(true) {
                    // Live document: reload so the view recovers after a
                    // daemon Start/Restart (mt#2219 behavior, unchanged).
                    if let Err(e) = window.eval("window.location.reload()") {
                        eprintln!("[cockpit-tray] failed to reload cockpit window: {e}");
                    }
                    return;
                }
            }
        }
        // Dead, unscriptable, missing, or already being recovered: the
        // recovery loop handles all of these (singleflight-deduped).
        spawn_window_recovery(&app_clone, None);
    });
}

/// Parse `COCKPIT_URL`'s origin (ascii serialization, e.g.
/// "http://localhost:3737"). None only on a malformed constant.
fn cockpit_origin() -> Option<String> {
    match COCKPIT_URL.parse::<Url>() {
        Ok(u) => Some(u.origin().ascii_serialization()),
        Err(e) => {
            eprintln!("[cockpit-tray] invalid cockpit URL {COCKPIT_URL:?}: {e}");
            None
        }
    }
}

/// The recovery loop driver: runs `recovery_ticks`, then closes the
/// singleflight window -- re-claiming the flag and looping again if a deep
/// link arrived during teardown (so it is never stranded until the next
/// trigger).
fn run_recovery(app: &AppHandle) {
    loop {
        {
            // Clears RECOVERY_ACTIVE on scope exit INCLUDING panic unwind, so
            // a crashed loop can't permanently strand future deep links.
            let _flag = RecoveryFlagGuard;
            recovery_ticks(app);
        }
        // Late-arrival check: a link parked after our last Deliver tick but
        // before the flag cleared would otherwise wait for the next trigger.
        if PENDING_DEEP_LINK.lock().unwrap().is_some()
            && !RECOVERY_ACTIVE.swap(true, Ordering::AcqRel)
        {
            continue;
        }
        return;
    }
}

/// The tick loop. See `spawn_window_recovery` / `refresh_or_heal_window`;
/// runs on a background thread, at most one instance per process.
///
/// Window CREATION is deferred onto the main run loop (mt#2546;
/// `WebviewWindowBuilder::build()` deadlocks if called directly from the
/// synchronous `on_open_url` callback, which holds the run loop).
/// `create_in_flight` (mt#2551) makes the deferred create resilient WITHOUT
/// a double-create race: the flag is set BEFORE enqueueing and cleared only
/// INSIDE the closure, so a slow `build()` is never double-scheduled, and a
/// failed create re-schedules on a later tick.
///
/// Rescue NAVIGATION (mt#2688): when the origin probe says the document is
/// not a live cockpit document and the daemon is accepting connections, the
/// loop re-navigates via `WebviewWindow::navigate`. Rust-side deliberately:
/// a dead document's JS context cannot be relied on to execute a JS-side
/// `location.replace`, and `location.reload()` reloads the blank document.
/// At most one navigation is issued per `RESCUE_REARM_TICKS` so an in-flight
/// load isn't restarted every tick.
fn recovery_ticks(app: &AppHandle) {
    let Some(cockpit_origin) = cockpit_origin() else {
        return;
    };
    let cockpit: Url = match COCKPIT_URL.parse() {
        Ok(u) => u,
        Err(_) => return, // unreachable: cockpit_origin() already parsed it
    };

    let create_in_flight = Arc::new(AtomicBool::new(false));
    let mut schedule_count: u32 = 0;
    let mut last_rescue_tick: Option<u32> = None;
    let mut navigate_err_logged = false;
    let mut last_logged: Option<&'static str> = None;

    for attempt in 0..DEEP_LINK_RETRY_MAX {
        std::thread::sleep(Duration::from_millis(DEEP_LINK_RETRY_INTERVAL_MS));

        let window = app.get_webview_window(COCKPIT_WINDOW_LABEL);
        let document_live = window.as_ref().and_then(|w| {
            let probed = probe_document_origin(w);
            origin_is_live(probed.as_deref(), &cockpit_origin)
        });
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
                // Drain the pending slot. Empty slot on a live document =
                // nothing (left) to deliver; the loop's purpose is complete.
                let pending = PENDING_DEEP_LINK.lock().unwrap().take();
                let Some(url) = pending else {
                    return;
                };
                let script = match serde_json::to_string(&url) {
                    Ok(json) => build_deliver_script(&json),
                    Err(e) => {
                        eprintln!(
                            "[cockpit-tray] deep-link: failed to JSON-encode URL {url:?}: {e}"
                        );
                        continue;
                    }
                };
                if let Some(w) = window.as_ref() {
                    match w.eval(script.as_str()) {
                        Ok(_) => {
                            // Pending var set on the live document (and
                            // __minskyDeepLink called if mounted). Next tick
                            // returns via the empty-slot path unless another
                            // link arrived meanwhile.
                        }
                        Err(e) => {
                            if attempt == 0 {
                                eprintln!("[cockpit-tray] deep-link: eval attempt 0 failed (webview not ready?): {e}");
                            }
                            // Webview not ready: put the link back for the
                            // next tick -- unless a newer one arrived
                            // (newest-wins).
                            let mut slot = PENDING_DEEP_LINK.lock().unwrap();
                            if slot.is_none() {
                                *slot = Some(url);
                            }
                        }
                    }
                }
            }
        }
    }
    let dropped = PENDING_DEEP_LINK.lock().unwrap().take();
    eprintln!(
        "[cockpit-tray] recovery: gave up after {DEEP_LINK_RETRY_MAX} ticks{}",
        match &dropped {
            Some(url) => format!(" (deep link dropped: {url:?})"),
            None => String::new(),
        }
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
        // for failed loads, so the in-document probe is the authority.
        assert_eq!(decide_tick(true, true, None, true), TickAction::RescueNavigate);
        // An issued navigation gets RESCUE_REARM_TICKS to commit before a
        // re-issue restarts the load.
        assert_eq!(
            decide_tick(true, true, Some(false), false),
            TickAction::AwaitNavigation
        );
    }

    // --- origin probe -------------------------------------------------------

    #[test]
    fn probe_asks_for_the_in_document_origin() {
        // The in-document location is the ground truth WKWebView.URL is not:
        // failed loads keep reporting the REQUESTED url via url().
        assert_eq!(DOM_PROBE_JS, "window.location.origin");
    }

    #[test]
    fn parse_probe_origin_handles_json_payloads() {
        // eval_with_callback serializes the JS result as JSON.
        assert_eq!(
            parse_probe_origin("\"http://localhost:3737\"").as_deref(),
            Some("http://localhost:3737")
        );
        // Blank / opaque-origin documents report the string "null".
        assert_eq!(parse_probe_origin("\"null\"").as_deref(), Some("null"));
        // Malformed payloads read as unscriptable (dead).
        assert_eq!(parse_probe_origin("not json"), None);
        assert_eq!(parse_probe_origin("42"), None);
    }

    #[test]
    fn origin_matching_is_exact() {
        let cockpit = "http://localhost:3737";
        assert_eq!(origin_is_live(Some("http://localhost:3737"), cockpit), Some(true));
        // Blank document.
        assert_eq!(origin_is_live(Some("null"), cockpit), Some(false));
        // Port-prefix trap: a string-prefix comparison would accept this.
        assert_eq!(
            origin_is_live(Some("http://localhost:37370"), cockpit),
            Some(false)
        );
        // Scheme mismatch.
        assert_eq!(
            origin_is_live(Some("https://localhost:3737"), cockpit),
            Some(false)
        );
        // Probe failure propagates as unknown.
        assert_eq!(origin_is_live(None, cockpit), None);
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
