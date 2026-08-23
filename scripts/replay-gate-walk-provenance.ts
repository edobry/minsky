#!/usr/bin/env bun
/**
 * Replay the merge-seam gate-walk check over real merged tasks (mt#1880 SC8/AT5).
 *
 * WHAT IT REPLAYS. Every task that reached DONE has, by construction, had code
 * merged under its id — so the DONE population IS the historical population of
 * `session_pr_merge` invocations this guard would have seen. For each one the
 * script assembles the SAME three facts the guard reads and calls the SHIPPED
 * `classifyMerge`. Nothing is re-derived: the facts are the guard's input and
 * the classifier IS the guard, so a fire here is a fire there.
 *
 * WHY IT EXISTS. mt#1880 SC8 requires fire and suppression counts over a real
 * window recorded in the spec BEFORE any posture discussion, and AT5 requires at
 * least one `ungated` that can be hand-confirmed against the task's own history.
 * The sibling precedent is mt#4171, whose own replay moved it from injecting to
 * record-only before it shipped. Argument is not measurement.
 *
 * ONE DIFFERENCE FROM THE GUARD, STATED SO IT IS NOT MISTAKEN FOR A REDERIVATION.
 * The guard issues its three reads per invocation; this issues two — the horizon
 * once, and one join that carries every task's `created_at` beside its earliest
 * `→ READY` row. That is the same data assembled in bulk, not a different
 * question. The classifier is untouched.
 *
 * The `skipped` bucket is reported BY REASON rather than as a total. Its members
 * are not one thing: a pre-horizon task is a bound on this substrate's reach,
 * while an unreadable stream is an outage, and a run that collapsed them would
 * hide exactly the distinction the guard's outcome vocabulary exists to keep.
 *
 * Usage:
 *   bun scripts/replay-gate-walk-provenance.ts [--limit N] [--since <ISO>] [--json]
 *   bun scripts/replay-gate-walk-provenance.ts --list-ungated 20
 */

import "reflect-metadata";
import { classifyMerge } from "../.minsky/hooks/gate-walk-provenance";
import type { GateWalkFacts, GateWalkOutcome } from "../.minsky/hooks/gate-walk-provenance";
import { firstIsoField } from "../.minsky/hooks/gate-walk-provenance";
import type { SqlCapablePersistenceProvider } from "@minsky/domain/persistence/types";

interface Args {
  limit: number;
  since: string | null;
  json: boolean;
  listUngated: number;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { limit: 5000, since: null, json: false, listUngated: 10 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--json") args.json = true;
    else if (flag === "--limit") args.limit = Number.parseInt(argv[++i] ?? "", 10) || args.limit;
    else if (flag === "--since") args.since = argv[++i] ?? null;
    else if (flag === "--list-ungated")
      args.listUngated = Number.parseInt(argv[++i] ?? "", 10) || args.listUngated;
  }
  return args;
}

interface TaskRow {
  taskId: string;
  facts: GateWalkFacts;
}

