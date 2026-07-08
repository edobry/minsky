/**
 * mapDeploymentRecordToEvent tests (mt#2537) — the deploy.live / deploy.fail
 * status-to-event mapping used by the `deployment.wait-for-latest` execute
 * handler's best-effort system-event emit.
 *
 * Also covers makeDeployBuildObserver (mt#2599) — the deploy.build
 * onStatusObserved factory used by the same execute handler.
 */
import { describe, test, expect } from "bun:test";
import { mapDeploymentRecordToEvent, makeDeployBuildObserver } from "./deployment";
import type { DeploymentRecord } from "@minsky/domain/deployment";
import type { AppContainerInterface } from "@minsky/domain/composition/types";

function record(status: DeploymentRecord["status"]): DeploymentRecord {
  return {
    id: "dep-1",
    status,
    commitHash: "abc123",
    commitMessage: "test commit",
    createdAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:05:00Z",
    durationMs: 300_000,
    url: null,
  };
}

describe("mapDeploymentRecordToEvent (mt#2537)", () => {
  test("SUCCESS maps to deploy.live with phase 'live'", () => {
    const event = mapDeploymentRecordToEvent(record("SUCCESS"), "reviewer");
    expect(event.eventType).toBe("deploy.live");
    expect(event.payload).toEqual({ phase: "live", service: "reviewer", status: "SUCCESS" });
  });

  test("FAILED maps to deploy.fail with phase 'fail'", () => {
    const event = mapDeploymentRecordToEvent(record("FAILED"), "reviewer");
    expect(event.eventType).toBe("deploy.fail");
    expect(event.payload).toEqual({ phase: "fail", service: "reviewer", status: "FAILED" });
  });

  test("CRASHED maps to deploy.fail", () => {
    const event = mapDeploymentRecordToEvent(record("CRASHED"), "site");
    expect(event.eventType).toBe("deploy.fail");
    expect(event.payload.status).toBe("CRASHED");
  });

  test("CANCELLED maps to deploy.fail (not 'live' for this bridge)", () => {
    const event = mapDeploymentRecordToEvent(record("CANCELLED"), "site");
    expect(event.eventType).toBe("deploy.fail");
    expect(event.payload.status).toBe("CANCELLED");
  });

  test("service is passed through as undefined when not provided", () => {
    const event = mapDeploymentRecordToEvent(record("SUCCESS"), undefined);
    expect(event.payload.service).toBeUndefined();
  });
});

/**
 * Fake DI container satisfying emitSystemEventBestEffort's duck-typed
 * persistence contract (`system-event-emit.ts`): `has("persistence")` ->
 * true, `get("persistence")` -> an object with `capabilities.sql: true` and a
 * `getDatabaseConnection` we can count calls to. Returning `null` from
 * `getDatabaseConnection` makes emitSystemEventBestEffort no-op immediately
 * after that call, so we observe "an emit was attempted" via the call count
 * without needing a live DrizzleEventEmitter/DB.
 */
function fakeContainerWithCallCounter(): {
  container: AppContainerInterface;
  getDatabaseConnectionCallCount: () => number;
} {
  let calls = 0;
  const persistence = {
    capabilities: { sql: true },
    getDatabaseConnection: async () => {
      calls++;
      return null;
    },
  };
  const container = {
    has: (k: string) => k === "persistence",
    get: (k: string) => (k === "persistence" ? persistence : undefined),
  } as unknown as AppContainerInterface;
  return { container, getDatabaseConnectionCallCount: () => calls };
}

describe("makeDeployBuildObserver (mt#2599)", () => {
  test("attempts an emit on a BUILDING observation", async () => {
    const { container, getDatabaseConnectionCallCount } = fakeContainerWithCallCounter();
    const observer = makeDeployBuildObserver(container, "reviewer");
    await observer(record("BUILDING"));
    expect(getDatabaseConnectionCallCount()).toBe(1);
  });

  test("does NOT attempt an emit for non-BUILDING statuses", async () => {
    const { container, getDatabaseConnectionCallCount } = fakeContainerWithCallCounter();
    const observer = makeDeployBuildObserver(container, "reviewer");
    await observer(record("DEPLOYING"));
    await observer(record("SUCCESS"));
    await observer(record("FAILED"));
    expect(getDatabaseConnectionCallCount()).toBe(0);
  });

  test("fires exactly once per call even across repeated BUILDING observations", async () => {
    const { container, getDatabaseConnectionCallCount } = fakeContainerWithCallCounter();
    const observer = makeDeployBuildObserver(container, "reviewer");
    await observer(record("BUILDING"));
    await observer(record("BUILDING"));
    await observer(record("BUILDING"));
    await observer(record("SUCCESS"));
    expect(getDatabaseConnectionCallCount()).toBe(1);
  });

  test("a fresh call produces an independent observer (no shared state across deploys)", async () => {
    const first = fakeContainerWithCallCounter();
    const second = fakeContainerWithCallCounter();
    const firstObserver = makeDeployBuildObserver(first.container, "reviewer");
    const secondObserver = makeDeployBuildObserver(second.container, "site");
    await firstObserver(record("BUILDING"));
    await secondObserver(record("BUILDING"));
    expect(first.getDatabaseConnectionCallCount()).toBe(1);
    expect(second.getDatabaseConnectionCallCount()).toBe(1);
  });

  test("does not throw when container is undefined (no persistence available)", async () => {
    const observer = makeDeployBuildObserver(undefined, "reviewer");
    await expect(observer(record("BUILDING"))).resolves.toBeUndefined();
  });
});
