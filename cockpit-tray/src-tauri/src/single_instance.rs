// Single-instance guard (mt#3770): exactly one cockpit-tray process per user.
//
// Nothing enforced this before. ADR-014 anticipated concurrent instances but
// scoped the risk to ONE consequence -- both processes spawning the daemon --
// and mitigated it with bind-authoritative adoption, which shipped and works.
// That is precisely why the duplicate stayed invisible: the second instance
// adopts the first instance's daemon and looks healthy, while every OTHER
// surface silently doubles. Observed 2026-08-05: two `/Applications/Minsky
// Cockpit.app` processes launched 15 s apart at login -- one by LaunchServices,
// one by this app's own autostart LaunchAgent -- each with its own tray icon,
// its own summon-hotkey registration, and its own cockpit window. The first
// ⌃⌥C press opened two windows. Tauri's `WindowLabelAlreadyExists` check is
// per-process and cannot dedupe across processes; the fix has to be at the
// process level, which is the "user-level lockfile or single-instance guard on
// the app" ADR-014 itself names as the secondary defense.
//
// The guard is `tauri-plugin-single-instance`, used as its docs prescribe: it
// MUST be the first plugin registered, so `main()` registers it ahead of the
// shell/notification/deep-link/hotkey chain.
//
// Deep links are unaffected: macOS routes `minsky://` to the RUNNING instance
// via Apple Event kAEGetURL and never launches a second process for them, so
// the plugin's optional `deep-link` feature (a Linux/Windows integration) is
// deliberately not enabled.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Wry};

/// How long after startup a refused second launch is treated as the login-time
/// race rather than a deliberate user action.
///
/// Grounded in the observed cadence (`decision-defaults.mdc §Thresholds`): the
/// two launches in the originating incident were 15 s apart, and both start
/// paths fire off the same login. The bound has to cover the slower of the two
/// arriving late on a contended boot -- but it exists only to keep the tray
/// menu-bar-only at login (mt#2219), so it can be generous without costing
/// anything: a user who genuinely re-launches the app a minute after logging in
/// still gets the window.
const STARTUP_GRACE: Duration = Duration::from_secs(60);

/// When this process started. Set once from `main()` before the plugin's
/// listener can accept a connection.
static STARTED_AT: OnceLock<Instant> = OnceLock::new();

/// Record the process start time. Call once, first thing in `main()`.
pub(crate) fn mark_started() {
    let _ = STARTED_AT.set(Instant::now());
}

/// Whether a refused second launch should bring the cockpit window forward.
///
/// A second launch that arrives during startup is the login race, NOT a user
/// asking for the cockpit -- fronting a window there would pop the cockpit open
/// on every login, defeating the menu-bar-only launch state mt#2219 established.
/// A later one is a deliberate act (double-clicking the app in `/Applications`,
/// a Dock launch) and gets the same treatment as the tray's "Open Cockpit".
///
/// `None` means the start time was never recorded, which should be impossible
/// -- treat it as "cannot tell" and take the quiet branch, since a spurious
/// window is worse than a missing one.
pub(crate) fn should_front_on_second_launch(uptime: Option<Duration>) -> bool {
    uptime.is_some_and(|elapsed| elapsed >= STARTUP_GRACE)
}

/// Build the single-instance plugin. Registered FIRST in `main()`'s plugin
/// chain, and release-only -- see `main.rs` for why.
#[cfg_attr(debug_assertions, allow(dead_code))]
pub(crate) fn plugin() -> tauri::plugin::TauriPlugin<Wry> {
    tauri_plugin_single_instance::init(|app, _args, _cwd| on_second_launch(app))
}

/// Runs in the FIRST instance when a second one is refused.
#[cfg_attr(debug_assertions, allow(dead_code))]
fn on_second_launch(app: &AppHandle) {
    if should_front_on_second_launch(STARTED_AT.get().map(Instant::elapsed)) {
        eprintln!("[cockpit-tray] refused a second instance; fronting the cockpit window");
        // NOT `menu::open_cockpit_window`, which builds the window inline: this
        // callback runs on a `tauri::async_runtime` task
        // (`tauri-plugin-single-instance-2.4.3/src/platform_impl/macos.rs:100-111`),
        // and creating a window from an out-of-band callback is what mt#2546
        // got wrong. The deep-link path's presenter routes creation through the
        // recovery loop, which is the deferral that fixed it.
        crate::deeplink::present_cockpit_window_no_link(app);
    } else {
        eprintln!(
            "[cockpit-tray] refused a second instance during startup (the login race) \
             -- leaving the tray menu-bar-only"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_launch_during_startup_does_not_open_a_window() {
        // The originating incident: LaunchServices at 15:37:01, the autostart
        // LaunchAgent at 15:37:16. Fronting a window here would pop the cockpit
        // open on every login.
        assert!(!should_front_on_second_launch(Some(Duration::from_secs(
            15
        ))));
        assert!(!should_front_on_second_launch(Some(Duration::ZERO)));
    }

    #[test]
    fn a_later_launch_is_a_deliberate_request_for_the_cockpit() {
        assert!(should_front_on_second_launch(Some(STARTUP_GRACE)));
        assert!(should_front_on_second_launch(Some(
            STARTUP_GRACE + Duration::from_secs(1)
        )));
        assert!(should_front_on_second_launch(Some(Duration::from_secs(
            60 * 60
        ))));
    }

    #[test]
    fn an_unrecorded_start_time_takes_the_quiet_branch() {
        assert!(!should_front_on_second_launch(None));
    }

    #[test]
    fn the_grace_covers_the_observed_login_race_with_headroom() {
        // Guards the threshold itself: shrinking it below the observed 15 s gap
        // would reintroduce the login-time window pop.
        assert!(STARTUP_GRACE > Duration::from_secs(15));
    }
}
