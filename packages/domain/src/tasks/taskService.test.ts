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

/**
 * mt#3636 — the same failure, one layer further out.
 *
 * mt#2949 (above) made the boot failure LOUD in the log. It stayed invisible at
 * the tool surface anyway, because the log goes to stderr and an MCP client
 * only sees the tool result — which was `{tasks: [], total: 0}`. These tests
 * exercise the REAL factory (not a hand-built `TaskServiceImpl`) so they cover
 * the production wiring: the reason recorded in the catch block must reach the
 * zero-backend guard's message.
 */
describe("createConfiguredTaskService — degraded reads fail closed (mt#3636)", () => {
  /** The verbatim boot failure from the 2026-08-03 incident. */
  const BOOT_FAILURE = "getaddrinfo ENOTFOUND";
  const WORKSPACE = "/tmp/mt3636-test-workspace";

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

  test("configured-but-unavailable: listTasks RAISES and carries the boot reason end-to-end", async () => {
    const service = await createConfiguredTaskService({
      workspacePath: WORKSPACE,
      persistenceProvider: new UnconfiguredPersistenceProvider(BOOT_FAILURE, true),
    });

    const error = await service.listTasks().catch((e: unknown) => e as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("TaskBackendUnavailableError");
    // The verbatim reason from the persistence provider survives the hop from
    // the catch block through setBackendUnavailable into the guard's message.
    expect(error.message).toContain(BOOT_FAILURE);
    expect(error.message).toContain("postgres");
  });

  test("configured-but-unavailable: a task that EXISTS is not reported as not-found", async () => {
    const service = await createConfiguredTaskService({
      workspacePath: WORKSPACE,
      persistenceProvider: new UnconfiguredPersistenceProvider(BOOT_FAILURE, true),
    });

    // The incident: `tasks_status_get mt#3524` answered "not found or has no
    // status" for a real task. Returning undefined here is the defect.
    await expect(service.getTaskStatus("mt#3524")).rejects.toThrow(/Task backend unavailable/);
  });

  test("deliberately unconfigured: still raises, with configure-Postgres guidance", async () => {
    const service = await createConfiguredTaskService({
      workspacePath: WORKSPACE,
      persistenceProvider: new UnconfiguredPersistenceProvider(
        "no Postgres connection configured",
        false
      ),
    });

    const error = await service.listTasks().catch((e: unknown) => e as Error);

    expect(error.message).toContain("persistence is not configured");
    expect(error.message).not.toContain("failed to initialize at boot");
  });
});
