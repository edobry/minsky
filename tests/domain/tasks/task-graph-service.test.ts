import { describe, it, expect } from "bun:test";
import { TaskGraphService } from "../../../src/domain/tasks/task-graph-service";

function createInMemoryRepo(initial: Array<[string, string]> = []) {
  const edges = new Set(initial.map(([f, t]) => `${f}→${t}`));
  return {
    async findEdge(fromId: string, toId: string) {
      return edges.has(`${fromId}→${toId}`);
    },
    async createEdge(fromId: string, toId: string) {
      edges.add(`${fromId}→${toId}`);
    },
    async deleteEdge(fromId: string, toId: string) {
      const key = `${fromId}→${toId}`;
      const had = edges.delete(key);
      return had ? 1 : 0;
    },
    async listFrom(taskId: string) {
      const res: string[] = [];
      for (const key of edges) {
        const [f, t] = key.split("→");
        if (f === taskId) res.push(t);
      }
      return res;
    },
    async listTo(taskId: string) {
      const res: string[] = [];
      for (const key of edges) {
        const [f, t] = key.split("→");
        if (t === taskId) res.push(f);
      }
      return res;
    },
    async getAllRelationships() {
      return Array.from(edges).map((key) => {
        const [fromTaskId, toTaskId] = key.split("→");
        return { fromTaskId, toTaskId };
      });
    },
    async getRelationshipsForTasks(taskIds: string[]) {
      const result: { fromTaskId: string; toTaskId: string }[] = [];
      for (const key of edges) {
        const [f, t] = key.split("→");
        if (taskIds.includes(f) || taskIds.includes(t)) {
          result.push({ fromTaskId: f, toTaskId: t });
        }
      }
      return result;
    },
  };
}

describe("TaskGraphService (in-memory)", () => {
  it("adds dependency idempotently and lists dependencies", async () => {
    const svc = new TaskGraphService(createInMemoryRepo());
    const r1 = await svc.addDependency("md#1", "db#2");
    const r2 = await svc.addDependency("md#1", "db#2");
    expect(r1.created).toBe(true);
    expect(r2.created).toBe(false);
    expect(await svc.listDependencies("md#1")).toEqual(["db#2"]);
  });

  it("prevents self-edge", async () => {
    const svc = new TaskGraphService(createInMemoryRepo());
    await expect(svc.addDependency("md#1", "md#1")).rejects.toThrow();
  });

  it("validates qualified IDs", async () => {
    const svc = new TaskGraphService(createInMemoryRepo());
    await expect(svc.addDependency("1", "db#2")).rejects.toThrow();
    await expect(svc.addDependency("md#1", "2")).rejects.toThrow();
  });

  it("removes dependency and lists dependents", async () => {
    const repo = createInMemoryRepo([
      ["md#1", "db#2"],
      ["md#3", "db#2"],
    ]);
    const svc = new TaskGraphService(repo as any);
    expect(await svc.listDependents("db#2")).toEqual(["md#1", "md#3"]);
    const r = await svc.removeDependency("md#1", "db#2");
    expect(r.removed).toBe(true);
    expect(await svc.listDependents("db#2")).toEqual(["md#3"]);
  });

  describe("Bulk query operations", () => {
    it("getAllRelationships returns all edges", async () => {
      const repo = createInMemoryRepo([
        ["md#1", "db#2"],
        ["mt#3", "gh#4"],
        ["db#2", "mt#5"],
      ]);
      const svc = new TaskGraphService(repo as any);
      
      const relationships = await svc.getAllRelationships();
      expect(relationships).toHaveLength(3);
      expect(relationships).toContainEqual({ fromTaskId: "md#1", toTaskId: "db#2" });
      expect(relationships).toContainEqual({ fromTaskId: "mt#3", toTaskId: "gh#4" });
      expect(relationships).toContainEqual({ fromTaskId: "db#2", toTaskId: "mt#5" });
    });

    it("getRelationshipsForTasks filters by task IDs", async () => {
      const repo = createInMemoryRepo([
        ["md#1", "db#2"],
        ["mt#3", "gh#4"],
        ["db#2", "mt#5"],
        ["gh#6", "mt#7"], // Should not be included
      ]);
      const svc = new TaskGraphService(repo as any);
      
      // Get relationships involving md#1 or mt#3
      const relationships = await svc.getRelationshipsForTasks(["md#1", "mt#3"]);
      expect(relationships).toHaveLength(2);
      expect(relationships).toContainEqual({ fromTaskId: "md#1", toTaskId: "db#2" });
      expect(relationships).toContainEqual({ fromTaskId: "mt#3", toTaskId: "gh#4" });
      expect(relationships).not.toContainEqual({ fromTaskId: "gh#6", toTaskId: "mt#7" });
    });

    it("getRelationshipsForTasks includes relationships where task is dependent", async () => {
      const repo = createInMemoryRepo([
        ["md#1", "db#2"],
        ["mt#3", "db#2"], // db#2 is dependency of both md#1 and mt#3
      ]);
      const svc = new TaskGraphService(repo as any);
      
      // Get relationships involving db#2 (as dependency)
      const relationships = await svc.getRelationshipsForTasks(["db#2"]);
      expect(relationships).toHaveLength(2);
      expect(relationships).toContainEqual({ fromTaskId: "md#1", toTaskId: "db#2" });
      expect(relationships).toContainEqual({ fromTaskId: "mt#3", toTaskId: "db#2" });
    });

    it("getRelationshipsForTasks returns empty array for unknown task IDs", async () => {
      const repo = createInMemoryRepo([
        ["md#1", "db#2"],
      ]);
      const svc = new TaskGraphService(repo as any);
      
      const relationships = await svc.getRelationshipsForTasks(["unknown#1", "unknown#2"]);
      expect(relationships).toHaveLength(0);
    });

    it("getRelationshipsForTasks handles empty task ID array", async () => {
      const repo = createInMemoryRepo([
        ["md#1", "db#2"],
      ]);
      const svc = new TaskGraphService(repo as any);
      
      const relationships = await svc.getRelationshipsForTasks([]);
      expect(relationships).toHaveLength(0);
    });
  });
});
