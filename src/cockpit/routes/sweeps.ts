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
 * @see ../sweepers.ts — createIntervalSweeper + getSweepLivenessSnapshot +
 *   startSweepMetaWatchdog (the self-heal half of mt#2894)
 */
import type express from "express";
import { getSweepLivenessSnapshot } from "../sweepers";

/** Mount `GET /api/sweeps` on `app`. */
export function mountSweepRoutes(app: express.Express): void {
  app.get("/api/sweeps", (_req, res) => {
    res.json({ sweeps: getSweepLivenessSnapshot() });
  });
}
