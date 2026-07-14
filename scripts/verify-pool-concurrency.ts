#!/usr/bin/env bun
/**
 * Provider-level pool-concurrency smoke (mt#2773).
 *
 * Fires 120 concurrent PARAMETERLESS raw queries through the provider's
 * guarded `getRawSqlConnection()` path — the exact shape that permanently
 * wedged the shared pool before the guard (parameterless `sql.unsafe` =
 * simple protocol; concurrent simple-protocol ramp-up against the Supavisor
 * transaction pooler destroys connections and postgres-js never settles some
 * of their promises; see the mt#2773 spec's experiment matrix).
 *
 * With the guard (in-flight `.unsafe()` queries capped at pool max — submission
 * pacing, NOT protocol forcing, which was tested and falsified), all 120 must
 * settle in seconds.
 *
 * Usage: bun scripts/verify-pool-concurrency.ts
 * Exits 0 on pass or graceful skip (no raw-SQL provider); 1 on failure/timeout.
 */
import "reflect-metadata";
import { setupConfiguration } from "../packages/domain/src/config-setup";
import { PersistenceService } from "../packages/domain/src/persistence/service";

function emit(result: Record<string, unknown>): void {
  console.log(JSON.stringify(result, null, 2));
}

try {
  await setupConfiguration();
} catch (err) {
  emit({
    status: "SKIP",
    reason: `configuration unavailable: ${err instanceof Error ? err.message : String(err)}`,
  });
  process.exit(0);
}

const svc = new PersistenceService();
let rawSql: { unsafe: (q: string, p?: unknown[]) => PromiseLike<unknown> };
try {
  await svc.initialize();
  const provider = svc.getProvider() as {
    getRawSqlConnection?: () => Promise<typeof rawSql>;
  };
  if (typeof provider.getRawSqlConnection !== "function") {
    emit({ status: "SKIP", reason: "provider has no raw SQL connection (non-Postgres backend)" });
    process.exit(0);
  }
  rawSql = await provider.getRawSqlConnection();
} catch (err) {
  emit({
    status: "SKIP",
    reason: `persistence unavailable: ${err instanceof Error ? err.message : String(err)}`,
  });
  process.exit(0);
}

const N = 120;
const CAP_MS = 30_000;
const started = Date.now();

const cap = setTimeout(() => {
  emit({
    status: "FAIL",
    reason: `concurrent parameterless queries still pending after ${CAP_MS}ms — pool wedge present (guard not effective)`,
  });
  process.exit(1);
}, CAP_MS);

let rejected = 0;
const results = await Promise.all(
  Array.from({ length: N }, () =>
    Promise.resolve(rawSql.unsafe("SELECT 1 AS one")).then(
      () => true,
      () => {
        rejected++;
        return false;
      }
    )
  )
);
clearTimeout(cap);

const succeeded = results.filter(Boolean).length;
const pass = succeeded === N;
emit({
  status: pass ? "PASS" : "FAIL",
  n: N,
  succeeded,
  rejected,
  elapsedMs: Date.now() - started,
});
await svc.close?.();
process.exit(pass ? 0 : 1);
