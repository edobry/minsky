//! The daemon registry (mt#3815, ADR-038 §Question 3).
//!
//! ADR-014 made the tray the canonical supervisor of the cockpit daemon — one
//! daemon, one port. ADR-038 §Question 3 lifts that boundary: the tray becomes
//! the supervisor of a REGISTRY of named daemons, and the local MCP daemon
//! (mt#3814) is the second entry.
//!
//! This module holds what makes an entry an entry — its id, its identity
//! strings, and how it is spawned. The supervision MECHANISM is
//! [`super::daemon_core`]; the per-daemon POLICY (the cockpit's bundle rebuild,
//! source-staleness adoption and `db` watchdog) is [`super`].
//!
//! ## Why the id set is a closed enum
//!
//! ADR-038 §Question 2 decided the two daemons stay separate PROCESSES; it did
//! not ask for a user-extensible registry, and nothing in the tray reads a
//! registry from configuration. A closed enum makes every per-daemon difference
//! visible at the `match` that handles it, needs no allocation or dynamic
//! dispatch in a 5s poll loop, and lets the compiler find every site a third
//! entry would have to be considered at. Growing it is adding a variant.

use std::path::{Path, PathBuf};

use super::daemon_core::{daemon_labels, DaemonLabels};

/// Which supervised daemon an entry, a menu item, or a command refers to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum DaemonId {
    Cockpit,
    Mcp,
}

impl DaemonId {
    /// Every registered daemon, in the order the tray menu lists them. The
    /// cockpit leads because it is the tray's namesake and the one an operator
    /// interacts with; the array — not a hand-maintained list at each call site
    /// — is what makes "the supervisor iterates the registry" true.
    pub(crate) const ALL: [DaemonId; 2] = [DaemonId::Cockpit, DaemonId::Mcp];

    /// Stable token used in menu-item ids (`start:cockpit`) and log lines.
    /// Deliberately not the display name: this one is parsed.
    pub(crate) fn slug(self) -> &'static str {
        match self {
            DaemonId::Cockpit => "cockpit",
            DaemonId::Mcp => "mcp",
        }
    }

    /// Inverse of [`slug`], for the menu-event dispatch that receives an id
    /// string back from the OS.
    pub(crate) fn from_slug(slug: &str) -> Option<Self> {
        DaemonId::ALL.into_iter().find(|d| d.slug() == slug)
    }
}

// ---------------------------------------------------------------------------
// The MCP daemon entry (mt#3814's daemon, registered here).
// ---------------------------------------------------------------------------

/// Unchanged by mt#4233's rename, byte for byte — this entry ALREADY carried the
/// class word, which is exactly what made its sibling's bare "Cockpit" read as
/// the app rather than as a process. Routed through `daemon_labels!` all the
/// same, so both entries declare their name in one place and cannot drift apart
/// on whether the suffix belongs in it.
pub(crate) const MCP_LABELS: DaemonLabels = daemon_labels!(
    "MCP daemon",
    "~/.local/state/minsky/logs/mcp-daemon-stderr.log"
);

/// The MCP daemon's health endpoint. `/health`, not the cockpit's
/// `/api/health` — the whole reason the path is per-entry data.
pub(crate) const MCP_HEALTH_PATH: &str = "/health";

/// The identity its health body must carry (mt#3148 / `SERVICE_IDENTITIES.mcp`).
pub(crate) const MCP_SERVICE: &str = "minsky-mcp";

/// Mirrors `DEFAULT_LOCAL_DAEMON_PORT` in `src/mcp/daemon/local-daemon.ts`.
///
/// Not configurable here on purpose: `--local-daemon` supplies this port
/// itself, and the shim entries `minsky setup local-http` writes (mt#3816)
/// point at the same number. A tray-local override would create a third place
/// the port is decided, which is the shape mt#2427's incident took.
pub(crate) const MCP_PORT: u16 = 48765;

pub(crate) const MCP_STDOUT_LOG: &str = "mcp-daemon-stdout.log";
pub(crate) const MCP_STDERR_LOG: &str = "mcp-daemon-stderr.log";

