// Cockpit-web bundle freshness + auto-rebuild (mt#2297).
//
// The tray serves the pre-built production bundle (src/cockpit/web/dist). When
// the operator runs from a source checkout, source files drift ahead of dist
// (e.g. after `git pull`), so the daemon silently serves a stale UI. These
// helpers keep dist fresh: a startup pre-flight rebuild + a runtime filesystem
// watcher. ALL of it is gated on source presence (`cockpit_source_root`); a
// packaged/no-source install skips every path and serves the shipped bundle.
// Split out of main.rs (mt#2628).

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::supervisor::{
    open_log, resolve_repo_root, set_status, BuildMenuItem, Sup, SupervisorCmd, SupervisorHandle,
    LABEL_BUILDING,
};

/// Debounce window for coalescing bursty editor-save events before a rebuild.
const BUILD_DEBOUNCE: Duration = Duration::from_millis(500);

/// Directory names excluded from the freshness walk AND the runtime watcher:
/// the build OUTPUT (`dist` — counting it would make a rebuild re-trigger
/// itself), installed deps (`node_modules`), and git internals (`.git`).
const WALK_EXCLUDES: [&str; 3] = ["dist", "node_modules", ".git"];

fn is_excluded_dir(name: &std::ffi::OsStr) -> bool {
    WALK_EXCLUDES.iter().any(|e| name == *e)
}

/// True if `path` lies inside any excluded directory. Used by the watcher's
/// event filter so our own `dist/` writes don't loop the rebuild.
fn path_is_excluded(path: &Path) -> bool {
    path.components().any(|c| match c {
        std::path::Component::Normal(name) => is_excluded_dir(name),
        _ => false,
    })
}

/// Editor temp/backup/hidden files that shouldn't trigger a rebuild (vim `.swp`,
/// emacs `#file#`, `~` backups, `.tmp`, dotfiles like `.DS_Store`). Keyed on the
/// file name only. Shared with `watcher_backend` (identical filter applies to
/// backend-source changes).
pub(crate) fn is_editor_temp_file(name: &str) -> bool {
    name.starts_with('.')
        || name.starts_with('#')
        || name.ends_with('~')
        || name.ends_with(".tmp")
        || name.ends_with(".swp")
}

/// True if a path **relative to the cockpit-web source root** is a real source
/// change worth a rebuild: not under an excluded dir, and not an editor temp
/// file. Callers pass a `web_src`-relative path so an ANCESTOR dir named
/// `dist`/`node_modules`/`.git` (e.g. the repo lives under one) can't suppress
/// every event (reviewer R1, PR #1558).
fn is_relevant_source_change(rel: &Path) -> bool {
    if path_is_excluded(rel) {
        return false;
    }
    match rel.file_name().and_then(|n| n.to_str()) {
        Some(name) => !is_editor_temp_file(name),
        None => false,
    }
}

/// Recursively find the newest mtime under `root`, skipping excluded dirs.
/// Returns `None` if `root` doesn't exist or has no readable entries. The
/// cockpit-web source tree is small (~60 files), so this completes well under
/// the 200ms fast-path budget; excluded dirs (dist/node_modules/.git) are
/// pruned before descent so the walk never touches the large subtrees.
fn newest_mtime_excluding(root: &Path) -> Option<SystemTime> {
    fn walk(dir: &Path, newest: &mut Option<SystemTime>) {
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let file_type = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if file_type.is_dir() {
                if entry.file_name().is_empty() || is_excluded_dir(&entry.file_name()) {
                    continue;
                }
                walk(&entry.path(), newest);
            } else if let Ok(mtime) = entry.metadata().and_then(|m| m.modified()) {
                if newest.map_or(true, |n| mtime > n) {
                    *newest = Some(mtime);
                }
            }
        }
    }
    let mut newest = None;
    walk(root, &mut newest);
    newest
}

/// Staleness verdict for the built bundle vs the source tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Staleness {
    /// No built bundle (dist/index.html missing) — must build before serving.
    NoDist,
    /// A bundle exists but source is newer — rebuild; the prior bundle can serve.
    Stale,
    /// Bundle is at least as new as every source file — serve as-is.
    Fresh,
}

