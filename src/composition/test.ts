/**
 * Test Composition Root
 *
 * Builds an AppContainer with fake/stub implementations for testing.
 * No I/O, no database connections, no filesystem access.
 *
 * Usage in tests:
 *   const container = createTestContainer({ persistence: myFakePersistence });
 *   const sessionProvider = container.get("sessionProvider");
 *
 * @see mt#761 spec, "Phase 2: Create composition roots"
 */

import { TsyringeContainer } from "./container";
import type { AppServices, AppContainerInterface } from "./types";

/**
 * Create a container with fake implementations for testing.
 * Override specific services by passing them in the overrides parameter.
 * No initialize() call needed — all services are set directly.
 */
export function createTestContainer(overrides: Partial<AppServices> = {}): AppContainerInterface {
  const container = new TsyringeContainer();

  // Default fakes — minimal stubs that satisfy the type constraints.
  // Tests override the services they actually care about.
  /* eslint-disable @typescript-eslint/no-explicit-any, custom/no-excessive-as-unknown */
  const defaults: AppServices = {
    persistence: {
      capabilities: { sql: false, vector: false },
      getCapabilities: () => ({ sql: false, vector: false }),
      getStorage: () => ({}) as any,
      initialize: async () => {},
      close: async () => {},
    } as unknown as AppServices["persistence"],

    sessionProvider: {
      getSession: async () => null,
      listSessions: async () => [],
      addSession: async () => {},
      deleteSession: async () => {},
      updateSession: async () => {},
    } as unknown as AppServices["sessionProvider"],

    gitService: {
      clone: async () => ({ workdir: "", session: "" }),
      branch: async () => ({ workdir: "", branch: "" }),
      branchWithoutSession: async () => ({ workdir: "", branch: "" }),
      execInRepository: async () => "",
      getSessionWorkdir: () => "",
      stashChanges: async () => ({ workdir: "", stashed: false }),
      fetchLatest: async () => ({ workdir: "", updated: false }),
      mergeBranch: async () => ({ workdir: "", merged: false, conflicts: false }),
      push: async () => ({ workdir: "", pushed: false }),
      popStash: async () => ({ workdir: "", stashed: false }),
      getStatus: async () => ({ modified: [], untracked: [], deleted: [] }),
      getCurrentBranch: async () => "main",
      hasUncommittedChanges: async () => false,
      fetchDefaultBranch: async () => "main",
      predictMergeConflicts: async () => ({ hasConflicts: false, conflictingFiles: [] }) as any,
      analyzeBranchDivergence: async () => ({}) as any,
      mergeWithConflictPrevention: async () => ({}) as any,
      smartSessionUpdate: async () => ({}) as any,
    } as unknown as AppServices["gitService"],

    taskService: {
      listTasks: async () => [],
      getTask: async () => null,
      getTaskStatus: async () => undefined,
      setTaskStatus: async () => {},
      createTask: async () => ({ id: "mt#1", title: "test", status: "TODO" }) as any,
      createTaskFromTitleAndSpec: async () =>
        ({ id: "mt#1", title: "test", status: "TODO" }) as any,
      deleteTask: async () => {},
    } as unknown as AppServices["taskService"],

    workspaceUtils: {
      isSessionWorkspace: async () => false,
      getSessionFromWorkspace: async () => null,
    } as unknown as AppServices["workspaceUtils"],

    repositoryBackend: {
      repoUrl: "https://github.com/test/repo.git",
      backendType: "github" as any,
    },

    sessionDeps: {} as any, // Tests that need sessionDeps should override this

    taskGraphService: {
      addDependency: async () => ({ created: false }),
      removeDependency: async () => ({ removed: false }),
      listDependencies: async () => [],
      listDependents: async () => [],
      addParent: async () => {},
      removeParent: async () => {},
      getParent: async () => null,
      listChildren: async () => [],
      getRelationshipsForTasks: async () => [],
    } as unknown as AppServices["taskGraphService"],

    taskRoutingService: {
      findAvailableTasks: async () => [],
      generateRoute: async () => ({
        targetTaskId: "",
        targetTitle: "",
        strategy: "ready-first",
        steps: [],
        parallelTracks: [],
        totalTasks: 0,
        readyTasks: 0,
        blockedTasks: 0,
      }),
    } as unknown as AppServices["taskRoutingService"],
  };

  /* eslint-enable @typescript-eslint/no-explicit-any, custom/no-excessive-as-unknown */

  // Apply defaults then overrides
  for (const key of Object.keys(defaults) as (keyof AppServices)[]) {
    container.set(key, (overrides[key] ?? defaults[key]) as AppServices[typeof key]);
  }

  return container;
}