/// The MCP daemon's argv, minus the program.
///
/// `--local-daemon`, NOT the bare transport flags the original spec and
/// ADR-038 §Question 3 named. mt#3814 landed between that authoring and this
/// implementation, and the mode flag is now what implies `--http`, supplies
/// `127.0.0.1:48765`, generates and uses the `0600` bearer token, writes the
/// discovery file, and arms the session-admission watermark. The bare form
/// would start an HTTP server with none of that — unauthenticated, undiscoverable,
/// and carrying the generic `mcp start (http)` process role.
///
/// Spawned as `bun run src/cli.ts`, the SOURCE entry, matching how the cockpit
/// daemon is spawned and for the same two reasons (mt#2282 cwd-sensitive
/// repo-backend detection, and a `minsky` bin that may resolve to a different
/// tree than `resolve_repo_root` picks — see `port.rs`).
pub(crate) fn mcp_spawn_args() -> Vec<String> {
    vec![
        "run".to_string(),
        "src/cli.ts".to_string(),
        "mcp".to_string(),
        "start".to_string(),
        "--local-daemon".to_string(),
    ]
}

/// Environment the MCP daemon is spawned with, beyond `PATH`.
///
/// mt#3764 gives an HTTP-mode `mcp start` a **never-connected idle exit**: if no
/// MCP session is ever established within 30 minutes, the process
/// self-terminates. It is armed whenever the process's startup ppid is not 1,
/// which is exactly the tray-spawned case, and it exists to reap an ABANDONED
/// listener — "a subagent testing a server in a session workspace and never
/// terminating it," in its own words.
///
/// A supervised daemon is the opposite of abandoned, and leaving the watcher
/// armed produces a 30-minute cycle: the daemon exits, the tray's
/// sustained-outage takeover respawns it ~2 minutes later, and the next idle
/// window starts over — with an operator returning from lunch finding no daemon
/// for that gap, which is precisely what registering it with the tray is meant
/// to prevent. So the tray disables it, using the escape hatch mt#3764 already
/// ships for the purpose.
///
/// mt#3764's OTHER watcher — the ppid-transition parent-death exit — is
/// deliberately left ARMED: the tray is the parent, so it is what makes AT6
/// true (kill the tray, the daemon self-exits rather than surviving as an
/// orphan). Disabling both would trade one leak for another.
pub(crate) const MCP_SPAWN_ENV: [(&str, &str); 1] =
    [("MINSKY_MCP_DISABLE_NEVER_CONNECTED_EXIT", "1")];

// ---------------------------------------------------------------------------
// Discovery record (mt#3814's output, read here).
// ---------------------------------------------------------------------------

/// The fields the tray reads out of `~/.local/state/minsky/local-mcp.json`.
///
/// Mirrors `LocalDaemonDiscoveryRecord` in `src/mcp/daemon/local-daemon.ts`.
/// Mirrored rather than shelled out for: the writer is TypeScript and the
/// reader is Rust, the record is four flat fields, and the alternative is a
/// `bun` subprocess on a path that runs while the supervisor decides whether to
/// spawn. The cost of mirroring is that a field rename on the TS side is not
/// caught by a compiler — which is why only the two fields the tray acts on are
/// read, and why a missing or unreadable record is INCONCLUSIVE rather than
/// "no daemon" (see [`read_discovery_record`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DiscoveryRecord {
    pub(crate) port: u16,
    pub(crate) pid: u32,
}

