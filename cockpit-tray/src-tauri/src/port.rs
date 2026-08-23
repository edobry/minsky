// Cockpit port resolution for the tray (mt#3988).
//
// ## Why this module exists
//
// The tray and the cockpit daemon have to agree on one number. Before this
// module they did not share a source: `supervisor.rs` pinned `DAEMON_PORT` and
// `HEALTH_URL` to 3737, `menu.rs` pinned `COCKPIT_URL` and a SECOND port
// constant for the same-origin check (with a hand-maintained "must stay in
// sync" comment between them), and `watcher_backend.rs` pinned a third URL. A
// daemon on any other port was therefore invisible to the tray: not adopted,
// not driven by Start/Stop/Restart, and liable to have a second daemon spawned
// beside it. That is the 2026-06-04 incident — a manual daemon on `:4317`
// alongside a tray-spawned one on `:3737`, with the browser reading the stale
// one.
//
// The fix is not "replace a constant with a variable" but "resolve the port
// ONCE and derive every consumer from it", which is why the same-origin check
// now reads the same value the URL is built from instead of a copy of it.
//
// ## Where the value comes from
//
// The tray does NOT re-implement configuration resolution. Precedence
// (`--port` > `cockpit.port` > 3737) is decided in `src/commands/cockpit/port.ts`
// and nowhere else; the tray asks that code for the answer by running
// `config get cockpit.port` once at startup.
//
// It asks through the SAME `(bun, repo_root)` pair `spawn_daemon` uses, not
// through whatever `minsky` happens to be on PATH. Those are not
// interchangeable: on the development machine this was written on, the `minsky`
// bin symlinks into a globally-installed copy while `resolve_repo_root` can
// prefer the launchd plist's `WorkingDirectory`, so the two can be different
// checkouts at different versions. Asking the tree we are about to spawn the
// daemon FROM is what makes "the tray and the daemon cannot disagree" true by
// construction rather than by coincidence.
//
// ## Failure is expected, and falls back rather than crashing
//
// A tree that predates `cockpit.port` answers
// `Error: Configuration path 'cockpit.port' not found` — **on stdout, with exit
// code 0**. So this module parses the output and never consults the exit
// status: a lookup is successful only when it yields a number in port range.
// Anything else (old tree, no repo root, no bun, a hung CLI) falls back to
// 3737, which is exactly the behavior every one of the constants above had.

use std::path::PathBuf;
use std::process::Command;
use std::sync::mpsc;
use std::sync::OnceLock;
use std::time::Duration;

use crate::supervisor::{resolve_program, resolve_repo_root};

/// The port used when configuration supplies none. Mirrors
/// `DEFAULT_COCKPIT_PORT` in `src/commands/cockpit/port.ts`; the two are the
/// same fallback expressed on each side of the process boundary.
pub(crate) const DEFAULT_COCKPIT_PORT: u16 = 3737;

/// Ceiling on the startup config lookup. The measured cost is ~1.1s (bun
/// startup dominates), paid once on the setup thread before the tray icon
/// appears — see `init`. The timeout exists so a wedged CLI degrades to the
/// default instead of wedging tray launch with it.
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(5);

/// The lookup the tray runs against the daemon's own tree. A named constant so
/// the live test below exercises the SAME invocation production uses rather
/// than a copy that can drift from it.
const CONFIG_GET_ARGS: [&str; 5] = ["run", "src/cli.ts", "config", "get", "cockpit.port"];

/// The resolved port, written once by `init`.
static RESOLVED_PORT: OnceLock<u16> = OnceLock::new();

/// Resolve the cockpit port from configuration and publish it process-wide.
///
/// Called once, early in Tauri's `setup`, BEFORE `menu::build` and
/// `supervisor::spawn` — every consumer downstream reads `cockpit_port()`, so
/// resolving first is what removes the window in which a menu click could open
/// a window on one port while the supervisor probes another. It is deliberately
/// synchronous for that reason: ~1.1s of launch latency buys the guarantee that
/// no consumer can ever observe a pre-resolution value.
///
/// Idempotent: a second call leaves the first answer in place.
pub(crate) fn init(path: &str) -> u16 {
    let resolved = resolve_from_config(path).unwrap_or(DEFAULT_COCKPIT_PORT);
    // Fails only if something already initialized it; the winner stands either
    // way, and `cockpit_port()` below reports whichever that was.
    let _ = RESOLVED_PORT.set(resolved);
    let port = cockpit_port();
    eprintln!("[cockpit-tray] supervising cockpit on port {port}");
    port
}

