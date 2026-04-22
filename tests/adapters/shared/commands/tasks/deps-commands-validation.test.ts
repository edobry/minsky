/**
 * Unit tests for deps-commands parameter validation (mt#1011 Bug 2).
 *
 * Verifies that the Zod schemas on tasks_parent, tasks_children,
 * tasks_deps_add, tasks_deps_rm, and tasks_deps_list reject empty strings
 * and malformed ids at the MCP boundary, before any DB query is issued.
 */

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import {
  createTasksParentCommand,
  createTasksChildrenCommand,
  createTasksDepsAddCommand,
  createTasksDepsRmCommand,
  createTasksDepsListCommand,
} from "../../../../../src/adapters/shared/commands/tasks/deps-commands";
import type { TaskGraphService } from "../../../../../src/domain/tasks/task-graph-service";
import type { RelationshipType } from "../../../../../src/domain/tasks/task-graph-service";

// ── Minimal in-memory TaskGraphService stub ───────────────────────────────────

type FakeEdge = { from: string; to: string; type: RelationshipType };

function createFakeGraphService(edges: FakeEdge[] = []): TaskGraphService {
  return {
    addDependency: async () => ({ created: true }),
    removeDependency: async () => ({ removed: true }),
    listDependencies: async (id) =>
      edges.filter((e) => e.from === id && e.type === "depends").map((e) => e.to),
    listDependents: async (id) =>
      edges.filter((e) => e.to === id && e.type === "depends").map((e) => e.from),
    addParent: async () => ({ created: true }),
    removeParent: async () => ({ removed: true }),
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
  } as unknown as TaskGraphService;
}

// ── Helper: extract the Zod schema for a named param ────────────────────────

type ParamMap = Record<string, { schema: z.ZodTypeAny; required?: boolean }>;

function getParamSchema(cmd: { parameters: ParamMap }, name: string): z.ZodTypeAny {
  const param = cmd.parameters[name];
  if (!param) throw new Error(`Parameter "${name}" not found on command`);
  return param.schema;
}

// ── tasks.parent ──────────────────────────────────────────────────────────────

describe("tasks.parent — parameter validation", () => {
  const svc = createFakeGraphService([{ from: "mt#2", to: "mt#1", type: "parent" }]);
  const cmd = createTasksParentCommand(() => svc);
  const schema = getParamSchema(cmd as unknown as { parameters: ParamMap }, "task");

  it("rejects empty string", () => {
    expect(() => schema.parse("")).toThrow();
  });

  it("rejects a bare number", () => {
    expect(() => schema.parse("123")).toThrow();
  });

  it("accepts a valid mt# id", () => {
    expect(schema.parse("mt#123")).toBe("mt#123");
  });

  it("accepts a valid gh# id", () => {
    expect(schema.parse("gh#456")).toBe("gh#456");
  });

  it("execute: task with a parent returns parent id string", async () => {
    const result = await cmd.execute({ task: "mt#2" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("mt#1");
  });

  it("execute: task without a parent returns root-task message", async () => {
    const result = await cmd.execute({ task: "mt#99" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("no parent");
  });
});

// ── tasks.children ────────────────────────────────────────────────────────────

describe("tasks.children — parameter validation", () => {
  const svc = createFakeGraphService([
    { from: "mt#2", to: "mt#1", type: "parent" },
    { from: "mt#3", to: "mt#1", type: "parent" },
  ]);
  const cmd = createTasksChildrenCommand(() => svc);
  const schema = getParamSchema(cmd as unknown as { parameters: ParamMap }, "task");

  it("rejects empty string", () => {
    expect(() => schema.parse("")).toThrow();
  });

  it("rejects a string with no # separator", () => {
    expect(() => schema.parse("notanid")).toThrow();
  });

  it("accepts a valid mt# id", () => {
    expect(schema.parse("mt#1")).toBe("mt#1");
  });
});

// ── tasks.deps.add ────────────────────────────────────────────────────────────

describe("tasks.deps.add — parameter validation", () => {
  const svc = createFakeGraphService();
  const cmd = createTasksDepsAddCommand(() => svc);
  const taskSchema = getParamSchema(cmd as unknown as { parameters: ParamMap }, "task");
  const depSchema = getParamSchema(cmd as unknown as { parameters: ParamMap }, "dependsOn");

  it("rejects empty task id", () => {
    expect(() => taskSchema.parse("")).toThrow();
  });

  it("rejects empty dependsOn id", () => {
    expect(() => depSchema.parse("")).toThrow();
  });

  it("accepts valid ids", () => {
    expect(taskSchema.parse("mt#1")).toBe("mt#1");
    expect(depSchema.parse("mt#2")).toBe("mt#2");
  });
});

// ── tasks.deps.rm ─────────────────────────────────────────────────────────────

describe("tasks.deps.rm — parameter validation", () => {
  const svc = createFakeGraphService();
  const cmd = createTasksDepsRmCommand(() => svc);
  const taskSchema = getParamSchema(cmd as unknown as { parameters: ParamMap }, "task");
  const depSchema = getParamSchema(cmd as unknown as { parameters: ParamMap }, "dependsOn");

  it("rejects empty task id", () => {
    expect(() => taskSchema.parse("")).toThrow();
  });

  it("rejects empty dependsOn id", () => {
    expect(() => depSchema.parse("")).toThrow();
  });
});

// ── tasks.deps.list ───────────────────────────────────────────────────────────

describe("tasks.deps.list — parameter validation", () => {
  const svc = createFakeGraphService();
  const cmd = createTasksDepsListCommand(() => svc);
  const schema = getParamSchema(cmd as unknown as { parameters: ParamMap }, "task");

  it("rejects empty string", () => {
    expect(() => schema.parse("")).toThrow();
  });

  it("accepts a valid md# id", () => {
    expect(schema.parse("md#42")).toBe("md#42");
  });
});
