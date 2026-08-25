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
//! **What belongs here:** logic and mechanism that would be identical for any
//! supervised local daemon — the spawn/adopt/conflict decision, respawn
//! throttling, the sustained-outage takeover rule, the watchdog counters those
//! read, and (since this module's second increment) the process-management
//! primitives they act through: PATH augmentation and program resolution, the
//! loopback-scoped port probes, SIGTERM of a pid or a process group, the
//! managed-child spawn, log-file opening and tailing, and the `ps`-derived
//! uptime arithmetic.
//!
//! **What does NOT belong here:** anything that knows it is supervising the
//! COCKPIT. The three that most easily leak in, and where they live instead:
//! the bundle rebuild and source-staleness adoption (`supervisor.rs`), the
//! `db` health field (`supervisor.rs`, since only the cockpit's `/api/health`
//! has one), and the user-visible strings (passed in as [`DaemonLabels`]).
//! The two seams that keep the mechanism half of the module honest are
//! [`DaemonLabels`] (every string) and [`DaemonSpawnSpec`] (every argument,
//! directory and log filename a spawn would otherwise hardcode).
//!
//! Success criterion 1 of mt#3990 is a grep over this module for those
//! cockpit-specific symbols returning zero hits.

use std::fs::{File, OpenOptions};
use std::io;
use std::net::{Ipv4Addr, TcpListener};
#[cfg(unix)]
use std::os::unix::process::CommandExt; // process_group
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

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

// ---------------------------------------------------------------------------
// Environment + program resolution.
//
// Everything below this point is MECHANISM rather than decision logic: it runs
// real processes and touches real sockets, so it is exercised live rather than
// unit-tested, except where a pure parsing/arithmetic half was split out (the
// `parse_*` functions, `augmented_path`, `format_duration`,
// `last_nonempty_capped`, `bind_error_means_in_use`, `lsof_port_args`).
// ---------------------------------------------------------------------------

fn home() -> String {
    std::env::var("HOME").unwrap_or_default()
}

/// Build a PATH that includes the common locations a GUI app (launched from
/// /Applications with a minimal PATH) won't otherwise have, so `minsky` / `bun`
/// / `lsof` resolve. Mirrors the launchd plist's PATH handling
/// (`src/cockpit/launchd.ts`). Existing entries are preserved and de-duped.
pub(crate) fn augmented_path(home: &str, existing: &str) -> String {
    let mut parts: Vec<String> = vec![
        format!("{home}/.bun/bin"),
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
        format!("{home}/.local/bin"),
        "/usr/bin".to_string(),
        "/bin".to_string(),
        "/usr/sbin".to_string(),
        "/sbin".to_string(),
    ];
    for p in existing.split(':') {
        if !p.is_empty() && !parts.iter().any(|x| x == p) {
            parts.push(p.to_string());
        }
    }
    parts.join(":")
}

/// `pub(crate)` since mt#3988: `main`'s setup needs the same augmented PATH the
/// supervisor uses in order to resolve the cockpit port before the tray builds.
pub(crate) fn path_env() -> String {
    augmented_path(&home(), &std::env::var("PATH").unwrap_or_default())
}

/// Find an executable by name on the given PATH string.
///
/// `pub(crate)` since mt#3988: `crate::port` resolves the SAME `bun` the daemon
/// is spawned with, so the config lookup and the spawn cannot come from
/// different toolchains.
pub(crate) fn resolve_program(name: &str, path: &str) -> Option<PathBuf> {
    for dir in path.split(':') {
        if dir.is_empty() {
            continue;
        }
        let cand = Path::new(dir).join(name);
        if is_executable(&cand) {
            return Some(cand);
        }
    }
    None
}

/// True when `p` is a regular file with at least one execute bit set.
#[cfg(unix)]
fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    p.is_file()
        && std::fs::metadata(p)
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(p: &Path) -> bool {
    p.is_file()
}

// ---------------------------------------------------------------------------
// Daemon log files.
//
// The DIRECTORY is shared by every supervised daemon; the FILENAMES within it
// are per-daemon and arrive from the caller (`DaemonSpawnSpec` for the spawn,
// an explicit argument for the tail).
// ---------------------------------------------------------------------------

fn log_dir() -> PathBuf {
    Path::new(&home()).join(".local/state/minsky/logs")
}

pub(crate) fn open_log(name: &str) -> io::Result<File> {
    let dir = log_dir();
    std::fs::create_dir_all(&dir)?;
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(name))
}

/// Extract the last non-empty line from a byte buffer, trimmed and capped for a
/// menu item. Pure (unit-tested); the bounded read happens in [`log_tail_last_line`].
pub(crate) fn last_nonempty_capped(bytes: &[u8]) -> Option<String> {
    let line = String::from_utf8_lossy(bytes)
        .lines()
        .rev()
        .map(|l| l.trim())
        .find(|l| !l.is_empty())?
        .to_string();
    const MAX: usize = 120;
    Some(if line.chars().count() > MAX {
        line.chars().take(MAX).collect::<String>() + "..."
    } else {
        line
    })
}

/// Last non-empty line of the named log file in the daemon log directory,
/// capped — used to summarize a restart/start failure in the status line
/// (mt#2299, criterion 5). Reads only the final ~8 KiB (seek from end) so a
/// large or flapping log can't block the supervisor loop on each crash within
/// the throttle window (reviewer R1 NB2).
///
/// Takes the filename rather than reading a hardcoded one (mt#3990): which log
/// a daemon writes is per-daemon, the bounded-tail mechanism is not.
pub(crate) fn log_tail_last_line(name: &str) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    const TAIL_BYTES: u64 = 8 * 1024;
    let mut file = File::open(log_dir().join(name)).ok()?;
    let len = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(len.saturating_sub(TAIL_BYTES)))
        .ok()?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).ok()?;
    // A partial first line in the window is harmless: we take the LAST non-empty
    // line, and the final line is always intact.
    last_nonempty_capped(&buf)
}

// ---------------------------------------------------------------------------
// Port probing.
// ---------------------------------------------------------------------------

fn lsof_bin(path: &str) -> PathBuf {
    resolve_program("lsof", path)
        .or_else(|| {
            ["/usr/sbin/lsof", "/usr/bin/lsof", "/sbin/lsof"]
                .iter()
                .map(PathBuf::from)
                .find(|p| p.is_file())
        })
        .unwrap_or_else(|| PathBuf::from("/usr/sbin/lsof"))
}

/// Parse the first PID from `lsof -ti` output (newline-separated PIDs).
fn parse_lsof_pid(output: &str) -> Option<u32> {
    output
        .lines()
        .filter_map(|l| l.trim().parse::<u32>().ok())
        .next()
}

/// Parse the first (pid, address) pair from `lsof -F pn` field output.
///
/// lsof's field format emits a process block (`p<pid>`) followed by one or more
/// file blocks, each carrying an fd (`f<n>`) and a name (`n<addr>`) line — the
/// `f` line arrives whether or not it was requested, which is why this matches
/// on prefixes rather than on position:
///
/// ```text
/// p42516
/// f6
/// n127.0.0.1:3737
/// ```
///
/// Takes the FIRST pid and the FIRST address after it, matching
/// `parse_lsof_pid`'s first-wins rule. A process listening on both loopback
/// families reports two `n` lines; either identifies the holder.
fn parse_lsof_holder(output: &str) -> Option<(u32, String)> {
    let mut pid = None;
    for line in output.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix('p') {
            if pid.is_none() {
                pid = rest.parse::<u32>().ok();
            }
        } else if let Some(addr) = line.strip_prefix('n') {
            if let Some(pid) = pid {
                return Some((pid, addr.to_string()));
            }
        }
    }
    None
}

