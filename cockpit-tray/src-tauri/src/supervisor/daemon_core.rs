//! Daemon-agnostic supervision core (mt#3990).
//!
//! ADR-038 §Question 3 asks the tray to supervise a REGISTRY of named daemons
//! rather than the one hardcoded cockpit daemon. Reading `supervisor.rs` at
//! mt#3815's implementation entry established that this is not a
//! parameterization of an existing generic loop, because no generic loop
//! exists: `Sup` and `run_supervisor` interleave supervision with cockpit
//! policy. This module is the supervision half, separated out so a second
//! daemon can be expressed without editing it.
//!
//! **What belongs here:** logic that would be identical for any supervised
//! local daemon — the spawn/adopt/conflict decision, respawn throttling, the
//! sustained-outage takeover rule, and the watchdog counters those read.
//!
//! **What does NOT belong here:** anything that knows it is supervising the
//! COCKPIT. The three that most easily leak in, and where they live instead:
//! the bundle rebuild and source-staleness adoption (`supervisor.rs`), the
//! `db` health field (`supervisor.rs`, since only the cockpit's `/api/health`
//! has one), and the user-visible strings (passed in as [`DaemonLabels`]).
//!
//! Success criterion 1 of mt#3990 is a grep over this module for those
//! cockpit-specific symbols returning zero hits.

use std::time::{Duration, Instant};

// ---------------------------------------------------------------------------
// Generic supervision constants.
//
// `DB_DEGRADED_POLL_THRESHOLD` is deliberately NOT here — it counts polls of a
// health field only the cockpit daemon publishes, so it stays with the cockpit
// policy layer.
// ---------------------------------------------------------------------------

/// How often the supervisor polls a supervised daemon's health endpoint.
pub(crate) const POLL_INTERVAL: Duration = Duration::from_secs(5);

/// Minimum gap between successive respawns of a crashed daemon. Mirrors the
/// launchd plist's `ThrottleInterval: 5` so a crash-loop doesn't spawn-storm.
pub(crate) const RESPAWN_THROTTLE: Duration = Duration::from_secs(5);

// ---------------------------------------------------------------------------
// Self-health watchdog constants (mt#2578).
//
// Calibrated per CLAUDE.md §MCP disconnect cadence: the session threshold is
// >1 eligible disconnect per MCP connection, daily >3 in 24h.  The watchdog
// intentionally uses a tighter window / lower count because the 2026-06-27
// incident hit 49,650 launchd restarts before any alert fired — early warning
// is the explicit design goal.
// ---------------------------------------------------------------------------

/// Rolling window for daemon restart-storm detection.
pub(crate) const RESTART_STORM_WINDOW: Duration = Duration::from_secs(600); // 10 min

/// Daemon-crash restarts within RESTART_STORM_WINDOW that trigger a principal alert.
pub(crate) const RESTART_STORM_THRESHOLD: usize = 3;

/// Consecutive health polls returning HTTP failure while the daemon child is
/// alive (or an adopted daemon is expected) but the endpoint is unresponsive. This
/// targets the unhealthy-but-not-exiting case (slow start, persistent hang, adopted
/// daemon silently stopped) — distinct from the restart-storm path which handles
/// the crash-and-exit case. At 5s/poll → 12 polls ≈ 1 min.
pub(crate) const HTTP_FAILURE_POLL_THRESHOLD: u32 = 12;

/// mt#2786: consecutive failed polls with NO child of ours before the supervisor
/// TAKES OVER a dead adopted daemon (spawns its own). 2× the alert threshold
/// (≈ 2 min at 5s/poll): the alert fires first, and an operator mid-manual-restart
/// has a comfortable window before the tray steps in — plus the port-free check
/// below, which is the real operator-race guard.
pub(crate) const ADOPTED_TAKEOVER_POLL_THRESHOLD: u32 = HTTP_FAILURE_POLL_THRESHOLD * 2;

/// Minimum gap between repeated toasts for the SAME ACTIVE condition.
/// Resets when the condition clears so the NEXT episode re-alerts immediately.
pub(crate) const ALERT_COOLDOWN: Duration = Duration::from_secs(900); // 15 min

// ---------------------------------------------------------------------------
// The per-daemon seam.
// ---------------------------------------------------------------------------

