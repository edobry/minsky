#!/usr/bin/env bun
/**
 * Live verification for the unattended task supervisor (mt#4571).
 *
 * `/implement-task` §7a: this task adds a NEW PERSISTENCE PATH (two tables, a
 * partial unique index, a cross-process advisory lock) plus a new sweeper on the
 * cockpit daemon. Unit tests cover the tick against an in-memory fake, which is
 * the right shape for the DAG walk and says NOTHING about whether the real
 * store binds — the §7a binding direction, and the exact failure mt#2076/mt#2757
 * shipped for five weeks (a DB layer that threw on every query while rendering
 * healthy zeros).
 *
 * What this exercises LIVE, against the configured Postgres:
 *
 *   1. The migration actually applied — both tables readable.
 *   2. `DrizzleSupervisionStore` round-trips a supervision and a dispatch, and
 *      a REPEAT dispatch is swallowed by the unique index (the idempotence the
 *      tick relies on after a crash-restart).
 *   3. The partial unique index REFUSES a second active supervision for one
 *      umbrella — the guarantee the create path relies on instead of a
 *      check-then-insert, which two concurrent callers would both pass.
 *   4. `withSupervisionLock` genuinely EXCLUDES a concurrent holder, checked
 *      from a SECOND connection while the first holds it. On one connection
 *      Postgres grants its own holder the same advisory lock, so a
 *      single-connection probe passes whether or not the lock works at all
 *      (mem#704: a probe that cannot fail carries no information).
 *   5. **AT1 end-to-end against a real database**: a seeded two-node DAG
 *      (B depends on A) under a real umbrella; the real `runSupervisionTick`
 *      dispatches only A, then dispatches B once A reaches DONE — with the real
 *      store, the real `TaskGraphService` and the real `computeUmbrellaFrontier`,
 *      and a recording spawner in place of the `claude` binary.
 *
 * **Point this at a database you own.** It writes fixture task rows and a
 * scratch supervision, and deletes them again. Prod migrations are applied by
 * the deploy-keyed single runner (mt#2505), so a fresh local database needs
 * migrating first:
 *
 *   createdb minsky_verify_4571
 *   MINSKY_PERSISTENCE_POSTGRES_URL=postgresql://$USER@127.0.0.1:5432/minsky_verify_4571 \
 *     bun src/cli.ts persistence migrate --execute
 *
 * What it deliberately does NOT exercise, and why: the actual `claude` spawn
 * (`startDrivenSession` + `sendDrivenSessionInput`). Starting a real agent that
 * would begin working a real task is a side effect a verification run has no
 * business causing, and that path is not new here — it is mt#2750's shipped
 * host, exercised in production by every cockpit driven session. The NEW code
 * between the tick and that host is `dispatchSupervisedChild`'s workspace
 * resolution and prompt generation, which step 5 stops short of. Treat the
 * end-to-end spawn as UNVERIFIED by this script.
 *
 * Cleans up everything it creates, including on failure.
 *
 * Usage:
 *   MINSKY_PERSISTENCE_POSTGRES_URL=... bun scripts/verify-task-supervision.ts
 */
import "reflect-metadata";
import { eq, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

const SCRATCH_UMBRELLA = "mt#verify-task-supervision-scratch";
const FIXTURE_UMBRELLA = "mt#verify4571-umbrella";
const FIXTURE_CHILD_A = "mt#verify4571-a";
const FIXTURE_CHILD_B = "mt#verify4571-b";
const FIXTURE_TASK_IDS = [FIXTURE_UMBRELLA, FIXTURE_CHILD_A, FIXTURE_CHILD_B];

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];

