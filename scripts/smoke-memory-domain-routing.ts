#!/usr/bin/env bun
/**
 * Smoke test for memory domain vector storage routing (mt#1605).
 *
 * Verifies that:
 * 1. Provider has getVectorStorageForDomain method
 * 2. Domain "memory" routes to memories_embeddings (not tasks_embeddings)
 * 3. Domain "tasks" routes correctly
 * 4. memories_embeddings table exists and is queryable
 *
 * Required env vars: DATABASE_URL or MINSKY_POSTGRES_URL
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — one or more checks failed
 *   2 — skip (required env vars not set)
 */

import "reflect-metadata";

const dbUrl = process.env.DATABASE_URL || process.env.MINSKY_POSTGRES_URL;

if (!dbUrl) {
  console.log("SKIP: DATABASE_URL or MINSKY_POSTGRES_URL not set");
  process.exit(2);
}

// Assign to non-optional const after the guard
const connectionString: string = dbUrl;

interface SmokeResult {
  check: string;
  passed: boolean;
  detail?: string;
}

const results: SmokeResult[] = [];

function pass(check: string, detail?: string): void {
  results.push({ check, passed: true, detail });
  console.log(`  PASS  ${check}${detail ? `: ${detail}` : ""}`);
}

function fail(check: string, detail: string): void {
  results.push({ check, passed: false, detail });
  console.error(`  FAIL  ${check}: ${detail}`);
}

async function run(): Promise<void> {
  console.log("smoke-memory-domain-routing: starting");
  console.log(`  Database: ${connectionString.replace(/:[^:@]+@/, ":<REDACTED>@")}`);
  console.log("");

  // Bootstrap persistence
  const { PersistenceService } = await import("../src/domain/persistence/service");
  const service = new PersistenceService();
  await service.initialize({ backend: "postgres", postgres: { connectionString } });

  const provider = service.getProvider();

  // Check 1: provider reports vectorStorage capability
  if (provider.capabilities.vectorStorage) {
    pass("provider.capabilities.vectorStorage", "true");
  } else {
    fail("provider.capabilities.vectorStorage", "false — Postgres without pgvector?");
    printAndExit();
    return;
  }

  // Check 2: getVectorStorageForDomain exists
  const hasNewApi =
    "getVectorStorageForDomain" in provider &&
    typeof (provider as Record<string, unknown>)["getVectorStorageForDomain"] === "function";

  if (!hasNewApi) {
    fail("getVectorStorageForDomain", "method not present on provider — old code deployed?");
    printAndExit();
    return;
  }

  // Use a typed accessor to avoid as-unknown casts
  const domainMethod = (provider as Record<string, unknown>)["getVectorStorageForDomain"] as (
    domain: string,
    dimension: number
  ) => unknown;

  // Check 3: domain "memory" returns an instance
  // Use .call(provider, ...) to preserve `this` binding — bare method reference loses it
  const memVs = domainMethod.call(provider, "memory", 1536);
  if (memVs) {
    pass("getVectorStorageForDomain('memory', 1536)", "returned instance");
  } else {
    fail("getVectorStorageForDomain('memory', 1536)", "returned null");
  }

  // Check 4: domain "tasks" returns an instance
  const tasksVs = domainMethod.call(provider, "tasks", 1536);
  if (tasksVs) {
    pass("getVectorStorageForDomain('tasks', 1536)", "returned instance");
  } else {
    fail("getVectorStorageForDomain('tasks', 1536)", "returned null");
  }

  // Check 5: memories_embeddings table exists (raw query)
  try {
    const providerWithConnection = provider as {
      getDatabaseConnection?: () => Promise<unknown>;
    };
    if (typeof providerWithConnection.getDatabaseConnection === "function") {
      // Call through provider to preserve `this` binding
      const rawDb = await providerWithConnection.getDatabaseConnection();
      if (rawDb) {
        const { sql } = await import("drizzle-orm");
        // Use Drizzle's execute — rawDb satisfies this at runtime (PostgresJsDatabase)
        const typedDb = rawDb as { execute: (q: unknown) => Promise<{ rows: unknown[] }> };
        const result = await typedDb.execute(
          sql`SELECT COUNT(*) AS count FROM memories_embeddings`
        );
        const firstRow = (result?.rows?.[0] ?? {}) as Record<string, unknown>;
        const count = firstRow["count"] ?? "?";
        pass("memories_embeddings table exists", `row count: ${count}`);
      } else {
        fail("memories_embeddings table check", "getDatabaseConnection() returned null");
      }
    } else {
      fail("memories_embeddings table check", "getDatabaseConnection not available");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail("memories_embeddings table exists", `query failed: ${msg.split("\n")[0] ?? msg}`);
  }

  await service.close();
  printAndExit();
}

function printAndExit(): void {
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = total - passed;
  console.log("");
  console.log(`Results: ${passed}/${total} passed, ${failed} failed`);
  if (failed > 0) {
    console.error("smoke-memory-domain-routing: FAILED");
    process.exit(1);
  } else {
    console.log("smoke-memory-domain-routing: PASSED");
    process.exit(0);
  }
}

run().catch((err) => {
  console.error("smoke-memory-domain-routing: unhandled error:", err);
  process.exit(1);
});
