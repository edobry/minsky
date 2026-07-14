/**
 * Cockpit health + widget-metadata routes (mt#2615 — extracted from server.ts).
 *
 *   GET /api/health           — health + version + uptime
 *   GET /api/widgets          — metadata for every registered widget
 *   GET /api/widget/:id/data  — fetch a single widget's data (registry-gated;
 *                               404 only for ids absent from WIDGET_REGISTRY)
 *
 * The /api/health response shape is pinned against the Rust tray supervisor
 * (`cockpit-tray/src-tauri/src/supervisor.rs`'s `health_ok` / `poll_health_detail`,
 * which polls this endpoint from a process that may run with no Minsky
 * CLI/MCP process alive at all) via the shared golden fixture
 * `contract/cockpit-health-shape.json` (mt#2629). See
 * `src/cockpit/health-contract.test.ts` and `contract/README.md`. Renaming,
 * removing, or re-typing a field below without updating the fixture (and,
 * for `db`/`processStartedAtMs`, the Rust parsing code) fails a test on
 * both sides.
 */
import type express from "express";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { TranscriptWatcherTracker } from "../transcript-watcher-tracker";
import { TranscriptSweepTracker } from "../transcript-sweep-tracker";
import { DispatchWatchdogSweepTracker } from "../dispatch-watchdog";
import { getDbStatus } from "../shared-persistence";
import type { WidgetModule } from "../types";

const serverStartTime = Date.now();

/**
 * Hard cap on a single widget's fetch when serving /api/widget/:id/data
 * (mt#2765). Generous relative to any healthy widget (slowest observed ~3s)
 * but bounded so one wedged widget cannot pin browser connections forever.
 */
const WIDGET_FETCH_TIMEOUT_MS = 30_000;

/**
 * Consecutive DB-degraded poll counter (mt#2578 watchdog TS slice).
 *
 * Incremented on each /api/health call when db !== "ok"; reset to 0 when db === "ok".
 * The tray watchdog reads this (alongside db field) to distinguish a transient failure
 * from a sustained DB outage without needing to track poll history on its own.
 * Module-level (not per-request) — intentional: the counter persists across health polls.
 */
let consecutiveDegradedCount = 0;

// Lazy + memoized: this module loads during CLI command registration (e.g. on
// `--help`), so a module-level spawn would run `git rev-parse` — and leak
// `fatal: not a git repository` from non-repo cwds — on commands that never
// touch the cockpit (mt#1428). `stdio: "pipe"` keeps the child's stderr out of
// the parent's output either way.
let gitCommit: string | undefined;
function getGitCommit(): string {
  if (gitCommit === undefined) {
    try {
      gitCommit = String(
        execSync("git rev-parse --short HEAD", { encoding: "utf-8", stdio: "pipe" })
      ).trim();
    } catch {
      gitCommit = "unknown";
    }
  }
  return gitCommit;
}

/** Options accepted by {@link mountHealthRoutes}. */
export interface HealthRoutesOptions {
  /** __dirname of server.ts — used to resolve package.json for the version field. */
  serverDirname: string;
  /** Every registered widget, keyed by id (registry-gated data endpoint). */
  availableWidgets: Map<string, WidgetModule>;
}

