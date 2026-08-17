// Backend-source freshness + auto-restart (mt#2299).
//
// Complements the mt#2297 web-bundle auto-rebuild. When server-side cockpit
// source changes (server.ts, widget-registry.ts, widgets/**, config.ts,
// types.ts, ...), the RUNNING daemon's in-memory state is stale: the widget
// registry and route table are loaded at process start, so new widgets return
// "Widget not found" until the process restarts. The daemon spawns from SOURCE
// (`bun run src/cli.ts`), so a plain restart picks up backend changes with NO
// build step (unlike the web bundle). These helpers detect backend staleness
// (startup, for an ADOPTED daemon, via `supervisor::adopt_decision`) and watch
// backend source at runtime, dispatching `SupervisorCmd::AutoRestart`. All
// gated on BACKEND source presence via `cockpit_backend_root` (NOT
// `watcher_web::cockpit_source_root`, which requires the web tree — reviewer
// R1 B1), like mt#2297 gates the rebuild on web presence.
// Split out of main.rs (mt#2628).
//
// mt#3048 (RFC "Conversation-first drive" Phase 1 slice 6) adds a turn-active
// pre-restart gate: `SupervisorCmd::AutoRestart` (dispatched below, distinct
// from the operator-explicit `SupervisorCmd::Restart`) is handled in
// `supervisor::run_supervisor` by spawning a background task that awaits
// `wait_for_turn_idle_or_grace_expiry` (this module) — a cheap query against
// the daemon's `GET /api/driven-session/turn-active` signal
// (src/cockpit/routes/driven-sessions.ts) that defers for a BOUNDED grace
// period while a driven session's turn is actively streaming, then re-sends
// `SupervisorCmd::Restart` regardless of outcome once done. The wait runs on
// a spawned task rather than inline in the handler so it never blocks the
// supervisor's single-threaded select loop (R2 fix — see the `AutoRestart`
// match arm's comment in supervisor.rs). The watcher's OWN trigger conditions
// (`is_relevant_backend_change` etc. below) are unchanged by this — the gate
// sits between "a relevant change was detected" and "the restart actually
// happens", not in the detection logic itself.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use tauri::{AppHandle, Manager};

use crate::supervisor::{resolve_repo_root, DaemonId, SupervisorCmd, SupervisorHandle};
use crate::watcher_web::is_editor_temp_file;

// ---------------------------------------------------------------------------
// mt#3048 — turn-active pre-restart gate.
// ---------------------------------------------------------------------------

// The mt#3048 "is any driven session mid-turn" signal endpoint used to be a
// third hardcoded `http://localhost:3737/...` constant here (mt#3988). It is
// now built by `crate::port::turn_active_url` from the same resolved port the
// supervisor probes and the webview loads — this endpoint gates AUTO-RESTART,
// so a stale port would have failed open against the wrong daemon and restarted
// the right one mid-turn.

/// Bounded grace period an `AutoRestart` waits for a driven session's
/// in-flight turn to finish before proceeding with the restart anyway. NOT
/// indefinite — the RFC's "Hard cases (a)" explicitly rejects an unbounded
/// deferral (a driven session can sit idle between turns for hours-days, so
/// "no active turn" must never become "never restart"). Once this elapses
/// with a turn apparently still active, the restart proceeds regardless: the
/// mt#3038 resume machinery (cross-process advisory lock, `claude --resume`,
/// interruption-notice injection) is the designed recovery path for that
/// case, not a failure this gate exists to prevent.
const TURN_ACTIVE_GRACE: Duration = Duration::from_secs(60);

/// Poll cadence while waiting out `TURN_ACTIVE_GRACE` above.
const TURN_ACTIVE_POLL_INTERVAL: Duration = Duration::from_secs(5);

