import { describe, it, expect } from "bun:test";
import {
  TaskGraphService,
  type RelationshipType,
  type TaskRelationship,
} from "../../../../../src/domain/tasks/task-graph-service";
import { createTasksReparentCommand } from "../../../../../src/adapters/shared/commands/tasks/reparent-command";

// Minimal in-memory repository — mirrors the one in task-graph-service.test.ts
function createInMemoryRepo(initial: Array<[string, string, RelationshipType?]> = []) {
  const edges = new Set(initial.map(([f, t, type]) => `${f}→${t}→${type ?? "depends"}`));

  function parseKey(key: string): { from: string; to: string; type: RelationshipType } {
    const parts = key.split("→");
    return { from: parts[0] as string, to: parts[1] as string, type: parts[2] as RelationshipType };
  }

  return {
    async findEdge(fromId: string, toId: string, type: RelationshipType) {
      return edges.has(`${fromId}→${toId}→${type}`);
    },
    async createEdge(fromId: string, toId: string, type: RelationshipType) {
      edges.add(`${fromId}→${toId}→${type}`);
    },
    async deleteEdge(fromId: string, toId: string, type: RelationshipType) {
      const key = `${fromId}→${toId}→${type}`;
      return edges.delete(key) ? 1 : 0;
    },
    async deleteEdgesFrom(fromId: string, type: RelationshipType) {
      let count = 0;
      for (const key of [...edges]) {
        const parsed = parseKey(key);
        if (parsed.from === fromId && parsed.type === type) {
          edges.delete(key);
          count++;
        }
      }
      return count;
    },
    async listFrom(taskId: string, type: RelationshipType) {
      const res: string[] = [];
      for (const key of edges) {
        const parsed = parseKey(key);
        if (parsed.from === taskId && parsed.type === type) res.push(parsed.to);
      }
      return res;
    },
    async listTo(taskId: string, type: RelationshipType) {
      const res: string[] = [];
      for (const key of edges) {
        const parsed = parseKey(key);
        if (parsed.to === taskId && parsed.type === type) res.push(parsed.from);
      }
      return res;
    },
    async getAllRelationships(type?: RelationshipType): Promise<TaskRelationship[]> {
      return Array.from(edges)
        .map(parseKey)
        .filter((e) => !type || e.type === type)
        .map((e) => ({ fromTaskId: e.from, toTaskId: e.to, type: e.type }));
    },
    async getRelationshipsForTasks(
      taskIds: string[],
      type?: RelationshipType
    ): Promise<TaskRelationship[]> {
      return Array.from(edges)
        .map(parseKey)
        .filter((e) => taskIds.includes(e.from) || taskIds.includes(e.to))
        .filter((e) => !type || e.type === type)
        .map((e) => ({ fromTaskId: e.from, toTaskId: e.to, type: e.type }));
    },
    async getAncestorChain(taskId: string, maxDepth: number): Promise<string[]> {
      const ancestors: string[] = [];
      let current = taskId;
      for (let i = 0; i < maxDepth; i++) {
        let parent: string | undefined;
        for (const key of edges) {
          const parsed = parseKey(key);
          if (parsed.from === current && parsed.type === "parent") {
            parent = parsed.to;
            break;
          }
        }
        if (!parent) break;
        ancestors.push(parent);
        current = parent;
      }
      return ancestors;
    },
    async upsertParent(childId: string, newParentId: string) {
      let previousParent: string | null = null;
      for (const key of [...edges]) {
        const parsed = parseKey(key);
        if (parsed.from === childId && parsed.type === "parent") {
          previousParent = parsed.to;
          edges.delete(key);
          break;
        }
      }
      edges.add(`${childId}→${newParentId}→parent`);
      return { previousParent };
    },
    async transaction<T>(
      callback: (txRepo: ReturnType<typeof createInMemoryRepo>) => Promise<T>
    ): Promise<T> {
      // Single-threaded in-memory: no real isolation needed, pass through.
      return callback(this);
    },
  };
}