/// `$MINSKY_STATE_DIR` or `~/.local/state/minsky` — the same resolution
/// `resolveStateDir` performs on the TS side, including the override, so the
/// tray reads the file the daemon actually wrote.
fn state_dir() -> PathBuf {
    match std::env::var("MINSKY_STATE_DIR") {
        Ok(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => Path::new(&std::env::var("HOME").unwrap_or_default()).join(".local/state/minsky"),
    }
}

pub(crate) fn discovery_path() -> PathBuf {
    state_dir().join("local-mcp.json")
}

/// Parse a discovery record. Pure, so the shape agreement with the TS writer is
/// unit-testable without a filesystem.
///
/// `None` for anything unreadable. Note what that does NOT mean: mt#3814's own
/// docstring says a null "NEVER means 'no daemon is running' — only 'no record
/// was readable'; a daemon started without `--local-daemon` writes nothing
/// here." The health probe stays the authority on whether something is serving;
/// this record only names a pid the tray can attribute, which `lsof` cannot.
pub(crate) fn parse_discovery_record(text: &str) -> Option<DiscoveryRecord> {
    let json: serde_json::Value = serde_json::from_str(text).ok()?;
    let port = u16::try_from(json.get("port")?.as_u64()?).ok()?;
    let pid = u32::try_from(json.get("pid")?.as_u64()?).ok()?;
    if port == 0 || pid == 0 {
        return None;
    }
    Some(DiscoveryRecord { port, pid })
}

/// Read the discovery record from disk, or `None` when absent/malformed.
pub(crate) fn read_discovery_record() -> Option<DiscoveryRecord> {
    let text = std::fs::read_to_string(discovery_path()).ok()?;
    parse_discovery_record(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_round_trip_for_every_registered_daemon() {
        for id in DaemonId::ALL {
            assert_eq!(
                DaemonId::from_slug(id.slug()),
                Some(id),
                "every registered daemon's slug must parse back to it — the menu \
                 dispatch depends on it"
            );
        }
        assert_eq!(DaemonId::from_slug("reviewer"), None);
        assert_eq!(DaemonId::from_slug(""), None);
    }

    /// The two entries must not collide on anything the supervisor keys on:
    /// a shared port would make each one's probe answer for the other, and a
    /// shared log filename would interleave their stderr tails into one
    /// status line.
    #[test]
    fn the_two_entries_are_distinct_where_it_matters() {
        assert_ne!(MCP_PORT, crate::port::DEFAULT_COCKPIT_PORT);
        assert_ne!(MCP_SERVICE, crate::supervisor::COCKPIT_SERVICE);
        assert_ne!(MCP_HEALTH_PATH, crate::supervisor::COCKPIT_HEALTH_PATH);
        assert_ne!(MCP_STDERR_LOG, "cockpit-stderr.log");
    }

    /// The launch line is the one thing mt#3814 changed out from under this
    /// task's spec, so it is pinned rather than left to a reader's memory.
    #[test]
    fn the_mcp_entry_launches_the_local_daemon_mode() {
        let args = mcp_spawn_args();
        assert_eq!(
            args,
            ["run", "src/cli.ts", "mcp", "start", "--local-daemon"]
        );
        assert!(
            !args.iter().any(|a| a == "--http" || a == "--port"),
            "the bare transport flags are what `--local-daemon` replaces: passing \
             them would start a server with no token, no discovery file and the \
             wrong process role"
        );
    }

    #[test]
    fn parses_a_discovery_record_written_by_the_daemon() {
        // Byte-for-byte the shape `writeDiscoveryRecord` emits.
        let written = r#"{
  "port": 48765,
  "host": "127.0.0.1",
  "pid": 4242,
  "startedAt": "2026-08-12T19:00:00.000Z"
}
"#;
        assert_eq!(
            parse_discovery_record(written),
            Some(DiscoveryRecord {
                port: 48765,
                pid: 4242
            })
        );
    }

    #[test]
    fn an_unusable_discovery_record_is_none_rather_than_a_guess() {
        assert_eq!(parse_discovery_record(""), None);
        assert_eq!(parse_discovery_record("not json"), None);
        assert_eq!(parse_discovery_record(r#"{"port":48765}"#), None, "no pid");
        assert_eq!(
            parse_discovery_record(r#"{"port":0,"pid":42}"#),
            None,
            "port 0 is not reachable"
        );
        assert_eq!(
            parse_discovery_record(r#"{"port":48765,"pid":0}"#),
            None,
            "pid 0 is not a process the tray can attribute"
        );
        assert_eq!(
            parse_discovery_record(r#"{"port":"48765","pid":42}"#),
            None,
            "a stringified port is a shape change, not a value to coerce"
        );
    }

    #[test]
    fn the_discovery_path_follows_the_state_dir_override() {
        // Asserting the FILENAME and the override key rather than an absolute
        // path: the home-relative default is environment-dependent, and what
        // must agree with the TS side is which file and which override.
        let path = discovery_path();
        assert!(path.ends_with("local-mcp.json"));
        assert!(
            path.to_string_lossy().contains("minsky"),
            "the record lives under the shared minsky state dir"
        );
    }
}