/// Compare the built bundle's mtime against the newest source mtime.
fn dist_staleness(web_src: &Path) -> Staleness {
    let dist_mtime = match std::fs::metadata(dist_index(web_src)).and_then(|m| m.modified()) {
        Ok(t) => t,
        Err(_) => return Staleness::NoDist,
    };
    match newest_mtime_excluding(web_src) {
        Some(src) if src > dist_mtime => Staleness::Stale,
        _ => Staleness::Fresh,
    }
}

/// Path to the cockpit web source dir under a repo root.
pub(crate) fn cockpit_web_src(repo_root: &Path) -> PathBuf {
    repo_root.join("src/cockpit/web")
}

/// The built SPA entry whose mtime stands for "when the bundle was last built".
fn dist_index(web_src: &Path) -> PathBuf {
    web_src.join("dist/index.html")
}

/// Format a wall-clock instant as `HH:MM:SS UTC` without a date crate. Shared
/// with `supervisor::uptime_label`, which renders the same timestamp shape for
/// the daemon's backend-source version.
pub(crate) fn format_hms_utc(t: SystemTime) -> String {
    let secs = t
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let sod = secs % 86_400;
    format!(
        "{:02}:{:02}:{:02} UTC",
        sod / 3600,
        (sod % 3600) / 60,
        sod % 60
    )
}

/// The repo root IF it both resolves (has `src/cli.ts`) AND contains the cockpit
/// web source. `None` for a no-source/packaged install — the signal that all
/// auto-rebuild machinery must no-op (mt#2297 source-presence gate).
pub(crate) fn cockpit_source_root(path: &str) -> Option<PathBuf> {
    let root = resolve_repo_root(path)?;
    if cockpit_web_src(&root).is_dir() {
        Some(root)
    } else {
        None
    }
}

/// Pick a short human summary from a failed build's output: the last non-empty
/// stderr line (vite/esbuild errors go to stderr), falling back to stdout,
/// capped for a menu item.
fn build_error_summary(stderr: &[u8], stdout: &[u8]) -> String {
    let pick = |bytes: &[u8]| -> Option<String> {
        String::from_utf8_lossy(bytes)
            .lines()
            .rev()
            .map(|l| l.trim())
            .find(|l| !l.is_empty())
            .map(|l| l.to_string())
    };
    let mut s = pick(stderr)
        .or_else(|| pick(stdout))
        .unwrap_or_else(|| "build failed".to_string());
    const MAX: usize = 120;
    if s.chars().count() > MAX {
        s = s.chars().take(MAX).collect::<String>() + "...";
    }
    s
}

/// Run `bun run cockpit:build` in `repo_root`. Returns `Ok` on success, or
/// `Err(summary)` with the tail of the build output. Full output is appended to
/// the cockpit build log for diagnostics regardless of outcome.
pub(crate) fn run_cockpit_build(bun: &Path, repo_root: &Path, path: &str) -> Result<(), String> {
    let output = Command::new(bun)
        .args(["run", "cockpit:build"])
        .current_dir(repo_root)
        .env("PATH", path)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("could not launch bun: {e}"))?;
    if let Ok(mut log) = open_log("cockpit-build.log") {
        use std::io::Write;
        let _ = writeln!(
            log,
            "--- cockpit:build {} ---\n{}{}",
            if output.status.success() {
                "OK"
            } else {
                "FAILED"
            },
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
    }
    if output.status.success() {
        Ok(())
    } else {
        Err(build_error_summary(&output.stderr, &output.stdout))
    }
}

/// Outcome of a pre-spawn freshness check + rebuild.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PreflightResult {
    /// Safe to spawn the daemon (bundle fresh, rebuilt OK, or stale-but-serving).
    Proceed,
    /// Refuse to spawn — no servable bundle and the build failed.
    Refuse,
}

/// Compute the build-status menu label for a finished/failed/in-progress build.
fn build_label_for(result: &Result<(), String>, now: SystemTime, servable_prior: bool) -> String {
    match result {
        Ok(()) => format!("Last build: {}", format_hms_utc(now)),
        Err(e) if servable_prior => format!("Build FAILED ({e}) - serving prior bundle"),
        Err(e) => format!("Build FAILED ({e}) - nothing to serve"),
    }
}

