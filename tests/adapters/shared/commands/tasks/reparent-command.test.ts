/**
 * Unit tests for tasks.reparent command (mt#1011 Bug 3).
 *
 * Verifies that the new reparent MCP surface correctly delegates to
 * TaskGraphService.removeParent + addParent, produces accurate output
 * messages, and handles edge cases (detach, already-same-parent, etc.).
 */

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { createTasksReparentCommand } from "../../../../../src/adapters/shared/commands/tasks/deps-commands";
import type { TaskGraphService } from "../../../../../src/domain/tasks/task-graph-service";
import type { RelationshipType } from "../../../../../src/domain/tasks/task-graph-service";

// ── In-memory graph service stub ──────────────────────────────────────────────

type FakeEdge = { from: string; to: string; type: RelationshipType };

function createFakeGraphService(initialEdges: FakeEdge[] = []): TaskGraphService {
  const edges: FakeEdge[] = [...initialEdges];

  return {
    addDependency: async () => ({ created: true }),
    removeDependency: async () => ({ removed: true }),
    listDependencies: async () => [],
    listDependents: async () => [],

    addParent: async (childId, parentId) => {
      const existing = edges.find((e) => e.from === childId && e.type === "parent");
      if (existing) throw new Error(`Task ${childId} already has parent ${existing.to}`);
      edges.push({ from: childId, to: parentId, type: "parent" });
      return { created: true };
    },

    removeParent: async (childId) => {
      const idx = edges.findIndex((e) => e.from === childId && e.type === "parent");
      if (idx === -1) return { removed: false };
      edges.splice(idx, 1);
      return { removed: true };
    },

    getParent: async (id) => {
      const e = edges.find((e) => e.from === id && e.type === "parent");
      return e?.to ?? null;
    },

    listChildren: async (id) =>
      edges.filter((e) => e.to === id && e.type === "parent").map((e) => e.from),

    getAncestors: async () => [],
    getTransitiveDependencies: async () => new Set<string>(),
    getAllRelationships: async () => [],
    getRelationshipsForTasks: async () => [],

    // Expose internal edge list for assertions
    _edges: edges,
  } as unknown as TaskGraphService & { _edges: FakeEdge[] };
}

// ── Helper types ──────────────────────────────────────────────────────────────

type ParamMap = Record<string, { schema: z.ZodTypeAny; required?: boolean }>;

function getParamSchema(cmd: { parameters: ParamMap }, name: string): z.ZodTypeAny {
  const param = cmd.parameters[name];
  if (!param) throw new Error(`Parameter "${name}" not found`);
  return param.schema;
}

// ── tasks.reparent — parameter validation ─────────────────────────────────────

describe("tasks.reparent — parameter validation", () => {
  const svc = createFakeGraphService();
  const cmd = createTasksReparentCommand(() => svc);
  const taskSchema = getParamSchema(cmd as unknown as { parameters: ParamMap }, "task");
  const parentSchema = getParamSchema(cmd as unknown as { parameters: ParamMap }, "parent");

  it("rejects empty task id", () => {
    expect(() => taskSchema.parse("")).toThrow();
  });

  it("rejects bare number as task id", () => {
    expect(() => taskSchema.parse("123")).toThrow();
  });

  it("accepts valid qualified task id", () => {
    expect(taskSchema.parse("mt#123")).toBe("mt#123");
  });

  it("accepts null for parent (detach)", () => {
    expect(parentSchema.parse(null)).toBeNull();
  });

  it("rejects empty string as parent (must be null or qualified id)", () => {
    expect(() => parentSchema.parse("")).toThrow();
  });

  it("accepts valid qualified parent id", () => {
    expect(parentSchema.parse("mt#456")).toBe("mt#456");
  });
});

// ── tasks.reparent — behaviour ────────────────────────────────────────────────

describe("tasks.reparent — execute behaviour", () => {
  it("moves a task from one parent to another", async () => {
    const svc = createFakeGraphService([{ from: "mt#6", to: "mt#5", type: "parent" }]);
    const cmd = createTasksReparentCommand(() => svc);

    const result = await cmd.execute({ task: "mt#6", parent: "mt#12" });

    expect(result.success).toBe(true);
    expect(result.output).toContain("mt#5");
    expect(result.output).toContain("mt#12");
    // Check edge was actually updated
    const extSvc = svc as unknown as { _edges: FakeEdge[] };
    const edge = extSvc._edges.find((e) => e.from === "mt#6" && e.type === "parent");
    expect(edge?.to).toBe("mt#12");
    // Old edge must be gone
    expect(extSvc._edges.filter((e) => e.to === "mt#5" && e.type === "parent")).toHaveLength(0);
  });

  it("sets parent for a root task (no existing parent)", async () => {
    const svc = createFakeGraphService();
    const cmd = createTasksReparentCommand(() => svc);

    const result = await cmd.execute({ task: "mt#6", parent: "mt#12" });

    expect(result.success).toBe(true);
    expect(result.output).toContain("mt#12");
    const extSvc = svc as unknown as { _edges: FakeEdge[] };
    const edge = extSvc._edges.find((e) => e.from === "mt#6" && e.type === "parent");
    expect(edge?.to).toBe("mt#12");
  });

  it("detaches a task from its parent when parent is null", async () => {
    const svc = createFakeGraphService([{ from: "mt#6", to: "mt#5", type: "parent" }]);
    const cmd = createTasksReparentCommand(() => svc);

    const result = await cmd.execute({ task: "mt#6", parent: null });

    expect(result.success).toBe(true);
    expect(result.output).toContain("removed");
    const extSvc = svc as unknown as { _edges: FakeEdge[] };
    expect(extSvc._edges.filter((e) => e.from === "mt#6" && e.type === "parent")).toHaveLength(0);
  });

  it("is idempotent when detaching a root task (no parent)", async () => {
    const svc = createFakeGraphService();
    const cmd = createTasksReparentCommand(() => svc);

    const result = await cmd.execute({ task: "mt#6", parent: null });

    expect(result.success).toBe(true);
    expect(result.output).toContain("already a root task");
  });

  it("is idempotent when parent is already the target parent", async () => {
    const svc = createFakeGraphService([{ from: "mt#6", to: "mt#12", type: "parent" }]);
    const cmd = createTasksReparentCommand(() => svc);

    const result = await cmd.execute({ task: "mt#6", parent: "mt#12" });

    expect(result.success).toBe(true);
    expect(result.output).toContain("already");
    // Edge count must be exactly 1 (no duplicate added)
    const extSvc = svc as unknown as { _edges: FakeEdge[] };
    expect(extSvc._edges.filter((e) => e.from === "mt#6" && e.type === "parent")).toHaveLength(1);
  });
});
