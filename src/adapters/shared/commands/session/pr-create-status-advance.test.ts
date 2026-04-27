/**
 * Regression test for mt#1266: ensure executeSessionPrCreate threads
 * taskService from its DI deps into the SessionPrCreateDependencies shape
 * passed to sessionPrCreate.
 *
 * The bug: executeSessionPrCreate built the deps object with only
 * { sessionDB, persistenceProvider, askRepository }. taskService was never
 * forwarded, so the auto-advance branch in sessionPrImpl always hit the
 * `log.warn("No taskService in deps")` path and skipped the IN-REVIEW update.
 */

import { describe, it, expect } from "bun:test";
import { buildSessionPrCreateDeps } from "./pr-create-command";
import type { SessionCommandDependencies } from "./types";

describe("buildSessionPrCreateDeps (mt#1266)", () => {
  it("threads taskService, sessionDB from DI deps", () => {
    const stubTaskService = { marker: "task" } as any;
    const stubSessionProvider = { marker: "sessiondb" } as any;

    const prCreateDeps = buildSessionPrCreateDeps(
      {
        sessionProvider: stubSessionProvider,
        taskService: stubTaskService,
      } as unknown as SessionCommandDependencies,
      undefined
    );

    expect(prCreateDeps.taskService).toBe(stubTaskService);
    expect(prCreateDeps.sessionDB).toBe(stubSessionProvider);
    expect(prCreateDeps.persistenceProvider).toBeUndefined();
    expect(prCreateDeps.askRepository).toBeUndefined();
  });

  it("reads persistenceProvider from the container when registered", () => {
    const stubPersistence = { marker: "persistence" } as any;
    const container = {
      has: (key: string) => key === "persistence",
      get: (key: string) => (key === "persistence" ? stubPersistence : undefined),
    };

    const prCreateDeps = buildSessionPrCreateDeps(
      { sessionProvider: {}, taskService: {} } as unknown as SessionCommandDependencies,
      container
    );

    expect(prCreateDeps.persistenceProvider).toBe(stubPersistence);
  });

  it("omits persistenceProvider when the container has no persistence binding", () => {
    const container = {
      has: () => false,
      get: () => undefined,
    };

    const prCreateDeps = buildSessionPrCreateDeps(
      { sessionProvider: {}, taskService: {} } as unknown as SessionCommandDependencies,
      container
    );

    expect(prCreateDeps.persistenceProvider).toBeUndefined();
  });

  it("passes through an explicit askRepository when provided", () => {
    const stubAskRepo = { marker: "ask" } as any;

    const prCreateDeps = buildSessionPrCreateDeps(
      { sessionProvider: {}, taskService: {} } as unknown as SessionCommandDependencies,
      undefined,
      stubAskRepo
    );

    expect(prCreateDeps.askRepository).toBe(stubAskRepo);
  });
});