/// Pure JSON-shape parse for the `GET /api/driven-session/turn-active`
/// response body (`{ active: boolean, activeSessionIds: string[] }` — see
/// src/cockpit/routes/driven-sessions.ts) — split out of `turn_active` so
/// this logic is unit-testable without a live HTTP fetch (mirrors
/// `poll_health_detail`'s `DbStatus` decode, tested the same way against a
/// fixture sample below). A missing or non-boolean `active` field parses as
/// `false` — the same "fail open" posture as every other failure branch in
/// `turn_active`.
fn parse_turn_active_body(json: &serde_json::Value) -> bool {
    json.get("active")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// Query the turn-active endpoint. Fails OPEN on ANY failure — connection error,
/// non-2xx status, or an unparseable/malformed body all count as "not
/// active" (`false`) — so a broken, slow, or not-yet-listening daemon never
/// blocks the watcher's restart (mirrors `supervisor::poll_health_detail`'s
/// defensive-parse posture: fail open on any network or parse failure). The
/// shared `client` already carries a bounded per-request timeout
/// (`run_supervisor`'s `reqwest::Client::builder().timeout(...)`), so the
/// common (no active turn) case costs one fast local HTTP round trip with no
/// perceptible added latency, and a hung/absent daemon costs no more than
/// that same bound before falling open.
async fn turn_active(client: &reqwest::Client) -> bool {
    let url = crate::port::turn_active_url(crate::port::cockpit_port());
    let resp = match client.get(url).send().await {
        Ok(r) if r.status().is_success() => r,
        _ => return false,
    };
    let json: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return false,
    };
    parse_turn_active_body(&json)
}

/// Awaited from a background task `tokio::spawn`ed by
/// `supervisor::run_supervisor`'s `SupervisorCmd::AutoRestart` handler — NOT
/// inline in that handler (mt#3048 R2 fix): the supervisor's `tokio::select!`
/// loop is single-threaded, so an inline await here would block every other
/// command (Start/Stop/Restart/Shutdown/Rebuild) and the watchdog poll arm
/// for up to `TURN_ACTIVE_GRACE`. The background task re-sends
/// `SupervisorCmd::Restart` once this returns, so the actual stop/spawn
/// always happens back on the main loop via the `Restart` arm. Returns
/// immediately (no added latency) when the first check finds no active turn
/// — the routine common case. Otherwise polls at `TURN_ACTIVE_POLL_INTERVAL`
/// until either the signal reports idle or `TURN_ACTIVE_GRACE` elapses,
/// whichever comes first, then returns unconditionally — the caller always
/// proceeds with the restart after this returns, regardless of the last
/// observed value.
pub(crate) async fn wait_for_turn_idle_or_grace_expiry(client: &reqwest::Client) {
    if !turn_active(client).await {
        return;
    }
    let deadline = Instant::now() + TURN_ACTIVE_GRACE;
    while Instant::now() < deadline {
        tokio::time::sleep(TURN_ACTIVE_POLL_INTERVAL).await;
        if !turn_active(client).await {
            return;
        }
    }
    // Grace period elapsed with a turn (apparently) still active — proceed
    // with the restart anyway; the mt#3038 resume machinery recovers it.
}

/// Debounce window for the backend-source watcher (mt#2299). Larger than
/// `watcher_web::BUILD_DEBOUNCE` because a process restart is more disruptive
/// than a bundle rebuild (it drops websocket connections + in-memory caches),
/// so we coalesce a burst of backend edits into a single restart.
const RESTART_DEBOUNCE: Duration = Duration::from_secs(2);

/// Path to the cockpit server-side source dir under a repo root.
pub(crate) fn cockpit_backend_src(repo_root: &Path) -> PathBuf {
    repo_root.join("src/cockpit")
}

/// Runtime-closure roots BEYOND `src/cockpit` whose change invalidates the
/// running daemon (mt#4230).
///
/// The daemon runs `bun run src/cli.ts`, so its import closure is `src/**` plus
/// `packages/**` — not `src/cockpit` alone. Until mt#4230 every mechanism here
/// modelled it as `src/cockpit`, which made a `packages/domain`-only change
/// invisible to all three at once: no auto-restart, no adoption-staleness
/// detection, and an `(src @ …)` uptime hint that read as current while the
/// daemon served stale code.
///
/// Scoped to each package's `src/` rather than the package root so the walk
/// skips `node_modules`, `dist`, and fixture trees without relying on
/// {@link BACKEND_WALK_EXCLUDES} to enumerate them.
///
/// Incident: 2026-08-17. mt#4212's fix was `packages/domain`-only; the daemon
/// kept serving the pre-merge commit for ~70 minutes while the bug recurred
/// live, and only an unrelated later commit that happened to touch
/// `src/cockpit` restarted it.
const WORKSPACE_PACKAGES_DIR: &str = "packages";

