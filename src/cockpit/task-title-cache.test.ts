/**
 * Tests for TaskTitleCache — specifically the new `getTaskMeta` batch method
 * (mt#3174), added ALONGSIDE `getTitles` (never changing its signature or
 * behavior) so the two existing consumers (`widgets/agents.ts`,
 * `widgets/context-inspector.ts`) stay untouched. Verifies:
 *   - `getTaskMeta` returns `{title, status}` for ids the provider resolves.
 *   - `getTitles`'s existing behavior (title-only map) is unaffected by
 *     status-carrying providers.
 *   - Both methods share the TTL/attempted bookkeeping (no double-fetch).
 *   - Failure tolerance: a throwing provider yields an empty map, never a
 *     rejected promise.
 */
import { describe, test, expect } from "bun:test";
import { TaskTitleCache, type TaskProviderLike } from "./task-title-cache";

function makeProvider(
  tasks: { id: string; title: string; status?: string }[],
  opts: { throws?: boolean; calls?: { count: number } } = {}
): () => Promise<TaskProviderLike> {
  return async () => ({
    async getTask() {
      return null; // batch path only in these tests
    },
    async getTasks(ids: string[]) {
      opts.calls && opts.calls.count++;
      if (opts.throws) throw new Error("provider failure");
      return tasks.filter((t) => ids.includes(t.id));
    },
  });
}

describe("TaskTitleCache.getTaskMeta", () => {
  test("returns {title, status} for resolvable ids", async () => {
    const cache = new TaskTitleCache(
      makeProvider([
        { id: "mt#1", title: "Task One", status: "READY" },
        { id: "mt#2", title: "Task Two", status: "DONE" },
      ])
    );
    const meta = await cache.getTaskMeta(["mt#1", "mt#2"]);
    expect(meta.get("mt#1")).toEqual({ title: "Task One", status: "READY" });
    expect(meta.get("mt#2")).toEqual({ title: "Task Two", status: "DONE" });
  });

  test("omits ids with no status from a provider that only returns title (getTitles' existing shape)", async () => {
    // A provider identical to the pre-mt#3174 shape (title only, no status)
    // — getTaskMeta must not fabricate a status; the id is simply absent
    // from the returned map (not present with status: undefined).
    const cache = new TaskTitleCache(
      makeProvider([{ id: "mt#1", title: "Task One" /* no status */ }])
    );
    const meta = await cache.getTaskMeta(["mt#1"]);
    expect(meta.has("mt#1")).toBe(false);
  });

  test("unresolvable ids are simply absent (never an error)", async () => {
    const cache = new TaskTitleCache(makeProvider([{ id: "mt#1", title: "T", status: "TODO" }]));
    const meta = await cache.getTaskMeta(["mt#1", "mt#999"]);
    expect(meta.has("mt#1")).toBe(true);
    expect(meta.has("mt#999")).toBe(false);
  });

  test("a throwing provider yields an empty map, not a rejection (failure-tolerant)", async () => {
    const cache = new TaskTitleCache(makeProvider([], { throws: true }));
    const meta = await cache.getTaskMeta(["mt#1"]);
    expect(meta.size).toBe(0);
  });

  test("getTitles' return shape and behavior are unaffected by a status-carrying provider", async () => {
    const cache = new TaskTitleCache(
      makeProvider([{ id: "mt#1", title: "Task One", status: "READY" }])
    );
    const titles = await cache.getTitles(["mt#1"]);
    expect(titles).toBeInstanceOf(Map);
    expect(titles.get("mt#1")).toBe("Task One");
    // Map<string,string> — no status leaking into getTitles' value type.
    expect(Array.from(titles.values()).every((v) => typeof v === "string")).toBe(true);
  });

  test("getTitles and getTaskMeta share TTL bookkeeping — one fetch serves both", async () => {
    const calls = { count: 0 };
    const cache = new TaskTitleCache(
      makeProvider([{ id: "mt#1", title: "Task One", status: "READY" }], { calls })
    );
    await cache.getTitles(["mt#1"]);
    expect(calls.count).toBe(1);
    // Second call (getTaskMeta) for the SAME id within the TTL window should
    // not re-fetch — cache.size > 0 and not stale, so getTitles' internal
    // fast path serves it, and the status was already populated by the
    // first fetch (getTaskMeta's implementation calls getTitles then reads
    // statusCache).
    const meta = await cache.getTaskMeta(["mt#1"]);
    expect(calls.count).toBe(1);
    expect(meta.get("mt#1")).toEqual({ title: "Task One", status: "READY" });
  });
});
