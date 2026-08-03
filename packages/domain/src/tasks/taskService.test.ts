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
 * mt#3628: the severity split itself is `classifyBackendUnavailableSeverity`,
 * a pure function tested below by return value. `createConfiguredTaskService`
 * gets one wiring test verifying the shell routes through the decision via
 * its injected `logSink` (constructor option), never `spyOn(log)`.
 */

import { describe, test, expect } from "bun:test";
import { createConfiguredTaskService, classifyBackendUnavailableSeverity } from "./taskService";
import { UnconfiguredPersistenceProvider } from "../persistence/unconfigured-provider";

describe("classifyBackendUnavailableSeverity (pure core, mt#3628 / mt#2949)", () => {
  test("configured-but-unavailable classifies as error", () => {
    expect(classifyBackendUnavailableSeverity(true)).toBe("error");
  });

  test("deliberately unconfigured classifies as warn", () => {
    expect(classifyBackendUnavailableSeverity(false)).toBe("warn");
  });
});

describe("createConfiguredTaskService — mt backend silent-degrade fix (mt#2949)", () => {
  test("wiring: severity routes to the matching logSink method, not spyOn(log) (mt#3628)", async () => {
    const errorCalls: string[] = [];
    const warnCalls: string[] = [];
    const logSink = {
      error: (message: string) => errorCalls.push(message),
      warn: (message: string) => warnCalls.push(message),
    };

    // configured-but-unavailable -> error, not warn.
    await createConfiguredTaskService({
      workspacePath: "/tmp/mt2949-test-workspace",
      persistenceProvider: new UnconfiguredPersistenceProvider(
        "connect ECONNREFUSED — Postgres unreachable",
        true
      ),
      logSink,
    });
    expect(errorCalls.some((msg) => msg.includes("Minsky task backend unavailable"))).toBe(true);
    // The pre-existing "Minsky backend database connection failed" warn must
    // NOT also fire for this case — it's the deliberately-unconfigured path.
    expect(warnCalls.some((msg) => msg.includes("Minsky backend database connection failed"))).toBe(
      false
    );

    // deliberately unconfigured -> warn, not error — no regression for local/dev.
    errorCalls.length = 0;
    warnCalls.length = 0;
    await createConfiguredTaskService({
      workspacePath: "/tmp/mt2949-test-workspace",
      persistenceProvider: new UnconfiguredPersistenceProvider(
        "no Postgres connection configured",
        false
      ),
      logSink,
    });
    expect(warnCalls.some((msg) => msg.includes("Minsky backend database connection failed"))).toBe(
      true
    );
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
