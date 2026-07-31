/**
 * Tests for proposal filing — the second dedupe stage + containment (mt#3330).
 *
 * AT1 (containment): every filed task is created with status "BLOCKED" and
 * tag `engprod-proposal` — this is verified here at the call-site level
 * (the actual `tasks_available` zero-routability claim is exercised
 * end-to-end against the real TaskRoutingService/TaskService in
 * `packages/domain/src/tasks/task-routing-service.test.ts`, which already
 * asserts the `["TODO", "IN-PROGRESS"]` default filter this depends on).
 *
 * SC5 (second dedupe stage): a similarity hit tagged `engprod-proposal` is
 * skipped — only a non-proposal (human-authored) task counts as a match.
 */

import { describe, test, expect } from "bun:test";
import { fileProposal, buildProposalTitle, buildProposalSpec } from "./proposal-filing-service";
import { ENGPROD_PROPOSAL_TAG, type ClusterAnalysis, type MinedCluster } from "./types";
import type { Task } from "../tasks";
import type { TaskSearchResponse } from "../tasks/task-similarity-service";

function cluster(): MinedCluster {
  return {
    signature: "sig-1",
    toolSequence: ["Read", "Edit", "Bash"],
    frequency: 8,
    sessionCount: 3,
    chainLength: 3,
    score: 72,
    sampleRefs: [{ sessionId: "s1", turnIndex: 2 }],
  };
}

const analysis: ClusterAnalysis = {
  proposedPrimitive: "a `bulk-edit` primitive",
  existingToolCoverage: "no existing tool covers this",
  alreadyCovered: false,
};

function fakeTaskService(tasksById: Map<string, Task>) {
  const created: Array<{ title: string; spec: string; options: Record<string, unknown> }> = [];
  return {
    created,
    getTask: async (id: string) => tasksById.get(id) ?? null,
    createTaskFromTitleAndSpec: async (
      title: string,
      spec: string,
      options: Record<string, unknown>
    ) => {
      const newTask: Task = {
        id: "mt#9999",
        title,
        status: (options.status as string) ?? "TODO",
        tags: (options.tags as string[]) ?? [],
      };
      created.push({ title, spec, options });
      return newTask;
    },
  };
}

function fakeSimilarityService(response: TaskSearchResponse) {
  return {
    searchByText: async () => response,
  };
}

function fakeLedgerService() {
  const superseded: Array<{ signature: string; matchedTaskId: string }> = [];
  const proposed: Array<{ signature: string; taskId: string }> = [];
  return {
    superseded,
    proposed,
    recordSuperseded: async (c: MinedCluster, matchedTaskId: string) => {
      superseded.push({ signature: c.signature, matchedTaskId });
    },
    recordProposed: async (c: MinedCluster, taskId: string) => {
      proposed.push({ signature: c.signature, taskId });
    },
  };
}

describe("buildProposalTitle / buildProposalSpec", () => {
  test("title includes the tool sequence and evidence counts", () => {
    const title = buildProposalTitle(cluster());
    expect(title).toContain("Read -> Edit -> Bash");
    expect(title).toContain("8x/3 sessions");
  });

  test("spec includes the evidence block and both LLM answers", () => {
    const spec = buildProposalSpec(cluster(), analysis);
    expect(spec).toContain("a `bulk-edit` primitive");
    expect(spec).toContain("no existing tool covers this");
    expect(spec).toContain("sig-1");
    expect(spec).toContain("s1#2");
  });
});

describe("fileProposal", () => {
  test("AT1 containment: files a BLOCKED task tagged engprod-proposal when no similar task exists", async () => {
    const taskService = fakeTaskService(new Map());
    const ledgerService = fakeLedgerService();
    const result = await fileProposal(
      {
        taskService: taskService as never,
        taskSimilarityService: fakeSimilarityService({
          results: [],
          backend: "embeddings",
          degraded: false,
        }) as never,
        ledgerService: ledgerService as never,
      },
      cluster(),
      analysis
    );

    expect(result.filed).toBe(true);
    expect(taskService.created).toHaveLength(1);
    expect(taskService.created[0]?.options.status).toBe("BLOCKED");
    expect(taskService.created[0]?.options.tags).toEqual([ENGPROD_PROPOSAL_TAG]);
    expect(ledgerService.proposed).toHaveLength(1);
    expect(ledgerService.proposed[0]?.taskId).toBe(result.taskId);
  });

  test("SC5: skips a similarity hit tagged engprod-proposal (not human-authored)", async () => {
    const proposalTask: Task = {
      id: "mt#100",
      title: "Existing proposal",
      status: "BLOCKED",
      tags: [ENGPROD_PROPOSAL_TAG],
    };
    const humanTask: Task = {
      id: "mt#200",
      title: "Existing human task",
      status: "TODO",
      tags: [],
    };
    const tasksById = new Map([
      ["mt#100", proposalTask],
      ["mt#200", humanTask],
    ]);
    const taskService = fakeTaskService(tasksById);
    const ledgerService = fakeLedgerService();

    const result = await fileProposal(
      {
        taskService: taskService as never,
        taskSimilarityService: fakeSimilarityService({
          results: [
            { id: "mt#100", score: 0.05, metadata: {} },
            { id: "mt#200", score: 0.06, metadata: {} },
          ],
          backend: "embeddings",
          degraded: false,
        }) as never,
        ledgerService: ledgerService as never,
      },
      cluster(),
      analysis
    );

    expect(result.filed).toBe(false);
    expect(result.matchedTaskId).toBe("mt#200"); // the human task, not the proposal
    expect(taskService.created).toHaveLength(0);
    expect(ledgerService.superseded).toHaveLength(1);
    expect(ledgerService.superseded[0]?.matchedTaskId).toBe("mt#200");
  });

  test("proceeds to file when the only similar hit is itself an engprod-proposal task", async () => {
    const proposalTask: Task = {
      id: "mt#100",
      title: "Existing proposal",
      status: "BLOCKED",
      tags: [ENGPROD_PROPOSAL_TAG],
    };
    const taskService = fakeTaskService(new Map([["mt#100", proposalTask]]));
    const ledgerService = fakeLedgerService();

    const result = await fileProposal(
      {
        taskService: taskService as never,
        taskSimilarityService: fakeSimilarityService({
          results: [{ id: "mt#100", score: 0.05, metadata: {} }],
          backend: "embeddings",
          degraded: false,
        }) as never,
        ledgerService: ledgerService as never,
      },
      cluster(),
      analysis
    );

    expect(result.filed).toBe(true);
    expect(taskService.created).toHaveLength(1);
  });
});