/// The lsof arguments for the port-holder probe, scoped to LOOPBACK (mt#3785).
///
/// Split out so the scoping is unit-testable without running lsof. The address
/// qualifier is the whole point: `tcp:<port>` matches a listener on ANY
/// interface, which is how a Tailscale listener on the tailnet addresses came
/// back as the holder of the cockpit port.
///
/// `tcp@localhost:<port>` is deliberate, and specifically NOT
/// `tcp@127.0.0.1:<port>` (PR #2684 R1 asked why): lsof resolves `localhost`
/// through the resolver, which on a normal host yields BOTH loopback families,
/// so one qualifier covers `127.0.0.1` and `::1` while still excluding every
/// non-loopback address. Verified against a live IPv6-only listener — the
/// `localhost` form finds it, the `127.0.0.1` form returns nothing:
///
/// ```text
/// $ (nc -l ::1 39371 &) ; lsof -ti tcp@localhost:39371 -sTCP:LISTEN
/// 69274
/// $ lsof -ti tcp@127.0.0.1:39371 -sTCP:LISTEN
/// (exit 1, no output)
/// ```
///
/// Missing an IPv6-loopback holder would matter: `pid_on_port` feeds the kill
/// in the stop path, and "no holder found" there means an adopted daemon is
/// never stopped.
fn lsof_port_args(port: u16) -> [String; 3] {
    [
        "-ti".to_string(),
        format!("tcp@localhost:{port}"),
        "-sTCP:LISTEN".to_string(),
    ]
}

/// The PID of whatever is LISTENing on `port` **on loopback**, if any.
///
/// This is the IDENTIFICATION half of port detection: who holds it, so the tray
/// can label the conflict, evict a legacy launchd agent, or kill an adopted
/// daemon. The separate question — *is the address available to the daemon?* —
/// is `port_in_use` below, and it is deliberately answered a different way.
///
/// Loopback-scoped since mt#3785. Before that this ran `-ti tcp:<port>`, which
/// is interface-agnostic, so with any non-loopback listener on the supervised
/// port the probe returned MORE than one PID and `parse_lsof_pid` kept
/// whichever lsof printed first. Every caller acts on that PID — the stop path
/// SIGTERMs it — so the unscoped form could send a kill meant for the
/// supervised daemon to an unrelated process.
///
/// Independent re-implementation of `findPortHolder` in
/// `src/cockpit/port-recovery.ts` (mt#2629) — the TS side additionally
/// resolves the holder's command line for zombie-recognition and uses `-i
/// :<port>` instead of `-ti tcp@localhost:<port>`, but both filter to
/// LISTEN-state sockets only and both treat "no matching PID" as "port free".
/// The TS side is NOT yet loopback-scoped (tracked at mt#3787); it cannot make
/// the same wrong kill because `killZombie` only fires on a PID it recognizes
/// as its own prior instance. Not unified: the Rust supervisor must keep
/// working with no Minsky CLI/MCP process running at all. See
/// `contract/README.md` §2 for the documented semantics both implementations
/// share and the divergence this introduced.
pub(crate) fn pid_on_port(port: u16, path: &str) -> Option<u32> {
    let out = Command::new(lsof_bin(path))
        .args(lsof_port_args(port))
        .env("PATH", path)
        .output()
        .ok()?;
    parse_lsof_pid(&String::from_utf8_lossy(&out.stdout))
}

/// The PID **and the address it was found on** for whatever is LISTENing on
/// `port` on loopback (mt#3785, PR #2684 R2).
///
/// Same scope as `pid_on_port`; the extra field output costs a second lsof
/// invocation, which is why only the conflict REPORT uses it — that fires on a
/// status transition, not on the 5s poll. The hot paths that only need a PID to
/// act on keep using `pid_on_port`.
pub(crate) fn port_holder(port: u16, path: &str) -> Option<(u32, String)> {
    let out = Command::new(lsof_bin(path))
        .args([
            "-nP",
            "-a",
            "-i",
            &format!("tcp@localhost:{port}"),
            "-sTCP:LISTEN",
            "-F",
            "pn",
        ])
        .env("PATH", path)
        .output()
        .ok()?;
    parse_lsof_holder(&String::from_utf8_lossy(&out.stdout))
}

/// Whether `port` is unavailable to the daemon — the AVAILABILITY half of port
/// detection, which is a different question from "who holds it?" above.
///
/// Answered by attempting the bind the daemon itself would attempt, per ADR-014
/// §"Implementation notes and risks": *"Prefer attempting the daemon's own bind
/// and treating an `EADDRINUSE` on `:3737` as 'a daemon (or something) already
/// owns the port', combined with a health probe … to confirm it is our daemon
/// before adopting."* The supervisor's health probe is that health probe, and it
/// already targets `127.0.0.1` — so before mt#3785, adoption and conflict
/// detection disagreed about which address "the port" even meant.
///
/// The bind answers the operative question directly: the daemon binds loopback,
/// so a listener on a tailnet or LAN address does not take the address away from
/// it, and no amount of lsof filtering can be as faithful as trying the thing.
/// The residual time-of-check/time-of-use gap before the spawn is the one
/// ADR-014 already accepts and resolves by making the daemon's own startup bind
/// authoritative — the loser gets `EADDRINUSE` and falls back to adopt.
pub(crate) fn port_in_use(port: u16) -> bool {
    match TcpListener::bind((Ipv4Addr::LOCALHOST, port)) {
        Ok(_) => false,
        Err(e) if bind_error_means_in_use(&e) => true,
        Err(e) => {
            // Any OTHER bind failure is not evidence the port is taken, and
            // treating it as such would reproduce mt#3785's own bug: a
            // false "in use" puts the tray in Conflict and it never spawns
            // (PR #2684 R1). Fall back to ADR-014's authority instead -- let
            // the daemon's own bind decide -- and say so, since a probe
            // failing for an unexpected reason is worth seeing.
            eprintln!(
                "[cockpit-tray] bind probe on 127.0.0.1:{port} failed unexpectedly ({e}); \
                 treating the port as available and letting the daemon's own bind decide"
            );
            false
        }
    }
}

/// Whether a failed bind means the address is genuinely taken.
///
/// ONLY `EADDRINUSE`. Split out from `port_in_use` so the distinction is
/// unit-testable without provoking a real kernel error.
fn bind_error_means_in_use(err: &io::Error) -> bool {
    err.kind() == io::ErrorKind::AddrInUse
}

// ---------------------------------------------------------------------------
// Process control.
// ---------------------------------------------------------------------------

/// Process-group ids of the daemons WE spawned, keyed by a stable per-daemon
/// token. Shared so the quit / `RunEvent::Exit` path can tear them down
/// synchronously even if the supervisor thread doesn't get to process a
/// Shutdown command before the process exits.
///
/// Was a single `Option<u32>` until mt#3815, when the tray began supervising a
/// registry: one slot could only ever remember the last daemon spawned, so
/// quitting would have left the other one running. A `Vec` of pairs rather than
/// a map — the registry has two entries, and teardown iterates all of them
/// anyway.
///
/// The key is a `&'static str` rather than the policy layer's `DaemonId`
/// because this module does not know the registry exists; the caller passes its
/// own stable token (`DaemonId::slug`).
pub(crate) type SpawnedPgids = Arc<Mutex<Vec<(&'static str, u32)>>>;

/// Remember the process group of a daemon we just spawned, replacing any prior
/// entry for the same key (a respawn supersedes the group it replaced).
pub(crate) fn record_spawned(spawned: &SpawnedPgids, key: &'static str, pgid: u32) {
    if let Ok(mut g) = spawned.lock() {
        g.retain(|(k, _)| *k != key);
        g.push((key, pgid));
    }
}

/// Forget and return one daemon's process group — the stop path, which kills it
/// itself.
pub(crate) fn take_spawned(spawned: &SpawnedPgids, key: &str) -> Option<u32> {
    let mut g = spawned.lock().ok()?;
    let idx = g.iter().position(|(k, _)| *k == key)?;
    Some(g.remove(idx).1)
}

pub(crate) fn kill_pid(pid: u32) {
    let _ = Command::new("/bin/kill")
        .args(["-TERM", &pid.to_string()])
        .output();
}

/// Send SIGTERM to an entire process group (negative pid).
pub(crate) fn kill_group(pgid: u32) {
    let _ = Command::new("/bin/kill")
        .args(["-TERM", &format!("-{pgid}")])
        .output();
}

/// Everything [`spawn_daemon`] needs to start ONE supervised daemon.
///
/// This is the second of the module's two seams (the first being
/// [`DaemonLabels`]). Before mt#3990 the spawn hardcoded the cockpit's
/// program arguments and its two log filenames; every one of those now
/// arrives from the policy layer, so registering a second daemon means
/// constructing a second value of this type rather than editing the spawn.
pub(crate) struct DaemonSpawnSpec<'a> {
    /// The executable to run, already resolved to an absolute path.
    pub(crate) program: &'a Path,
    /// Its arguments, in order.
    pub(crate) args: &'a [String],
    /// Working directory for the child. The daemon's own repo/config detection
    /// runs here, so a GUI app launched from /Applications (cwd `/`) must not
    /// inherit its cwd (mt#2282).
    pub(crate) cwd: &'a Path,
    /// PATH handed to the child — the augmented one from [`path_env`], not the
    /// GUI app's minimal inherited PATH.
    pub(crate) path_env: &'a str,
    /// Filename within the daemon log directory that the child's stdout is
    /// appended to.
    pub(crate) stdout_log: &'a str,
    /// Filename within the daemon log directory that the child's stderr is
    /// appended to.
    pub(crate) stderr_log: &'a str,
    /// Extra environment variables for the child, beyond `PATH` (mt#3815).
    ///
    /// Empty for the cockpit. The MCP entry uses it to disable mt#3764's
    /// never-connected self-exit, which exists to reap an ABANDONED HTTP
    /// listener — a condition supervision replaces. See
    /// `registry::mcp_spawn_env` for the full argument.
    pub(crate) extra_env: &'a [(&'a str, &'a str)],
}

