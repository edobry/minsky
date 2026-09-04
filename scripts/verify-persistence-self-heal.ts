#!/usr/bin/env bun
/**
 * mt#3635 — verify the persistence provider self-heals after a transient
 * boot-time failure, with no process restart.
 *
 * This exercises the REAL pieces end to end: the real `PersistenceService`, the
 * real Postgres provider, the real `TsyringeContainer` retry path. Only the
 * connection string varies between attempts — the first attempt points at an
 * unresolvable host to reproduce the originating `getaddrinfo ENOTFOUND`, and
 * later attempts point at a live database, standing in for the DNS blip
 * clearing seconds later.
 *
 * Why not just the unit tests: those inject a structural stand-in for the
 * degraded substitute. This asserts the arc holds when the substitute is a real
 * `UnconfiguredPersistenceProvider` produced by a real failed init, and when
 * recovery is a real Postgres connection — the substrate the acceptance test
 * names (`/implement-task` §7a).
 *
 * Env: INTEGRATION_POSTGRES_URL (defaults to a local Postgres). Skips cleanly
 * with exit 0 when no database is reachable.
 *
 *   bun scripts/verify-persistence-self-heal.ts
 */
import "reflect-metadata";
import { TsyringeContainer, RETRY_MIN_INTERVAL_MS } from "@minsky/domain/composition/container";
import { PersistenceService } from "@minsky/domain/persistence/service";
import { UnconfiguredPersistenceProvider } from "@minsky/domain/persistence/unconfigured-provider";
import { assessPersistenceHealth } from "@minsky/domain/persistence/health";
import type { PersistenceProvider } from "@minsky/domain/persistence/types";
import { maskConnectionString } from "@minsky/domain/persistence/connection-string";

// No credentials in the DSN: the host is unresolvable, so DNS fails before any
// authentication is attempted, and a credential-shaped literal here would trip
// the pre-commit secret scan for no benefit.
const UNRESOLVABLE = "postgresql://nonexistent-mt3635.invalid:5432/db";
// No username in the default (PR #2603 R1): baking one in makes the script look
// broken to everyone else. Omitted, postgres-js falls back to the OS user, which
// is what a local install grants anyway. Point it elsewhere with
// INTEGRATION_POSTGRES_URL.
const LIVE = process.env.INTEGRATION_POSTGRES_URL ?? "postgres://127.0.0.1:5432/postgres";

/**
 * The slice of the real task service this check needs. Deliberately the REAL
 * service rather than a stand-in: the criterion is that recovery reaches the
 * DEPENDENT, and `createConfiguredTaskService` is the dependent that was broken
 * in the incident — it registers no `mt` backend when built against a degraded
 * provider, which is what makes an existing task read as "not found".
 */
interface TaskServiceLike {
  listBackends?: () => Array<{ name: string }>;
  getTask(id: string): Promise<unknown>;
}

// The container's typed key space is the real AppServices map; this script
// registers its own keys, so the `as never` key cast is deliberate. `get()` then
// returns `never`, which needs no `as unknown` step to narrow.
function providerOf(c: TsyringeContainer): PersistenceProvider {
  return c.get("persistence" as never) as PersistenceProvider;
}

function taskServiceOf(c: TsyringeContainer): TaskServiceLike {
  return c.get("taskService" as never) as TaskServiceLike;
}

/** Names of the backends the real task service currently has registered. */
function backendNames(c: TsyringeContainer): string[] {
  return (taskServiceOf(c).listBackends?.() ?? []).map((b) => b.name);
}

function hasMinskyBackend(c: TsyringeContainer): boolean {
  return backendNames(c).some((name) => /minsky/i.test(name));
}

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Gate: is the live database reachable at all? If not, skip rather than fail. */
async function liveDbReachable(): Promise<boolean> {
  // Guarded import (PR #2603 R1): a missing driver throws BEFORE the
  // reachability check below, so without this the script would die with a
  // module-resolution stack trace instead of skipping the way it advertises.
  const postgresModule = await import("postgres").catch(() => null);
  if (postgresModule === null) {
    console.log("SKIP: the 'postgres' driver is not installed in this context");
    process.exit(0);
  }
  const postgres = postgresModule.default;
  const sql = postgres(LIVE, { max: 1, connect_timeout: 5, prepare: false, onnotice: () => {} });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    try {
      await sql.end({ timeout: 5 });
    } catch {
      // Best-effort: a failure to close the gate probe must not mask its result.
    }
  }
}

