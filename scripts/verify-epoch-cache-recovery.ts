#!/usr/bin/env bun
/**
 * Live verification for mt#3721 — do the real cockpit widgets recover from a
 * real pool recycle, without a process restart?
 *
 * WHY THIS EXISTS. Every unit test for `createEpochKeyedCache` drives the
 * `getEpoch` seam, so it proves the CACHE's logic and says nothing about the
 * real-wired BINDING: whether each widget actually routes through the helper,
 * and whether a genuine `recycleSharedPersistence()` actually causes them to
 * re-resolve. That gap is exactly the §7a binding-direction failure mode —
 * mt#2076/mt#2757 shipped a seam-tested reviewer DB layer that threw on every
 * real query for ~5 weeks while rendering healthy zeros.
 *
 * WHAT IT DOES.
 *   1. Fetches each affected widget once, so every cache is populated against
 *      the live pool.
 *   2. Calls the real `recycleSharedPersistence()` — the same function the
 *      degraded-probe trigger calls. This ENDS the pool (postgres-js then
 *      rejects anything holding a handle to it with CONNECTION_ENDED, forever)
 *      and bumps the persistence epoch.
 *   3. Fetches every widget again and asserts each returns real data.
 *
 * Step 3 is the whole point: before mt#3721 these caches had no epoch check, so
 * they kept the handle from step 1 and every post-recycle fetch failed for the
 * remaining life of the process.
 *
 * WHAT IT DOES NOT COVER. What CAUSES a recycle — the degraded-probe duration
 * trigger — is mt#3638's mechanism and is verified by its own tests and its
 * SC6 live run against a wedge proxy. This script starts from "a recycle
 * happened" and verifies only the half mt#3721 owns.
 *
 * Usage: bun scripts/verify-epoch-cache-recovery.ts
 * Exits 0 on pass, non-zero on fail, and 0 with a SKIP line when no database is
 * configured (so an unattended run is safe).
 */

// Required before anything pulls in tsyringe-decorated domain modules; without
// it Bun 1.3.x throws "tsyringe requires a reflect polyfill" (mt#3561). Same
// reason the Dockerfile CMD preloads it.
import "reflect-metadata";

import type { WidgetContext, WidgetData } from "../src/cockpit/types";

interface WidgetCheck {
  id: string;
  /** Lazily imported so a module-load failure is attributable to one widget. */
  load: () => Promise<{ fetch: (ctx: WidgetContext) => Promise<WidgetData> }>;
  /**
   * Widget-specific "this is real data, not a placeholder". Returning a reason
   * string marks failure; `null` means healthy.
   */
  verdict: (data: WidgetData) => string | null;
}

/** A widget that reports `degraded` cannot serve its data at all. */
function requireOk(data: WidgetData): string | null {
  if (data.state === "degraded") {
    return `state=degraded (${"reason" in data ? data.reason : "no reason given"})`;
  }
  return null;
}

const CHECKS: WidgetCheck[] = [
  {
    id: "reviewer-bot-status",
    load: async () =>
      (await import("../src/cockpit/widgets/reviewer-bot-status")).reviewerBotStatusWidget,
    // This widget reports state:"ok" even when every query failed — the mt#2758
    // counters are the only honest signal, and they are what regressed.
    verdict: (data) => {
      const degraded = requireOk(data);
      if (degraded) return degraded;
      const db = (
        data as { payload?: { db?: { queryFailureCount?: number; queryTotalCount?: number } } }
      ).payload?.db;
      if (!db) return "payload.db is null — DB stats unavailable";
      const failed = db.queryFailureCount ?? -1;
      const total = db.queryTotalCount ?? -1;
      if (failed !== 0) return `queryFailureCount=${failed}/${total} (expected 0)`;
      return null;
    },
  },
  {
    id: "task-list",
    load: async () => (await import("../src/cockpit/widgets/task-list")).taskListWidget,
    verdict: requireOk,
  },
  {
    id: "task-graph",
    load: async () => (await import("../src/cockpit/widgets/task-graph")).taskGraphWidget,
    verdict: requireOk,
  },
  {
    id: "attention",
    load: async () => (await import("../src/cockpit/widgets/attention")).attentionWidget,
    verdict: requireOk,
  },
  {
    id: "workstreams",
    load: async () => (await import("../src/cockpit/widgets/workstreams")).workstreamsWidget,
    verdict: requireOk,
  },
];