/// Spawn a supervised daemon as a managed child in its own process group, with
/// stdout/stderr appended to its log files. Returns the child and its pgid
/// (== child pid under `process_group(0)`).
pub(crate) fn spawn_daemon(spec: &DaemonSpawnSpec) -> io::Result<(Child, u32)> {
    let out = open_log(spec.stdout_log)?;
    let err = open_log(spec.stderr_log)?;
    let mut cmd = Command::new(spec.program);
    cmd.args(spec.args)
        .current_dir(spec.cwd)
        .env("PATH", spec.path_env)
        .envs(spec.extra_env.iter().copied())
        .stdin(Stdio::null())
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err));
    // New process group (pgid == child pid) so teardown can SIGTERM the whole
    // group. Unix-only; on other targets the child is spawned without a group.
    #[cfg(unix)]
    cmd.process_group(0);
    let child = cmd.spawn()?;
    let pid = child.id();
    Ok((child, pid))
}

/// Tear down EVERY daemon we spawned. Idempotent (the list is drained, so a
/// second call finds nothing). Called from `main()`'s `RunEvent::Exit` handler.
///
/// Iterating all of them is AT5: quitting the tray must stop both registered
/// daemons, not whichever one was spawned last.
pub(crate) fn teardown(spawned: &SpawnedPgids) {
    let groups: Vec<(&'static str, u32)> = match spawned.lock() {
        Ok(mut g) => std::mem::take(&mut *g),
        Err(_) => return,
    };
    for (key, pgid) in groups {
        eprintln!("[cockpit-tray] teardown: SIGTERM process group {pgid} ({key})");
        kill_group(pgid);
    }
}

// ---------------------------------------------------------------------------
// Uptime arithmetic.
// ---------------------------------------------------------------------------

/// Parse macOS `ps -o etime=` (`[[dd-]hh:]mm:ss`) into elapsed seconds. Pure.
fn parse_etime_to_secs(s: &str) -> Option<u64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let (days, hms) = match s.split_once('-') {
        Some((d, rest)) => (d.trim().parse::<u64>().ok()?, rest),
        None => (0u64, s),
    };
    let mut h = 0u64;
    let parts: Vec<&str> = hms.split(':').collect();
    let (m, sec) = match parts.as_slice() {
        [m, sec] => (m.parse::<u64>().ok()?, sec.parse::<u64>().ok()?),
        [hh, m, sec] => {
            h = hh.parse::<u64>().ok()?;
            (m.parse::<u64>().ok()?, sec.parse::<u64>().ok()?)
        }
        _ => return None,
    };
    Some(days * 86_400 + h * 3_600 + m * 60 + sec)
}