/// The resolved cockpit port.
///
/// Falls back to the default when `init` has not run (unit tests, and any
/// startup path that reaches a consumer before setup). That fallback is the
/// pre-mt#3988 behavior, so the degraded case is never worse than what the
/// constants did.
pub(crate) fn cockpit_port() -> u16 {
    RESOLVED_PORT.get().copied().unwrap_or(DEFAULT_COCKPIT_PORT)
}

/// Run `config get cockpit.port` in the tree the daemon is spawned from.
///
/// `None` on any failure — no repo root, no bun, timeout, or output that is not
/// a port. Every one of those is a legitimate configuration (a checkout that
/// predates the key, a tray with no source tree), not an error worth surfacing
/// beyond a log line.
fn resolve_from_config(path: &str) -> Option<u16> {
    let repo_root = resolve_repo_root(path)?;
    let bun = resolve_program("bun", path)?;
    let out = run_with_timeout(bun, repo_root, path.to_string())?;
    match parse_port_output(&out) {
        Some(port) => Some(port),
        None => {
            // Worth seeing: it is the difference between "you configured 4317
            // and the tray is on 4317" and "you configured 4317 and the tray
            // quietly stayed on 3737".
            eprintln!(
                "[cockpit-tray] could not read cockpit.port from configuration \
                 (output: {:?}) — falling back to {DEFAULT_COCKPIT_PORT}",
                out.trim()
            );
            None
        }
    }
}

/// Capture `bun run src/cli.ts config get cockpit.port`'s stdout, or `None` if
/// it does not answer within `RESOLVE_TIMEOUT`.
///
/// std has no timeout on `Command::output()`, so the wait happens on a helper
/// thread and this one gives up on the channel. A timed-out child is left to
/// exit on its own: it is a read-only config lookup with no side effects, and
/// killing it would buy nothing.
fn run_with_timeout(bun: PathBuf, repo_root: PathBuf, path: String) -> Option<String> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let out = Command::new(bun)
            .args(CONFIG_GET_ARGS)
            .current_dir(repo_root)
            .env("PATH", path)
            .output();
        // A closed receiver means we already timed out; nothing to do.
        let _ = tx.send(out);
    });
    match rx.recv_timeout(RESOLVE_TIMEOUT) {
        Ok(Ok(out)) => Some(String::from_utf8_lossy(&out.stdout).into_owned()),
        Ok(Err(e)) => {
            eprintln!("[cockpit-tray] could not run the cockpit.port config lookup: {e}");
            None
        }
        Err(_) => {
            eprintln!(
                "[cockpit-tray] cockpit.port config lookup did not answer within {}s — \
                 falling back to {DEFAULT_COCKPIT_PORT}",
                RESOLVE_TIMEOUT.as_secs()
            );
            None
        }
    }
}

/// Parse `config get cockpit.port`'s stdout into a port. Pure.
///
/// The whole trimmed output must parse — deliberately, because the failure this
/// guards is not a malformed number but a tree that answers
/// `Error: Configuration path 'cockpit.port' not found` with exit code 0. Exit
/// status carries no signal here, so the output has to.
///
/// Accepts a quoted scalar (`"4317"`) as well as a bare one: which of the two a
/// config reader emits is a formatting decision on the other side of the
/// process boundary, and neither form is ambiguous.
fn parse_port_output(out: &str) -> Option<u16> {
    let trimmed = out.trim();
    let unquoted = trimmed
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .unwrap_or(trimmed);
    // `u16` gives the upper bound (65535) for free; 0 is not a port a daemon
    // can be reached on, so it is rejected rather than passed through.
    match unquoted.parse::<u16>() {
        Ok(0) | Err(_) => None,
        Ok(port) => Some(port),
    }
}

// ---------------------------------------------------------------------------
// URL builders.
//
// Every cockpit URL in the tray is built here, from an explicit port, so that
// (a) there is one host convention rather than three literals, and (b) each one
// is unit-testable at a non-default port without touching the process-wide
// `RESOLVED_PORT`.
// ---------------------------------------------------------------------------

/// The cockpit origin: what the webview loads and what "Open Cockpit" opens.
pub(crate) fn cockpit_url(port: u16) -> String {
    format!("http://localhost:{port}")
}

// The cockpit's health URL used to be built here, as `health_url(port)`. It
// moved out in mt#3815: the supervisor now probes N daemons, each with its own
// health PATH carried on its registry entry, so the URL is composed generically
// by `daemon_core::probe_health` from `(port, health_path)`. Keeping a
// cockpit-specific builder beside that would be a second way to spell the same
// URL — which is the exact duplication mt#3988 removed from this module.

