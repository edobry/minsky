// minsky:// deep-link handling (mt#2528, ADR-023).
//
// `register` wires the tauri-plugin-deep-link cold-start + hot-start hooks
// (called once from `main()`'s setup closure); `handle_deep_link` brings up
// the cockpit window and forwards the URL into the SPA via eval, retrying
// until the webview accepts script. Split out of main.rs (mt#2628).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager, Wry};

use crate::menu::{ensure_cockpit_window_visible, set_dock_presence, COCKPIT_WINDOW_LABEL};

// Deep-link retry constants (mt#2528, ADR-023 cold-start handling).
// After a minsky:// URL is opened we retry window.eval(...) until the webview
// FIRST accepts the script. Each successful eval sets window.__minskyPendingDeepLink
// (the durable hand-off the SPA drains on mount) AND calls window.__minskyDeepLink
// if it is already defined. We retry until the first success rather than a short
// fixed count, so a slow cold start (daemon boot + webview load) never drops the
// link; we only give up if the cockpit genuinely never comes up.
/// Max retry attempts before giving up (cockpit never came up).
const DEEP_LINK_RETRY_MAX: u32 = 400;
/// Interval between retry attempts (ms). 400 × 150 ms = 60 s total window —
/// generous enough to cover a cold daemon + webview start on a slow machine.
const DEEP_LINK_RETRY_INTERVAL_MS: u64 = 150;

