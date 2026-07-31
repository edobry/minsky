/**
 * Tests for validatePostgresBackend's false-positive-health-check fix
 * (mt#2949).
 *
 * Root cause (2026-07-19 outage): `validatePostgresBackend` branched on
 * `provider.getCapabilities().sql`. When persistence init failed and DI
 * substituted `UnconfiguredPersistenceProvider`, it logged "Non-SQL backend
 * initialized successfully", skipped all further checks, and returned
 * `{success: true}` — a dead branch written for a non-Postgres backend that
 * no longer exists (Postgres-only since mt#2349). This is exactly why
 * `persistence_check` reported SUCCESS during the outage while every
 * session tool was dead.
 *
 * These tests use dependency injection (the `deps.getConfiguration` seam)
 * rather than `mock.module()`, which is banned outside tests/setup.ts
 * (eslint-rules/no-global-module-mocks.js).
 */

import { describe, test, expect } from "bun:test";
import { validatePostgresBackend } from "./validation-operations";
import { UnconfiguredPersistenceProvider } from "./unconfigured-provider";
import type { Configuration } from "../configuration/schemas";

const CONNECTION_STRING = "postgresql://user:pass@host:5432/db";

function configWithConnectionString(): Configuration {
  return {
    persistence: {
      backend: "postgres",
      postgres: { connectionString: CONNECTION_STRING },
    },
  } as unknown as Configuration;
}

function configWithoutConnectionString(): Configuration {
  return {} as unknown as Configuration;
}

describe("validatePostgresBackend (mt#2949 false-positive fix)", () => {
  test("connection string configured but the live provider is the Unconfigured placeholder (init failed) → fails, does NOT mask as success", async () => {
    const provider = new UnconfiguredPersistenceProvider(
      "migration failed: CREATE SCHEMA IF NOT EXISTS drizzle",
      true
    );

    const result = await validatePostgresBackend(provider, {
      getConfiguration: configWithConnectionString,
    });

    expect(result.success).toBe(false);
    const issues = result.issues ?? [];
    expect(issues.some((i) => i.includes("not SQL-capable"))).toBe(true);
    expect(issues.some((i) => i.includes("CREATE SCHEMA"))).toBe(true);
  });

  test("connection string configured, provider is the Unconfigured placeholder for a deliberately-unconfigured reason → still fails (Postgres-only; no legitimate non-SQL backend exists)", async () => {
    // Even the `configuredButUnavailable: false` construction fails here,
    // because reaching this branch at all already proves a connection
    // string IS configured (the early return above handles "not configured
    // at all"). Any sql=false provider seen past that point is a failure.
    const provider = new UnconfiguredPersistenceProvider("no Postgres connection configured");

    const result = await validatePostgresBackend(provider, {
      getConfiguration: configWithConnectionString,
    });

    expect(result.success).toBe(false);
  });

  test("no connection string configured at all → fails with the pre-existing 'not configured' message (unchanged behavior)", async () => {
    const provider = new UnconfiguredPersistenceProvider("no Postgres connection configured");

    const result = await validatePostgresBackend(provider, {
      getConfiguration: configWithoutConnectionString,
    });

    expect(result.success).toBe(false);
    expect(result.details).toBe("PostgreSQL connection not configured");
  });
});
