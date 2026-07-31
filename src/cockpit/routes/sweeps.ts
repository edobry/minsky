/**
 * Cockpit sweep-liveness route (mt#2894).
 *
 *   GET /api/sweeps — per-sweep liveness snapshot: name, cadence, and
 *                      lastAttemptAt/lastSuccessAt/lastErrorAt/
 *                      consecutiveFailures/reinits/metaRestarts for every
 *                      sweep registered via `createIntervalSweeper`.
 *
 * Distinguishes "daemon healthy but a sweep is dead" from "daemon healthy,
 * all sweeps healthy" in one read (the SC this route exists to satisfy) —
 * `/api/health` reports the daemon process's own liveness plus a handful of
 * DOMAIN-specific sweep trackers (transcriptSweep, dispatchWatchdogSweep);
 * this route reports the SCHEDULING layer's liveness uniformly across every
 * sweep, including the three (ask advancement, topology, deploy.smoke) that
 * have no domain-specific tracker of their own.
 *
 * Deliberately a SEPARATE module rather than folded into routes/health.ts —
 * server.ts is touched by exactly one import + one mount line, keeping the
 * conflict surface minimal against the in-flight server.ts redesign
 * (mt#2881, IN-PROGRESS at the time this route was added).
 *
 * **Auth / caching posture** (mirrors `/api/health` and `/api/widgets` in
 * `./health.ts`): GET-only, so `server.ts`'s `mutationAuthMiddleware` does
 * not apply — it gates non-GET/HEAD/OPTIONS requests only, relying on the
 * loopback bind + Host-header allowlist for the local read surface (see
 * `../auth.ts`, `../server.ts`'s security-hardening comment block). No
 * response caching — the handler reads the live in-process registry
 * (`getSweepLivenessSnapshot`) on every call, which is cheap (no I/O, no DB)
 * so there is nothing to cache. Redaction: the payload carries only names,
 * cadences, counts, and ISO timestamps — no raw error-message strings, no
 * absolute filesystem paths — matching the same unauthenticated-endpoint
 * redaction policy as `transcriptWatcher`/`transcriptSweep` on `/api/health`
 * (see `../transcript-sweep-tracker.ts`'s doc comment).
 *
 * @see ../sweepers.ts — createIntervalSweeper + getSweepLivenessSnapshot +
 *   startSweepMetaWatchdog (the self-heal half of mt#2894)
 */
import type express from "express";
import { getSweepLivenessSnapshot } from "../sweepers";
import { getTranscriptCoverage } from "../transcript-coverage";

/**
 * Mount `GET /api/sweeps` on `app`.
 *
 * Payload: `{ sweeps, transcriptCoverage }`.
 *
 * `transcriptCoverage` (mt#3441) answers the question the liveness registry
 * cannot: a sweep can be alive and producing NOTHING. `SummaryPipeline` had no
 * automatic caller and sat at 0.5% coverage indefinitely with no surface saying
 * so. Reporting liveness and output together makes that shape visible in one
 * read. `null` when persistence is not SQL-capable or the query fails — "not
 * measured", deliberately distinct from "measured as zero".
 *
 * NOTE: this adds one cheap aggregate DB query to a handler whose doc comment
 * above describes the registry read as I/O-free. That is still true of the
 * `sweeps` half; the coverage half is a single `count(*)` over
 * `agent_transcripts` and degrades to null rather than failing the route.
 */
export function mountSweepRoutes(app: express.Express): void {
  app.get("/api/sweeps", async (_req, res) => {
    res.json({
      sweeps: getSweepLivenessSnapshot(),
      transcriptCoverage: await getTranscriptCoverage(),
    });
  });
}
