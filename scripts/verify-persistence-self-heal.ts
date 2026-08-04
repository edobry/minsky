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

// No credentials in the DSN: the host is unresolvable, so DNS fails before any
// authentication is attempted, and a credential-shaped literal here would trip
// the pre-commit secret scan for no benefit.
const UNRESOLVABLE = "postgresql://nonexistent-mt3635.invalid:5432/db";
const LIVE = process.env.INTEGRATION_POSTGRES_URL ?? "postgres://edobry@127.0.0.1:5432/postgres";

/** Stands in for a service that captures a provider-derived fact at construction. */
interface DbBackedReader {
  canRead: boolean;
}

// The container's typed key space is the real AppServices map; this script
// registers its own keys, so the `as never` key cast is deliberate. `get()` then
// returns `never`, which needs no `as unknown` step to narrow.
function providerOf(c: TsyringeContainer): PersistenceProvider {
  return c.get("persistence" as never) as PersistenceProvider;
}

function readerOf(c: TsyringeContainer): DbBackedReader {
  return c.get("dbBackedReader" as never) as DbBackedReader;
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
  const postgres = (await import("postgres")).default;
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
    console.log(`SKIP: no reachable Postgres at ${LIVE.replace(/:\/\/[^@]*@/, "://***@")}`);
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

  // Stands in for taskService: captures a provider-derived fact at CONSTRUCTION
  // time, which is why swapping the provider alone does not restore it.
  container.register(
    "dbBackedReader" as never,
    ((inner: TsyringeContainer) => {
      const reader: DbBackedReader = { canRead: providerOf(inner).getCapabilities().sql };
      return reader as never;
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
  if (readerOf(container).canRead) {
    fail("expected the dependent to be non-functional at boot");
  }
  console.log(`boot        : degraded (${bootProvider.reason}); dependent canRead=false`);
  console.log(`              health mode=${bootHealth.mode}, lastAttemptAt=<absent>`);

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
    if (readerOf(container).canRead) {
      readerHealed = true;
      break;
    }
    await sleep(100);
  }
  if (!readerHealed) {
    fail("the provider recovered but its dependent was not rebuilt (criterion 2)");
  }
  console.log("dependent   : rebuilt, canRead=true");

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
