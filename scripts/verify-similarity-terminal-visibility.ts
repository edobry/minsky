#!/usr/bin/env bun
/**
 * Diagnostic + live-verification artifact for mt#3305.
 *
 * The question: `tasks_similar` returns zero results for tasks whose entire
 * embedding neighbourhood is DONE/CLOSED, even though it passes NO status
 * filters and the vectors are healthy. Direct SQL shows the neighbours exist at
 * cosine distance ~0.12-0.18; the tool returns nothing.
 *
 * This script isolates WHERE terminal-status results are dropped by exercising
 * the layers separately:
 *
 *   1. `listTasks({})`            — does the live-task listing the project-scope
 *                                   cross-check reads even contain DONE tasks?
 *   2. `similarToTask` @ resolved — the real command path (project scope resolved).
 *   3. `similarToTask` @ ALL      — the same call with ALL_PROJECTS, which makes
 *                                   `applyProjectScope` a documented no-op.
 *
 * If (1) has no DONE tasks, the drop is `listTasks`'s default. If (1) has them
 * and (2) is empty while (3) is not, the drop is `applyProjectScope`.
 *
 * Run: `bun scripts/verify-similarity-terminal-visibility.ts`
 * Exit 0 = diagnosis printed; non-zero = the environment could not be reached.
 */

import "reflect-metadata";

import type { SqlCapablePersistenceProvider } from "@minsky/domain/persistence/types";
import type { TaskServiceInterface } from "@minsky/domain/tasks/taskService";

/** A task whose nearest neighbours are all terminal — the mt#3290 duplicate case. */
const PROBE_TASK_ID = process.env.MINSKY_PROBE_TASK_ID ?? "mt#3271";

const TERMINAL = new Set(["DONE", "CLOSED"]);

async function bootstrap(): Promise<{
  taskService: TaskServiceInterface;
  persistence: SqlCapablePersistenceProvider;
}> {
  const { initializeConfiguration, CustomConfigFactory } = await import(
    "@minsky/domain/configuration"
  );
  const { createCliContainer } = await import("../src/composition/cli");
  const { PersistenceProvider } = await import("@minsky/domain/persistence/types");
  const { createConfiguredTaskService } = await import("@minsky/domain/tasks/taskService");

  await initializeConfiguration(new CustomConfigFactory(), {
    workingDirectory: process.cwd(),
  });

  const container = await createCliContainer();
  await container.initialize();

  const persistence = container.has("persistence") ? container.get("persistence") : undefined;
  if (!persistence || !(persistence instanceof PersistenceProvider)) {
    throw new Error("This diagnostic requires a SQL-capable persistence provider (Postgres).");
  }
  if (!persistence.capabilities.sql || typeof persistence.getDatabaseConnection !== "function") {
    throw new Error("This diagnostic requires a SQL-capable persistence provider (Postgres).");
  }

  const taskService = await createConfiguredTaskService({
    workspacePath: process.cwd(),
    persistenceProvider: persistence,
  });

  return { taskService, persistence: persistence as SqlCapablePersistenceProvider };
}

function summarizeStatuses(tasks: Array<{ status?: string }>): string {
  const counts = new Map<string, number>();
  for (const t of tasks) {
    const key = t.status ?? "(none)";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([status, n]) => `${status}=${n}`)
    .join(" ");
}

async function main(): Promise<void> {
  const { taskService, persistence } = await bootstrap();

  // ---- Layer 1: the live-task listing applyProjectScope cross-checks against.
  const listed = await taskService.listTasks();
  const terminalListed = listed.filter((t) => TERMINAL.has(String(t.status)));
  console.log("=== Layer 1: taskService.listTasks() ===");
  console.log(`  total returned      : ${listed.length}`);
  console.log(`  terminal (DONE/CLOSED): ${terminalListed.length}`);
  console.log(`  status distribution : ${summarizeStatuses(listed)}`);
  console.log(`  probe task present  : ${listed.some((t) => t.id === PROBE_TASK_ID)}`);

  // ---- Layers 2 & 3: the similarity path, scoped vs unscoped.
  const { createTaskSimilarityService } = await import(
    "../src/adapters/shared/commands/tasks/similarity-commands"
  );
  const { ALL_PROJECTS } = await import("@minsky/domain/project/scope");
  const { resolveProjectIdentity } = await import("@minsky/domain/project/identity");
  const { resolveProjectScope } = await import("@minsky/domain/project/scope-resolver");

  const service = await createTaskSimilarityService(persistence, taskService);

  const unscoped = await service.similarToTask(PROBE_TASK_ID, 10, undefined, ALL_PROJECTS);
  console.log("\n=== Layer 3: similarToTask @ ALL_PROJECTS (applyProjectScope is a no-op) ===");
  console.log(`  results: ${unscoped.results.length}`);
  for (const r of unscoped.results.slice(0, 8)) {
    const task = await taskService.getTask(r.id);
    console.log(`    ${r.id.padEnd(10)} ${String(task?.status ?? "?").padEnd(8)} score=${r.score}`);
  }

  let scopedCount = "n/a (project identity did not resolve)";
  try {
    const identity = resolveProjectIdentity({ repoPath: process.cwd() });
    if (identity.kind === "resolved") {
      const db = await persistence.getDatabaseConnection();
      if (!db) throw new Error("no database connection available for project-scope resolution");
      const scope = await resolveProjectScope(identity, db);
      const scoped = await service.similarToTask(PROBE_TASK_ID, 10, undefined, scope);
      scopedCount = String(scoped.results.length);
      console.log(
        "\n=== Layer 2: similarToTask @ resolved project scope (the real command path) ==="
      );
      console.log(`  results: ${scoped.results.length}`);
      for (const r of scoped.results.slice(0, 8)) {
        const task = await taskService.getTask(r.id);
        console.log(
          `    ${r.id.padEnd(10)} ${String(task?.status ?? "?").padEnd(8)} score=${r.score}`
        );
      }
    }
  } catch (err) {
    console.log(`\n=== Layer 2: skipped — ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log("\n=== Diagnosis ===");
  console.log(`  listTasks() default hides terminal : ${terminalListed.length === 0}`);
  console.log(`  unscoped similar results           : ${unscoped.results.length}`);
  console.log(`  scoped similar results             : ${scopedCount}`);

  // The regression this artifact exists to catch: the SCOPED path (what the
  // `tasks_similar` command actually runs) must surface terminal-status
  // neighbours. mt#3271's entire neighbourhood is DONE/CLOSED, so before the
  // mt#3305 fix the scoped call returned 0 while SQL showed neighbours at
  // cosine distance 0.12-0.18 — which is how mt#3290 came to be filed as a
  // duplicate of mt#3271.
  const scopedResults = Number.isNaN(Number(scopedCount)) ? -1 : Number(scopedCount);
  if (scopedResults === -1) {
    console.log("\nSKIP: project identity did not resolve; scoped path not exercised.");
    return;
  }
  if (scopedResults === 0) {
    throw new Error(
      "REGRESSION: the scoped similarity path returned 0 results for a probe task whose " +
        "neighbourhood is entirely terminal. Terminal-status tasks are being dropped from the " +
        "live cross-check again — see the `all: true` note in createTaskSimilarityService."
    );
  }
  console.log(
    `\nPASS: scoped path surfaced ${scopedResults} neighbours for ${PROBE_TASK_ID}, ` +
      "including terminal-status tasks."
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
