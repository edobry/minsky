// Global summon hotkey (mt#2676): toggles the cockpit window from anywhere,
// even when another app is frontmost or the tray currently has no windows.
// Uses tauri-plugin-global-shortcut, the community-standard plugin for
// Tauri v2 global hotkeys (https://v2.tauri.app/plugin/global-shortcut/),
// registered from Rust only -- the cockpit SPA is an untrusted external-URL
// webview with no IPC bridge (ADR-023), so this never needs a capabilities
// grant (no `invoke()` call from the webview ever reaches it).
//
// Toggle semantics: hidden (or nonexistent) -> show+focus via the mt#2675
// presentation path (`menu::open_cockpit_window` -- the SAME helper the
// tray's "Open Cockpit" click uses, so a cold summon gets the same
// cold-start recovery loop as a menu click: PR #2051 review R1, see that
// function's doc comment); visible+focused -> hide (`menu::hide_cockpit_window`,
// policy back to Accessory). Registration failure (e.g. the shortcut is
// already bound by another app) degrades gracefully: a logged warning plus
// a one-time OS notification, never a crash (mt#2676 success criterion 2).
//
// DEFAULT BINDING is a principal-reserved decision -- an Ask was filed at
// implementation start (mt#2676) presenting Ctrl+Opt+C vs Cmd+Shift+Space.
// `summon_shortcut()` below is the single easily-changed spot to flip once
// that Ask resolves; see the mt#2676 PR body for the recommendation.

use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;

use crate::menu::{hide_cockpit_window, open_cockpit_window, COCKPIT_WINDOW_LABEL};

/// Provisional default: Ctrl+Opt+C ("C" for Cockpit). Recommended in the
/// mt#2676 Ask over Cmd+Shift+Space for its clearer mnemonic and lower
/// collision risk with the Cmd+Space / Option+Space cluster common
/// launcher apps (Spotlight/Raycast/Alfred) default to.
///
/// Not a `const` because `Shortcut::new` is not a `const fn`; called from
/// the few call sites below instead (cheap value construction, no need for
/// a cached static).
pub(crate) fn summon_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyC)
}

/// Human-readable label for the tray dropdown (mt#2676 success criterion:
/// "the tray dropdown lists the shortcut next to 'Open Cockpit' so it is
/// discoverable"). macOS-convention glyphs: ⌃ Control, ⌥ Option.
pub(crate) const SUMMON_SHORTCUT_LABEL: &str = "⌃⌥C";

/// Build the global-shortcut plugin with its press handler. Added to the
/// `tauri::Builder` plugin chain in `main()` alongside the other plugins
/// (shell, notification, deep-link) -- constructed once at app setup. The
/// actual OS-level shortcut registration happens separately in `register`
/// below (called from `main()`'s setup closure, where a live `AppHandle` is
/// available to log failures against).
pub(crate) fn plugin() -> tauri::plugin::TauriPlugin<Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if shortcut == &summon_shortcut() && event.state() == ShortcutState::Pressed {
                toggle_cockpit_window(app);
            }
        })
        .build()
}

/// Register the summon shortcut with the OS. Called once from `main()`'s
/// setup closure, BEFORE `menu::build` -- returns whether registration
/// succeeded so the tray label can reflect the OS's actual decision instead
/// of unconditionally advertising a shortcut that may silently do nothing
/// (PR #2051 review R1).
///
/// Registration can fail for reasons entirely outside this app's control
/// (another running app already claimed the same OS-level hotkey, or the
/// platform denies it) -- per mt#2676 success criterion 2, that must never
/// crash the tray. On failure this logs a warning AND fires a best-effort
/// one-time OS notification (silently ignored if permission was denied or
/// unavailable, same posture as the existing build-failure toasts in
/// `menu::build`) so the failure isn't silent to the user, not just to the
/// terminal.
pub(crate) fn register(app: &AppHandle) -> bool {
    match app.global_shortcut().register(summon_shortcut()) {
        Ok(()) => true,
        Err(e) => {
            eprintln!(
                "[cockpit-tray] failed to register summon hotkey {SUMMON_SHORTCUT_LABEL} \
                 (likely already bound by another app): {e}"
            );
            let _ = app
                .notification()
                .builder()
                .title("Minsky Cockpit")
                .body(format!(
                    "Global hotkey {SUMMON_SHORTCUT_LABEL} is unavailable -- probably already \
                     bound by another app. Use the tray menu to open the cockpit instead."
                ))
                .show();
            false
        }
    }
}

/// Toggle handler invoked on every hotkey press: hidden (or nonexistent) ->
/// show+focus; visible+focused -> hide. A window that is visible but NOT
/// focused (e.g. it sits behind another frontmost app) is treated as the
/// "show" case -- the hotkey brings it to the front rather than hiding a
/// window the user cannot currently see.
fn toggle_cockpit_window(app: &AppHandle) {
    let is_visible_and_focused = app
        .get_webview_window(COCKPIT_WINDOW_LABEL)
        .map(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false))
        .unwrap_or(false);

    if is_visible_and_focused {
        hide_cockpit_window(app);
    } else {
        // Reuse the exact helper the tray's "Open Cockpit" click uses (not
        // the deep-link-oriented `ensure_cockpit_window_visible`, which
        // deliberately skips cold-start recovery so it doesn't double-heal
        // underneath the deep-link loop). The hotkey has no competing
        // recovery loop of its own, so it needs the SAME cold-start healing
        // a menu click gets -- otherwise summoning before the daemon is
        // listening leaves a permanently blank window (PR #2051 review R1).
        open_cockpit_window(app);
    }
}
