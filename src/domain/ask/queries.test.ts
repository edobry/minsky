/**
 * Tests for Ask query helpers (render-time enrichment utilities).
 *
 * All tests use FakeAskRepository — hermetic, no DB required.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { FakeAskRepository } from "./repository";
import type { CreateAskInput } from "./repository";
import type { Ask } from "./types";
import { getOpenAskForTask, getOpenAsksByTaskIds } from "./queries";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REQUESTOR = "com.anthropic.claude-code:proc:test-agent";
const TASK_ID = "mt#123";
const TASK_ID_2 = "mt#456";

function makeInput(overrides: Partial<CreateAskInput> = {}): CreateAskInput {
  return {
    kind: "direction.decide",
    classifierVersion: "v1.0.0",
    requestor: REQUESTOR,
    title: "Choose a direction",
    question: "Which approach should we take?",
    parentTaskId: TASK_ID,
    metadata: {},
    ...overrides,
  };
}

/** Build a minimal Ask at an arbitrary state for seeding via _seedAtState. */
function makeSeedAsk(overrides: Partial<Ask>): Ask {
  return {
    id: overrides.id ?? `seed-${Math.random().toString(36).slice(2)}`,
    kind: "direction.decide",
    classifierVersion: "v1.0.0",
    state: "detected",
    requestor: REQUESTOR,
    title: "Choose a direction",
    question: "Which approach?",
    createdAt: new Date().toISOString(),
    metadata: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

let repo: FakeAskRepository;

beforeEach(() => {
  repo = new FakeAskRepository();
});

// ---------------------------------------------------------------------------
// getOpenAskForTask
// ---------------------------------------------------------------------------

describe("getOpenAskForTask", () => {
  it("returns null when no Asks exist for the task", async () => {
    const result = await getOpenAskForTask(repo, TASK_ID);
    expect(result).toBeNull();
  });

  it("returns null when all Asks for the task are in terminal states", async () => {
    repo._seedAtState(makeSeedAsk({ id: "ask-1", parentTaskId: TASK_ID, state: "closed" }));
    repo._seedAtState(makeSeedAsk({ id: "ask-2", parentTaskId: TASK_ID, state: "cancelled" }));
    repo._seedAtState(makeSeedAsk({ id: "ask-3", parentTaskId: TASK_ID, state: "expired" }));

    const result = await getOpenAskForTask(repo, TASK_ID);
    expect(result).toBeNull();
  });

  it("returns the open Ask when one exists", async () => {
    const ask = await repo.create(makeInput({ parentTaskId: TASK_ID }));
    const result = await getOpenAskForTask(repo, TASK_ID);
    expect(result).not.toBeNull();
    expect(result?.id).toBe(ask.id);
  });

  it("returns null when the task has an Ask with a different parentTaskId", async () => {
    await repo.create(makeInput({ parentTaskId: TASK_ID_2 }));
    const result = await getOpenAskForTask(repo, TASK_ID);
    expect(result).toBeNull();
  });

  it("returns the most recent open Ask when multiple open Asks exist for one task", async () => {
    // Seed two open Asks with different createdAt timestamps
    const older = new Date(2025, 0, 1).toISOString();
    const newer = new Date(2025, 6, 1).toISOString();

    repo._seedAtState(
      makeSeedAsk({ id: "ask-old", parentTaskId: TASK_ID, state: "detected", createdAt: older })
    );
    repo._seedAtState(
      makeSeedAsk({ id: "ask-new", parentTaskId: TASK_ID, state: "routed", createdAt: newer })
    );

    const result = await getOpenAskForTask(repo, TASK_ID);
    expect(result?.id).toBe("ask-new");
  });

  it("non-terminal states count as open", async () => {
    const openStates = ["detected", "classified", "routed", "suspended", "responded"] as const;
    for (const state of openStates) {
      repo.clear();
      repo._seedAtState(makeSeedAsk({ id: `ask-${state}`, parentTaskId: TASK_ID, state }));
      const result = await getOpenAskForTask(repo, TASK_ID);
      expect(result?.state).toBe(state);
    }
  });
});

// ---------------------------------------------------------------------------
// getOpenAsksByTaskIds
// ---------------------------------------------------------------------------

describe("getOpenAsksByTaskIds", () => {
  it("returns an empty map when taskIds is empty", async () => {
    const result = await getOpenAsksByTaskIds(repo, []);
    expect(result.size).toBe(0);
  });

  it("returns null entries for tasks with no open Asks", async () => {
    const result = await getOpenAsksByTaskIds(repo, [TASK_ID, TASK_ID_2]);
    expect(result.get(TASK_ID)).toBeNull();
    expect(result.get(TASK_ID_2)).toBeNull();
  });

  it("returns the open Ask for each task that has one", async () => {
    const ask1 = await repo.create(makeInput({ parentTaskId: TASK_ID }));
    const ask2 = await repo.create(makeInput({ parentTaskId: TASK_ID_2 }));

    const result = await getOpenAsksByTaskIds(repo, [TASK_ID, TASK_ID_2]);
    expect(result.get(TASK_ID)?.id).toBe(ask1.id);
    expect(result.get(TASK_ID_2)?.id).toBe(ask2.id);
  });

  it("returns null for a task that has only closed Asks", async () => {
    repo._seedAtState(makeSeedAsk({ id: "ask-closed", parentTaskId: TASK_ID, state: "closed" }));
    const ask2 = await repo.create(makeInput({ parentTaskId: TASK_ID_2 }));

    const result = await getOpenAsksByTaskIds(repo, [TASK_ID, TASK_ID_2]);
    expect(result.get(TASK_ID)).toBeNull();
    expect(result.get(TASK_ID_2)?.id).toBe(ask2.id);
  });

  it("invokes findOpenByTaskIds exactly once for N task IDs (mt#1470 batch)", async () => {
    // Seed 5 tasks each with one open Ask
    const taskIds = ["mt#1", "mt#2", "mt#3", "mt#4", "mt#5"];
    for (const id of taskIds) {
      await repo.create(makeInput({ parentTaskId: id }));
    }

    let findOpenByTaskIdsCalls = 0;
    let listByParentTaskCalls = 0;
    const realFindOpen = repo.findOpenByTaskIds.bind(repo);
    const realListByParent = repo.listByParentTask.bind(repo);
    const spy = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === "findOpenByTaskIds") {
          return (taskIds: string[]) => {
            findOpenByTaskIdsCalls++;
            return realFindOpen(taskIds);
          };
        }
        if (prop === "listByParentTask") {
          return (taskId: string) => {
            listByParentTaskCalls++;
            return realListByParent(taskId);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const result = await getOpenAsksByTaskIds(spy as FakeAskRepository, taskIds);
    expect(result.size).toBe(5);
    expect(findOpenByTaskIdsCalls).toBe(1);
    expect(listByParentTaskCalls).toBe(0);
  });

  it("returns the most recent open Ask per task when multiple exist for one task", async () => {
    const olderTs = new Date(2025, 0, 1).toISOString();
    const newerTs = new Date(2025, 6, 1).toISOString();
    repo._seedAtState(
      makeSeedAsk({ id: "ask-old", parentTaskId: TASK_ID, state: "detected", createdAt: olderTs })
    );
    repo._seedAtState(
      makeSeedAsk({ id: "ask-new", parentTaskId: TASK_ID, state: "routed", createdAt: newerTs })
    );

    const result = await getOpenAsksByTaskIds(repo, [TASK_ID]);
    expect(result.get(TASK_ID)?.id).toBe("ask-new");
  });
});