/** Mount /api/health, /api/widgets, and /api/widget/:id/data on `app`. */
export function mountHealthRoutes(app: express.Express, opts: HealthRoutesOptions): void {
  const { serverDirname, availableWidgets } = opts;

  /** GET /api/health */
  app.get("/api/health", (_req, res) => {
    const uptimeSec = Math.floor((Date.now() - serverStartTime) / 1000);
    let version = "unknown";
    try {
      // Attempt to read version from package.json relative to project root
      const pkgPath = path.join(serverDirname, "..", "..", "package.json");
      const raw = String(fs.readFileSync(pkgPath));
      const pkg = JSON.parse(raw) as { version?: string };
      version = pkg.version ?? "unknown";
    } catch {
      // fallback: unknown
    }
    // Transcript watcher observability (mt#2320 SC2/SC5): the watcher runs in
    // THIS cockpit process, so its tracker singleton is readable here directly
    // (it is intentionally not on debug_systemInfo, which is a different
    // process). Exposes aggregate counters + the per-session freshness registry.
    const watcherTracker = TranscriptWatcherTracker.getInstance();
    // Transcript sweep backstop observability (mt#2321 SC3): the sweep also runs
    // in THIS cockpit process. Aggregate counters only; no raw error strings
    // (redaction policy — same as the watcher tracker above, per reviewer R1 on
    // mt#2320).
    const sweepTracker = TranscriptSweepTracker.getInstance();
    // Dispatch-watchdog sweep observability (mt#2646 R1 non-blocking #2):
    // same in-process-singleton shape as the transcript sweep tracker above.
    const dispatchWatchdogSweepTracker = DispatchWatchdogSweepTracker.getInstance();

    // mt#2578 watchdog TS slice: update the consecutive-degraded counter.
    // "ok" resets; anything else (degraded, unreachable, or unexpected) increments.
    const dbStatus = getDbStatus();
    if (dbStatus === "ok") {
      consecutiveDegradedCount = 0;
    } else {
      consecutiveDegradedCount++;
    }

    res.json({
      status: "ok",
      version,
      commit: getGitCommit(),
      uptimeSec,
      // gh#1761: last-known DB connection status. "ok" after a successful init;
      // "degraded" when a circuit-breaker or auth error has been received and
      // the retry loop is running; "unreachable" before any init attempt.
      // Read-only: does NOT probe the DB on every health poll.
      db: dbStatus,
      // mt#2578 watchdog fields — consumed by the tray's self-health watchdog.
      // processStartedAtMs: monotonic epoch-ms of when THIS process started.
      // A change between successive polls means the daemon restarted.
      processStartedAtMs: serverStartTime,
      // consecutiveDegraded: how many consecutive /api/health calls have seen
      // db !== "ok". Resets to 0 on "ok". Read-only mirror of consecutiveDegradedCount.
      consecutiveDegraded: consecutiveDegradedCount,
      transcriptWatcher: {
        ...watcherTracker.getSummary(),
        activeSessions: watcherTracker.getActiveSessions(),
      },
      transcriptSweep: sweepTracker.getSummary(),
      dispatchWatchdogSweep: dispatchWatchdogSweepTracker.getSummary(),
    });
  });

  /** GET /api/widgets — metadata for every registered widget */
  app.get("/api/widgets", (_req, res) => {
    const widgets = Array.from(availableWidgets.values()).map((w) => ({
      id: w.id,
      title: w.title,
      updateMode: w.updateMode,
    }));
    res.json(widgets);
  });

  /** GET /api/widget/:id/data — registry-gated; 404 only for unregistered ids */
  app.get("/api/widget/:id/data", async (req, res) => {
    const widget = availableWidgets.get(req.params.id);
    if (!widget) {
      res.status(404).json({ error: "Widget not found" });
      return;
    }
    try {
      const query: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.query)) {
        if (typeof v === "string") query[k] = v;
      }
      // Deadline (mt#2765): a wedged widget fetch must degrade, never hold the
      // request open forever — the reviewer widget's pool wedge left the
      // overview card on "Loading…" indefinitely because this await had no
      // bound. The losing fetch keeps running (no cancellation seam on
      // WidgetModule.fetch today); the deadline only caps the HTTP response.
      //
      // Contract note (PR #1895 R1): the timeout response is HTTP 200 with
      // `{ state: "degraded" }` — DELIBERATELY, not an oversight. The widget
      // data contract is state-keyed, not HTTP-status-keyed: the pre-existing
      // crash path below returns 200 + degraded the same way, and the sole
      // consumer (`src/cockpit/web/lib/widget-client.ts` fetchWidgetData)
      // never inspects `res.ok`/status — it parses the body and branches on
      // `state`. A 503 here would diverge from every other degraded response
      // for zero consumer benefit.
      let deadlineHandle: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<{ state: "degraded"; reason: string }>((resolve) => {
        deadlineHandle = setTimeout(
          () =>
            resolve({
              state: "degraded",
              reason: `widget fetch timed out after ${WIDGET_FETCH_TIMEOUT_MS / 1000}s`,
            }),
          WIDGET_FETCH_TIMEOUT_MS
        );
        deadlineHandle.unref?.();
      });
      try {
        const data = await Promise.race([widget.fetch({ id: req.params.id, query }), deadline]);
        res.json(data);
      } finally {
        if (deadlineHandle) clearTimeout(deadlineHandle);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.json({ state: "degraded", reason: `Widget crashed: ${message}` });
    }
  });
}
