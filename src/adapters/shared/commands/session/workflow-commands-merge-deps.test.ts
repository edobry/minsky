/**
 * Regression test for mt#1025: ensure the session.pr.merge adapter
 * threads taskService and gitService from its DI deps into the
 * SessionMergeDependencies shape passed to mergeSessionPr.
 *
 * The bug: createSessionPrMergeCommand built a deps object with only
 * { sessionDB, persistenceProvider }. mt#972 Part 3 (209d95fee) had
 * removed the createConfiguredTaskService fallback in mergeSessionPr,
 * so every session_pr_merge call threw "taskService is required" until
 * this test's target (buildSessionMergeDeps) was fixed.
 *
 * mt#1475: also verifies that an explicit askRepository stub is threaded
 * through so the domain layer can emit quality.review Asks before merge.
 */

import { describe, it, expect } from "bun:test";
import { buildSessionMergeDeps } from "./workflow-commands";
import { FakeAskRepository } from "@minsky/domain/ask/repository";

describe("buildSessionMergeDeps (mt#1025)", () => {
  it("threads taskService, gitService, and sessionDB from DI deps", () => {
    const stubTaskService = { marker: "task" } as any;
    const stubGitService = { marker: "git" } as any;
    const stubSessionProvider = { marker: "persistence" } as any;

    const mergeDeps = buildSessionMergeDeps(
      {
        sessionProvider: stubSessionProvider,
        taskService: stubTaskService,
        gitService: stubGitService,
      } as any,
      undefined
    );

    expect(mergeDeps.taskService).toBe(stubTaskService);
    expect(mergeDeps.gitService).toBe(stubGitService);
    expect(mergeDeps.sessionDB).toBe(stubSessionProvider);
    expect(mergeDeps.persistenceProvider).toBeUndefined();
  });

  it("reads persistenceProvider from the container when registered", () => {
    const stubPersistence = { marker: "persistence" } as any;
    const container = {
      has: (key: string) => key === "persistence",
      get: (key: string) => (key === "persistence" ? stubPersistence : undefined),
    };

    const mergeDeps = buildSessionMergeDeps(
      { sessionProvider: {}, taskService: {}, gitService: {} } as any,
      container
    );

    expect(mergeDeps.persistenceProvider).toBe(stubPersistence);
  });

  it("omits persistenceProvider when the container has no persistence binding", () => {
    const container = {
      has: () => false,
      get: () => undefined,
    };

    const mergeDeps = buildSessionMergeDeps(
      { sessionProvider: {}, taskService: {}, gitService: {} } as any,
      container
    );

    expect(mergeDeps.persistenceProvider).toBeUndefined();
  });

  it("threads askRepository stub through when provided (mt#1475)", () => {
    const stubAskRepo = new FakeAskRepository();

    const mergeDeps = buildSessionMergeDeps(
      { sessionProvider: {}, taskService: {}, gitService: {} } as any,
      undefined,
      stubAskRepo
    );

    expect(mergeDeps.askRepository).toBe(stubAskRepo);
  });

  it("omits askRepository when not provided", () => {
    const mergeDeps = buildSessionMergeDeps(
      { sessionProvider: {}, taskService: {}, gitService: {} } as any,
      undefined
    );

    expect(mergeDeps.askRepository).toBeUndefined();
  });
});