/// Register the minsky:// URL-scheme handler (mt#2528, ADR-023).
///
/// macOS routes clicked minsky:// links to the running instance via Apple
/// Event kAEGetURL (no tauri-plugin-single-instance needed); if the app
/// is closed, Launch Services launches it first, then delivers the URL.
///
/// Navigation shape (ADR-023): the SPA is an untrusted external-URL
/// webview, so we forward the URL via Rust->webview eval of the SPA-
/// exposed global window.__minskyDeepLink(uri). The payload is JSON-
/// encoded (serde_json::to_string) -- never raw string-interpolated, as a
/// crafted minsky:// URL is otherwise a script-injection vector.
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
/// Called from the `on_open_url` handler registered in `register`. Brings up
/// the cockpit window — showing/focusing an existing one synchronously, or
/// CREATING a missing one deferred onto the main run loop (mt#2546;
/// `WebviewWindowBuilder::build()` deadlocks if called directly from the
/// synchronous `on_open_url` callback, which holds the run loop) — then
/// forwards the URL to the SPA via eval.
///
/// **Navigation strategy (ADR-023, cold-start handling):**
/// A single eval script runs on each retry attempt. It always sets
/// `window.__minskyPendingDeepLink` (so the SPA can drain it on mount), then
/// immediately calls `window.__minskyDeepLink(uri)` if the global is already
/// defined (hot-start fast path). Once ANY eval attempt succeeds, we stop
/// retrying -- the pending variable is set and the SPA will pick it up.
///
/// Retries are needed because `eval()` fails with an error when the webview is
/// not yet ready to accept script (e.g., just after `menu::ensure_cockpit_window_visible`
/// is called on cold start). Each retry sleeps `DEEP_LINK_RETRY_INTERVAL_MS` ms;
/// total retry window = `DEEP_LINK_RETRY_MAX` x `DEEP_LINK_RETRY_INTERVAL_MS`.
///
/// **Security:** the URL is JSON-encoded via `serde_json::to_string` before being
/// interpolated into the eval script -- never raw string-interpolated. This prevents
/// a crafted `minsky://` URL from breaking out of the JS string context.
pub(crate) fn handle_deep_link(app: &AppHandle, url: String) {
    // If a cockpit window ALREADY exists, show + focus it synchronously. Unlike
    // window CREATION (`build()`), `show()`/`set_focus()` don't block on the run
    // loop, so they're safe to call directly from the `on_open_url` callback. A
    // MISSING window is created later, deferred onto the run loop (see below).
    // Dock presence first (mt#2675): the window may be hidden via hide-on-close
    // with the app back in Accessory; Regular must be restored BEFORE show/focus
    // or macOS may refuse to front the window.
    if let Some(window) = app.get_webview_window(COCKPIT_WINDOW_LABEL) {
        set_dock_presence(app, true);
        let _ = window.show();
        let _ = window.set_focus();
    }

    // JSON-encode the URL once so all retry attempts can reuse it.
    // serde_json::to_string on a &str produces a valid JSON string literal
    // including the surrounding double-quotes -- safe to interpolate into JS.
    let url_json = match serde_json::to_string(&url) {
        Ok(j) => j,
        Err(e) => {
            eprintln!("[cockpit-tray] deep-link: failed to JSON-encode URL {url:?}: {e}");
            return;
        }
    };

    // Step 2: forward the URL to the SPA via eval, with retry for cold-start.
    // The webview may not accept eval() immediately after window creation.
    let app_clone = app.clone();
    std::thread::spawn(move || {
        // Script run on every attempt:
        //  1. Always sets window.__minskyPendingDeepLink = url so the SPA can
        //     drain it on mount even if it hasn't mounted yet.
        //  2. Immediately calls window.__minskyDeepLink(url) if already defined
        //     (hot-start: SPA is already mounted) and clears the pending var.
        let script = format!(
            "(function(){{ \
                window.__minskyPendingDeepLink = {url_json}; \
                if (typeof window.__minskyDeepLink === 'function') {{ \
                    window.__minskyDeepLink({url_json}); \
                    window.__minskyPendingDeepLink = null; \
                }} \
            }})()"
        );

        // Create a MISSING window from this background thread, DEFERRED onto the
        // main run loop (mt#2546): scheduling via `run_on_main_thread` lands on the
        // next run-loop tick (after the synchronous `on_open_url` callback returned),
        // so `build()` can complete instead of deadlocking.
        //
        // `create_in_flight` (mt#2551) makes the deferred create resilient WITHOUT a
        // double-create race. `run_on_main_thread` returning Ok means the create
        // closure was ENQUEUED, not that `menu::ensure_cockpit_window_visible`'s
        // `build()` succeeded. The flag is set BEFORE enqueueing and cleared only
        // INSIDE the closure (once `ensure_cockpit_window_visible` has returned and
        // the window therefore either exists or has definitively failed to build).
        // So:
        //   - while a create is queued OR mid-flight, no second create is scheduled —
        //     even on a slow/back-pressured machine where `build()` outlasts any fixed
        //     grace window (the race flagged on PR #1741);
        //   - if the deferred create FAILS, the flag clears with the window still
        //     absent, and the next tick re-schedules — so a one-off transient failure
        //     doesn't spin out the whole retry budget with no window.
        // On `run_on_main_thread` Err the closure never runs, so the flag is cleared
        // here to allow a retry on the next tick.
        let create_in_flight = Arc::new(AtomicBool::new(false));
        let mut schedule_count: u32 = 0;
        for attempt in 0..DEEP_LINK_RETRY_MAX {
            std::thread::sleep(Duration::from_millis(DEEP_LINK_RETRY_INTERVAL_MS));

            let Some(window) = app_clone.get_webview_window(COCKPIT_WINDOW_LABEL) else {
                // No window yet — schedule creation unless one is already in flight.
                if !create_in_flight.swap(true, Ordering::AcqRel) {
                    let app_for_window = app_clone.clone();
                    let flag = create_in_flight.clone();
                    match app_clone.run_on_main_thread(move || {
                        ensure_cockpit_window_visible(&app_for_window);
                        flag.store(false, Ordering::Release);
                    }) {
                        Ok(()) => {
                            schedule_count += 1;
                            // Log once, on the first RE-schedule (a prior deferred
                            // create produced no window) — a useful field signal
                            // without spamming the happy path.
                            if schedule_count == 2 {
                                eprintln!("[cockpit-tray] deep-link: re-scheduling window creation (prior deferred create produced no window) for {url:?}");
                            }
                        }
                        Err(e) => {
                            create_in_flight.store(false, Ordering::Release);
                            if attempt == 0 {
                                eprintln!("[cockpit-tray] deep-link: run_on_main_thread (window create) failed, will retry: {e}");
                            }
                        }
                    }
                }
                continue;
            };

            match window.eval(&script) {
                Ok(_) => {
                    // eval succeeded: __minskyPendingDeepLink is now set and
                    // __minskyDeepLink was called if defined. Done.
                    return;
                }
                Err(e) => {
                    if attempt == 0 {
                        eprintln!(
                            "[cockpit-tray] deep-link: eval attempt 0 failed (webview not ready?): {e}"
                        );
                    }
                    // Webview not ready yet -- keep retrying.
                }
            }
        }
        eprintln!(
            "[cockpit-tray] deep-link: gave up after {DEEP_LINK_RETRY_MAX} attempts for {url:?}"
        );
    });
}