/// Wall-clock start time of the process on `pid`, derived from `ps -o etime=`
/// (elapsed) subtracted from now. Used for an ADOPTED daemon the tray didn't
/// spawn (so it has no `Instant`). `None` if `ps` fails or the pid is gone.
pub(crate) fn daemon_start_time(pid: u32) -> Option<SystemTime> {
    let out = Command::new("/bin/ps")
        .args(["-o", "etime=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let secs = parse_etime_to_secs(&String::from_utf8_lossy(&out.stdout))?;
    SystemTime::now().checked_sub(Duration::from_secs(secs))
}

// ---------------------------------------------------------------------------
// Swap-inclusive memory ceiling (mt#4105)
// ---------------------------------------------------------------------------

/// The ceiling a supervised daemon's swap-inclusive memory must stay under.
///
/// 2048 MB, matching `DEFAULT_MEMORY_CEILING_MB` (`src/mcp/orphan-exit.ts:339`) —
/// the in-process watcher's default. Both enforce the SAME quantity at the same
/// threshold; what differs is WHO runs the check, which is the entire point: a
/// process that has wedged its own event loop cannot be the thing that notices
/// it has wedged, so its `setInterval` watcher never fires (mt#4099 measured a
/// 48.2 GB `mcp start` with all of it armed and zero `kevent` samples).
pub(crate) const MEMORY_CEILING_BYTES: u64 = 2048 * 1024 * 1024;

/// Parse `phys_footprint: 15517760 B` out of `footprint -f bytes -p <pid>`.
///
/// `-f bytes` is what makes this a parser and not a unit converter — without it
/// `footprint` prints human units and the caller has to interpret `1.4G`.
/// Pure, so the shape agreement with `footprint(1)` is unit-testable.
pub(crate) fn parse_footprint_bytes(stdout: &str) -> Option<u64> {
    for line in stdout.lines() {
        let Some((label, rest)) = line.split_once(':') else {
            continue;
        };
        // `phys_footprint_peak` is a DIFFERENT quantity printed on an adjacent
        // line — a `contains` match would take whichever came first.
        if label.trim() != "phys_footprint" {
            continue;
        }
        let digits: String = rest
            .trim()
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        if digits.is_empty() {
            continue;
        }
        return digits.parse::<u64>().ok();
    }
    None
}

/// Sum `VmRSS` and `VmSwap` (both printed in kB) from `/proc/<pid>/status`.
///
/// Per `proc_pid_status(5)`, VmSwap is "Swapped-out virtual memory size by
/// anonymous private pages". RSS alone is the blind spot this task exists to
/// close: mt#4099's specimen read ~900 MB RSS against a 48.2 GB footprint.
///
/// **`VmRSS` is required; a missing `VmSwap` counts as zero swap, not as a
/// failed measurement.** This mirrors the TypeScript side verbatim
/// (`packages/shared/src/process-memory.ts:176-179`: "VmSwap has been present
/// since Linux 2.6.34; treat its absence as zero swap rather than as a failed
/// measurement, since VmRSS alone is still a real [measurement]").
///
/// Requiring both looks like the conservative choice and is the opposite of one
/// (PR #3045 R1). A kernel built without `CONFIG_SWAP` emits no `VmSwap` line at
/// all, so on that host every read would return `None`, every `None` is a
/// non-breach by [`breaches_ceiling`], and the ceiling would silently never fire
/// — a guardrail that is off rather than safe. The fail-safe direction is right
/// for a TRANSIENT failure and wrong for a STRUCTURAL absence.
pub(crate) fn parse_proc_status_bytes(contents: &str) -> Option<u64> {
    let mut rss_kb: Option<u64> = None;
    let mut swap_kb: Option<u64> = None;
    for line in contents.lines() {
        let Some((label, rest)) = line.split_once(':') else {
            continue;
        };
        let slot = match label.trim() {
            "VmRSS" => &mut rss_kb,
            "VmSwap" => &mut swap_kb,
            _ => continue,
        };
        *slot = rest.split_whitespace().next().and_then(|n| n.parse().ok());
    }
    Some((rss_kb? + swap_kb.unwrap_or(0)) * 1024)
}

/// Swap-inclusive memory for `pid`, or `None` when it could not be measured.
///
/// Mirrors [`daemon_start_time`]'s shape — a system binary, a pure parser, an
/// `Option` — and mirrors the TypeScript primitive's CHOICE of interface rather
/// than its code. `packages/shared/src/process-memory.ts` reaches the same two
/// quantities the same two ways, and records why a native call is not an option:
/// `task_info(TASK_VM_INFO)` "cannot read another process's without
/// `task_for_pid`, which requires root or the debugger entitlement on modern
/// macOS." A Rust crate binding the same call hits the same wall, and the crates
/// that avoid it report RSS — the blind spot. So the subprocess is not a
/// shortcut here; on macOS it is the only route to `phys_footprint` for a
/// foreign pid.
///
/// Cost measured 2026-08-16: 0.03s per call, against a 5s [`POLL_INTERVAL`].
pub(crate) fn daemon_memory_bytes(pid: u32) -> Option<u64> {
    if cfg!(target_os = "macos") {
        let out = Command::new("/usr/bin/footprint")
            .args(["-f", "bytes", "-p", &pid.to_string()])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        parse_footprint_bytes(&String::from_utf8_lossy(&out.stdout))
    } else {
        let contents = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
        parse_proc_status_bytes(&contents)
    }
}

/// Whether a reading breaches the ceiling.
///
/// **An unmeasurable process does NOT breach.** `None` means `footprint` failed,
/// the pid is gone, or `/proc` was unreadable — none of which is evidence the
/// daemon is oversized, and treating them as one would let a transient failure
/// SIGKILL a healthy daemon. The in-process watcher makes the same choice for
/// the same reason (`process-memory.ts` returns a discriminated union precisely
/// so "could not measure" is not representable as a number).
pub(crate) fn breaches_ceiling(measured: Option<u64>, ceiling: u64) -> bool {
    matches!(measured, Some(bytes) if bytes > ceiling)
}

/// SIGKILL, for a child that cannot be asked to leave.
///
/// [`kill_pid`] sends SIGTERM, which Node/Bun delivers to a JS handler — and
/// `src/commands/mcp/start-command.ts:2132-2134` registers exactly such a
/// handler. A wedged event loop never runs it, so SIGTERM on the case this
/// mechanism exists for is a no-op. SIGKILL is not deliverable to a handler and
/// needs no cooperation from the target, which is the property required here.
pub(crate) fn kill_pid_force(pid: u32) {
    let _ = Command::new("/bin/kill")
        .args(["-KILL", &pid.to_string()])
        .output();
}

// ---------------------------------------------------------------------------
// The supervised-daemon record.
// ---------------------------------------------------------------------------

/// One supervised daemon: who it is, and how its supervision is going.
///
/// This is the unit mt#3815's registry holds N of. Everything on it is identity
/// or state that EVERY supervised daemon has. A daemon that additionally needs
/// policy-specific state — as the cockpit does, with a bundle-build label, a
/// backend source mtime and a `db`-degraded counter — WRAPS this rather than
/// extending it, which is what `supervisor::Sup` does. That is the whole point
/// of the split: before mt#3990 those four cockpit-only fields sat in the same
/// struct as the ten below, so a second daemon would have inherited a build
/// label and a `db` counter that mean nothing for it.
///
/// mt#3990 success criterion 4 is that this module's surface suffices to
/// express a SECOND daemon with no further change to it. That claim is checked
/// by the compiler rather than asserted: `tests::a_second_daemon_needs_no_change_here`
/// constructs a full record, and a spawn spec, for a daemon that does not exist.
pub(crate) struct SupervisedDaemon {
    // --- Identity: fixed for this daemon's lifetime. ---
    /// The user-visible strings this daemon contributes to the tray.
    pub(crate) labels: DaemonLabels,
    /// The loopback port it serves on. Read once at construction so every
    /// probe, spawn, adoption decision and label in the loop provably refers to
    /// the same port (mt#3988).
    pub(crate) port: u16,
    /// Path of its health endpoint — `/api/health` for the cockpit, `/health`
    /// for the MCP daemon. Per-daemon since mt#3815; before that the whole
    /// URL was a cockpit constant.
    pub(crate) health_path: &'static str,
    /// The `service` value its health body must carry for the supervisor to
    /// treat it as this daemon (mt#3148). See [`HealthProbe::is_ours`] for why
    /// a missing field fails rather than passes.
    pub(crate) expected_service: &'static str,

    // --- Supervision state: driven by the poll loop. ---
    /// The managed child, when WE spawned it. `None` for an adopted daemon or
    /// when nothing is running.
    pub(crate) child: Option<Child>,
    pub(crate) last_spawn: Option<Instant>,
    /// Last status-line text. Owned `String` (not `&'static str`) so dynamic
    /// messages — port-conflict holder pid, restart-failure summary — can be
    /// shown alongside the static [`DaemonLabels`] entries (mt#2299).
    pub(crate) last_status: Option<String>,
    /// Wall-clock start time of the daemon currently being supervised (mt#2299):
    /// `SystemTime::now()` for a tray-spawned daemon, or `now − ps(etime)` for
    /// an adopted one. `None` when no daemon is running. Drives the uptime line.
    pub(crate) daemon_started_at: Option<SystemTime>,
    /// Last value pushed to the uptime menu line (mt#2299), for dedupe.
    pub(crate) last_uptime_label: Option<String>,

    // --- Self-health watchdog state (mt#2578). ---
    /// Ring buffer of daemon-crash restart timestamps (child-exited or
    /// processStartedAtMs changed) within [`RESTART_STORM_WINDOW`]. Pruned every
    /// poll to evict entries older than the window.
    pub(crate) restart_timestamps: Vec<Instant>,
    /// Instant of the last restart-storm alert toast; `None` when the condition
    /// is clear (cooldown reset so the next episode fires immediately).
    pub(crate) last_restart_alert: Option<Instant>,
    /// `processStartedAtMs` from the daemon's most recent successful health
    /// response; `None` before the first successful poll. A change between polls
    /// means the daemon restarted (for adopted-daemon restart detection).
    pub(crate) last_process_started_at_ms: Option<u64>,
    /// Consecutive polls where the health probe failed while the daemon child is
    /// alive or an adopted daemon is expected (the unhealthy-but-not-exiting
    /// case). Reset to 0 on the first successful health poll; also reset in the
    /// crash-exit arm (that path's alerting is owned by `restart_timestamps`).
    pub(crate) consecutive_http_failed: u32,
    /// Last time a sustained-HTTP-failure alert was fired; reset when health
    /// returns (condition cleared → next episode re-alerts immediately).
    pub(crate) last_http_alert: Option<Instant>,

    // --- Not-ready watchdog state (mt#4472). ---
    //
    // The sibling of `consecutive_http_failed` / `last_http_alert` directly
    // above, for the case those two cannot see: the daemon ANSWERS, identifies
    // itself, returns 2xx — and says in the body that it cannot serve
    // DB-backed work. HTTP-failure counting is blind to it by construction.
    //
    // Generic rather than cockpit-policy state, per ADR-014's 2026-08-12
    // amendment ("every decision this ADR records still holds — now PER
    // ENTRY"). It lived in `CockpitPolicy` until mt#4472 for a reason its own
    // comment gave — "only the cockpit daemon's health body carries a `db`
    // field at all" — which mt#4471 retired by giving the MCP daemon `db` and
    // `ready`. The MCP daemon is also the entry where the 2026-08-23 incident
    // happened, so the axis it was excluded from is the one it needed.
    /// Consecutive polls where this daemon answered but reported it cannot
    /// serve DB-backed work. Reset to 0 on the first serving poll.
    pub(crate) consecutive_not_ready: u32,
    /// Last time a not-ready alert was fired; reset when the condition clears,
    /// so a new episode alerts immediately.
    pub(crate) last_not_ready_alert: Option<Instant>,
    /// Last time this watchdog RESTARTED the daemon for being not-ready.
    ///
    /// Deliberately separate from `last_not_ready_alert` rather than reusing
    /// it: an alert is a toast, and a restart drops whatever every conversation
    /// on this machine has in flight (ADR-038). They earn different cooldowns,
    /// and collapsing them would silently give the expensive action the cheap
    /// one's cadence.
    pub(crate) last_not_ready_restart: Option<Instant>,
    /// Set when this supervisor SIGKILLed the current child for breaching
    /// [`MEMORY_CEILING_BYTES`], and read by [`classify_exit`] on the poll that
    /// observes the exit (mt#4105).
    ///
    /// It exists because a SIGKILLed process is indistinguishable from any other
    /// signalled death at the syscall level — the supervisor's own record is the
    /// ONLY thing that can tell "we removed it" from "it died". Cleared at spawn,
    /// so it can never carry across into a later child's exit.
    pub(crate) killed_for_ceiling: bool,
    /// Last time a ceiling-kill toast was shown; `None` until the first one
    /// (PR #3045 R1). Gated on [`ALERT_COOLDOWN`] like every other alert in this
    /// module: a daemon that balloons, is killed, respawns and balloons again
    /// would otherwise toast the operator on every cycle, and an alert arriving
    /// that often stops being read.
    pub(crate) last_ceiling_alert: Option<Instant>,
}

impl SupervisedDaemon {
    /// A record for a daemon that is not running yet: identity set, every piece
    /// of supervision state at its "nothing has happened" value.
    pub(crate) fn new(
        labels: DaemonLabels,
        port: u16,
        health_path: &'static str,
        expected_service: &'static str,
    ) -> Self {
        Self {
            labels,
            port,
            health_path,
            expected_service,
            child: None,
            last_spawn: None,
            last_status: None,
            daemon_started_at: None,
            last_uptime_label: None,
            restart_timestamps: Vec::new(),
            last_restart_alert: None,
            last_process_started_at_ms: None,
            consecutive_http_failed: 0,
            last_http_alert: None,
            consecutive_not_ready: 0,
            last_not_ready_alert: None,
            last_not_ready_restart: None,
            killed_for_ceiling: false,
            last_ceiling_alert: None,
        }
    }
}

/// Move the watchdog counters between a [`SupervisedDaemon`] and the plain-data
/// [`NoChildCounters`] that `handle_health_down_no_child` takes.
///
/// These conversions lived in the cockpit policy layer until the `Sup` split
/// (mt#3990 increment 3) — not by preference, but because until then the
/// generic half of the state was a cockpit-owned struct this module could not
/// name. It can now, so they come home.
impl NoChildCounters {
    pub(crate) fn take_from(daemon: &mut SupervisedDaemon) -> Self {
        Self {
            consecutive_http_failed: daemon.consecutive_http_failed,
            last_http_alert: daemon.last_http_alert,
            last_spawn: daemon.last_spawn,
            restart_timestamps: std::mem::take(&mut daemon.restart_timestamps),
            last_process_started_at_ms: daemon.last_process_started_at_ms,
        }
    }

    pub(crate) fn write_back_to(self, daemon: &mut SupervisedDaemon) {
        daemon.consecutive_http_failed = self.consecutive_http_failed;
        daemon.last_http_alert = self.last_http_alert;
        daemon.restart_timestamps = self.restart_timestamps;
        daemon.last_process_started_at_ms = self.last_process_started_at_ms;
    }
}

// ---------------------------------------------------------------------------
// Health probing (mt#3815).
//
// Before this, health lived in the cockpit policy layer: `health_ok` and
// `poll_health_detail` closed over the cockpit's endpoint and parsed the
// cockpit's `db` field. A registry entry needs the mechanism without the
// cockpit's body shape, so the transport + identity half lives here and each
// daemon's body-specific reading stays with its policy.
// ---------------------------------------------------------------------------

/// What a single health poll observed.
///
/// Deliberately carries the raw `body` alongside the two fields every daemon
/// publishes: the generic half of the supervisor reads `status` and `service`,
/// and a policy layer reads whatever else its own daemon emits (the cockpit's
/// `db`) out of `body` without a second request.
pub(crate) struct HealthProbe {
    /// HTTP status, or `None` when nothing answered.
    pub(crate) status: Option<u16>,
    /// The `service` identity field (mt#3148). `None` when absent or the body
    /// was not JSON.
    pub(crate) service: Option<String>,
    /// `processStartedAtMs`, used to detect a restart of a daemon we did not
    /// spawn. `None` for a daemon that predates the field.
    pub(crate) process_started_at_ms: Option<u64>,
    /// The parsed body, for policy-specific fields.
    pub(crate) body: Option<serde_json::Value>,
}

impl HealthProbe {
    /// Nothing answered.
    pub(crate) fn unreachable() -> Self {
        Self {
            status: None,
            service: None,
            process_started_at_ms: None,
            body: None,
        }
    }

    /// The daemon answered 2xx — the "healthy" half.
    pub(crate) fn http_ok(&self) -> bool {
        matches!(self.status, Some(s) if (200..300).contains(&s))
    }

    /// The endpoint ANSWERED and the body identifies the expected service.
    ///
    /// This — not the status code — is what the supervision decisions key on
    /// (mt#3148). Two consequences worth stating, because each is a deliberate
    /// choice rather than a side effect:
    ///
    /// - A **non-2xx** answer still counts as ours. The MCP daemon answers 503
    ///   when persistence is unhealthy (mt#2949) and mt#3814's own adopt-or-fail
    ///   treats that as a legitimate Minsky MCP answer. A supervisor that read
    ///   503 as "not running" would respawn into a port its own daemon holds,
    ///   and restarting cannot fix what a 503 reports.
    /// - A **missing** `service` field is NOT ours. That is the fail-closed
    ///   direction and the whole point of mt#3148: a probe whose output space
    ///   does not separate the states it cares about carries no information, and
    ///   an "absent means pass" carve-out reintroduces exactly the mt#3142 shape
    ///   this assertion exists to catch. The visible consequence is a Conflict
    ///   status naming the holder — not a silent double-spawn.
    pub(crate) fn is_ours(&self, expected_service: &str) -> bool {
        self.status.is_some() && self.service.as_deref() == Some(expected_service)
    }
}

/// Extract the generic fields from a health response. Pure, so the identity
/// assertion is testable without an HTTP hop.
pub(crate) fn parse_health_body(status: u16, text: &str) -> HealthProbe {
    let body: Option<serde_json::Value> = serde_json::from_str(text).ok();
    let service = body
        .as_ref()
        .and_then(|v| v.get("service"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let process_started_at_ms = body
        .as_ref()
        .and_then(|v| v.get("processStartedAtMs"))
        .and_then(|v| v.as_u64());
    HealthProbe {
        status: Some(status),
        service,
        process_started_at_ms,
        body,
    }
}

/// Poll one daemon's health endpoint. Never panics: any transport failure is
/// reported as [`HealthProbe::unreachable`].
pub(crate) async fn probe_health(
    client: &reqwest::Client,
    port: u16,
    health_path: &str,
) -> HealthProbe {
    let url = format!("http://localhost:{port}{health_path}");
    let resp = match client.get(url).send().await {
        Ok(r) => r,
        Err(_) => return HealthProbe::unreachable(),
    };
    let status = resp.status().as_u16();
    match resp.text().await {
        Ok(text) => parse_health_body(status, &text),
        // The status is real even when the body could not be read; without a
        // body there is no identity, so `is_ours` correctly says no.
        Err(_) => HealthProbe {
            status: Some(status),
            service: None,
            process_started_at_ms: None,
            body: None,
        },
    }
}

// ---------------------------------------------------------------------------
// Exit classification (mt#3815).
//
// mt#3814 gave the local MCP daemon its own identity-asserting adopt-or-fail on
// `EADDRINUSE`, so a spawned daemon now has THREE intentional non-crash exits,
// two of them exit-0. A supervisor that reads exit-0 as "it ran and finished"
// or as "it crashed, respawn" is wrong in both directions.
// ---------------------------------------------------------------------------

/// Why a spawned daemon's process ended, as far as the supervisor can tell.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ExitClass {
    /// Exit 0 and our health endpoint now answers with the expected identity:
    /// the child lost a benign bind race and an incumbent holds the port. Adopt
    /// it — do NOT respawn, and do NOT count it toward the restart throttle.
    AdoptedIncumbent,
    /// Exit 0 with nothing serving: mt#3764's ppid-transition self-exit, or a
    /// clean stop. Not a crash.
    CleanStop,
    /// Non-zero exit with a foreign listener holding the port. Surface it;
    /// respawning into a port that will keep refusing is a spawn-storm.
    Conflict,
    /// Anything else — the daemon died and should be respawned (throttled).
    Crash,
    /// WE killed it: it breached [`MEMORY_CEILING_BYTES`] and was SIGKILLed by
    /// this supervisor (mt#4105). Respawn it, but do NOT count it toward the
    /// restart throttle.
    ///
    /// Distinct from [`Crash`] because the exit is INDISTINGUISHABLE from one at
    /// the syscall level — a SIGKILLed process reports no exit code, exactly like
    /// a process the kernel killed for its own reasons. The only thing that can
    /// tell them apart is the supervisor's own record of having fired, which is
    /// why this is carried in as a flag rather than inferred from the status.
    ///
    /// Not counting it is ADR-038 §Question 3's constraint generalized: it
    /// requires the supervisor not to double-count mt#3764's self-exit as a
    /// crash, and a kill the supervisor itself ordered has the same property —
    /// throttling on it would make the ceiling progressively slower to enforce
    /// the more often it was needed.
    CeilingKill,
}

/// Classify a spawned daemon's exit.
///
/// The discriminator is a health RE-PROBE, not a match on mt#3814's
/// `Adopting the incumbent` log line: that string is a contract mt#3814 never
/// promised the supervisor, and matching it would couple two crates through
/// prose. The health probe is the authority the rest of this module already
/// uses, and it answers the question directly.
///
/// `reprobe_is_ours` is [`HealthProbe::is_ours`] taken AFTER the exit was
/// observed; `port_held` is [`port_in_use`] at the same moment.
///
/// `we_killed_for_ceiling` is the supervisor's own record that it SIGKILLed this
/// child for breaching the ceiling (mt#4105). It is checked FIRST and outranks
/// the health re-probe: a ceiling kill frees the port, so an unrelated incumbent
/// binding it in the same tick would otherwise read as `AdoptedIncumbent` and
/// suppress the respawn of a daemon we deliberately removed.
pub(crate) fn classify_exit(
    exit_code: Option<i32>,
    reprobe_is_ours: bool,
    port_held: bool,
    we_killed_for_ceiling: bool,
) -> ExitClass {
    if we_killed_for_ceiling {
        return ExitClass::CeilingKill;
    }
    if reprobe_is_ours {
        // Something of ours is serving the port even though our child is gone.
        // Whatever the code, the correct response is to adopt rather than to
        // spawn a second one.
        return ExitClass::AdoptedIncumbent;
    }
    match exit_code {
        Some(0) => ExitClass::CleanStop,
        _ if port_held => ExitClass::Conflict,
        _ => ExitClass::Crash,
    }
}

/// Humanize a duration for the uptime line: `5s`, `1m 30s`, `2h 5m`, `8d 3h`. Pure.
pub(crate) fn format_duration(d: Duration) -> String {
    let s = d.as_secs();
    if s < 60 {
        format!("{s}s")
    } else if s < 3_600 {
        format!("{}m {}s", s / 60, s % 60)
    } else if s < 86_400 {
        format!("{}h {}m", s / 3_600, (s % 3_600) / 60)
    } else {
        format!("{}d {}h", s / 86_400, (s % 86_400) / 3_600)
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

    // -----------------------------------------------------------------------
    // Process/port/log/uptime primitives (moved here with their functions,
    // mt#3990 increment 2). Bodies are unchanged from `supervisor.rs`; the two
    // port-args cases lost their `crate::port::DEFAULT_COCKPIT_PORT` input,
    // which is a cockpit constant this module must not read — the assertions
    // already spelled the expected port out literally, so the constant was
    // only supplying the input value.
    // -----------------------------------------------------------------------

    /// The default-port case's input. Numerically the cockpit's default, but
    /// arbitrary to the core: the probe must be loopback-scoped at whatever
    /// port it is handed.
    const DEFAULT_PORT_CASE: u16 = 3737;

    #[test]
    fn parse_lsof_pid_takes_first_numeric_line() {
        assert_eq!(parse_lsof_pid("12345\n67890\n"), Some(12345));
        assert_eq!(parse_lsof_pid("  4242 \n"), Some(4242));
        assert_eq!(parse_lsof_pid(""), None);
        assert_eq!(parse_lsof_pid("\n\n"), None);
        assert_eq!(parse_lsof_pid("not-a-pid\n"), None);
    }

    #[test]
    fn parse_lsof_holder_reads_the_pid_and_the_address() {
        // Real captured output, including the `f` line lsof emits whether or
        // not it was requested.
        assert_eq!(
            parse_lsof_holder("p42516\nf6\nn127.0.0.1:3737\n"),
            Some((42516, "127.0.0.1:3737".to_string()))
        );
        // IPv6 loopback — the case `tcp@127.0.0.1` would have missed entirely.
        assert_eq!(
            parse_lsof_holder("p1465\nf3\nn[::1]:39372\n"),
            Some((1465, "[::1]:39372".to_string()))
        );
        // A process listening on both families: first address wins, matching
        // parse_lsof_pid's first-wins rule.
        assert_eq!(
            parse_lsof_holder("p7\nf3\nn127.0.0.1:3737\nf4\nn[::1]:3737\n"),
            Some((7, "127.0.0.1:3737".to_string()))
        );
        // A process line with no address line is not a holder.
        assert_eq!(parse_lsof_holder("p42516\nf6\n"), None);
        // An address line with no preceding process line is not a holder.
        assert_eq!(parse_lsof_holder("n127.0.0.1:3737\n"), None);
    }

    #[test]
    fn the_port_holder_probe_is_scoped_to_loopback() {
        // mt#3785: `tcp:<port>` matches ANY interface, so a Tailscale listener
        // on the tailnet addresses came back as the cockpit port's holder --
        // and since `parse_lsof_pid` above keeps only the FIRST of the several
        // PIDs that returns, a kill aimed at the daemon could land elsewhere.
        let args = lsof_port_args(DEFAULT_PORT_CASE);
        assert_eq!(args[1], "tcp@localhost:3737");
        assert_ne!(args[1], "tcp:3737", "the unscoped form is the mt#3785 bug");
        // The two invariants `contract/README.md` §2 pins across the Rust and
        // TypeScript implementations: LISTEN-state only, and PID-only output.
        assert_eq!(args[0], "-ti");
        assert_eq!(args[2], "-sTCP:LISTEN");
    }

    /// mt#3988: the probe follows the CONFIGURED port. Without this, a tray
    /// configured to 4317 would keep asking lsof about 3737 — which is the
    /// original defect wearing a different hat, since `pid_on_port` feeds the
    /// kill in the stop path.
    #[test]
    fn the_port_holder_probe_follows_the_configured_port() {
        let args = lsof_port_args(TEST_PORT);
        assert_eq!(args[1], "tcp@localhost:4317");
        // Still loopback-scoped at a non-default port (the mt#3785 invariant
        // must not be something only the default port enjoys).
        assert!(!args[1].starts_with("tcp:"));
        assert_eq!(args[2], "-sTCP:LISTEN");
    }

    #[test]
    fn only_addr_in_use_means_the_port_is_taken() {
        // PR #2684 R1: `bind(..).is_err()` conflated EADDRINUSE with every
        // other failure, so an unrelated error would have put the tray in the
        // Conflict state that task exists to get it out of.
        assert!(bind_error_means_in_use(&io::Error::from(
            io::ErrorKind::AddrInUse
        )));
        for kind in [
            io::ErrorKind::PermissionDenied,
            io::ErrorKind::AddrNotAvailable,
            io::ErrorKind::Interrupted,
            io::ErrorKind::Other,
        ] {
            assert!(
                !bind_error_means_in_use(&io::Error::from(kind)),
                "{kind:?} is not evidence the port is taken"
            );
        }
    }

    #[test]
    fn port_in_use_tracks_a_live_loopback_listener() {
        // Exercises the real bind rather than a stub: the whole point of
        // ADR-014's bind probe is that it asks the OS the same question the
        // daemon will ask, so stubbing it would test nothing.
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind an ephemeral port");
        let port = listener.local_addr().expect("local addr").port();

        assert!(
            port_in_use(port),
            "a live loopback listener must read as in-use"
        );

        drop(listener);

        // Bounded retry, not a single check: releasing a listener does not
        // always make its port re-bindable on the very next syscall under
        // parallel test load -- measured here at roughly one run in two, and
        // it vanishes entirely if anything slow happens in between. That is a
        // property of the OS release path, not of the probe, and it is
        // irrelevant in production (the only place the tray probes right after
        // a kill is the Restart arm, which already sleeps 500ms first). What
        // the probe owes us is that a released port BECOMES free.
        let became_free = (0..50).any(|_| {
            if !port_in_use(port) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
            false
        });
        assert!(
            became_free,
            "the port must read as free once the listener is released"
        );
    }

    #[test]
    fn port_in_use_ignores_a_listener_on_another_interface() {
        // The mt#3785 case in miniature. A non-loopback listener does not take
        // the loopback address away from the daemon, so the tray must still
        // consider the port available. Uses whatever non-loopback address this
        // machine has; skips rather than fails where there is none (CI).
        let Some(addr) = non_loopback_ipv4() else {
            return;
        };
        let listener = TcpListener::bind((addr, 0)).expect("bind on a non-loopback address");
        let port = listener.local_addr().expect("local addr").port();

        assert!(
            !port_in_use(port),
            "a listener on {addr} must not make the loopback address unavailable"
        );
    }

    /// First non-loopback IPv4 address on this host, if any. `None` on a
    /// loopback-only machine, where the sibling test has nothing to assert.
    fn non_loopback_ipv4() -> Option<Ipv4Addr> {
        // Connecting a UDP socket performs no traffic; it just makes the OS
        // pick the source address it would route from, which is a real local
        // interface address.
        let sock = std::net::UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
        sock.connect(("192.0.2.1", 9)).ok()?; // TEST-NET-1, never routed
        match sock.local_addr().ok()? {
            std::net::SocketAddr::V4(a) if !a.ip().is_loopback() => Some(*a.ip()),
            _ => None,
        }
    }

    #[test]
    fn augmented_path_prepends_common_dirs_and_dedupes() {
        let p = augmented_path("/Users/x", "/usr/bin:/custom/bin");
        assert!(p.starts_with("/Users/x/.bun/bin:"));
        assert!(p.contains(":/custom/bin"));
        // /usr/bin is in the prepend list, so it must not be duplicated.
        assert_eq!(p.matches("/usr/bin").count(), 1);
    }

    #[test]
    fn parse_etime_handles_all_ps_formats() {
        assert_eq!(parse_etime_to_secs("00:00"), Some(0));
        assert_eq!(parse_etime_to_secs("01:30"), Some(90));
        assert_eq!(parse_etime_to_secs("01:01:01"), Some(3661));
        assert_eq!(
            parse_etime_to_secs("2-03:00:00"),
            Some(2 * 86_400 + 3 * 3_600)
        );
        // ps right-pads/space-pads; trim tolerated.
        assert_eq!(parse_etime_to_secs("  05:00 "), Some(300));
        assert_eq!(parse_etime_to_secs(""), None);
        assert_eq!(parse_etime_to_secs("garbage"), None);
        assert_eq!(parse_etime_to_secs("1:2:3:4"), None);
    }

    #[test]
    fn format_duration_picks_unit_by_magnitude() {
        assert_eq!(format_duration(Duration::from_secs(5)), "5s");
        assert_eq!(format_duration(Duration::from_secs(90)), "1m 30s");
        assert_eq!(format_duration(Duration::from_secs(3_700)), "1h 1m");
        assert_eq!(format_duration(Duration::from_secs(90_000)), "1d 1h");
    }

    #[test]
    fn last_nonempty_capped_picks_last_line_and_caps() {
        assert_eq!(
            last_nonempty_capped(b"warn\n\nError: boom\n\n"),
            Some("Error: boom".to_string())
        );
        assert_eq!(last_nonempty_capped(b""), None);
        assert_eq!(last_nonempty_capped(b"\n  \n"), None);
        // Capped at 120 chars + ellipsis.
        let long = "x".repeat(200);
        let out = last_nonempty_capped(long.as_bytes()).expect("some");
        assert_eq!(out.chars().count(), 123); // 120 + "..."
        assert!(out.ends_with("..."));
    }

    /// mt#3990 success criterion 4, checked by the COMPILER rather than
    /// asserted. Everything a second supervised daemon needs — its strings, its
    /// port, its supervision state, and the spec it would be spawned from — is
    /// constructed here for a daemon that does not exist. If a later change
    /// makes any of that inexpressible without editing this module, this stops
    /// compiling; that is the point, since a sufficiency claim carried only in
    /// prose can quietly become false.
    ///
    /// Constructed, deliberately never spawned: handing the spec to
    /// `spawn_daemon` would start a real process, and what is under test is the
    /// surface, not the syscall.
    #[test]
    fn a_second_daemon_needs_no_change_here() {
        let mut second = SupervisedDaemon::new(TEST_LABELS, TEST_PORT, "/health", "testd");

        // The record is driven by the same generic logic the cockpit daemon
        // runs on — reaching any of it requires no cockpit-shaped state.
        assert!(throttle_ok(
            second.last_spawn,
            Instant::now(),
            RESPAWN_THROTTLE
        ));
        assert_eq!(status_label(true, &second.labels), "Testd: running");
        assert_eq!(decide_action(false, false), DaemonAction::Spawn);

        // The watchdog counters round-trip through the record, so a second
        // daemon gets its OWN restart-storm and sustained-outage accounting
        // rather than sharing the cockpit's.
        second.consecutive_http_failed = 7;
        let counters = NoChildCounters::take_from(&mut second);
        assert_eq!(counters.consecutive_http_failed, 7);
        assert!(
            second.restart_timestamps.is_empty(),
            "take_from moves the ring buffer out"
        );
        counters.write_back_to(&mut second);
        assert_eq!(second.consecutive_http_failed, 7);

        // ...and its spawn is expressible without this module knowing what it
        // runs, where from, or what it logs to.
        let program = PathBuf::from("/usr/bin/true");
        let cwd = PathBuf::from("/tmp");
        let args = vec!["--serve".to_string(), second.port.to_string()];
        let spec = DaemonSpawnSpec {
            program: &program,
            args: &args,
            cwd: &cwd,
            path_env: "/usr/bin:/bin",
            stdout_log: "testd-stdout.log",
            stderr_log: "testd-stderr.log",
            extra_env: &[],
        };
        assert_eq!(spec.args, ["--serve", "4317"]);
        assert!(
            !spec.stderr_log.contains("cockpit"),
            "a second daemon writes its own logs"
        );

        // ...and it carries its own health endpoint and identity, so the
        // probe below can tell it from a different Minsky app on the same port.
        assert_eq!(second.health_path, "/health");
        assert_eq!(second.expected_service, "testd");
    }

    // -----------------------------------------------------------------------
    // Health probing + identity assertion (mt#3815).
    // -----------------------------------------------------------------------

    #[test]
    fn parses_the_generic_health_fields() {
        let probe = parse_health_body(
            200,
            r#"{"status":"ok","service":"minsky-cockpit","processStartedAtMs":1735689600000,"db":"ok"}"#,
        );
        assert_eq!(probe.status, Some(200));
        assert_eq!(probe.service.as_deref(), Some("minsky-cockpit"));
        assert_eq!(probe.process_started_at_ms, Some(1_735_689_600_000));
        // The body is retained so a policy layer reads its OWN fields without
        // a second request — the cockpit's `db` is the live case.
        assert_eq!(
            probe
                .body
                .as_ref()
                .and_then(|b| b.get("db"))
                .and_then(|v| v.as_str()),
            Some("ok")
        );
    }

    /// AT4's classification half, and the reason this assertion exists at all
    /// (mt#3148): a status-code-only check reports the WRONG service healthy.
    #[test]
    fn identity_assertion_rejects_a_different_minsky_service() {
        let wrong = parse_health_body(200, r#"{"status":"ok","service":"minsky-reviewer"}"#);
        assert!(
            wrong.http_ok(),
            "the negative control: a status-code-only check passes here"
        );
        assert!(
            !wrong.is_ours("minsky-mcp"),
            "a different Minsky service answering 200 is NOT our daemon"
        );
    }

    #[test]
    fn identity_assertion_fails_closed_on_a_missing_or_unparseable_body() {
        let no_field = parse_health_body(200, r#"{"status":"ok"}"#);
        assert!(
            !no_field.is_ours("minsky-mcp"),
            "absent identity fails rather than passes — an 'absent means pass' \
             carve-out is the mt#3142 shape this check exists to catch"
        );
        let not_json = parse_health_body(200, "OK");
        assert!(!not_json.is_ours("minsky-mcp"));
        assert!(!HealthProbe::unreachable().is_ours("minsky-mcp"));
        assert!(!HealthProbe::unreachable().http_ok());
    }

    /// The MCP daemon answers 503 when persistence is unhealthy (mt#2949), and
    /// mt#3814's own adopt-or-fail treats that as a legitimate Minsky MCP
    /// answer. Reading it as "not running" would respawn into a port our own
    /// daemon holds.
    #[test]
    fn a_503_from_the_expected_service_is_still_ours() {
        let degraded = parse_health_body(503, r#"{"status":"unhealthy","service":"minsky-mcp"}"#);
        assert!(degraded.is_ours("minsky-mcp"), "answering, and it is ours");
        assert!(!degraded.http_ok(), "but not healthy");
    }

    // -----------------------------------------------------------------------
    // Exit classification (mt#3815).
    // -----------------------------------------------------------------------

    /// The benign adopt race (AT10): our spawn lost to an incumbent and exited
    /// 0 having adopted it. Respawning here would spawn a second daemon; the
    /// negative control is the `Crash` case below, which a supervisor treating
    /// exit-0 as a crash would produce for this same input.
    #[test]
    fn exit_zero_with_our_service_serving_is_an_adopted_incumbent() {
        assert_eq!(
            classify_exit(Some(0), true, true, false),
            ExitClass::AdoptedIncumbent
        );
        // The incumbent is what matters, not the code: a daemon killed by a
        // signal (code None) while a replacement already serves is the same
        // situation.
        assert_eq!(
            classify_exit(None, true, true, false),
            ExitClass::AdoptedIncumbent,
            "an incumbent of ours outranks the exit code"
        );
    }

    /// mt#3764's ppid-transition self-exit and an operator's clean stop are
    /// indistinguishable from here, and want the same treatment: not a crash.
    #[test]
    fn exit_zero_with_nothing_serving_is_a_clean_stop() {
        assert_eq!(
            classify_exit(Some(0), false, false, false),
            ExitClass::CleanStop
        );
    }

    #[test]
    fn nonzero_exit_against_a_foreign_listener_is_a_conflict() {
        assert_eq!(
            classify_exit(Some(1), false, true, false),
            ExitClass::Conflict
        );
    }

    #[test]
    fn nonzero_exit_with_a_free_port_is_a_crash() {
        assert_eq!(
            classify_exit(Some(1), false, false, false),
            ExitClass::Crash
        );
        assert_eq!(classify_exit(None, false, false, false), ExitClass::Crash);
    }

    // -----------------------------------------------------------------------
    // Memory ceiling (mt#4105).
    // -----------------------------------------------------------------------

    /// The discriminating case for SC4. A SIGKILLed child reports the SAME exit
    /// status as one the kernel killed — `None` — so without the flag these two
    /// assertions would be the same call, and the first would be counted as a
    /// crash against the restart throttle.
    #[test]
    fn a_ceiling_kill_is_told_from_a_crash_only_by_the_supervisors_own_record() {
        assert_eq!(
            classify_exit(None, false, false, true),
            ExitClass::CeilingKill
        );
        assert_eq!(classify_exit(None, false, false, false), ExitClass::Crash);
    }

    /// The flag outranks the health re-probe: a ceiling kill frees the port, so
    /// an incumbent binding it in the same tick must not turn a deliberate
    /// removal into an adoption that suppresses the respawn.
    #[test]
    fn a_ceiling_kill_outranks_an_incumbent_taking_the_freed_port() {
        assert_eq!(
            classify_exit(None, true, true, true),
            ExitClass::CeilingKill
        );
    }

    #[test]
    fn parses_the_footprint_bytes_form() {
        // The shape `footprint -f bytes -p <pid>` actually prints, peak line
        // included — captured from a live run 2026-08-16.
        let out = "    phys_footprint: 2605888 B     phys_footprint_peak: 2605888 B\n";
        assert_eq!(parse_footprint_bytes(out), Some(2605888));
    }

    /// `phys_footprint_peak` is a different quantity on the same line. A
    /// `contains("phys_footprint")` match would accept it, and on a process that
    /// had shrunk since its high-water mark the ceiling would fire on a number
    /// the process no longer occupies.
    #[test]
    fn the_peak_field_is_not_mistaken_for_the_current_footprint() {
        let peak_first = "phys_footprint_peak: 9999999 B\nphys_footprint: 1024 B\n";
        assert_eq!(parse_footprint_bytes(peak_first), Some(1024));
    }

    #[test]
    fn unusable_footprint_output_is_none_rather_than_a_guess() {
        assert_eq!(parse_footprint_bytes(""), None);
        assert_eq!(parse_footprint_bytes("no such process"), None);
        assert_eq!(
            parse_footprint_bytes("phys_footprint: B"),
            None,
            "a label with no number is not a measurement"
        );
    }

    #[test]
    fn sums_rss_and_swap_from_proc_status() {
        let status = "Name:\tbun\nVmRSS:\t  900 kB\nVmSwap:\t  100 kB\n";
        assert_eq!(parse_proc_status_bytes(status), Some(1000 * 1024));
    }

    /// PR #3045 R1. A kernel without `CONFIG_SWAP` prints no `VmSwap` line, so
    /// requiring both fields would return `None` on every read on that host —
    /// and since an unmeasurable process never breaches, the ceiling would be
    /// silently OFF there rather than safe. Zero swap is the true value on a
    /// swapless kernel, so RSS alone is a real measurement.
    #[test]
    fn a_missing_vmswap_is_zero_swap_rather_than_a_failed_measurement() {
        assert_eq!(
            parse_proc_status_bytes("VmRSS:\t900 kB\n"),
            Some(900 * 1024)
        );
    }

    /// `VmRSS` is the other direction and IS required: without it there is no
    /// measurement to fall back on, and inventing one from VmSwap alone would
    /// report a number that is not the process's memory.
    #[test]
    fn a_proc_status_without_vmrss_is_not_measured() {
        assert_eq!(parse_proc_status_bytes("VmSwap:\t100 kB\n"), None);
        assert_eq!(parse_proc_status_bytes(""), None);
        assert_eq!(parse_proc_status_bytes("Name:\tbun\n"), None);
    }

    /// Fail-safe direction. An unmeasurable process is not evidence of an
    /// oversized one, and the consequence of confusing them is SIGKILL on a
    /// healthy daemon every time `footprint` hiccups.
    #[test]
    fn an_unmeasurable_process_never_breaches() {
        assert!(!breaches_ceiling(None, 10));
        assert!(
            !breaches_ceiling(Some(10), 10),
            "at the ceiling is not over it"
        );
        assert!(breaches_ceiling(Some(11), 10));
    }

    /// The tray and the in-process watcher must enforce the same number, or an
    /// operator reading one and observing the other has no way to reconcile
    /// them. Pinned against `DEFAULT_MEMORY_CEILING_MB` in
    /// `src/mcp/orphan-exit.ts`, which is 2048.
    #[test]
    fn the_ceiling_matches_the_in_process_watchers_default() {
        assert_eq!(MEMORY_CEILING_BYTES, 2048 * 1024 * 1024);
    }

    // -----------------------------------------------------------------------
    // Spawned-process-group bookkeeping (mt#3815).
    //
    // The two properties AT2 and AT5 rest on. Not a substitute for AT5's live
    // run — `teardown` sends real signals, so what is pinned here is the
    // BOOKKEEPING it iterates, not the kill.
    // -----------------------------------------------------------------------

    #[test]
    fn stopping_one_daemon_leaves_the_others_group_recorded() {
        let spawned: SpawnedPgids = Arc::new(Mutex::new(Vec::new()));
        record_spawned(&spawned, "cockpit", 111);
        record_spawned(&spawned, "mcp", 222);

        assert_eq!(take_spawned(&spawned, "mcp"), Some(222));
        assert_eq!(
            spawned.lock().expect("lock").as_slice(),
            [("cockpit", 111)],
            "stopping one entry must not forget the other's group — that is what \
             makes killing one daemon leave the other running (AT2)"
        );
        assert_eq!(
            take_spawned(&spawned, "mcp"),
            None,
            "taking twice is not an error, it is just gone"
        );
    }

    #[test]
    fn a_respawn_supersedes_the_group_it_replaced() {
        let spawned: SpawnedPgids = Arc::new(Mutex::new(Vec::new()));
        record_spawned(&spawned, "mcp", 222);
        record_spawned(&spawned, "mcp", 333);
        assert_eq!(
            spawned.lock().expect("lock").as_slice(),
            [("mcp", 333)],
            "a stale group id would outlive its process and be signalled at quit"
        );
    }

    #[test]
    fn teardown_drains_every_recorded_group() {
        let spawned: SpawnedPgids = Arc::new(Mutex::new(Vec::new()));
        // Our OWN process group: `teardown` signals what it finds, so a test
        // must not hand it a pgid belonging to anything else. SIGTERM to our
        // own group would kill the test runner, so this deliberately records
        // NOTHING killable and checks the drain instead — the half that was
        // broken before mt#3815, when a single slot could only ever remember
        // one daemon.
        teardown(&spawned);
        assert!(spawned.lock().expect("lock").is_empty());

        record_spawned(&spawned, "cockpit", 111);
        record_spawned(&spawned, "mcp", 222);
        assert_eq!(
            spawned.lock().expect("lock").len(),
            2,
            "both entries are recorded, so both are reachable at teardown (AT5)"
        );
    }
}