/// Source-gated pre-flight rebuild, run inside `do_spawn` before the daemon is
/// spawned. Caller must have already confirmed the web source is present.
pub(crate) fn preflight_rebuild(
    app: &AppHandle,
    sup: &mut Sup,
    bun: &Path,
    repo_root: &Path,
    path: &str,
) -> PreflightResult {
    let web_src = cockpit_web_src(repo_root);
    match dist_staleness(&web_src) {
        Staleness::Fresh => PreflightResult::Proceed,
        staleness => {
            let servable_prior = staleness == Staleness::Stale;
            set_status(app, sup, LABEL_BUILDING);
            set_build_status(app, sup, "Rebuilding bundle...".to_string());
            let result = run_cockpit_build(bun, repo_root, path);
            let proceed = result.is_ok() || servable_prior;
            report_build_result(app, sup, &result, servable_prior);
            if proceed {
                PreflightResult::Proceed
            } else {
                PreflightResult::Refuse
            }
        }
    }
}

/// Start the runtime filesystem watcher on the cockpit-web source tree. Events
/// under excluded dirs (our own `dist/` writes, node_modules, .git) are filtered
/// out so a rebuild can't re-trigger itself. A relevant change sends a debounced
/// `Rebuild` command to the supervisor. The returned `Debouncer` must be held
/// alive for the watch to persist.
pub(crate) fn start_web_watcher(
    app: &AppHandle,
    web_src: &Path,
) -> Option<Debouncer<RecommendedWatcher>> {
    let tx = app.try_state::<SupervisorHandle>()?.0.clone();
    let root = web_src.to_path_buf();
    let mut debouncer = new_debouncer(BUILD_DEBOUNCE, move |res: DebounceEventResult| {
        if let Ok(events) = res {
            // Filter on the path RELATIVE to web_src so an ancestor dir named
            // dist/node_modules/.git can't suppress every event; also drop
            // editor temp files (reviewer R1, PR #1558).
            let relevant = events.iter().any(|e| {
                e.path
                    .strip_prefix(&root)
                    .map(is_relevant_source_change)
                    .unwrap_or(false)
            });
            if relevant {
                let _ = tx.send(SupervisorCmd::Rebuild);
            }
        }
    })
    .ok()?;
    debouncer
        .watcher()
        .watch(web_src, RecursiveMode::Recursive)
        .ok()?;
    Some(debouncer)
}

/// Update the build-status dropdown line on the main thread (mt#2297).
fn update_build_status(app: &AppHandle, label: &str) -> tauri::Result<()> {
    let app_handle = app.clone();
    let label = label.to_string();
    app.run_on_main_thread(move || {
        if let Some(item) = app_handle.try_state::<BuildMenuItem>() {
            let _ = item.0.set_text(&label);
        }
    })
}

/// Set the build-status label, skipping the UI round-trip when unchanged.
pub(crate) fn set_build_status(app: &AppHandle, sup: &mut Sup, label: String) {
    if sup.last_build_label.as_deref() == Some(label.as_str()) {
        return;
    }
    sup.last_build_label = Some(label.clone());
    let _ = update_build_status(app, &label);
}

/// Fire a best-effort OS-toast on build failure (mt#2306). Additive to the
/// status label + "Last build" menu line; ignored if notification permission is
/// unavailable.
fn notify_build_failure(app: &AppHandle, summary: &str) {
    let _ = app
        .notification()
        .builder()
        .title("Cockpit bundle build failed")
        .body(summary)
        .show();
}