function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      ${detail}`);
}

/**
 * Insert the two-node fixture DAG with raw SQL.
 *
 * Raw rather than through the task service because the point is to give the
 * REAL graph service real rows to read; how they got there is irrelevant, and
 * going through the creation path would drag in spec generation and status
 * gates that have nothing to do with what is under test.
 */
async function seedFixtureDag(db: PostgresJsDatabase): Promise<void> {
  await cleanupFixtureDag(db);
  await db.execute(sql`
    INSERT INTO tasks (id, backend, status, title, kind)
    VALUES
      (${FIXTURE_UMBRELLA}, 'minsky', 'IN-PROGRESS', 'verify4571 umbrella', 'implementation'),
      (${FIXTURE_CHILD_A}, 'minsky', 'READY', 'verify4571 child A', 'implementation'),
      (${FIXTURE_CHILD_B}, 'minsky', 'READY', 'verify4571 child B', 'implementation')
  `);
  await db.execute(sql`
    INSERT INTO task_relationships (from_task_id, to_task_id, type)
    VALUES
      (${FIXTURE_CHILD_A}, ${FIXTURE_UMBRELLA}, 'parent'),
      (${FIXTURE_CHILD_B}, ${FIXTURE_UMBRELLA}, 'parent'),
      (${FIXTURE_CHILD_B}, ${FIXTURE_CHILD_A}, 'depends')
  `);
}

async function cleanupFixtureDag(db: PostgresJsDatabase): Promise<void> {
  await db.execute(sql`
    DELETE FROM task_relationships
    WHERE from_task_id IN (${FIXTURE_UMBRELLA}, ${FIXTURE_CHILD_A}, ${FIXTURE_CHILD_B})
       OR to_task_id IN (${FIXTURE_UMBRELLA}, ${FIXTURE_CHILD_A}, ${FIXTURE_CHILD_B})
  `);
  await db.execute(sql`
    DELETE FROM tasks
    WHERE id IN (${FIXTURE_UMBRELLA}, ${FIXTURE_CHILD_A}, ${FIXTURE_CHILD_B})
  `);
}

async function main(): Promise<void> {
  const umbrellaArgIndex = process.argv.indexOf("--umbrella");
  const requestedUmbrella = umbrellaArgIndex >= 0 ? process.argv[umbrellaArgIndex + 1] : undefined;

  const connectionString = process.env.MINSKY_PERSISTENCE_POSTGRES_URL;
  const { PersistenceService } = await import("@minsky/domain/persistence/service");
  const service = new PersistenceService();

  if (connectionString) {
    await service.initialize({ backend: "postgres", postgres: { connectionString } });
  } else {
    const { initializeConfiguration, CustomConfigFactory } = await import(
      "@minsky/domain/configuration"
    );
    await initializeConfiguration(new CustomConfigFactory(), { workingDirectory: process.cwd() });
    await service.initialize();
  }

  const provider = service.getProvider();
  // The bare `PostgresJsDatabase` (schema `Record<string, never>`) is what
  // `TaskGraphService` takes and what `DrizzleSupervisionStore` accepts, so
  // typing the handle this way once avoids casting at either call site.
  const db = (await (
    provider as { getDatabaseConnection?: () => Promise<unknown> }
  ).getDatabaseConnection?.()) as PostgresJsDatabase | undefined;

  if (!db) {
    console.log("SKIP: no SQL-capable persistence provider configured.");
    process.exit(0);
  }

  const { taskSupervisionsTable, taskSupervisionDispatchesTable } = await import(
    "@minsky/domain/storage/schemas/task-supervisions-schema"
  );
  const { DrizzleSupervisionStore } = await import("@minsky/domain/supervision/supervision-store");
  const { runSupervisionTick } = await import("@minsky/domain/supervision/supervision-tick");
  const { computeUmbrellaFrontier } = await import("@minsky/domain/tasks/umbrella-frontier");

  const store = new DrizzleSupervisionStore(db);
  let supervisionId: string | null = null;

  try {
    // ---- 1. The migration applied ---------------------------------------
    const existingRows = await db.select().from(taskSupervisionsTable).limit(1);
    record(
      "migration applied — task_supervisions is readable",
      true,
      `SELECT returned ${existingRows.length} row(s) without error`
    );

    // ---- 2. Round-trip a supervision and a dispatch ----------------------
    const created = await store.createSupervision({
      umbrellaTaskId: SCRATCH_UMBRELLA,
      statusFilter: ["TODO", "READY"],
      wipLimit: 4,
      model: null,
    });
    supervisionId = created.supervision.id;
    record(
      "createSupervision round-trips through the live store",
      created.created && created.supervision.statusFilter.join(",") === "TODO,READY",
      `id=${created.supervision.id} statusFilter=${created.supervision.statusFilter.join(",")} wipLimit=${created.supervision.wipLimit}`
    );

    await store.recordDispatch({
      supervisionId,
      taskId: "mt#verify-child",
      drivenSessionLocalId: "verify-driven-1",
      minskySessionId: "verify-ws-1",
    });
    const inFlight = await store.listInFlightDispatches(supervisionId);
    record(
      "recordDispatch + listInFlightDispatches",
      inFlight.length === 1 && inFlight[0]?.taskId === "mt#verify-child",
      `in-flight=${inFlight.map((d) => d.taskId).join(",") || "(none)"}`
    );

    await store.recordDispatch({
      supervisionId,
      taskId: "mt#verify-child",
      drivenSessionLocalId: "verify-driven-2",
      minskySessionId: "verify-ws-2",
    });
    const afterRepeat = await store.listInFlightDispatches(supervisionId);
    record(
      "repeat recordDispatch is a no-op (no double-dispatch after a crash-restart)",
      afterRepeat.length === 1,
      `dispatch rows for this supervision: ${afterRepeat.length} (expected 1)`
    );

    const firstDispatch = inFlight[0];
    if (!firstDispatch) {
      throw new Error(
        "recordDispatch produced no in-flight row, so the settle path below cannot be exercised."
      );
    }
    await store.settleDispatch({
      dispatchId: firstDispatch.id,
      status: "succeeded",
      settledBy: "pr.merged",
      lastError: null,
      at: new Date(),
    });
    const afterSettle = await store.listInFlightDispatches(supervisionId);
    record(
      "settleDispatch clears the WIP slot",
      afterSettle.length === 0,
      `in-flight after settle: ${afterSettle.length} (expected 0)`
    );

    // ---- 3. The partial unique index refuses a second active supervision -
    const second = await store.createSupervision({
      umbrellaTaskId: SCRATCH_UMBRELLA,
      statusFilter: ["TODO"],
      wipLimit: 1,
      model: null,
    });
    record(
      "partial unique index refuses a second ACTIVE supervision for one umbrella",
      !second.created && second.supervision.id === supervisionId,
      `second create returned created=${second.created}, id=${second.supervision.id} (expected the existing ${supervisionId})`
    );

    // ---- 4. The advisory lock genuinely excludes -------------------------
    const postgres = (await import("postgres")).default;
    const { drizzle } = await import("drizzle-orm/postgres-js");
    if (!connectionString) {
      record(
        "advisory lock excludes a concurrent holder on a second connection",
        false,
        "UNVERIFIED: MINSKY_PERSISTENCE_POSTGRES_URL is not set, so a second connection could " +
          "not be opened. A single-connection probe cannot distinguish a working lock from one " +
          "that always grants, so this is reported as unverified rather than passed."
      );
    } else {
      const secondClient = postgres(connectionString, { max: 1 });
      const secondDb = drizzle(secondClient);
      const secondStore = new DrizzleSupervisionStore(secondDb);
      let concurrentResult: string | null = "not-run";
      try {
        await store.withSupervisionLock(supervisionId, async () => {
          concurrentResult = await secondStore.withSupervisionLock(
            supervisionId as string,
            async () => "acquired-concurrently"
          );
          return "outer";
        });
      } finally {
        await secondClient.end({ timeout: 5 });
      }
      record(
        "advisory lock excludes a concurrent holder on a second connection",
        concurrentResult === null,
        `second connection's withSupervisionLock returned ${JSON.stringify(concurrentResult)} (expected null)`
      );
    }

    // ---- 5. AT1 end-to-end, real store + real graph ----------------------
    const { createConfiguredTaskService } = await import("@minsky/domain/tasks/taskService");
    const { TaskGraphService } = await import("@minsky/domain/tasks/task-graph-service");
    const taskService = await createConfiguredTaskService({
      workspacePath: process.cwd(),
      persistenceProvider: provider,
    });
    const graphService = new TaskGraphService(db);

    const frontierDeps = {
      listChildren: (parentTaskId: string) => graphService.listChildren(parentTaskId),
      getDependsRelationships: async (taskIds: string[]) =>
        await graphService.getRelationshipsForTasks(taskIds, "depends"),
      getTasks: async (taskIds: string[]) => {
        const tasks = await taskService.getTasks(taskIds);
        return tasks.map((t) => ({ id: t.id, title: t.title, status: t.status }));
      },
    };

    // Seed a real two-node DAG so the frontier reads real rows through the real
    // graph service. An umbrella with no children would let this step pass
    // without the graph service ever being consulted — a probe that cannot fail.
    const umbrella = requestedUmbrella ?? FIXTURE_UMBRELLA;
    if (!requestedUmbrella) {
      await seedFixtureDag(db);
      record(
        "seeded a real two-node fixture DAG (B depends on A)",
        true,
        `${FIXTURE_UMBRELLA} -> ${FIXTURE_CHILD_A} (READY), ${FIXTURE_CHILD_B} (READY, depends on ${FIXTURE_CHILD_A})`
      );
    }
    await db
      .update(taskSupervisionsTable)
      .set({ umbrellaTaskId: umbrella })
      .where(eq(taskSupervisionsTable.id, supervisionId));

    const realFrontier = await computeUmbrellaFrontier(umbrella, ["READY"], frontierDeps);
    record(
      "computeUmbrellaFrontier reads the REAL task graph",
      realFrontier.dispatchable.length === 1 &&
        realFrontier.dispatchable[0]?.taskId === FIXTURE_CHILD_A &&
        realFrontier.blocked.length === 1,
      `${umbrella}: dispatchable=[${realFrontier.dispatchable.map((c) => c.taskId).join(",")}] ` +
        `blocked=[${realFrontier.blocked.map((c) => `${c.taskId}<-${c.blockedBy.join("+")}`).join(",")}]`
    );

    const spawnCalls: string[] = [];
    const buildRealTickDeps = () => ({
      store,
      computeFrontier: (umbrellaTaskId: string, statusFilter: readonly string[]) =>
        computeUmbrellaFrontier(umbrellaTaskId, statusFilter, frontierDeps),
      getTaskStatuses: async (taskIds: string[]) => {
        const tasks = await taskService.getTasks(taskIds);
        const out = new Map<string, string>();
        for (const t of tasks) if (t.status) out.set(t.id, t.status);
        return out;
      },
      drivenSessionLiveness: () => "live" as const,
      // No driven session exists for the fixture children — the real reader is
      // `listNonTerminalDrivenSessions`, exercised by the daemon rather than
      // here, since this script never spawns.
      hasLiveWriterForTask: async () => false,
      // Records instead of spawning. Everything ELSE in this call is real: the
      // store writes to the live database, the frontier reads the live graph.
      dispatchChild: async (input: { taskId: string }) => {
        spawnCalls.push(input.taskId);
        return {
          drivenSessionLocalId: `verify-spawn-${spawnCalls.length}`,
          minskySessionId: null,
        };
      },
      now: () => new Date(),
      logWarn: (m: string) => console.log(`      [warn] ${m}`),
    });

    const firstTick = await runSupervisionTick(buildRealTickDeps());
    const firstAdvance = firstTick.advances.find((a) => a.supervisionId === supervisionId);
    record(
      "AT1(a): the real tick dispatches ONLY the unblocked child",
      firstAdvance?.dispatched.length === 1 &&
        firstAdvance.dispatched[0] === FIXTURE_CHILD_A &&
        firstAdvance.error === null,
      `dispatched=[${firstAdvance?.dispatched.join(",") ?? ""}] holdReason=${firstAdvance?.holdReason ?? "-"} error=${firstAdvance?.error ?? "none"}`
    );

    // Reading the rows back is what separates "the function returned" from
    // "the write landed".
    const persistedDispatches = await store.listDispatches(supervisionId);
    const [persistedSupervision] = await db
      .select()
      .from(taskSupervisionsTable)
      .where(eq(taskSupervisionsTable.id, supervisionId));
    record(
      "the tick's dispatch row and clocks were persisted, not just returned",
      persistedDispatches.some((d) => d.taskId === FIXTURE_CHILD_A) &&
        persistedSupervision?.lastTickAt != null &&
        persistedSupervision?.lastAdvanceAt != null,
      `rows=[${persistedDispatches.map((d) => `${d.taskId}:${d.status}`).join(",")}] ` +
        `lastTickAt=${persistedSupervision?.lastTickAt?.toISOString() ?? "null"} ` +
        `lastAdvanceAt=${persistedSupervision?.lastAdvanceAt?.toISOString() ?? "null"}`
    );

    await db.execute(sql`UPDATE tasks SET status = 'DONE' WHERE id = ${FIXTURE_CHILD_A}`);

    const secondTick = await runSupervisionTick(buildRealTickDeps());
    const secondAdvance = secondTick.advances.find((a) => a.supervisionId === supervisionId);
    record(
      "AT1(b): the dependent child dispatches once its prerequisite reaches DONE",
      secondAdvance?.dispatched.length === 1 &&
        secondAdvance.dispatched[0] === FIXTURE_CHILD_B &&
        secondAdvance.settled.some((s) => s.taskId === FIXTURE_CHILD_A),
      `settled=[${secondAdvance?.settled.map((s) => `${s.taskId}:${s.status}/${s.settledBy}`).join(",") ?? ""}] ` +
        `dispatched=[${secondAdvance?.dispatched.join(",") ?? ""}]`
    );
    record(
      "no operator action occurred between the two dispatches",
      spawnCalls.length === 2 &&
        spawnCalls[0] === FIXTURE_CHILD_A &&
        spawnCalls[1] === FIXTURE_CHILD_B,
      `spawn calls, in order: ${spawnCalls.join(" -> ") || "(none)"}`
    );
  } finally {
    // Clean up whatever we created, on every path.
    if (supervisionId) {
      await db
        .delete(taskSupervisionDispatchesTable)
        .where(eq(taskSupervisionDispatchesTable.supervisionId, supervisionId));
      await db.delete(taskSupervisionsTable).where(eq(taskSupervisionsTable.id, supervisionId));
    }
    if (!requestedUmbrella) await cleanupFixtureDag(db);
    const leftovers = await db
      .select({ id: taskSupervisionsTable.id })
      .from(taskSupervisionsTable)
      .where(
        inArray(taskSupervisionsTable.umbrellaTaskId, [SCRATCH_UMBRELLA, ...FIXTURE_TASK_IDS])
      );
    console.log(
      `\nCleanup: scratch supervision removed; ${leftovers.length} leftover supervision row(s) (expected 0).`
    );
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  if (failed.length > 0) {
    console.log(`FAILED: ${failed.map((c) => c.name).join("; ")}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`verify-task-supervision: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
