#!/usr/bin/env bun
/**
 * Live verification for the computed autonomy class (mt#5130) — READ-ONLY.
 *
 * Runs the real `TaskRoutingService.findAvailableTasksWithClass` (the service
 * behind `tasks_available`, with its bulk spec-section loader) against the
 * configured persistence provider over the default population, and reports:
 *
 *   - how many candidates were served vs withheld, by class;
 *   - the reasons histogram over the withheld `principal-gated` set;
 *   - AT4: whether any served task carries the `engprod-proposal` tag.
 *
 * Exit 0 = checked, zero proposals served. Exit 1 = a proposal was served.
 * Exit 2 = SKIP: no SQL-capable persistence provider configured.
 *
 *   bun scripts/verify-autonomy-class.ts [--json]
 */

import "reflect-metadata";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

interface SqlCapablePersistence {
  getDatabaseConnection: () => Promise<PostgresJsDatabase | null>;
}

/** Mirrors scripts/backlog-theme-clusters.ts's bootstrapDb() convention. */
async function bootstrap() {
  const { initializeConfiguration, CustomConfigFactory } = await import(
    "@minsky/domain/configuration"
  );
  const { createCliContainer } = await import("../src/composition/cli");

  await initializeConfiguration(new CustomConfigFactory(), { workingDirectory: process.cwd() });
  const container = await createCliContainer();
  await container.initialize();

  const persistence = container.has("persistence") ? container.get("persistence") : undefined;
  const isSqlCapable = (p: unknown): p is SqlCapablePersistence =>
    !!p &&
    !!(p as { capabilities?: { sql?: boolean } }).capabilities?.sql &&
    typeof (p as { getDatabaseConnection?: unknown }).getDatabaseConnection === "function";
  if (!isSqlCapable(persistence)) return null;
  const db = await persistence.getDatabaseConnection();
  if (!db) return null;
  return { container, db };
}

async function main(): Promise<void> {
  const json = process.argv.includes("--json");
  const booted = await bootstrap();
  if (!booted) {
    console.log("SKIP: no SQL-capable persistence provider configured (Postgres required).");
    process.exit(2);
  }
  const { container, db } = booted;

  const { TaskRoutingService } = await import("@minsky/domain/tasks/task-routing-service");
  const { createDbAutonomySignalSource } = await import(
    "@minsky/domain/tasks/autonomy-class-store"
  );
  const { computeAutonomyClass } = await import("@minsky/domain/tasks/autonomy-class");
  const { ENGPROD_PROPOSAL_TAG } = await import("@minsky/domain/engprod/types");

  const taskService = container.get("taskService");
  const taskGraphService = container.get("taskGraphService");
  const signalSource = createDbAutonomySignalSource(db);
  const routing = new TaskRoutingService(taskGraphService, taskService, signalSource);

  const startedAt = Date.now();
  const result = await routing.findAvailableTasksWithClass({ limit: 100_000 });
  const elapsedMs = Date.now() - startedAt;

  // Re-derive the reasons histogram over the same population the service saw,
  // with the same classifier and loader — the service reports counts only.
  const listed = await taskService.listTasks({});
  const population = listed.filter(
    (t) => t.kind !== "work-package" && ["TODO", "IN-PROGRESS"].includes(t.status)
  );
  const signals = await signalSource.loadSpecSignals(population.map((t) => t.id));
  const reasonCounts = new Map<string, number>();
  const classCounts: Record<string, number> = {};
  for (const t of population) {
    const r = computeAutonomyClass({
      id: t.id,
      kind: t.kind,
      status: t.status,
      tags: t.tags ?? [],
      title: t.title ?? "",
      spec: signals.get(t.id),
      humanOrigin: undefined,
    });
    classCounts[r.class] = (classCounts[r.class] ?? 0) + 1;
    if (r.class === "principal-gated") {
      for (const reason of r.reasons) {
        // Collapse per-path and per-marker detail to the signal family.
        const family = reason.replace(/ .*$/, "").replace(/^principal-reserved$/, "marker");
        reasonCounts.set(family, (reasonCounts.get(family) ?? 0) + 1);
      }
    }
  }

  const servedProposals = result.tasks.filter((t) => {
    const row = population.find((p) => p.id === t.taskId);
    return (row?.tags ?? []).includes(ENGPROD_PROPOSAL_TAG);
  });
  const taggedInPopulation = population.filter((t) =>
    (t.tags ?? []).includes(ENGPROD_PROPOSAL_TAG)
  ).length;

  const report = {
    asOf: new Date().toISOString(),
    elapsedMs,
    population: population.length,
    served: result.tasks.length,
    excludedByClass: result.excludedByClass,
    classCounts,
    principalGatedReasons: Object.fromEntries(
      [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])
    ),
    engprodProposalsInPopulation: taggedInPopulation,
    engprodProposalsServed: servedProposals.map((t) => t.taskId),
    at4: servedProposals.length === 0 ? "PASS" : "FAIL",
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Autonomy class over the default population — as of ${report.asOf}`);
    console.log(`Population: ${report.population}; served: ${report.served}; ${elapsedMs} ms`);
    console.log(`Excluded by class: ${JSON.stringify(report.excludedByClass)}`);
    console.log(`Class counts: ${JSON.stringify(report.classCounts)}`);
    console.log(`Principal-gated reasons: ${JSON.stringify(report.principalGatedReasons)}`);
    console.log(
      `AT4: ${report.at4} — ${taggedInPopulation} engprod-proposal task(s) in population, ${servedProposals.length} served`
    );
  }
  process.exit(servedProposals.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`verify-autonomy-class failed: ${getLoggableErrorSummary(err)}`);
  process.exit(1);
});
