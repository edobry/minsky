// Mouse back/forward (X1/X2) → cockpit history navigation (mt#3570).
//
// WHY THIS IS NATIVE AND NOT A DOM LISTENER
//   mt#3535 first shipped this as a tray-only init script listening for
//   `mousedown` with `event.button` 3/4. That code can never run on macOS.
//   Measured on the principal's MX Master 3 with a local NSEvent monitor:
//   the thumb buttons arrive as `NSEventTypeSwipe`, and `otherMouseDown`
//   NEVER fires -- yet `otherMouseDown` is the only type WKWebView converts
//   into a DOM `mousedown`. Upstream bug: tauri-apps/tauri#10936 (OPEN since
//   2024-09-09), whose reproduction is literally
//   `window.addEventListener("mousedown", console.log)` logging nothing on
//   macOS while working on Windows and Linux.
//
//   Chrome/Safari/iTerm handle these buttons because they service the swipe /
//   HID-consumer paths themselves. A Tauri app gets nothing unless it does the
//   same, which is what this module does.
//
// THE THREE DELIVERY PATHS
//   macOS hands X1/X2 to an app in one of three shapes depending on the device
//   and its driver. All three are handled here; only the third would ever have
//   reached the DOM.
//
//     1. HID AC_Back / AC_Forward consumer codes -- e.g. the MX Master line:
//        `NSEventTypeSwipe`, direction in `deltaX` (+1.0 back, -1.0 forward).
//     2. `NX_SUBTYPE_AUX_MOUSE_BUTTONS`: `NSEventTypeSystemDefined` subtype 7,
//        with `data1` carrying `1 << buttonNumber` and `data2 != 0` on press.
//     3. Generic HID mouse buttons: `NSEventTypeOtherMouseDown`, `buttonNumber`
//        3 (back) / 4 (forward).
//
//   The +1.0-is-back mapping was calibrated against the real device (22
//   BACK-button presses, 22 x deltaX=+1.0, zero negative), not assumed from the
//   upstream table -- it also matches AppKit's swipe-right-goes-back convention.
//
// WHY A *LOCAL* MONITOR
//   `addLocalMonitorForEventsMatchingMask:` runs inside `-[NSApplication
//   sendEvent:]`, before the responder chain, so returning null SWALLOWS the
//   event -- which is what stops the synthetic scroll some drivers emit
//   alongside Swipe from reaching the webview. It needs no Accessibility
//   permission. A *global* monitor is the wrong tool and actively misleads: it
//   observes events routed to OTHER apps, so it reports nothing for the app
//   with focus (this cost a wrong diagnosis before the local monitor was tried).
//
// NAVIGATION SEAM
//   Navigation goes through `menu::eval_history_nav` -- a Rust->webview `eval`,
//   the ADR-023 native->SPA seam the History menu items already use. The
//   upstream workaround in tauri#10936 emits a Tauri event for a JS `listen()`
//   handler; that shape does NOT apply here, because the cockpit SPA is an
//   untrusted external-URL webview with no IPC bridge.