/// Every source root whose change should restart the daemon.
///
/// Always includes {@link cockpit_backend_src}, then DISCOVERS `packages/*/src`
/// rather than naming packages (mt#4230, PR #3083 R2). The first cut hardcoded
/// `packages/domain/src` + `packages/shared/src` — currently an exhaustive list
/// (`packages/` holds exactly those two, and `src/cli.ts` imports exactly those
/// two) — but a hardcoded set reproduces THIS TASK'S OWN BUG one level up: the
/// watched set drifts from the real import closure, silently, and the tell is a
/// daemon serving stale code with nothing to notice. Discovery cannot drift.
///
/// Results are sorted so the root order is deterministic across runs (directory
/// iteration order is not guaranteed), which keeps the watch order and any
/// order-sensitive test stable.
///
/// A missing or unreadable `packages/` yields just the cockpit root, so a
/// packaged or partial checkout degrades to the pre-mt#4230 behavior rather
/// than failing.
pub(crate) fn cockpit_backend_roots(repo_root: &Path) -> Vec<PathBuf> {
    let mut roots = vec![cockpit_backend_src(repo_root)];

    if let Ok(entries) = std::fs::read_dir(repo_root.join(WORKSPACE_PACKAGES_DIR)) {
        let mut discovered: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path().join("src"))
            .filter(|p| p.is_dir())
            .collect();
        discovered.sort();
        roots.extend(discovered);
    }

    roots
}

/// The repo root IF it resolves (has `src/cli.ts`) AND contains the backend
/// source dir (`src/cockpit`). Backend-restart analogue of
/// `watcher_web::cockpit_source_root` — gated on BACKEND source presence, NOT
/// the web tree. A checkout with backend source but no `src/cockpit/web`
/// (relocated/removed frontend) still gets auto-restart; `None` only on a
/// no-backend-source/packaged install (reviewer R1 B1, the originating cause
/// of the silent no-op).
pub(crate) fn cockpit_backend_root(path: &str) -> Option<PathBuf> {
    let root = resolve_repo_root(path)?;
    if cockpit_backend_src(&root).is_dir() {
        Some(root)
    } else {
        None
    }
}

/// Directory names excluded from the backend freshness walk AND watcher: `web`
/// (mt#2297 owns the frontend → rebuild path; backend restart must NOT fire on
/// web edits — acceptance test 6), plus deps/build/git internals, plus the
/// test-adjacent directory family (mt#4230, PR #3083 R1).
///
/// The last group arrived with the packages roots. This list was written for
/// `src/cockpit`, whose tree carries no fixture or mock directories, so the
/// per-file `.test.ts` suffix check was sufficient there. `packages/*/src` has
/// four such directories, and a non-test module inside one — currently one file,
/// `domain/src/transcripts/__fixtures__` — would restart the daemon on every
/// edit despite never being loaded at runtime. Measured at R1: 0 `.spec.ts` and
/// 544 `.test.ts` under the packages roots, so the suffix check already covered
/// the bulk; this closes the directory-shaped remainder.
const BACKEND_WALK_EXCLUDES: [&str; 8] = [
    "web",
    "node_modules",
    ".git",
    "dist",
    "__fixtures__",
    "__tests__",
    "__mocks__",
    "fixtures",
];

fn is_backend_excluded_dir(name: &std::ffi::OsStr) -> bool {
    BACKEND_WALK_EXCLUDES.iter().any(|e| name == *e)
}