async function connect() {
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
    throw new Error(`persistence unavailable: ${resolution.errorClass}: ${resolution.error}`);
  }
  const provider = resolution.provider;
  if (!provider.capabilities.sql || typeof provider.getDatabaseConnection !== "function") {
    throw new Error(`provider ${provider.constructor.name} is not SQL-capable`);
  }
  // Narrowed for the same reason the guard narrows: the base provider declares
  // `getDatabaseConnection?(): Promise<unknown>` because subclasses return
  // different concrete DB types.
  const db = await (provider as SqlCapablePersistenceProvider).getDatabaseConnection();
  if (!db) throw new Error("no database connection");
  return db;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = await connect();
  const { sql } = await import("drizzle-orm");

  // Same query the guard's horizon read issues, verbatim in shape.
  const horizonRows = await db.execute(sql`
    select min(created_at) as horizon
    from system_events
    where event_type = 'task.status_changed'
  `);
  const horizonAt = firstIsoField(horizonRows, "horizon");

  const sinceClause = args.since ? sql`and t.created_at >= ${new Date(args.since)}` : sql``;

  // The population: every task that reached DONE, i.e. every task under whose id
  // code has merged. `ready.fired` is the earliest → READY row for that task, or
  // NULL — the same value the guard's third query produces.
  const rows = await db.execute(sql`
    select
      t.id            as task_id,
      t.created_at    as created,
      ready.fired     as fired
    from tasks t
    left join lateral (
      select e.created_at as fired
      from system_events e
      where e.event_type = 'task.status_changed'
        and e.related_task_id = t.id
        and e.payload->>'newStatus' = 'READY'
      order by e.created_at asc
      limit 1
    ) ready on true
    where t.status = 'DONE' ${sinceClause}
    order by t.created_at desc
    limit ${args.limit}
  `);

  const list = Array.isArray(rows) ? rows : [];
  const tasks: TaskRow[] = list.map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      taskId: typeof row["task_id"] === "string" ? row["task_id"] : String(row["task_id"] ?? ""),
      facts: {
        readyEventAt: firstIsoField([row], "fired"),
        horizonAt,
        taskCreatedAt: firstIsoField([row], "created"),
      },
    };
  });

  const counts: Record<GateWalkOutcome, number> = { gated: 0, ungated: 0, skipped: 0 };
  const skippedByReason = new Map<string, number>();
  const ungated: Array<{ taskId: string; createdAt: string | null }> = [];

  for (const t of tasks) {
    const classification = classifyMerge({ taskId: t.taskId, facts: t.facts });
    counts[classification.outcome]++;
    if (classification.outcome === "skipped") {
      // Bucket by the reason's KIND, not its full text — the text interpolates
      // timestamps, so keying on it whole would produce one bucket per task.
      const kind = classification.reason.includes("predates the emission horizon")
        ? "pre-horizon"
        : classification.reason.includes("no creation timestamp")
          ? "no-task-created-at"
          : classification.reason.includes("could not be read")
            ? "stream-unreadable"
            : "other";
      skippedByReason.set(kind, (skippedByReason.get(kind) ?? 0) + 1);
    }
    if (classification.outcome === "ungated") {
      ungated.push({ taskId: t.taskId, createdAt: t.facts.taskCreatedAt });
    }
  }

  const report = {
    population: "tasks with status DONE (every task under whose id code has merged)",
    horizonAt,
    examined: tasks.length,
    counts,
    skippedByReason: Object.fromEntries(skippedByReason),
    ungatedRate: tasks.length > 0 ? counts.ungated / tasks.length : 0,
    // The rate that matters for posture is over the ADJUDICABLE population — the
    // tasks this substrate can actually answer for. Reporting only the raw rate
    // would let the pre-horizon bulk dilute it into looking harmless.
    adjudicable: counts.gated + counts.ungated,
    ungatedRateAmongAdjudicable:
      counts.gated + counts.ungated > 0 ? counts.ungated / (counts.gated + counts.ungated) : 0,
    ungatedSample: ungated.slice(0, args.listUngated),
  };

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(`gate-walk-provenance replay\n`);
  process.stdout.write(`  population        ${report.population}\n`);
  process.stdout.write(`  emission horizon  ${horizonAt ?? "(none — stream is empty)"}\n`);
  process.stdout.write(`  examined          ${report.examined}\n`);
  process.stdout.write(`  gated             ${counts.gated}\n`);
  process.stdout.write(`  ungated           ${counts.ungated}\n`);
  process.stdout.write(`  skipped           ${counts.skipped}\n`);
  for (const [kind, n] of skippedByReason) {
    process.stdout.write(`      ${kind.padEnd(20)} ${n}\n`);
  }
  process.stdout.write(
    `  adjudicable       ${report.adjudicable} (ungated ${(report.ungatedRateAmongAdjudicable * 100).toFixed(1)}%)\n`
  );
  if (report.ungatedSample.length > 0) {
    process.stdout.write(`  ungated sample (hand-confirm these against the task's own history):\n`);
    for (const u of report.ungatedSample) {
      process.stdout.write(`      ${u.taskId}  created ${u.createdAt}\n`);
    }
  }
}

await main();
process.exit(0);