#[cfg(target_os = "macos")]
pub(crate) fn install(app: &tauri::AppHandle) {
    use std::ptr::NonNull;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use block2::RcBlock;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventType};

    /// `data1` bits for the aux-mouse-button path (`1 << buttonNumber`).
    /// Matched EXACTLY, never by truthiness: the MX Master 3 also emits this
    /// subtype with `data1 == 1` (bit 0) for an unrelated control, which a
    /// `data1 != 0` test would misread as a back-button press.
    const X1_BACK_BIT: isize = 1 << 3;
    const X2_FORWARD_BIT: isize = 1 << 4;

    /// Swipe phase events carry `deltaX == 0.0`; only a decisive deflection
    /// counts as a press.
    const SWIPE_DEADZONE: f64 = 0.5;

    /// One physical press can surface across several phase events, and some
    /// drivers repeat. Collapse a burst into a single navigation.
    const DEDUPE_WINDOW: Duration = Duration::from_millis(200);

    let mask = NSEventMask::Swipe
        | NSEventMask::OtherMouseDown
        | NSEventMask::OtherMouseUp
        | NSEventMask::SystemDefined;

    let app = app.clone();
    let last_fired: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));

    let block = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        // SAFETY: AppKit hands the monitor a live, non-null NSEvent that
        // outlives this callback.
        let ev = unsafe { event.as_ref() };

        // `Some(true)` = forward, `Some(false)` = back, `None` = not ours.
        let direction: Option<bool> = match ev.r#type() {
            // A two-finger TRACKPAD page-swipe also lands here, and that is not
            // separable (PR #2547 R1). Measured on this machine: both the thumb
            // buttons and a trackpad swipe produce `deltaX = +/-1.0` with a
            // began->ended phase pair and no fractional deltas -- AppKit
            // deliberately normalizes both input sources into one "swipe"
            // abstraction, so there is no field left to discriminate on.
            //
            // Accepted rather than worked around: a trackpad page-swipe
            // navigating cockpit history is the platform-conventional behavior,
            // and swallowing it costs nothing, because horizontal SCROLLING is
            // `NSEventTypeScrollWheel` -- a different type this monitor never
            // sees. Nothing else in the tray consumes swipes: the webview's own
            // `allowsBackForwardNavigationGestures` is off (never set), so there
            // is no competing handler to double-navigate.
            NSEventType::Swipe => {
                let dx = ev.deltaX();
                if dx > SWIPE_DEADZONE {
                    Some(false)
                } else if dx < -SWIPE_DEADZONE {
                    Some(true)
                } else {
                    None
                }
            }
            NSEventType::SystemDefined => {
                // Subtype 7 == NX_SUBTYPE_AUX_MOUSE_BUTTONS.
                if ev.subtype().0 == 7 && ev.data2() != 0 {
                    match ev.data1() {
                        X1_BACK_BIT => Some(false),
                        X2_FORWARD_BIT => Some(true),
                        _ => None,
                    }
                } else {
                    None
                }
            }
            NSEventType::OtherMouseDown => match ev.buttonNumber() {
                3 => Some(false),
                4 => Some(true),
                _ => None,
            },
            // Swallow the matching release so it can't reach the webview as a
            // stray middle-click, but never navigate on it.
            NSEventType::OtherMouseUp => {
                if matches!(ev.buttonNumber(), 3 | 4) {
                    return std::ptr::null_mut();
                }
                None
            }
            _ => None,
        };

        let Some(forward) = direction else {
            return event.as_ptr();
        };

        // Debounce, then navigate. The event is swallowed either way: a
        // suppressed repeat must not fall through to the webview.
        let now = Instant::now();
        let mut guard = match last_fired.lock() {
            Ok(g) => g,
            // A poisoned lock would otherwise panic inside an AppKit callback.
            Err(poisoned) => poisoned.into_inner(),
        };
        if guard.map_or(true, |t| now.duration_since(t) >= DEDUPE_WINDOW) {
            *guard = Some(now);
            drop(guard);
            // Mouse presses navigate regardless of what holds keyboard focus:
            // unlike Cmd+[ / Cmd+], a thumb-button press is never a text-editing
            // keystroke, so the focused-editable carve-out does not apply.
            crate::menu::eval_history_nav(&app, forward, false);
        }
        std::ptr::null_mut()
    });

    // SAFETY: `mask` and `block` are valid; the returned token is intentionally
    // leaked below so the monitor lives for the whole process.
    let registration =
        unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &block) };
    if registration.is_none() {
        eprintln!("[cockpit-tray] mouse back/forward monitor was not installed");
    }
    // The monitor must outlive this function for the life of the app; there is
    // no teardown path (the app owns it until exit).
    std::mem::forget(block);
    std::mem::forget(registration);
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn install(_app: &tauri::AppHandle) {
    // The tray app is macOS-only today. On other platforms WKWebView is not the
    // webview and the DOM path works, so no native monitor is needed.
}
