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
import { ProdStateSweepTracker } from "../prod-state-sweep-tracker";
import { getSweepLivenessSnapshot } from "../sweepers";
import { deriveHealthSweepLiveness } from "../health-sweep-liveness";
import {
  getDbCheck,
  getDbHealth,
  getDbRecycle,
  getDbStatus,
  refreshDbReachability,
} from "../shared-persistence";
import { getSurvivedExceptions } from "../daemon-error-policy";
import { getPrincipalChannelStatus } from "../principal-channel-launch";
import { getSchemaReadiness } from "../schema-readiness";
import { findRepoRoot } from "../web-dist";
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
//
// Names the DAEMON, not the bundle (mt#3241). The memo freezes this at the first
// /api/health call, which is correct: this process runs the code it loaded at
// start. Do NOT "fix" it to recompute per request — that reports the workspace's
// HEAD, which this process is not executing. The web bundle is versioned
// separately (rebuilt by mt#2297's watcher without a restart) and carries its own
// `__BUILD_COMMIT__`; `RailFooter` renders and labels both.
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
    // Prod-state sweep observability (mt#3039): same in-process-singleton
    // shape as the trackers above. Distinguishes "the sweep's DOMAIN work
    // (the cache write) is actually succeeding" from "the interval is still
    // attempting ticks" (`/api/sweeps`) — the mt#3039 incident showed these
    // two can diverge for hours with no other visible signal.
    const prodStateSweepTracker = ProdStateSweepTracker.getInstance();

    // mt#3563: kick a live reachability probe, but do NOT await it. Awaiting
    // would make this route as slow as the database it is reporting on — and a
    // wedged database is exactly when the tray most needs a fast answer, since
    // ADR-014 makes this endpoint its liveness and adoption signal. So the
    // handler stays synchronous and reads the value the PREVIOUS poll's probe
    // produced; the cost is a one-poll lag into (and out of) degraded, which
    // `dbCheck.checkedAt` makes visible. refreshDbReachability never throws and
    // never issues more than one concurrent probe.
    void refreshDbReachability();

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
      // mt#3148: the discriminator a healthcheck asserts on. A bare
      // `status: "ok"` cannot tell "this service is healthy" from "a DIFFERENT
      // application is answering on this host" — mt#3142 is the proof (the MCP
      // server answered /health 200 on the reviewer's host for ~1h while every
      // reviewer route 404'd). Declared in contract/cockpit-health-shape.json
      // and asserted by BOTH sides of the tray/cockpit split.
      service: "minsky-cockpit",
      version,
      commit: getGitCommit(),
      uptimeSec,
      // gh#1761, semantics widened by mt#3563: DB reachability as of the last
      // probe. "ok" means a query actually completed through the SHARED pool
      // within the probe deadline; "degraded" means one did not (it timed out,
      // errored, or a previously issued probe still has not come back — the
      // never-settling-query wedge); "unreachable" means no init has succeeded.
      //
      // Until mt#3563 this was set ONCE at init and only ever left "ok" via a
      // circuit-breaker rejection, so a pool that stopped answering entirely
      // reported "ok" forever. Both the 2026-08-01 and 2026-08-03 incidents ran
      // with every DB route hanging and this field green, which is why the
      // tray's DB-degraded watchdog (supervisor.rs) never fired. The value is
      // still read cheaply here — the probe runs out-of-band, see above.
      db: dbStatus,
      // mt#3563: when that probe last finished, and how long the last
      // successful one took. `checkedAt` is what distinguishes "ok, just
      // measured" from a stale "ok" — without it this field would be another
      // value a reader cannot date. Rising `latencyMs` is the early warning
      // ahead of an outright wedge.
      dbCheck: getDbCheck(),
      // mt#3638: wedge-recycle telemetry. `recycleCount > 0` means this
      // process detected a wedged pool and tore it down in place; a RISING
      // count across polls is the recurrence signal that used to require log
      // spelunking (or a 40-minute outage) to see.
      dbRecycle: getDbRecycle(),
      // mt#3826: WHY the DB is unusable, not just that it is. `db` above
      // collapses a half-open pool wedge and a network refusing the port into
      // the same "degraded", which is what let the 2026-08-07 incident spend
      // ~9 hours recycling a pool against a port that was never going to open.
      // Shape is ADR-035 rule 4's (`mode`/`reason`/`lastAttemptAt`) so this
      // subsystem reports liveness in the same vocabulary as the others; the
      // added `failure` field is the discriminated form of `reason`, so a
      // consumer branches on `failure.kind` instead of parsing prose.
      dbHealth: getDbHealth(),
      // mt#3626: uncaught exceptions this process SURVIVED rather than died on
      // (transient outbound-connect failures inside the runtime's own net
      // module). Surviving is the designed behavior, so a non-zero count does
      // NOT degrade `status` — but it must be visible, because the failure it
      // replaces used to be loud (the process died) and is now quiet. A RISING
      // `count` across polls is the recurrence signal.
      survivedExceptions: getSurvivedExceptions(),
      // mt#3608: whether the Telegram principal channel is actually RUNNING.
      // It launches once at boot and, before this, a failed credential read
      // left it permanently off with nothing but a single startup `warn` to
      // say so — five times on 2026-08-03, each discovered only when the
      // principal noticed a message going unanswered. The channel's own acks
      // cannot report this, because the poller that sets them is the thing
      // that did not start. `state` distinguishes "the operator never
      // configured it" from "it is configured and the read FAILED".
      principalChannel: getPrincipalChannelStatus(),
      // mt#2578 watchdog fields — consumed by the tray's self-health watchdog.
      // processStartedAtMs: monotonic epoch-ms of when THIS process started.
      // A change between successive polls means the daemon restarted.
      processStartedAtMs: serverStartTime,
      // mt#4232: the pid of the process ANSWERING this request. Discharges the
      // earmark `src/cockpit/launchd.ts` has carried since mt#3682 ("Reporting a
      // PID for the tray-supervised case needs a new health field"), which is
      // why `cockpit status` printed a null pid for every non-launchd daemon:
      // launchctl was the only pid source, and it knows nothing about a daemon
      // the tray spawned.
      //
      // Self-reported rather than inferred, and that is the point. Resolving the
      // pid from the outside means `lsof` on the port, which answers "who holds
      // this socket" — a question whose answer has already been wrong here (see
      // `port-recovery.ts`'s `findPortHolder`, where a naive `lsof -i :3737`
      // returned Tailscale's pid). `process.pid` read inside the handler is the
      // process that actually served the response, so a caller pairing it with
      // this payload's `service` field has an identity chain rather than a guess
      // — which is what makes it safe to SIGNAL (mt#4232's `cockpit restart`).
      //
      // A plain top-level number, deliberately: mt#4186's liveness-dating
      // invariant governs sub-objects that assert an operational state, and a
      // pid asserts none, so this owes no `lastAttemptAt` sibling.
      pid: process.pid,
      // mt#4489: does this process's working directory still resolve a Minsky
      // repo root?
      //
      // The daemon is spawned as `bun run src/cli.ts` with cwd set to a repo
      // root, so cwd and the process's module-resolution root are the same tree.
      // Delete that tree under a live process — a session clone that gets
      // cleaned up — and the daemon keeps serving on already-loaded modules
      // while every not-yet-loaded `import()` fails with ENOENT. On 2026-08-24
      // an orphan daemon sat in exactly that state; nothing on this endpoint
      // could express it, and it took a log grep 19 hours later to find.
      //
      // `cwd` is therefore a PROXY for the module root, not the thing itself —
      // exact because of how the daemon is spawned, and the check would need
      // revisiting if it ever gained a `--cwd`-style flag that decoupled them.
      // It is the right proxy to publish regardless: it is what an operator can
      // compare against, and it is cheap.
      //
      // Re-checked per request rather than cached at boot, because the whole
      // point is that the answer CHANGES under a running process. Cheap: a
      // bounded `existsSync` walk (MAX_ASCEND 12), no IO beyond stat.
      //
      // Carries `checkedAt` per mt#4186's liveness-dating invariant — this
      // sub-object asserts an operational state, so it owes a timestamp saying
      // when that assertion was made.
      workspaceRoot: {
        cwd: process.cwd(),
        resolved: findRepoRoot([process.cwd()]) ?? null,
        checkedAt: new Date().toISOString(),
      },
      // consecutiveDegraded: how many consecutive /api/health calls have seen
      // db !== "ok". Resets to 0 on "ok". Read-only mirror of consecutiveDegradedCount.
      consecutiveDegraded: consecutiveDegradedCount,
      // mt#3857: `activeSessions` carries the LIVE subset only, and the registry
      // total rides alongside as a scalar. This endpoint is the most-polled surface
      // in the system — every 5s by the tray supervisor, 3x/15s by the webview — so
      // an unbounded array here is multiplied by ~12 requests a minute forever. It
      // had grown to 1,380 entries / 209 KB per response (99.5% of the payload)
      // before this filter; the full registry is still available via
      // `getActiveSessions()` for any caller that wants it.
      //
      // Emitting a count next to a bounded list also matches the convention ADR-017
      // set for the sibling `transcriptSweep` field ("counts + ISO timestamps only"),
      // and matches what `contract/cockpit-health-shape.json`'s sample already
      // assumed this field looked like.
      transcriptWatcher: {
        ...watcherTracker.getSummary(),
        activeSessionCount: watcherTracker.trackedSessionCount,
        activeSessions: watcherTracker.getLiveSessions(),
      },
      // mt#3297: whether the DB has the schema this build expects. The status
      // code cannot carry this — the daemon boots fine and answers 200 whether
      // or not its migrations are applied, which is exactly how a merged
      // migration left every ingest failing for hours while /health stayed
      // green. `current: null` means the check could not run, and is
      // deliberately NOT reported as current.
      schema: getSchemaReadiness(),
      transcriptSweep: sweepTracker.getSummary(),
      dispatchWatchdogSweep: dispatchWatchdogSweepTracker.getSummary(),
      prodStateSweep: prodStateSweepTracker.getSummary(),
      // mt#4384: the three sweep fields above are DOMAIN trackers, and a domain
      // tracker records the outcome of work. An ABANDONED tick never completes, so
      // it produces no outcome ever — which is why on 2026-08-21 `prodStateSweep`
      // read `lastSuccessAt: null, lastErrorAt: null, consecutiveFailures: 0`
      // (indistinguishable from "in flight, fine") while `/api/sweeps` showed nine
      // sweeps wedged with guards held.
      //
      // Until now this endpoint never read the liveness registry at all, so that
      // state could not appear here BY CONSTRUCTION. This field is the aggregate
      // projection; `/api/sweeps` remains the per-sweep authority.
      //
      // Deliberately does NOT change the top-level `status`. The tray restarts the
      // daemon on an unhealthy status, and a restart is not a reliable remedy for
      // this class — mem#1178 records an occurrence that self-cleared with no
      // restart, and mt#4335's hard release means recovery can legitimately take 15
      // minutes. Flipping `status` would trade a silent wedge for a restart loop
      // against a condition that often heals itself. ADR-035 rule 5 asks for surface
      // HONESTY, which the body carries; recovery is a separate obligation and is
      // not this task's.
      sweepLiveness: deriveHealthSweepLiveness(
        getSweepLivenessSnapshot(),
        new Date().toISOString()
      ),
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
