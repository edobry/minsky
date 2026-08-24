#!/usr/bin/env bun
/**
 * Measure session-start-to-first-write cadence from the task event ledger.
 *
 * Written to answer mt#4494's SC6 — "the recency window is derived from observed
 * session-start-to-first-write cadence, not a round number"
 * (`decision-defaults.mdc §Thresholds`). It ALSO reports the transition-shape
 * distribution, because that turned out to be the finding: the requested
 * quantity is measurable over only ~3% of sessions, and the distribution says
 * why.
 *
 * The quantity: for each `session.started`, how long until that task's NEXT
 * `task.status_changed`.
 *
 * **What the measurement found (2026-08-24, ~2.5 months of ledger):** 40 usable
 * pairs from 1194 `session.started` rows. `task.status_changed` is emitted
 * almost entirely by EXPLICIT `tasks_status_set` calls during planning
 * (TODO->PLANNING 1480, PLANNING->READY 1372); the IMPLICIT lifecycle
 * transitions barely appear — READY->IN-PROGRESS 36 against those 1194 session
 * starts, IN-PROGRESS->IN-REVIEW 13. So a session start is rarely followed by a
 * status event at all, and the 40 pairs that exist are the unrepresentative
 * tail rather than the typical case.
 *
 * Within those 40: p50 16.2min, p75 742min — a 45x jump — max 55 days, and only
 * 47.5% inside 15 minutes. Heavy-tailed with no stable central value, over a
 * population in which the phenomenon is mostly ABSENT: exactly the shape
 * `/plan-task` gate (o) step 3 says not to summarize. **Conclusion: this
 * quantity cannot ground the window.** See mt#4494 SC6 for what was used
 * instead and why.
 *
 * Read-only. Prints and changes nothing.
 *
 *   bun scripts/measure-session-start-to-first-write.ts
 */

import "reflect-metadata";

interface Stamped {
  taskId: string;
  at: number;
}

async function getDb(): Promise<unknown> {
  const { isConfigurationInitialized } = await import("../packages/domain/src/configuration/index");
  if (!isConfigurationInitialized()) {
    const { setupConfiguration } = await import("../packages/domain/src/config-setup");
    await setupConfiguration();
  }
  const { resolvePersistenceProviderOrError } = await import(
    "../packages/domain/src/persistence/factory"
  );
  const resolution = await resolvePersistenceProviderOrError();
  if (!resolution.ok) {
    console.error("SKIP: persistence unavailable — cannot measure");
    process.exit(0);
  }
  const provider = resolution.provider;
  if (!provider.capabilities.sql || typeof provider.getDatabaseConnection !== "function") {
    console.error("SKIP: provider is not SQL-capable");
    process.exit(0);
  }
  const db = await provider.getDatabaseConnection();
  if (!db) {
    console.error("SKIP: no database connection");
    process.exit(0);
  }
  return db;
}

async function main(): Promise<void> {
  const db = await getDb();
  const { listEvents } = await import("../packages/domain/src/events/query");

  const starts: Stamped[] = [];
  const changes: Stamped[] = [];
  const transitions = new Map<string, number>();

  // `listEvents` caps `limit` at 500, so page backwards by timestamp.
  for (const type of ["session.started", "task.status_changed"] as const) {
    let until: string | undefined = undefined;
    for (let page = 0; page < 40; page++) {
      const rows = await listEvents(db as never, { eventType: type, limit: 500, until });
      const oldest = rows.at(-1);
      if (rows.length === 0 || oldest === undefined) break;
      for (const r of rows) {
        const payload = (r.payload ?? {}) as Record<string, unknown>;
        if (type === "task.status_changed") {
          const k = `${payload["previousStatus"] ?? "?"} -> ${payload["newStatus"] ?? "?"}`;
          transitions.set(k, (transitions.get(k) ?? 0) + 1);
        }
        const taskId = r.relatedTaskId ?? "";
        const at = new Date(r.createdAt).getTime();
        if (!taskId || Number.isNaN(at)) continue;
        (type === "session.started" ? starts : changes).push({ taskId, at });
      }
      if (rows.length < 500) break;
      until = new Date(new Date(oldest.createdAt).getTime() - 1).toISOString();
    }
  }

  const byTask = new Map<string, number[]>();
  for (const c of changes) {
    const list = byTask.get(c.taskId) ?? [];
    list.push(c.at);
    byTask.set(c.taskId, list);
  }
  for (const list of byTask.values()) list.sort((a, b) => a - b);

  const deltas: number[] = [];
  for (const s of starts) {
    const next = byTask.get(s.taskId)?.find((t) => t > s.at);
    if (next !== undefined) deltas.push(next - s.at);
  }
  deltas.sort((a, b) => a - b);

  const span = (a: Stamped[]) =>
    a.length
      ? `${new Date(Math.min(...a.map((x) => x.at))).toISOString().slice(0, 10)} .. ${new Date(
          Math.max(...a.map((x) => x.at))
        )
          .toISOString()
          .slice(0, 10)}`
      : "empty";

  console.log(`ledger span — session.started:     ${span(starts)}  (${starts.length} rows)`);
  console.log(`ledger span — task.status_changed: ${span(changes)}  (${changes.length} rows)`);
  console.log("");
  console.log("transition shapes (top 8) — why the pairing is sparse:");
  for (const [k, v] of [...transitions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(`  ${String(v).padStart(5)}  ${k}`);
  }
  console.log("");
  console.log(`usable pairs: ${deltas.length} of ${starts.length} session starts`);
  if (deltas.length === 0) {
    console.log("no pairs — nothing to summarize");
    process.exit(0);
  }

  const pct = (p: number): number =>
    deltas[Math.min(deltas.length - 1, Math.floor((p / 100) * deltas.length))] ?? 0;
  const mins = (ms: number) => `${(ms / 60000).toFixed(1)} min`;

  for (const p of [50, 75, 90, 95, 99]) console.log(`  p${p}: ${mins(pct(p))}`);
  console.log(`  max: ${mins(deltas.at(-1) ?? 0)}`);
  console.log(
    `  within 15m: ${((deltas.filter((d) => d <= 15 * 60000).length / deltas.length) * 100).toFixed(1)}%`
  );
  console.log("");
  console.log("Read the spread before using any of these: see this file's docblock.");
  process.exit(0);
}

await main();