const EMPTY_CTX = {} as WidgetContext;

async function fetchAll(phase: string): Promise<Map<string, string | null>> {
  const verdicts = new Map<string, string | null>();
  for (const check of CHECKS) {
    try {
      const widget = await check.load();
      const data = await widget.fetch(EMPTY_CTX);
      verdicts.set(check.id, check.verdict(data));
    } catch (err) {
      verdicts.set(check.id, `threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  for (const [id, verdict] of verdicts) {
    console.log(
      `  ${verdict === null ? "PASS" : "FAIL"}  ${phase}  ${id}${verdict ? ` — ${verdict}` : ""}`
    );
  }
  return verdicts;
}

async function main(): Promise<number> {
  // The cockpit server does this at boot; a standalone script must too, or
  // persistence init throws "Configuration not initialized". Same pattern as
  // `scripts/asks-backlog-triage.ts`.
  const { initializeConfiguration, CustomConfigFactory } = await import(
    "@minsky/domain/configuration"
  );
  await initializeConfiguration(new CustomConfigFactory(), {
    workingDirectory: process.cwd(),
  });

  const { getSharedPersistenceService, recycleSharedPersistence, getDbStatus } = await import(
    "../src/cockpit/shared-persistence"
  );

  // Gate on a reachable database — this verifies real-pool behavior and is
  // meaningless without one.
  try {
    await getSharedPersistenceService();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Distinguish "no database here" (a legitimate skip) from "something else
    // broke" (a failure). Reporting the second as a SKIP is how a broken check
    // passes unattended forever — the first run of this script did exactly
    // that, reporting a missing reflect-metadata preload as an unreachable DB.
    const isUnreachable =
      /CONNECT_TIMEOUT|ENOTFOUND|ECONNREFUSED|not configured|no database|unreachable/i.test(
        message
      );
    if (!isUnreachable) {
      console.error(
        `FAIL: could not initialize persistence for a reason that is NOT "no database": ${message}`
      );
      return 1;
    }
    console.log(
      `SKIP: no reachable database (${message}). ` +
        `This check verifies real-pool recovery and cannot run without one.`
    );
    return 0;
  }
  console.log(`Database reachable (status=${getDbStatus()}).\n`);

  console.log("Phase 1 — populate every widget cache against the live pool:");
  const before = await fetchAll("before");
  const brokenBefore = [...before].filter(([, v]) => v !== null);
  if (brokenBefore.length > 0) {
    console.log(
      `\nFAIL: ${brokenBefore.length} widget(s) unhealthy BEFORE the recycle — ` +
        `the environment is not in a state that can verify anything.`
    );
    return 1;
  }

  console.log("\nPhase 2 — recycle the shared pool (ends it; bumps the epoch):");
  recycleSharedPersistence("mt#3721 live verification");
  console.log("  recycle issued\n");

  console.log("Phase 3 — the assertion: every widget must re-resolve, same process:");
  const after = await fetchAll("after");
  const brokenAfter = [...after].filter(([, v]) => v !== null);

  console.log("");
  if (brokenAfter.length > 0) {
    console.log(
      `FAIL: ${brokenAfter.length}/${CHECKS.length} widget(s) did NOT recover from the recycle. ` +
        `This is the mt#3721 defect: a cache pinned to the ended pool.`
    );
    return 1;
  }
  console.log(`PASS: all ${CHECKS.length} widgets re-resolved after the recycle, same process.`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(
      `verify-epoch-cache-recovery failed: ${err instanceof Error ? err.stack : String(err)}`
    );
    process.exit(1);
  });