/// True if a path (relative to the backend source root) lies under an excluded dir.
fn backend_path_is_excluded(path: &Path) -> bool {
    path.components().any(|c| match c {
        std::path::Component::Normal(name) => is_backend_excluded_dir(name),
        _ => false,
    })
}

/// A TypeScript module file the daemon loads — `.ts`/`.mts`/`.cts`, excluding
/// test files (`*.test.{ts,mts,cts}`). The cockpit backend is currently all
/// `.ts`, but `.mts`/`.cts` are included so a future ESM/CJS module still
/// triggers a restart (reviewer R1 NB1). Operator config
/// (`~/.config/minsky/cockpit.json`) lives outside `src/cockpit` and is loaded
/// fresh per request, so it is intentionally not part of the watched tree.
fn is_backend_module_file(name: &str) -> bool {
    const EXTS: [&str; 3] = [".ts", ".mts", ".cts"];
    // `.spec.*` joins `.test.*` at mt#4230 R1. The packages roots carry 0 of
    // them today, so this is pre-emptive rather than a measured miss — but the
    // convention is live elsewhere in the ecosystem and a first `.spec.ts` under
    // `packages/*/src` would otherwise restart the daemon on every edit, with
    // nothing to make the cause visible.
    const TEST_EXTS: [&str; 6] = [
        ".test.ts",
        ".test.mts",
        ".test.cts",
        ".spec.ts",
        ".spec.mts",
        ".spec.cts",
    ];
    EXTS.iter().any(|e| name.ends_with(e)) && !TEST_EXTS.iter().any(|e| name.ends_with(e))
}

/// True if a path **relative to the backend source root** is a real server-side
/// change worth a daemon restart: a non-test TS module file, not under an
/// excluded dir (esp. `web/`), not an editor temp file. Callers pass a
/// `src/cockpit`-relative path (mirrors `watcher_web::is_relevant_source_change`,
/// PR #1558).
fn is_relevant_backend_change(rel: &Path) -> bool {
    if backend_path_is_excluded(rel) {
        return false;
    }
    match rel.file_name().and_then(|n| n.to_str()) {
        Some(name) => is_backend_module_file(name) && !is_editor_temp_file(name),
        None => false,
    }
}

/// Newest mtime among relevant backend-source files under `root` (`src/cockpit`),
/// skipping excluded dirs. `None` if `root` is absent or has no relevant files.
pub(crate) fn newest_backend_mtime(root: &Path) -> Option<SystemTime> {
    fn walk(dir: &Path, root: &Path, newest: &mut Option<SystemTime>) {
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let file_type = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            let p = entry.path();
            if file_type.is_dir() {
                if entry.file_name().is_empty() || is_backend_excluded_dir(&entry.file_name()) {
                    continue;
                }
                walk(&p, root, newest);
            } else if let Ok(rel) = p.strip_prefix(root) {
                if is_relevant_backend_change(rel) {
                    if let Ok(mtime) = entry.metadata().and_then(|m| m.modified()) {
                        if newest.map_or(true, |n| mtime > n) {
                            *newest = Some(mtime);
                        }
                    }
                }
            }
        }
    }
    let mut newest = None;
    walk(root, root, &mut newest);
    newest
}

/// Newest mtime across EVERY runtime-closure root (mt#4230) — the daemon is
/// stale if ANY of them is newer than it, so this is a max over the per-root
/// answers, not a walk of one privileged tree.
pub(crate) fn newest_backend_mtime_across(roots: &[PathBuf]) -> Option<SystemTime> {
    roots.iter().filter_map(|r| newest_backend_mtime(r)).max()
}