async function main(): Promise<void> {
  if (!(await liveDbReachable())) {
    console.log(`SKIP: no reachable Postgres at ${maskConnectionString(LIVE)}`);
    console.log("      set INTEGRATION_POSTGRES_URL to run this verification");
    process.exit(0);
  }

  let attempt = 0;
  const container = new TsyringeContainer();

  // Mirrors composition/domain.ts's persistence factory: catch a failed init and
  // RETURN the boot-tolerant substitute rather than throwing. That conversion is
  // the defect this task fixes, so the reproduction has to keep it.
  container.register(
    "persistence" as never,
    (async () => {
      attempt += 1;
      const connectionString = attempt === 1 ? UNRESOLVABLE : LIVE;
      const service = new PersistenceService();
      try {
        await service.initialize({ backend: "postgres", postgres: { connectionString } });
        return service.getProvider();
      } catch (err) {
        return new UnconfiguredPersistenceProvider(
          err instanceof Error ? err.message : String(err),
          true
        );
      }
    }) as never
  );

  // The REAL task service, registered after persistence exactly as
  // createDomainContainer() registers it. It resolves its backends at
  // CONSTRUCTION time, which is why swapping the provider alone does not
  // restore it — a healed provider behind a task service with zero registered
  // backends is precisely the shape that makes an existing task read as
  // "not found".
  container.register(
    "taskService" as never,
    (async (inner: TsyringeContainer) => {
      const { createConfiguredTaskService } = await import("@minsky/domain/tasks/taskService");
      return (await createConfiguredTaskService({
        workspacePath: process.cwd(),
        persistenceProvider: providerOf(inner),
      })) as never;
    }) as never
  );

  await container.initialize();

  // --- Boot state: degraded, and the dependent is broken with it -------------
  const bootProvider = providerOf(container);
  if (!(bootProvider instanceof UnconfiguredPersistenceProvider)) {
    fail(`expected the degraded substitute at boot, got ${bootProvider.constructor.name}`);
  }
  const bootHealth = assessPersistenceHealth(bootProvider);
  if (bootHealth.mode !== "unavailable") {
    fail(`expected mode "unavailable" at boot, got "${bootHealth.mode}"`);
  }
  if (bootHealth.lastAttemptAt !== undefined) {
    fail("expected no lastAttemptAt at boot (nothing has been retried yet)");
  }
  if (hasMinskyBackend(container)) {
    fail("expected the task service to have NO minsky backend at boot");
  }
  console.log(`boot        : degraded (${bootProvider.reason})`);
  console.log(`              health mode=${bootHealth.mode}, lastAttemptAt=<absent>`);
  console.log(
    `              taskService backends=[${backendNames(container).join(", ")}] ` +
      "(no minsky backend — the 'not found' shape)"
  );

  // --- The condition clears; a later use must recover without a restart ------
  container.get("persistence" as never);

  const deadlineMs = Date.now() + 30_000;
  let recovered = false;
  while (Date.now() < deadlineMs) {
    await sleep(250);
    if (providerOf(container).getCapabilities().sql) {
      recovered = true;
      break;
    }
  }
  if (!recovered) fail("provider did not recover within 30s of the database becoming reachable");

  const healedHealth = assessPersistenceHealth(providerOf(container));
  if (healedHealth.mode !== "connected") {
    fail(`expected mode "connected" after recovery, got "${healedHealth.mode}"`);
  }
  console.log(
    `recovered   : ${providerOf(container).constructor.name}, health mode=${healedHealth.mode}`
  );

  // --- The dependent must have been rebuilt, not just the provider swapped ---
  let readerHealed = false;
  const readerDeadlineMs = Date.now() + 10_000;
  while (Date.now() < readerDeadlineMs) {
    if (hasMinskyBackend(container)) {
      readerHealed = true;
      break;
    }
    await sleep(100);
  }
  if (!readerHealed) {
    fail("the provider recovered but its task service was not rebuilt (criterion 2)");
  }
  console.log(
    `dependent   : taskService rebuilt, backends=[${backendNames(container).join(", ")}]`
  );

  // Push one step further than backend registration where the environment
  // allows: actually READ through the rebuilt service. On a scratch database
  // Minsky's schema is absent — and it cannot be created there, because the
  // migration tree cannot bootstrap a fresh DB (mt#2439, open). Report which
  // of the two happened rather than claiming the stronger one.
  try {
    await taskServiceOf(container).getTask("mt#3635");
    console.log("read-through: getTask() executed against the rebuilt backend (no throw)");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The driver error is WRAPPED: drizzle surfaces "Failed query: select …"
    // and keeps the postgres-js error underneath, so neither the SQLSTATE nor
    // the "relation … does not exist" text is present at the top level. How
    // deeply it nests is a detail of two libraries' error plumbing, so walk the
    // whole `cause` chain instead of assuming a depth — an earlier version
    // inspected only `err` and one `err.cause` typed as `Error`, and reported a
    // schema-less database as an unexpected FAILURE rather than skipping.
    const chain: unknown[] = [];
    for (let node: unknown = err, depth = 0; node != null && depth < 10; depth += 1) {
      chain.push(node);
      node = (node as { cause?: unknown }).cause;
    }
    // Two SQLSTATEs mean the same thing for THIS check: the database is not at
    // the current migration level. 42P01 (undefined_table) is a scratch DB with
    // no Minsky schema at all; 42703 (undefined_column) is a stale one whose
    // `tasks` predates a later migration. Neither says anything about the retry
    // arc being verified here, and a fresh DB cannot be migrated to compare
    // (mt#2439, open). Schema correctness is the test suite's job, not this
    // artifact's — but note the skip loudly rather than passing silently.
    const staleSchemaPattern = /relation .* does not exist|no such table|column .* does not exist/i;
    const staleSchema = chain.some((node) => {
      const code = (node as { code?: unknown }).code;
      if (code === "42P01" || code === "42703") return true;
      const text = node instanceof Error ? node.message : String(node);
      return staleSchemaPattern.test(text);
    });
    if (!staleSchema) {
      fail(`getTask() through the rebuilt service failed unexpectedly: ${message}`);
    }
    console.log(
      "read-through: SKIPPED — this database is not at the current migration level " +
        "(no Minsky schema, or a stale one), and a fresh DB cannot be migrated " +
        "(mt#2439). Backend registration above is the assertion that ran."
    );
  }

  // --- The retry must be rate-limited, not fired per call --------------------
  const attemptsBefore = attempt;
  for (let i = 0; i < 50; i += 1) container.get("persistence" as never);
  await sleep(200);
  if (attempt !== attemptsBefore) {
    fail(`a healthy key must not be retried at all; ${attempt - attemptsBefore} extra attempts`);
  }
  console.log(
    `rate limit  : 50 further get() calls issued 0 re-init attempts ` +
      `(floor ${RETRY_MIN_INTERVAL_MS}ms)`
  );

  console.log(`\nPASS: recovered after ${attempt} init attempts, no process restart`);
  process.exit(0);
}

await main();