function createService(initial: Array<[string, string, RelationshipType?]> = []): TaskGraphService {
  const repo = createInMemoryRepo(initial);
  return new TaskGraphService(repo as unknown as ConstructorParameters<typeof TaskGraphService>[0]);
}

describe("createTasksReparentCommand", () => {
  function makeCommand(initial: Array<[string, string, RelationshipType?]> = []) {
    const svc = createService(initial);
    return { command: createTasksReparentCommand(() => svc), svc };
  }

  describe("happy path — set parent", () => {
    it("sets parent when task has none", async () => {
      const { command, svc } = makeCommand();
      const result = await command.execute({ taskId: "mt#2", parent: "mt#1" });
      expect(result.success).toBe(true);
      expect(result.newParent).toBe("mt#1");
      expect(result.previousParent).toBeNull();
      expect(await svc.getParent("mt#2")).toBe("mt#1");
    });

    it("replaces existing parent", async () => {
      const { command, svc } = makeCommand([["mt#2", "mt#1", "parent"]]);
      const result = await command.execute({ taskId: "mt#2", parent: "mt#3" });
      expect(result.success).toBe(true);
      expect(result.previousParent).toBe("mt#1");
      expect(result.newParent).toBe("mt#3");
      expect(await svc.getParent("mt#2")).toBe("mt#3");
    });

    it("output mentions the old and new parent when replacing", async () => {
      const { command } = makeCommand([["mt#2", "mt#1", "parent"]]);
      const result = await command.execute({ taskId: "mt#2", parent: "mt#3" });
      expect(result.output).toMatch(/mt#1/);
      expect(result.output).toMatch(/mt#3/);
    });
  });

  describe("happy path — orphan (parent: null)", () => {
    it("removes parent when parent is null", async () => {
      const { command, svc } = makeCommand([["mt#2", "mt#1", "parent"]]);
      const result = await command.execute({ taskId: "mt#2", parent: null });
      expect(result.success).toBe(true);
      expect(result.newParent).toBeNull();
      expect(result.previousParent).toBe("mt#1");
      expect(await svc.getParent("mt#2")).toBeNull();
    });
  });

  describe("no-op", () => {
    it("returns no-op when parent already matches", async () => {
      const { command, svc } = makeCommand([["mt#2", "mt#1", "parent"]]);
      const result = await command.execute({ taskId: "mt#2", parent: "mt#1" });
      expect(result.success).toBe(true);
      expect(result.previousParent).toBe("mt#1");
      expect(result.newParent).toBe("mt#1");
      // parent unchanged
      expect(await svc.getParent("mt#2")).toBe("mt#1");
    });

    it("no-op when task has no parent and null requested", async () => {
      const { command } = makeCommand();
      const result = await command.execute({ taskId: "mt#2", parent: null });
      expect(result.success).toBe(true);
      expect(result.previousParent).toBeNull();
      expect(result.newParent).toBeNull();
    });
  });

  describe("error cases", () => {
    it("rejects self-parenting", async () => {
      const { command } = makeCommand();
      await expect(command.execute({ taskId: "mt#1", parent: "mt#1" })).rejects.toThrow(
        /cannot be its own parent/
      );
    });

    it("rejects cycles", async () => {
      const { command } = makeCommand([
        ["mt#2", "mt#1", "parent"],
        ["mt#3", "mt#2", "parent"],
      ]);
      await expect(command.execute({ taskId: "mt#1", parent: "mt#3" })).rejects.toThrow(
        /Cycle detected/
      );
    });

    it("rejects unqualified child ID", async () => {
      const { command } = makeCommand();
      await expect(command.execute({ taskId: "123", parent: "mt#1" })).rejects.toThrow(
        /Invalid task ID/
      );
    });

    it("rejects unqualified parent ID", async () => {
      const { command } = makeCommand();
      await expect(command.execute({ taskId: "mt#1", parent: "456" })).rejects.toThrow(
        /Invalid task ID/
      );
    });
  });
});