/// The user-visible strings a supervised daemon contributes to the tray.
///
/// This is the seam that lets the supervision logic below run for any daemon:
/// every string it would otherwise hardcode arrives through here. Registering a
/// second daemon means constructing a second value of this type, not editing
/// this module — which is what mt#3990's fourth success criterion checks, by
/// constructing exactly such a value for a fictitious daemon and letting the
/// compiler judge whether the surface is sufficient.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DaemonLabels {
    /// Human name used in alert prose, e.g. `"Cockpit"`.
    pub(crate) display_name: &'static str,
    /// Status line while the daemon is healthy.
    pub(crate) running: &'static str,
    /// Status line while no daemon is running.
    pub(crate) stopped: &'static str,
    /// Status line while a spawn is in flight.
    pub(crate) starting: &'static str,
    /// Where an operator should look when the daemon stops answering. Named in
    /// the sustained-outage alert so the toast is actionable.
    pub(crate) stderr_log_hint: &'static str,
}

// ---------------------------------------------------------------------------
// Pure logic (unit-tested without the Tauri runtime — mt#2226).
// ---------------------------------------------------------------------------

/// What to do for a port that may or may not already be serving our daemon.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DaemonAction {
    /// Our health endpoint answers — monitor the existing daemon, don't spawn.
    Adopt,
    /// Nothing is listening — safe to spawn.
    Spawn,
    /// Something is listening but it's not our daemon — don't spawn, surface it.
    Conflict,
}

/// Map a health-poll result to the status label.
///
/// **Currently has no production caller, and did not have one before mt#3990
/// either** — the live poll loop pushes `LABEL_*` directly at each branch, and
/// this function's only callers have always been tests. It is kept (rather than
/// deleted as dead code) because it is the status-rendering half of the seam
/// mt#3815's registry needs: a registry entry renders its own status from its
/// own `DaemonLabels` rather than from a branch that hardcodes one daemon's
/// constants. If mt#3815 lands without using it, delete it there.
#[allow(dead_code)]
pub(crate) fn status_label(healthy: bool, labels: &DaemonLabels) -> &'static str {
    if healthy {
        labels.running
    } else {
        labels.stopped
    }
}

/// Decide what to do at startup / on an explicit Start, given whether our
/// health endpoint answers and whether *anything* is listening on the port.
/// Health-OK always wins (it's the strongest signal it's our daemon), even if
/// the port also shows a listener.
pub(crate) fn decide_action(health_ok: bool, port_in_use: bool) -> DaemonAction {
    if health_ok {
        DaemonAction::Adopt
    } else if port_in_use {
        DaemonAction::Conflict
    } else {
        DaemonAction::Spawn
    }
}

/// True when enough time has elapsed since the last spawn to respawn again.
pub(crate) fn throttle_ok(last_spawn: Option<Instant>, now: Instant, min: Duration) -> bool {
    match last_spawn {
        Some(t) => now.duration_since(t) >= min,
        None => true,
    }
}

/// mt#2786: whether the supervisor should take over after an adopted (or
/// never-spawned) daemon has been unresponsive for a sustained window. The
/// original design NEVER respawned over an adopted daemon ("don't fight an
/// operator restarting it manually") — which left the cockpit down
/// indefinitely once an adopted daemon died (observed 2026-07-13: 9+ min dead
/// port, manual restart required). Takeover requires ALL of:
/// - the outage is sustained past ADOPTED_TAKEOVER_POLL_THRESHOLD (the 1-min
///   alert has already fired by then), AND
/// - the port is FREE — an operator mid-restart (or any replacement daemon)
///   holds the port, so this preserves the original conservatism, AND
/// - the respawn throttle permits.
pub(crate) fn should_takeover_adopted(
    consecutive_http_failed: u32,
    port_held: bool,
    throttle_ok: bool,
) -> bool {
    consecutive_http_failed > ADOPTED_TAKEOVER_POLL_THRESHOLD && !port_held && throttle_ok
}

// ---------------------------------------------------------------------------
// mt#2794: health-down/no-child poll arm, extracted for testability.
//
// The live `Some(Err(_)) | None` poll arm (in `run_supervisor`) needs an
// `&AppHandle` and a live `Sup` to actually spawn a daemon, toast a
// notification, or push a status/uptime label. None of that is available in
// a `cargo test` without a Tauri runtime. `handle_health_down_no_child`
// carries the ARM'S DECISION LOGIC (the mt#2786 takeover branch + its PR
// #1927 R1 pre-spawn recheck) without touching any of that: the two seams a
// test controls are `port_in_use` (stubbed port checks) and `effect`
// (records which live operation the arm would have performed instead of
// performing it). `NoChildCounters` carries the plain-data slice of `Sup`
// this arm reads/writes.
// ---------------------------------------------------------------------------