/// Start the runtime backend-source watcher on `src/cockpit`. Mirrors
/// `watcher_web::start_web_watcher` but dispatches `SupervisorCmd::AutoRestart`
/// (not `Rebuild`) on a larger debounce — `AutoRestart`, not the operator-explicit
/// `Restart`, so the mt#3048 turn-active gate applies (see this module's
/// top-of-file doc comment). `web/**` events are filtered out (mt#2297 owns
/// them), so a frontend edit never triggers a backend restart. Hold the
/// returned `Debouncer` alive for the watch to persist.
pub(crate) fn start_backend_watcher(
    app: &AppHandle,
    backend_roots: &[PathBuf],
) -> Option<Debouncer<RecommendedWatcher>> {
    let tx = app.try_state::<SupervisorHandle>()?.0.clone();
    let roots: Vec<PathBuf> = backend_roots.to_vec();
    let mut debouncer = new_debouncer(RESTART_DEBOUNCE, move |res: DebounceEventResult| {
        if let Ok(events) = res {
            // Relevance is judged against WHICHEVER root contains the event
            // (mt#4230). The filter takes a root-relative path, so a single
            // hardcoded prefix would silently reject every event from the
            // packages roots — `strip_prefix` fails, `unwrap_or(false)`, no
            // restart, and nothing to notice.
            let relevant = events.iter().any(|e| {
                roots.iter().any(|root| {
                    e.path
                        .strip_prefix(root)
                        .map(is_relevant_backend_change)
                        .unwrap_or(false)
                })
            });
            if relevant {
                // Addressed to the cockpit entry: this watcher watches the
                // COCKPIT's backend source tree (mt#3815).
                let _ = tx.send(SupervisorCmd::AutoRestart(DaemonId::Cockpit));
            }
        }
    })
    .ok()?;
    // Every root is watched by the SAME debouncer, so a burst spanning two of
    // them coalesces into one restart rather than one per root.
    //
    // Partial failure degrades rather than failing closed (mt#4230, PR #3083 R1).
    // `.ok()?` inside this loop would abort the whole function on ONE bad root,
    // dropping the debouncer and with it EVERY watch — so an unreadable
    // `packages/shared/src` would silently disable auto-restart for
    // `src/cockpit` too, which worked fine before this task widened the roots.
    // Watching some roots strictly beats watching none; the count is returned to
    // the caller's decision below.
    let watched = backend_roots
        .iter()
        .filter(|root| {
            debouncer
                .watcher()
                .watch(root, RecursiveMode::Recursive)
                .is_ok()
        })
        .count();

    // Zero successful watches means the debouncer would sit inert forever, which
    // is indistinguishable from "no changes are happening" — report it as the
    // absence it is, so the caller's `Option` still carries a truthful signal.
    if watched == 0 {
        return None;
    }
    Some(debouncer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;

    fn touch(path: &Path, mtime: SystemTime) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("mkdir");
        }
        File::create(path).expect("create");
        // Set mtime via `filetime` (a dev-dependency) for deterministic,
        // toolchain-version-independent control of the freshness comparison.
        filetime::set_file_mtime(path, filetime::FileTime::from_system_time(mtime))
            .expect("set mtime");
    }

    fn tmp(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mt2297-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn backend_roots_include_the_daemons_real_import_closure() {
        // mt#4230: the daemon runs `bun run src/cli.ts`, so a `packages/**`
        // change invalidates it exactly as a `src/cockpit` change does.
        let repo = tmp("roots-full");
        for d in ["src/cockpit", "packages/domain/src", "packages/shared/src"] {
            std::fs::create_dir_all(repo.join(d)).expect("mkdir");
        }

        let roots = cockpit_backend_roots(&repo);

        assert_eq!(roots.len(), 3, "all three roots present: {roots:?}");
        assert!(roots.contains(&repo.join("src/cockpit")));
        assert!(roots.contains(&repo.join("packages/domain/src")));
        assert!(roots.contains(&repo.join("packages/shared/src")));
    }

    #[test]
    fn backend_roots_discover_a_package_nobody_named_in_code() {
        // R2: the watched set must not need editing when a package is added —
        // a hardcoded list is the same drift this task exists to fix, one level
        // up. `zzz-future` appears nowhere in this crate.
        let repo = tmp("roots-discovery");
        for d in ["src/cockpit", "packages/zzz-future/src"] {
            std::fs::create_dir_all(repo.join(d)).expect("mkdir");
        }

        let roots = cockpit_backend_roots(&repo);

        assert!(
            roots.contains(&repo.join("packages/zzz-future/src")),
            "discovered roots: {roots:?}"
        );
    }

    #[test]
    fn backend_roots_skip_a_package_with_no_src_dir() {
        // A package directory that is not a source tree (no `src/`) contributes
        // nothing — discovery must not watch a path that does not exist.
        let repo = tmp("roots-nosrc");
        std::fs::create_dir_all(repo.join("src/cockpit")).expect("mkdir");
        std::fs::create_dir_all(repo.join("packages/docs-only")).expect("mkdir");

        let roots = cockpit_backend_roots(&repo);

        assert_eq!(roots, vec![repo.join("src/cockpit")]);
    }

    #[test]
    fn newest_mtime_across_ignores_test_adjacent_dirs_under_packages() {
        // R1 BLOCKING: the exclusion list was written for `src/cockpit`, which
        // has no fixture/mock dirs. `packages/*/src` has four, and a non-test
        // module inside one would restart the daemon on every edit.
        let repo = tmp("across-fixtures");
        let old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        let new = SystemTime::UNIX_EPOCH + Duration::from_secs(2_000_000);
        touch(&repo.join("src/cockpit/server.ts"), old);
        touch(
            &repo.join("packages/domain/src/transcripts/__fixtures__/sample.ts"),
            new,
        );
        touch(&repo.join("packages/domain/src/tests/__mocks__/db.ts"), new);
        touch(&repo.join("packages/domain/src/repo/fixtures/seed.ts"), new);
        touch(
            &repo.join("packages/domain/src/detectors/__tests__/helper.ts"),
            new,
        );
        touch(&repo.join("packages/domain/src/parser.spec.ts"), new);

        let roots = cockpit_backend_roots(&repo);

        assert_eq!(
            newest_backend_mtime_across(&roots),
            Some(old),
            "every changed file is test-adjacent and must not count"
        );
    }

    #[test]
    fn backend_roots_degrade_when_packages_are_absent() {
        // A packaged or partial checkout keeps the pre-mt#4230 behavior rather
        // than watching a path that does not exist.
        let repo = tmp("roots-partial");
        std::fs::create_dir_all(repo.join("src/cockpit")).expect("mkdir");

        let roots = cockpit_backend_roots(&repo);

        assert_eq!(roots, vec![repo.join("src/cockpit")]);
    }

    #[test]
    fn newest_mtime_across_sees_a_packages_only_change() {
        // The originating incident, as a unit test: the cockpit tree is OLD and
        // only `packages/domain/src` is new. Walking `src/cockpit` alone — the
        // pre-mt#4230 behavior — reports the old mtime and the daemon is judged
        // fresh while serving stale code.
        let repo = tmp("across");
        let old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        let new = SystemTime::UNIX_EPOCH + Duration::from_secs(2_000_000);
        touch(&repo.join("src/cockpit/server.ts"), old);
        touch(&repo.join("packages/domain/src/tasks.ts"), new);

        let roots = cockpit_backend_roots(&repo);

        // Negative control: the single-root walk this change replaces cannot
        // see the newer file at all.
        assert_eq!(newest_backend_mtime(&cockpit_backend_src(&repo)), Some(old));
        // The widened walk does.
        assert_eq!(newest_backend_mtime_across(&roots), Some(new));
    }

    #[test]
    fn newest_mtime_across_applies_the_relevance_filter_in_every_root() {
        // The excludes are not `src/cockpit`-specific — a test file or a
        // `node_modules` entry under a packages root must not count either,
        // or widening the roots would restart the daemon on every test edit.
        let repo = tmp("across-filter");
        let old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        let new = SystemTime::UNIX_EPOCH + Duration::from_secs(2_000_000);
        touch(&repo.join("src/cockpit/server.ts"), old);
        touch(&repo.join("packages/domain/src/tasks.test.ts"), new);
        touch(
            &repo.join("packages/domain/src/node_modules/dep/index.ts"),
            new,
        );
        touch(&repo.join("packages/domain/src/README.md"), new);

        let roots = cockpit_backend_roots(&repo);

        assert_eq!(
            newest_backend_mtime_across(&roots),
            Some(old),
            "only irrelevant files changed under the packages root"
        );
    }

    #[test]
    fn is_relevant_backend_change_filters_web_test_and_nonts() {
        // Real server-side .ts edits trigger a restart.
        assert!(is_relevant_backend_change(Path::new("server.ts")));
        assert!(is_relevant_backend_change(Path::new("widget-registry.ts")));
        assert!(is_relevant_backend_change(Path::new("widgets/agents.ts")));
        assert!(is_relevant_backend_change(Path::new("config.ts")));
        // web/** is mt#2297's territory — must NOT restart the daemon (test 6).
        assert!(!is_relevant_backend_change(Path::new("web/App.tsx")));
        assert!(!is_relevant_backend_change(Path::new(
            "web/dist/index.html"
        )));
        // deps/git internals excluded.
        assert!(!is_relevant_backend_change(Path::new(
            "node_modules/x/y.ts"
        )));
        assert!(!is_relevant_backend_change(Path::new(".git/HEAD")));
        // non-.ts, test files, and editor temp files excluded.
        assert!(!is_relevant_backend_change(Path::new("README.md")));
        assert!(!is_relevant_backend_change(Path::new("server.test.ts")));
        assert!(!is_relevant_backend_change(Path::new(
            "widgets/.agents.ts.swp"
        )));
        // .mts/.cts modules trigger; their test variants don't (reviewer R1 NB1).
        assert!(is_relevant_backend_change(Path::new("server.mts")));
        assert!(is_relevant_backend_change(Path::new("server.cts")));
        assert!(!is_relevant_backend_change(Path::new("server.test.mts")));
        assert!(!is_relevant_backend_change(Path::new("server.test.cts")));
    }

    #[test]
    fn newest_backend_mtime_ignores_web_test_and_excluded() {
        let dir = tmp("backend");
        let base = std::time::UNIX_EPOCH + Duration::from_secs(1_000_000);
        touch(&dir.join("server.ts"), base);
        touch(
            &dir.join("widgets/agents.ts"),
            base + Duration::from_secs(10),
        );
        // Newer files that must NOT count: web/** (mt#2297), test files, deps.
        touch(&dir.join("web/App.tsx"), base + Duration::from_secs(100));
        touch(&dir.join("server.test.ts"), base + Duration::from_secs(100));
        touch(
            &dir.join("node_modules/x.ts"),
            base + Duration::from_secs(100),
        );
        assert_eq!(
            newest_backend_mtime(&dir),
            Some(base + Duration::from_secs(10))
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // -----------------------------------------------------------------------
    // mt#3048 — turn-active signal parsing (pure logic; no live HTTP fetch).
    // -----------------------------------------------------------------------

    #[test]
    fn parse_turn_active_body_true_when_active_is_true() {
        let json: serde_json::Value = serde_json::json!({
            "active": true,
            "activeSessionIds": ["a-1"],
        });
        assert!(parse_turn_active_body(&json));
    }

    #[test]
    fn parse_turn_active_body_false_when_active_is_false() {
        let json: serde_json::Value = serde_json::json!({
            "active": false,
            "activeSessionIds": [],
        });
        assert!(!parse_turn_active_body(&json));
    }

    #[test]
    fn parse_turn_active_body_fails_open_when_active_is_missing() {
        // Malformed/older/mismatched response shape — never crash, never
        // block the watcher: treat as "not active".
        let json: serde_json::Value = serde_json::json!({ "activeSessionIds": [] });
        assert!(!parse_turn_active_body(&json));
    }

    #[test]
    fn parse_turn_active_body_fails_open_when_active_is_the_wrong_type() {
        let json: serde_json::Value = serde_json::json!({ "active": "yes" });
        assert!(!parse_turn_active_body(&json));
    }

    #[test]
    fn parse_turn_active_body_fails_open_on_a_non_object_body() {
        let json: serde_json::Value = serde_json::json!([1, 2, 3]);
        assert!(!parse_turn_active_body(&json));
    }
}