/// Set the build-status label AND fire an OS-toast when the build failed.
/// Success updates the label only (no toast).
pub(crate) fn report_build_result(
    app: &AppHandle,
    sup: &mut Sup,
    result: &Result<(), String>,
    servable_prior: bool,
) {
    let label = build_label_for(result, SystemTime::now(), servable_prior);
    set_build_status(app, sup, label.clone());
    if result.is_err() {
        notify_build_failure(app, &label);
    }
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
    fn dist_staleness_no_dist_when_index_missing() {
        let dir = tmp("nodist");
        touch(&dir.join("App.tsx"), SystemTime::now());
        assert_eq!(dist_staleness(&dir), Staleness::NoDist);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn dist_staleness_fresh_when_dist_newer() {
        let dir = tmp("fresh");
        let base = UNIX_EPOCH + Duration::from_secs(1_000_000);
        touch(&dir.join("App.tsx"), base);
        touch(&dist_index(&dir), base + Duration::from_secs(10));
        assert_eq!(dist_staleness(&dir), Staleness::Fresh);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn dist_staleness_stale_when_source_newer() {
        let dir = tmp("stale");
        let base = UNIX_EPOCH + Duration::from_secs(1_000_000);
        touch(&dist_index(&dir), base);
        touch(&dir.join("widgets/Foo.tsx"), base + Duration::from_secs(10));
        assert_eq!(dist_staleness(&dir), Staleness::Stale);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn dist_staleness_ignores_excluded_dirs() {
        let dir = tmp("excl");
        let base = UNIX_EPOCH + Duration::from_secs(1_000_000);
        touch(&dir.join("App.tsx"), base);
        touch(&dist_index(&dir), base + Duration::from_secs(10));
        // Newer files under excluded dirs must NOT flip the verdict to Stale.
        touch(
            &dir.join("node_modules/pkg/x.js"),
            base + Duration::from_secs(100),
        );
        touch(
            &dir.join("dist/assets/app.js"),
            base + Duration::from_secs(100),
        );
        touch(&dir.join(".git/HEAD"), base + Duration::from_secs(100));
        assert_eq!(dist_staleness(&dir), Staleness::Fresh);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn path_is_excluded_matches_excluded_dirs() {
        assert!(path_is_excluded(Path::new(
            "/r/src/cockpit/web/dist/index.html"
        )));
        assert!(path_is_excluded(Path::new(
            "/r/src/cockpit/web/node_modules/x/y.js"
        )));
        assert!(path_is_excluded(Path::new("/r/src/cockpit/web/.git/HEAD")));
        assert!(!path_is_excluded(Path::new(
            "/r/src/cockpit/web/widgets/Foo.tsx"
        )));
        assert!(!path_is_excluded(Path::new("/r/src/cockpit/web/App.tsx")));
    }

    #[test]
    fn is_relevant_source_change_filters_excluded_and_temp() {
        // Real source edits (paths relative to web_src) trigger a rebuild.
        assert!(is_relevant_source_change(Path::new("widgets/Foo.tsx")));
        assert!(is_relevant_source_change(Path::new("App.tsx")));
        // Excluded dirs do not.
        assert!(!is_relevant_source_change(Path::new("dist/assets/app.js")));
        assert!(!is_relevant_source_change(Path::new("node_modules/x/y.js")));
        assert!(!is_relevant_source_change(Path::new(".git/HEAD")));
        // Editor temp/backup/hidden files do not.
        assert!(!is_relevant_source_change(Path::new(
            "widgets/.Foo.tsx.swp"
        )));
        assert!(!is_relevant_source_change(Path::new("widgets/Foo.tsx~")));
        assert!(!is_relevant_source_change(Path::new("widgets/#Foo.tsx#")));
    }

    #[test]
    fn format_hms_utc_formats_seconds_of_day() {
        assert_eq!(
            format_hms_utc(UNIX_EPOCH + Duration::from_secs(3661)),
            "01:01:01 UTC"
        );
        assert_eq!(
            format_hms_utc(UNIX_EPOCH + Duration::from_secs(86_400 * 100)),
            "00:00:00 UTC"
        );
    }

    #[test]
    fn build_error_summary_takes_last_nonempty_line() {
        assert_eq!(
            build_error_summary(b"warn\n\nError: boom\n\n", b""),
            "Error: boom"
        );
        assert_eq!(build_error_summary(b"", b"out line\n"), "out line");
        assert_eq!(build_error_summary(b"", b""), "build failed");
    }

    #[test]
    fn build_label_for_renders_states() {
        let t = UNIX_EPOCH + Duration::from_secs(3661);
        assert_eq!(
            build_label_for(&Ok(()), t, false),
            "Last build: 01:01:01 UTC"
        );
        assert_eq!(
            build_label_for(&Err("E".to_string()), t, true),
            "Build FAILED (E) - serving prior bundle"
        );
        assert_eq!(
            build_label_for(&Err("E".to_string()), t, false),
            "Build FAILED (E) - nothing to serve"
        );
    }
}
