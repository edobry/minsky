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
// backend source at runtime, dispatching the existing `SupervisorCmd::Restart`.
// All gated on BACKEND source presence via `cockpit_backend_root` (NOT
// `watcher_web::cockpit_source_root`, which requires the web tree — reviewer
// R1 B1), like mt#2297 gates the rebuild on web presence.
// Split out of main.rs (mt#2628).

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use tauri::{AppHandle, Manager};

use crate::supervisor::{resolve_repo_root, SupervisorCmd, SupervisorHandle};
use crate::watcher_web::is_editor_temp_file;

/// Debounce window for the backend-source watcher (mt#2299). Larger than
/// `watcher_web::BUILD_DEBOUNCE` because a process restart is more disruptive
/// than a bundle rebuild (it drops websocket connections + in-memory caches),
/// so we coalesce a burst of backend edits into a single restart.
const RESTART_DEBOUNCE: Duration = Duration::from_secs(2);

/// Path to the cockpit server-side source dir under a repo root.
pub(crate) fn cockpit_backend_src(repo_root: &Path) -> PathBuf {
    repo_root.join("src/cockpit")
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
/// web edits — acceptance test 6), plus deps/build/git internals.
const BACKEND_WALK_EXCLUDES: [&str; 4] = ["web", "node_modules", ".git", "dist"];

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
    const TEST_EXTS: [&str; 3] = [".test.ts", ".test.mts", ".test.cts"];
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

/// Start the runtime backend-source watcher on `src/cockpit`. Mirrors
/// `watcher_web::start_web_watcher` but dispatches `SupervisorCmd::Restart`
/// (not `Rebuild`) on a larger debounce. `web/**` events are filtered out
/// (mt#2297 owns them), so a frontend edit never triggers a backend restart.
/// Hold the returned `Debouncer` alive for the watch to persist.
pub(crate) fn start_backend_watcher(
    app: &AppHandle,
    backend_src: &Path,
) -> Option<Debouncer<RecommendedWatcher>> {
    let tx = app.try_state::<SupervisorHandle>()?.0.clone();
    let root = backend_src.to_path_buf();
    let mut debouncer = new_debouncer(RESTART_DEBOUNCE, move |res: DebounceEventResult| {
        if let Ok(events) = res {
            let relevant = events.iter().any(|e| {
                e.path
                    .strip_prefix(&root)
                    .map(is_relevant_backend_change)
                    .unwrap_or(false)
            });
            if relevant {
                let _ = tx.send(SupervisorCmd::Restart);
            }
        }
    })
    .ok()?;
    debouncer
        .watcher()
        .watch(backend_src, RecursiveMode::Recursive)
        .ok()?;
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
}
