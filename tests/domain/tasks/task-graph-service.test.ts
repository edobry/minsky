import { describe, it, expect } from "bun:test";
import {
  TaskGraphService,
  type RelationshipType,
  type TaskRelationship,
} from "../../../src/domain/tasks/task-graph-service";

function createInMemoryRepo(initial: Array<[string, string, RelationshipType?]> = []) {
  // Store edges as "from→to→type"
  const edges = new Set(initial.map(([f, t, type]) => `${f}→${t}→${type ?? "depends"}`));

  function parseKey(key: string): { from: string; to: string; type: RelationshipType } {
    const parts = key.split("→");
    if (parts.length < 3) throw new Error(`Invalid edge key: ${key}`);
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
      const had = edges.delete(key);
      return had ? 1 : 0;
    },
    async deleteEdgesFrom(fromId: string, type: RelationshipType) {
      let count = 0;
      for (const key of edges) {
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
    async upsertParent(
      childId: string,
      newParentId: string
    ): Promise<{ previousParent: string | null }> {
      // Find and remove existing parent edge
      let previousParent: string | null = null;
      for (const key of edges) {
        const parsed = parseKey(key);
        if (parsed.from === childId && parsed.type === "parent") {
          previousParent = parsed.to;
          edges.delete(key);
          break;
        }
      }
      // Insert new parent edge
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

describe("TaskGraphService (in-memory)", () => {
  // ── Dependency operations ─────────────────────────────────────────

  describe("dependencies", () => {
    it("adds dependency idempotently and lists dependencies", async () => {
      const svc = createService();
      const r1 = await svc.addDependency("md#1", "db#2");
      const r2 = await svc.addDependency("md#1", "db#2");
      expect(r1.created).toBe(true);
      expect(r2.created).toBe(false);
      expect(await svc.listDependencies("md#1")).toEqual(["db#2"]);
    });

    it("prevents self-edge", async () => {
      const svc = createService();
      await expect(svc.addDependency("md#1", "md#1")).rejects.toThrow();
    });

    it("validates qualified IDs", async () => {
      const svc = createService();
      await expect(svc.addDependency("1", "db#2")).rejects.toThrow();
      await expect(svc.addDependency("md#1", "2")).rejects.toThrow();
    });

    it("prevents direct dependency cycle: A→B, B→A", async () => {
      const svc = createService([["mt#1", "mt#2", "depends"]]);
      await expect(svc.addDependency("mt#2", "mt#1")).rejects.toThrow(/Cycle detected/);
    });

    it("prevents indirect dependency cycle: A→B→C, C→A", async () => {
      const svc = createService([
        ["mt#1", "mt#2", "depends"],
        ["mt#2", "mt#3", "depends"],
      ]);
      await expect(svc.addDependency("mt#3", "mt#1")).rejects.toThrow(/Cycle detected/);
    });

    it("allows non-cyclic dependency chains", async () => {
      const svc = createService([
        ["mt#1", "mt#2", "depends"],
        ["mt#2", "mt#3", "depends"],
      ]);
      // mt#1 depending on mt#3 is fine (parallel dependency, not a cycle)
      const r = await svc.addDependency("mt#1", "mt#3");
      expect(r.created).toBe(true);
    });

    it("allows diamond dependencies (not cycles)", async () => {
      const svc = createService([
        ["mt#1", "mt#2", "depends"],
        ["mt#1", "mt#3", "depends"],
        ["mt#2", "mt#4", "depends"],
      ]);
      // mt#3 also depending on mt#4 creates a diamond, not a cycle
      const r = await svc.addDependency("mt#3", "mt#4");
      expect(r.created).toBe(true);
    });

    it("removes dependency and lists dependents", async () => {
      const svc = createService([
        ["md#1", "db#2"],
        ["md#3", "db#2"],
      ]);
      expect(await svc.listDependents("db#2")).toEqual(["md#1", "md#3"]);
      const r = await svc.removeDependency("md#1", "db#2");
      expect(r.removed).toBe(true);
      expect(await svc.listDependents("db#2")).toEqual(["md#3"]);
    });
  });

  // ── Parent-child operations ───────────────────────────────────────

  describe("parent-child", () => {
    it("adds parent and retrieves it", async () => {
      const svc = createService();
      const r = await svc.addParent("mt#2", "mt#1");
      expect(r.created).toBe(true);
      expect(await svc.getParent("mt#2")).toBe("mt#1");
    });

    it("lists children of a parent", async () => {
      const svc = createService([
        ["mt#2", "mt#1", "parent"],
        ["mt#3", "mt#1", "parent"],
      ]);
      const children = await svc.listChildren("mt#1");
      expect(children).toContain("mt#2");
      expect(children).toContain("mt#3");
      expect(children).toHaveLength(2);
    });

    it("returns null for tasks with no parent", async () => {
      const svc = createService();
      expect(await svc.getParent("mt#1")).toBeNull();
    });

    it("returns empty array for tasks with no children", async () => {
      const svc = createService();
      expect(await svc.listChildren("mt#1")).toEqual([]);
    });

    it("addParent is idempotent", async () => {
      const svc = createService();
      await svc.addParent("mt#2", "mt#1");
      const r2 = await svc.addParent("mt#2", "mt#1");
      expect(r2.created).toBe(false);
    });

    it("rejects adding second parent", async () => {
      const svc = createService([["mt#2", "mt#1", "parent"]]);
      await expect(svc.addParent("mt#2", "mt#3")).rejects.toThrow(/already has parent mt#1/);
    });

    it("prevents self-parent", async () => {
      const svc = createService();
      await expect(svc.addParent("mt#1", "mt#1")).rejects.toThrow();
    });

    it("validates qualified IDs", async () => {
      const svc = createService();
      await expect(svc.addParent("1", "mt#2")).rejects.toThrow();
      await expect(svc.addParent("mt#1", "2")).rejects.toThrow();
    });

    it("removes parent", async () => {
      const svc = createService([["mt#2", "mt#1", "parent"]]);
      const r = await svc.removeParent("mt#2");
      expect(r.removed).toBe(true);
      expect(await svc.getParent("mt#2")).toBeNull();
      expect(await svc.listChildren("mt#1")).toEqual([]);
    });

    it("removeParent returns false when no parent exists", async () => {
      const svc = createService();
      const r = await svc.removeParent("mt#1");
      expect(r.removed).toBe(false);
    });
  });

  // ── Cycle prevention ──────────────────────────────────────────────

  describe("cycle prevention", () => {
    it("prevents direct cycle: A parent of B, B parent of A", async () => {
      const svc = createService([["mt#2", "mt#1", "parent"]]);
      await expect(svc.addParent("mt#1", "mt#2")).rejects.toThrow(/Cycle detected/);
    });

    it("prevents indirect cycle: A→B→C, then C→A", async () => {
      const svc = createService([
        ["mt#2", "mt#1", "parent"],
        ["mt#3", "mt#2", "parent"],
      ]);
      // mt#1 has child mt#2, mt#2 has child mt#3
      // Trying to make mt#1 a child of mt#3 would create a cycle
      await expect(svc.addParent("mt#1", "mt#3")).rejects.toThrow(/Cycle detected/);
    });

    it("allows non-cyclic deep hierarchies", async () => {
      const svc = createService([
        ["mt#2", "mt#1", "parent"],
        ["mt#3", "mt#2", "parent"],
      ]);
      // Adding mt#4 as child of mt#3 should work (no cycle)
      const r = await svc.addParent("mt#4", "mt#3");
      expect(r.created).toBe(true);
    });
  });

  // ── Ancestor queries ──────────────────────────────────────────────

  describe("getAncestors", () => {
    it("returns empty for root tasks", async () => {
      const svc = createService();
      expect(await svc.getAncestors("mt#1")).toEqual([]);
    });

    it("returns chain of ancestors", async () => {
      const svc = createService([
        ["mt#3", "mt#2", "parent"],
        ["mt#2", "mt#1", "parent"],
      ]);
      const ancestors = await svc.getAncestors("mt#3");
      expect(ancestors).toEqual(["mt#2", "mt#1"]);
    });
  });

  // ── Dependency/parent isolation ───────────────────────────────────

  describe("isolation between types", () => {
    it("dependency edges don't appear as parent edges", async () => {
      const svc = createService([["mt#1", "mt#2", "depends"]]);
      expect(await svc.getParent("mt#1")).toBeNull();
      expect(await svc.listChildren("mt#2")).toEqual([]);
      expect(await svc.listDependencies("mt#1")).toEqual(["mt#2"]);
    });

    it("parent edges don't appear as dependency edges", async () => {
      const svc = createService([["mt#2", "mt#1", "parent"]]);
      expect(await svc.listDependencies("mt#2")).toEqual([]);
      expect(await svc.listDependents("mt#1")).toEqual([]);
      expect(await svc.getParent("mt#2")).toBe("mt#1");
    });

    it("same pair can have both dependency and parent edges", async () => {
      const svc = createService([
        ["mt#2", "mt#1", "depends"],
        ["mt#2", "mt#1", "parent"],
      ]);
      expect(await svc.listDependencies("mt#2")).toEqual(["mt#1"]);
      expect(await svc.getParent("mt#2")).toBe("mt#1");
    });
  });

  // ── Bulk query operations ─────────────────────────────────────────

  describe("bulk query operations", () => {
    it("getAllRelationships returns all edges with types", async () => {
      const svc = createService([
        ["md#1", "db#2"],
        ["mt#3", "gh#4"],
        ["mt#5", "mt#3", "parent"],
      ]);
      const relationships = await svc.getAllRelationships();
      expect(relationships).toHaveLength(3);
      expect(relationships).toContainEqual({
        fromTaskId: "md#1",
        toTaskId: "db#2",
        type: "depends",
      });
      expect(relationships).toContainEqual({
        fromTaskId: "mt#5",
        toTaskId: "mt#3",
        type: "parent",
      });
    });

    it("getAllRelationships filters by type", async () => {
      const svc = createService([
        ["md#1", "db#2", "depends"],
        ["mt#5", "mt#3", "parent"],
      ]);
      const deps = await svc.getAllRelationships("depends");
      expect(deps).toHaveLength(1);
      expect(deps[0]?.type).toBe("depends");

      const parents = await svc.getAllRelationships("parent");
      expect(parents).toHaveLength(1);
      expect(parents[0]?.type).toBe("parent");
    });

    it("getRelationshipsForTasks filters by task IDs and type", async () => {
      const svc = createService([
        ["md#1", "db#2", "depends"],
        ["mt#3", "db#2", "parent"],
        ["gh#6", "mt#7", "depends"],
      ]);
      const deps = await svc.getRelationshipsForTasks(["db#2"], "depends");
      expect(deps).toHaveLength(1);
      expect(deps).toContainEqual({
        fromTaskId: "md#1",
        toTaskId: "db#2",
        type: "depends",
      });
    });

    it("getRelationshipsForTasks handles empty task ID array", async () => {
      const svc = createService([["md#1", "db#2"]]);
      const relationships = await svc.getRelationshipsForTasks([]);
      expect(relationships).toHaveLength(0);
    });
  });

  // ── reparent ──────────────────────────────────────────────────────

  describe("reparent", () => {
    it("assigns a parent when the child has none (happy path)", async () => {
      const svc = createService();
      const result = await svc.reparent("mt#2", "mt#1");
      expect(result).toEqual({ taskId: "mt#2", previousParent: null, newParent: "mt#1" });
      expect(await svc.getParent("mt#2")).toBe("mt#1");
    });

    it("replaces an existing parent (happy path)", async () => {
      const svc = createService([["mt#2", "mt#1", "parent"]]);
      const result = await svc.reparent("mt#2", "mt#3");
      expect(result).toEqual({ taskId: "mt#2", previousParent: "mt#1", newParent: "mt#3" });
      expect(await svc.getParent("mt#2")).toBe("mt#3");
      // old parent no longer has mt#2 as child
      expect(await svc.listChildren("mt#1")).toEqual([]);
    });

    it("orphans the task when newParentId is null", async () => {
      const svc = createService([["mt#2", "mt#1", "parent"]]);
      const result = await svc.reparent("mt#2", null);
      expect(result).toEqual({ taskId: "mt#2", previousParent: "mt#1", newParent: null });
      expect(await svc.getParent("mt#2")).toBeNull();
    });

    it("no-op when current parent already matches requested parent", async () => {
      const svc = createService([["mt#2", "mt#1", "parent"]]);
      const result = await svc.reparent("mt#2", "mt#1");
      expect(result).toEqual({ taskId: "mt#2", previousParent: "mt#1", newParent: "mt#1" });
      // still has the parent
      expect(await svc.getParent("mt#2")).toBe("mt#1");
    });

    it("no-op when task has no parent and null is requested", async () => {
      const svc = createService();
      const result = await svc.reparent("mt#2", null);
      expect(result).toEqual({ taskId: "mt#2", previousParent: null, newParent: null });
    });

    it("rejects self-parenting", async () => {
      const svc = createService();
      await expect(svc.reparent("mt#1", "mt#1")).rejects.toThrow(/cannot be its own parent/);
    });

    it("rejects cycles", async () => {
      const svc = createService([
        ["mt#2", "mt#1", "parent"],
        ["mt#3", "mt#2", "parent"],
      ]);
      // mt#1 is an ancestor of mt#3; making mt#1 a child of mt#3 would cycle
      await expect(svc.reparent("mt#1", "mt#3")).rejects.toThrow(/Cycle detected/);
    });

    it("rejects unqualified child ID", async () => {
      const svc = createService();
      await expect(svc.reparent("1", "mt#1")).rejects.toThrow(/Invalid task ID/);
    });

    it("rejects unqualified parent ID", async () => {
      const svc = createService();
      await expect(svc.reparent("mt#1", "2")).rejects.toThrow(/Invalid task ID/);
    });

    it("executes inside a transaction (pass-through for in-memory repo)", async () => {
      // Verify that the transactional code path completes correctly end-to-end.
      // The in-memory transaction is a simple pass-through, so this confirms
      // the wrapping doesn't break observable behavior.
      const svc = createService([["mt#2", "mt#1", "parent"]]);
      const result = await svc.reparent("mt#2", "mt#3");
      expect(result).toEqual({ taskId: "mt#2", previousParent: "mt#1", newParent: "mt#3" });
      expect(await svc.getParent("mt#2")).toBe("mt#3");
      expect(await svc.listChildren("mt#1")).toEqual([]);
      expect(await svc.listChildren("mt#3")).toContain("mt#2");
    });
  });
});
