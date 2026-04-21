import { describe, expect, test } from "bun:test";
import {
  autoIndexTaskEmbedding,
  type AutoIndexDeps,
} from "../../../../../src/adapters/shared/commands/tasks/auto-index-embedding";

describe("autoIndexTaskEmbedding", () => {
  test("does not throw when similarity service creation fails", async () => {
    const deps: AutoIndexDeps = {
      getConfiguration: () => ({ embeddings: { autoIndex: true } }),
      createTaskSimilarityService: async () => {
        throw new Error("No embedding provider configured");
      },
      getPersistenceProvider: () => ({}) as any,
      getTaskService: () => ({}) as any,
    };

    // Should not throw - fire-and-forget pattern swallows errors
    expect(() => autoIndexTaskEmbedding("mt#999", deps)).not.toThrow();

    // Give the async IIFE time to settle
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  test("is a no-op when autoIndex is false", async () => {
    let serviceCreated = false;

    const deps: AutoIndexDeps = {
      getConfiguration: () => ({ embeddings: { autoIndex: false } }),
      createTaskSimilarityService: async () => {
        serviceCreated = true;
        return { indexTask: async () => true };
      },
      getPersistenceProvider: () => ({}) as any,
      getTaskService: () => ({}) as any,
    };

    autoIndexTaskEmbedding("mt#888", deps);

    // Give the async IIFE time to settle
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Service should never have been created since config gate stopped it
    expect(serviceCreated).toBe(false);
  });

  test("calls indexTask when autoIndex is true", async () => {
    const result: { taskId: string | null } = { taskId: null };

    const deps: AutoIndexDeps = {
      getConfiguration: () => ({ embeddings: { autoIndex: true } }),
      createTaskSimilarityService: async () => ({
        indexTask: async (id: string) => {
          result.taskId = id;
          return true;
        },
      }),
      getPersistenceProvider: () => ({}) as any,
      getTaskService: () => ({}) as any,
    };

    autoIndexTaskEmbedding("mt#777", deps);

    // Give the async IIFE time to settle
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(result.taskId as string).toBe("mt#777");
  });
});