/// The mt#3048 "is any driven session mid-turn" endpoint the backend watcher
/// consults before an auto-restart.
pub(crate) fn turn_active_url(port: u16) -> String {
    format!("{}/api/driven-session/turn-active", cockpit_url(port))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_bare_port() {
        assert_eq!(parse_port_output("3737\n"), Some(3737));
        assert_eq!(parse_port_output("  4317  \n"), Some(4317));
    }

    #[test]
    fn parses_a_quoted_port() {
        assert_eq!(parse_port_output("\"4317\"\n"), Some(4317));
    }

    /// The case that motivates parsing rather than trusting the exit status: a
    /// tree that predates the key prints this on STDOUT and exits 0.
    #[test]
    fn rejects_the_key_not_found_message() {
        assert_eq!(
            parse_port_output("Error: Configuration path 'cockpit.port' not found\n"),
            None
        );
    }

    #[test]
    fn rejects_empty_and_out_of_range_output() {
        assert_eq!(parse_port_output(""), None);
        assert_eq!(parse_port_output("   \n"), None);
        assert_eq!(parse_port_output("0\n"), None, "0 is not a reachable port");
        assert_eq!(parse_port_output("65536\n"), None, "above the u16 ceiling");
        assert_eq!(parse_port_output("-1\n"), None);
        assert_eq!(parse_port_output("4317 is the port\n"), None);
    }

    #[test]
    fn urls_follow_the_port_they_are_given() {
        assert_eq!(cockpit_url(4317), "http://localhost:4317");
        assert_eq!(
            turn_active_url(4317),
            "http://localhost:4317/api/driven-session/turn-active"
        );
    }

    /// The default-port renderings are pinned because they are what every
    /// replaced constant spelled out literally — this is the "nothing changed
    /// when nothing is configured" half of the change.
    #[test]
    fn urls_at_the_default_port_match_the_replaced_constants() {
        assert_eq!(cockpit_url(DEFAULT_COCKPIT_PORT), "http://localhost:3737");
        assert_eq!(
            turn_active_url(DEFAULT_COCKPIT_PORT),
            "http://localhost:3737/api/driven-session/turn-active"
        );
    }

    /// The repo root this crate lives in — the tree whose `src/cli.ts` answers
    /// the live lookup below.
    fn checkout_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent() // cockpit-tray/
            .and_then(|p| p.parent()) // repo root
            .expect("crate must live at <repo>/cockpit-tray/src-tauri")
            .to_path_buf()
    }

    /// LIVE probe of the whole resolution path — real `bun`, real `src/cli.ts`,
    /// real configuration stack, real parse. Everything the unit tests above
    /// stub out.
    ///
    /// `#[ignore]` because it shells out to a toolchain that is not present in
    /// every environment `cargo test` runs in; run it with
    /// `cargo test -- --ignored`. It is the artifact for the mt#3988 claim that
    /// the tray and the daemon read the same configuration — a claim no
    /// in-process test can make, because the whole mechanism IS a subprocess.
    #[test]
    #[ignore = "live: runs `bun run src/cli.ts config get` against this checkout"]
    fn resolves_the_port_from_a_live_config_lookup() {
        let path = crate::supervisor::path_env();
        let bun = resolve_program("bun", &path).expect("bun must be on PATH for the live test");
        let out = run_with_timeout(bun.clone(), checkout_root(), path.clone())
            .expect("the config lookup must answer within the timeout");
        assert_eq!(
            parse_port_output(&out),
            Some(DEFAULT_COCKPIT_PORT),
            "unconfigured, this checkout must answer the default. raw output: {out:?}"
        );

        // And the override reaches the same code path. Run as its own process
        // with the env var set, rather than mutating this test process's
        // environment, so nothing races a parallel test.
        let overridden = Command::new(bun)
            .args(CONFIG_GET_ARGS)
            .current_dir(checkout_root())
            .env("PATH", &path)
            .env("MINSKY_COCKPIT_PORT", "4317")
            .output()
            .expect("the overridden lookup must run");
        let overridden = String::from_utf8_lossy(&overridden.stdout).into_owned();
        assert_eq!(
            parse_port_output(&overridden),
            Some(4317),
            "MINSKY_COCKPIT_PORT must reach the resolved value. raw output: {overridden:?}"
        );
    }

    /// `cockpit_port()` must be usable before `init` — unit tests and any early
    /// consumer reach it that way, and the answer has to be the old constant.
    #[test]
    fn falls_back_to_the_default_when_uninitialized() {
        // Not asserting `== DEFAULT` unconditionally: another test in this
        // binary may have initialized the OnceLock first. What must hold is
        // that the accessor answers a usable port either way.
        let port = cockpit_port();
        assert!(port > 0, "cockpit_port() must always answer a usable port");
        if RESOLVED_PORT.get().is_none() {
            assert_eq!(port, DEFAULT_COCKPIT_PORT);
        }
    }
}
