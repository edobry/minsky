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
});
