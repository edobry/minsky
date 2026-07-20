/**
 * Tests for createConfiguredTaskService's "mt" backend registration
 * silent-degrade fix (mt#2949).
 *
 * Root cause (2026-07-19 outage forensics): when the injected
 * persistenceProvider's `getDatabaseConnection()` throws (the Unconfigured
 * placeholder DI substitutes when Postgres initialization fails), the catch
 * block always logged at `log.warn` and silently skipped registering the
 * "mt" backend — the SAME log severity whether persistence was deliberately
 * unconfigured (local/dev, expected) or configured-but-unreachable
 * (deployed, a genuine outage). The failure only surfaced much later,
 * confusingly, as "No backends registered" once something tried to use the
 * task service.
 *
 * These tests spy on `log.error`/`log.warn` (established pattern — see
 * persistence/postgres-notice-handler.test.ts) rather than using
 * `mock.module()`, which is banned (eslint-rules/no-global-module-mocks.js).
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { log } from "@minsky/shared/logger";
import { createConfiguredTaskService } from "./taskService";
import { UnconfiguredPersistenceProvider } from "../persistence/unconfigured-provider";

describe("createConfiguredTaskService — mt backend silent-degrade fix (mt#2949)", () => {
  let errorSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    errorSpy = spyOn(log, "error").mockImplementation(() => {});
    warnSpy = spyOn(log, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test("configured-but-unavailable (Postgres configured, init failed) surfaces via log.error, not log.warn", async () => {
    const provider = new UnconfiguredPersistenceProvider(
      "connect ECONNREFUSED — Postgres unreachable",
      true
    );

    await createConfiguredTaskService({
      workspacePath: "/tmp/mt2949-test-workspace",
      persistenceProvider: provider,
    });

    const errorCalls = errorSpy.mock.calls.map((c) => String(c[0]));
    expect(errorCalls.some((msg) => msg.includes("Minsky task backend unavailable"))).toBe(true);

    // The pre-existing "Minsky backend database connection failed" warn must
    // NOT also fire for this case — it's the deliberately-unconfigured path.
    const warnCalls = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnCalls.some((msg) => msg.includes("Minsky backend database connection failed"))).toBe(
      false
    );
  });

  test("deliberately unconfigured (no connection string anywhere) keeps the quiet log.warn path — no regression for local/dev", async () => {
    const provider = new UnconfiguredPersistenceProvider(
      "no Postgres connection configured",
      false
    );

    await createConfiguredTaskService({
      workspacePath: "/tmp/mt2949-test-workspace",
      persistenceProvider: provider,
    });

    const warnCalls = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnCalls.some((msg) => msg.includes("Minsky backend database connection failed"))).toBe(
      true
    );

    const errorCalls = errorSpy.mock.calls.map((c) => String(c[0]));
    expect(errorCalls.some((msg) => msg.includes("Minsky task backend unavailable"))).toBe(false);
  });
});