/// Watchdog counters the health-down/no-child poll arm reads and mutates,
/// pulled out of `Sup` into an owned value. `handle_health_down_no_child`
/// takes this instead of `&mut Sup` directly: the live call site also needs
/// a SEPARATE `&mut Sup` borrow inside its `effect` closure (for
/// `do_spawn` / `set_status` / `clear_uptime`), and Rust doesn't allow two
/// live mutable borrows of the same value at once. Callers move the
/// relevant fields out with `take_from` and copy them back with
/// `write_back_to` after the call; `last_spawn` is read-only here — the
/// real `do_spawn`, invoked through the `Spawn` effect, updates
/// `Sup::last_spawn` directly on its own `&mut Sup`.
///
/// The `take_from` / `write_back_to` conversions live with `Sup` in the
/// cockpit policy layer, not here: this struct knows nothing about what it
/// was taken from.
pub(crate) struct NoChildCounters {
    pub(crate) consecutive_http_failed: u32,
    pub(crate) last_http_alert: Option<Instant>,
    pub(crate) last_spawn: Option<Instant>,
    pub(crate) restart_timestamps: Vec<Instant>,
    pub(crate) last_process_started_at_ms: Option<u64>,
}

/// A live effect `handle_health_down_no_child` asks its caller to perform.
/// Bundled into one enum (rather than four separate closures) so the call
/// site needs only ONE `FnMut` capturing `&mut Sup` / `&AppHandle` — Rust
/// doesn't allow several closures to each independently capture the same
/// `&mut` binding.
pub(crate) enum NoChildEffect {
    /// Fire the sustained-HTTP-failure toast with this message. Owns the
    /// String (PR #1936 R1) so the effect carries its message without
    /// borrowing a callee-local.
    Notify(String),
    /// mt#2786 takeover: spawn a new daemon (`do_spawn` in the live loop).
    Spawn,
    /// Push this label to the status line.
    SetStatus(&'static str),
    /// Clear the uptime line (no daemon running).
    ClearUptime,
}

/// Body of the poll loop's `Some(Err(_)) | None` arm: no child of ours
/// (adopted daemon down, or never spawned). Split out (mt#2794, a PR #1927
/// follow-up) so the mt#2786 takeover branch is testable without a live
/// Tokio loop — `port_in_use` and `effect` are the seams a test stubs;
/// `counters` is the plain-data slice of `Sup` this arm touches.
///
/// `port_in_use` may be called TWICE in one invocation: once for the
/// takeover gate, once for the PR #1927 R1 pre-spawn recheck. A caller can
/// return a different result per call to model the port being bound in the
/// gap between the two checks.
///
/// Two time parameters (PR #1936 R1): `poll_now` is the tick timestamp used
/// for alert-cooldown and restart-storm bookkeeping (as in the original
/// inline arm), while `now` is a FRESH instant used only for the
/// respawn-throttle check — the original arm called `Instant::now()` inline
/// there, and reusing the earlier `poll_now` would silently shorten the
/// throttle window by the tick's processing time.
///
/// Behavior-preserving versus the original inline arm, with one in-scope
/// fix (PR #1927 R2 non-blocking): the aborted-takeover path now also
/// emits `ClearUptime`, so an aborted takeover no longer leaves a stale
/// uptime line visible for one more poll cycle.
///
/// mt#3990 made the user-visible strings arrive via `labels` instead of
/// reading cockpit `LABEL_*` constants directly. For the cockpit daemon the
/// emitted text is byte-identical to what the constants produced.
#[allow(clippy::too_many_arguments)]
pub(crate) fn handle_health_down_no_child(
    counters: &mut NoChildCounters,
    poll_now: Instant,
    now: Instant,
    // The supervised port. Used only to NAME the port in the takeover logs —
    // the availability answer itself comes from the `port_in_use` seam below,
    // which is what keeps this function testable without a live socket.
    port: u16,
    labels: &DaemonLabels,
    mut port_in_use: impl FnMut() -> bool,
    mut effect: impl FnMut(NoChildEffect),
) {
    // Don't IMMEDIATELY spawn over an adopted daemon — but see the mt#2786
    // takeover below. Apply the same sustained-HTTP-failure alert here: an
    // expected adopted daemon that stops responding is an alert-worthy
    // condition.
    if counters.consecutive_http_failed > HTTP_FAILURE_POLL_THRESHOLD {
        let cooldown_elapsed = counters
            .last_http_alert
            .map(|t| poll_now.duration_since(t) >= ALERT_COOLDOWN)
            .unwrap_or(true);
        if cooldown_elapsed {
            let sustained_secs = counters.consecutive_http_failed as u64 * POLL_INTERVAL.as_secs();
            let reason = format!(
                "{} health endpoint has been unreachable for {sustained_secs}s — \
                 daemon may be down. Check logs: {}",
                labels.display_name, labels.stderr_log_hint,
            );
            eprintln!(
                "[watchdog] sustained HTTP-failure (no child) alert: {}",
                reason
            );
            effect(NoChildEffect::Notify(reason));
            counters.last_http_alert = Some(poll_now);
        }
    }

    // mt#2786: takeover-respawn. Once the outage is sustained (2× the alert
    // threshold) and nobody holds the port (an operator's replacement
    // daemon would), convert from adopted to spawned supervision instead of
    // staying "stopped" forever. Counts toward restart-storm accounting so
    // a flapping takeover still alerts.
    let port_held = port_in_use();
    if should_takeover_adopted(
        counters.consecutive_http_failed,
        port_held,
        throttle_ok(counters.last_spawn, now, RESPAWN_THROTTLE),
    ) {
        // Final pre-spawn recheck (PR #1927 R1): shrink the race between the
        // poll-time port check and our spawn — an operator's replacement
        // daemon may have bound the port in the gap. If so, stand down; the
        // next poll adopts it via the healthy path.
        if port_in_use() {
            eprintln!(
                "[watchdog] takeover aborted — port {port} was bound between check and spawn (operator restart in progress?)"
            );
            effect(NoChildEffect::SetStatus(labels.starting));
            // PR #1927 R2 non-blocking (closed by mt#2794): the aborted
            // takeover leaves no daemon running — clear the uptime line
            // rather than leaving a stale entry visible for one more poll
            // cycle.
            effect(NoChildEffect::ClearUptime);
        } else {
            let sustained_secs = counters.consecutive_http_failed as u64 * POLL_INTERVAL.as_secs();
            eprintln!(
                "[watchdog] adopted daemon gone for {sustained_secs}s and port {port} is free — taking over supervision (mt#2786)"
            );
            counters.consecutive_http_failed = 0;
            counters.last_http_alert = None;
            counters.restart_timestamps.push(poll_now);
            counters.last_process_started_at_ms = None;
            effect(NoChildEffect::Spawn);
        }
    } else {
        effect(NoChildEffect::SetStatus(labels.stopped));
        effect(NoChildEffect::ClearUptime);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Labels for a daemon that does not exist, used to prove the logic below
    /// reads its strings from the seam rather than from anything cockpit-shaped.
    const TEST_LABELS: DaemonLabels = DaemonLabels {
        display_name: "Testd",
        running: "Testd: running",
        stopped: "Testd: stopped",
        starting: "Testd: starting...",
        stderr_log_hint: "/tmp/testd-stderr.log",
    };

    /// A port for the seam-driven cases below. The value is irrelevant to the
    /// logic — `port_in_use` is stubbed — it only appears in log text.
    const TEST_PORT: u16 = 4317;

    // mt#2786 — takeover-respawn decision for a dead adopted daemon.
    #[test]
    fn takeover_fires_when_sustained_port_free_and_throttle_ok() {
        assert!(should_takeover_adopted(
            ADOPTED_TAKEOVER_POLL_THRESHOLD + 1,
            false,
            true
        ));
    }

    #[test]
    fn takeover_waits_below_the_sustained_threshold() {
        // At the alert threshold (half the takeover threshold) we alert but do NOT spawn.
        assert!(!should_takeover_adopted(
            HTTP_FAILURE_POLL_THRESHOLD + 1,
            false,
            true
        ));
        assert!(!should_takeover_adopted(
            ADOPTED_TAKEOVER_POLL_THRESHOLD,
            false,
            true
        ));
    }

    #[test]
    fn takeover_never_fights_a_port_holder() {
        // An operator's replacement daemon (or anything else) holding the port
        // suppresses takeover no matter how long the outage.
        assert!(!should_takeover_adopted(
            ADOPTED_TAKEOVER_POLL_THRESHOLD * 10,
            true,
            true
        ));
    }

    #[test]
    fn takeover_respects_the_respawn_throttle() {
        assert!(!should_takeover_adopted(
            ADOPTED_TAKEOVER_POLL_THRESHOLD + 1,
            false,
            false
        ));
    }

    // --- mt#2794: `handle_health_down_no_child` integration-style coverage
    // of the mt#2786 takeover branch, wired through the extracted seam
    // function instead of a live Tokio poll loop. ---

    #[derive(Default)]
    struct NoChildLog {
        notifies: Vec<String>,
        spawn_calls: u32,
        status_calls: Vec<&'static str>,
        clear_uptime_calls: u32,
    }

    fn base_counters(consecutive_http_failed: u32) -> NoChildCounters {
        NoChildCounters {
            consecutive_http_failed,
            last_http_alert: None,
            last_spawn: None,
            restart_timestamps: Vec::new(),
            last_process_started_at_ms: Some(42),
        }
    }

    /// Drive `handle_health_down_no_child` with stubbed `port_in_use`
    /// results (consumed in call order) and record every effect it asks
    /// for, instead of performing any live AppHandle/process operation.
    fn run_no_child_arm(
        counters: &mut NoChildCounters,
        poll_now: Instant,
        mut port_results: std::collections::VecDeque<bool>,
    ) -> NoChildLog {
        let mut log = NoChildLog::default();
        handle_health_down_no_child(
            counters,
            poll_now,
            Instant::now(),
            TEST_PORT,
            &TEST_LABELS,
            || {
                port_results
                    .pop_front()
                    .expect("unexpected extra port_in_use() call")
            },
            |eff| match eff {
                NoChildEffect::Notify(reason) => log.notifies.push(reason.to_string()),
                NoChildEffect::Spawn => log.spawn_calls += 1,
                NoChildEffect::SetStatus(label) => log.status_calls.push(label),
                NoChildEffect::ClearUptime => log.clear_uptime_calls += 1,
            },
        );
        log
    }

    // Scenario 1: sustained outage + free port -> takeover invokes the spawn
    // seam, resets the watchdog counters, and pushes a restart timestamp.
    #[test]
    fn no_child_sustained_outage_and_free_port_takes_over() {
        let poll_now = Instant::now();
        let mut counters = base_counters(ADOPTED_TAKEOVER_POLL_THRESHOLD + 1);
        // Two port_in_use calls expected: the takeover gate, then the
        // pre-spawn recheck — both report the port free.
        let log = run_no_child_arm(
            &mut counters,
            poll_now,
            std::collections::VecDeque::from([false, false]),
        );

        assert_eq!(log.spawn_calls, 1, "takeover should invoke the spawn seam");
        assert_eq!(log.notifies.len(), 1, "sustained outage should also alert");
        assert!(
            log.status_calls.is_empty(),
            "the success path doesn't set status directly (do_spawn does that live)"
        );
        assert_eq!(
            log.clear_uptime_calls, 0,
            "the success path doesn't clear uptime directly"
        );

        assert_eq!(
            counters.consecutive_http_failed, 0,
            "counter resets on takeover"
        );
        assert_eq!(
            counters.last_http_alert, None,
            "alert cooldown resets on takeover"
        );
        assert_eq!(
            counters.restart_timestamps,
            vec![poll_now],
            "takeover pushes a restart timestamp"
        );
        assert_eq!(
            counters.last_process_started_at_ms, None,
            "takeover clears the adopted-restart baseline"
        );
    }

    // Scenario 2: pre-spawn recheck bail-out when the port becomes bound
    // between the takeover-gate check and the spawn (PR #1927 R1). Also
    // covers the PR #1927 R2 non-blocking fix folded into this task: the
    // aborted path must clear the uptime line.
    #[test]
    fn no_child_aborts_takeover_when_port_binds_between_check_and_spawn() {
        let poll_now = Instant::now();
        let mut counters = base_counters(ADOPTED_TAKEOVER_POLL_THRESHOLD + 1);
        // Gate check sees the port free; the pre-spawn recheck sees it
        // bound — an operator's replacement daemon won the race.
        let log = run_no_child_arm(
            &mut counters,
            poll_now,
            std::collections::VecDeque::from([false, true]),
        );

        assert_eq!(log.spawn_calls, 0, "an aborted takeover must not spawn");
        assert_eq!(
            log.notifies.len(),
            1,
            "the sustained-failure alert still fires"
        );
        assert_eq!(log.status_calls, vec![TEST_LABELS.starting]);
        assert_eq!(
            log.clear_uptime_calls, 1,
            "PR #1927 R2: the aborted path must clear the stale uptime line"
        );

        // Counters are untouched by an aborted takeover — it retries next poll.
        assert_eq!(
            counters.consecutive_http_failed,
            ADOPTED_TAKEOVER_POLL_THRESHOLD + 1
        );
        assert!(counters.restart_timestamps.is_empty());
    }

    // Scenario 3: alert fires at the 1-minute threshold without taking over.
    #[test]
    fn no_child_alerts_at_threshold_without_taking_over() {
        let poll_now = Instant::now();
        // Above the alert threshold but below the 2x takeover threshold.
        let mut counters = base_counters(HTTP_FAILURE_POLL_THRESHOLD + 1);
        let log = run_no_child_arm(
            &mut counters,
            poll_now,
            std::collections::VecDeque::from([false]),
        );

        assert_eq!(log.notifies.len(), 1, "sustained-failure alert should fire");
        assert_eq!(
            log.spawn_calls, 0,
            "must not take over below the takeover threshold"
        );
        assert_eq!(log.status_calls, vec![TEST_LABELS.stopped]);
        assert_eq!(log.clear_uptime_calls, 1);
        assert_eq!(counters.last_http_alert, Some(poll_now));
    }

    // Scenario 4: port held throughout -> no takeover ever, regardless of
    // how long the outage has been sustained (mt#2786's core conservatism).
    #[test]
    fn no_child_never_takes_over_while_port_is_held() {
        let poll_now = Instant::now();
        let mut counters = base_counters(ADOPTED_TAKEOVER_POLL_THRESHOLD * 10);
        let log = run_no_child_arm(
            &mut counters,
            poll_now,
            std::collections::VecDeque::from([true]),
        );

        assert_eq!(log.spawn_calls, 0, "a held port must never be fought");
        assert_eq!(log.status_calls, vec![TEST_LABELS.stopped]);
        assert_eq!(log.clear_uptime_calls, 1);
        assert_eq!(
            log.notifies.len(),
            1,
            "still alerts even though it won't take over"
        );
    }

    /// mt#3990: the alert prose is built from the seam, not from anything
    /// cockpit-shaped. Asserted on a daemon that does not exist, so a
    /// regression that re-hardcodes "Cockpit" fails here rather than shipping.
    #[test]
    fn the_sustained_outage_alert_names_the_supervised_daemon() {
        let mut counters = base_counters(HTTP_FAILURE_POLL_THRESHOLD + 1);
        let log = run_no_child_arm(
            &mut counters,
            Instant::now(),
            std::collections::VecDeque::from([true]),
        );

        let reason = log.notifies.first().expect("alert should have fired");
        assert!(
            reason.starts_with("Testd health endpoint has been unreachable"),
            "alert should name the supervised daemon, got: {reason}"
        );
        assert!(
            reason.ends_with("/tmp/testd-stderr.log"),
            "alert should point at the daemon's own log, got: {reason}"
        );
        assert!(!reason.contains("Cockpit"));
    }

    #[test]
    fn status_label_maps_health_to_text() {
        assert_eq!(status_label(true, &TEST_LABELS), TEST_LABELS.running);
        assert_eq!(status_label(false, &TEST_LABELS), TEST_LABELS.stopped);
    }

    #[test]
    fn decide_action_adopts_when_healthy() {
        // Health-OK wins regardless of the port-in-use signal.
        assert_eq!(decide_action(true, true), DaemonAction::Adopt);
        assert_eq!(decide_action(true, false), DaemonAction::Adopt);
    }

    #[test]
    fn decide_action_conflict_when_port_taken_but_unhealthy() {
        assert_eq!(decide_action(false, true), DaemonAction::Conflict);
    }

    #[test]
    fn decide_action_spawn_when_free() {
        assert_eq!(decide_action(false, false), DaemonAction::Spawn);
    }

    #[test]
    fn throttle_allows_first_spawn() {
        assert!(throttle_ok(None, Instant::now(), RESPAWN_THROTTLE));
    }

    #[test]
    fn throttle_blocks_within_window() {
        let now = Instant::now();
        assert!(!throttle_ok(Some(now), now, RESPAWN_THROTTLE));
    }

    #[test]
    fn throttle_allows_after_window() {
        let now = Instant::now();
        let long_ago = now
            .checked_sub(RESPAWN_THROTTLE + Duration::from_secs(1))
            .expect("instant arithmetic");
        assert!(throttle_ok(Some(long_ago), now, RESPAWN_THROTTLE));
    }
}
