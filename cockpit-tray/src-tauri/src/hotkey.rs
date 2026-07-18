// Global summon hotkey (mt#2676): toggles the cockpit window from anywhere,
// even when another app is frontmost or the tray currently has no windows.
// Uses tauri-plugin-global-shortcut, the community-standard plugin for
// Tauri v2 global hotkeys (https://v2.tauri.app/plugin/global-shortcut/),
// registered from Rust only -- the cockpit SPA is an untrusted external-URL
// webview with no IPC bridge (ADR-023), so this never needs a capabilities
// grant (no `invoke()` call from the webview ever reaches it).
//
// Toggle semantics: hidden (or nonexistent) -> show+focus via the mt#2675
// presentation path (`menu::ensure_cockpit_window_visible`, which flips the
// activation policy to Regular so the window can be fronted); visible+
// focused -> hide (`menu::hide_cockpit_window`, policy back to Accessory).
// Registration failure (e.g. the shortcut is already bound by another app)
// degrades gracefully: a logged warning, never a crash (mt#2676 success
// criterion 2).
//
// DEFAULT BINDING is a principal-reserved decision -- an Ask was filed at
// implementation start (mt#2676) presenting Ctrl+Opt+C vs Cmd+Shift+Space.
// `summon_shortcut()` below is the single easily-changed spot to flip once
// that Ask resolves; see the mt#2676 PR body for the recommendation.

use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::menu::{ensure_cockpit_window_visible, hide_cockpit_window, COCKPIT_WINDOW_LABEL};

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
/// setup closure, after `menu::build` (so the tray label already shows
/// `SUMMON_SHORTCUT_LABEL` regardless of whether OS registration actually
/// succeeds -- the label communicates the app's BOUND intent, not live
/// registration state).
///
/// Registration can fail for reasons entirely outside this app's control
/// (another running app already claimed the same OS-level hotkey, or the
/// platform denies it) -- per mt#2676 success criterion 2, that must never
/// crash the tray, only warn.
pub(crate) fn register(app: &AppHandle) {
    if let Err(e) = app.global_shortcut().register(summon_shortcut()) {
        eprintln!(
            "[cockpit-tray] failed to register summon hotkey {SUMMON_SHORTCUT_LABEL} \
             (likely already bound by another app): {e}"
        );
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
        ensure_cockpit_window_visible(app);
    }
}
