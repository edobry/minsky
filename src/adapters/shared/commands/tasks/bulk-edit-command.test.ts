import { describe, test, expect } from "bun:test";
import { createTasksBulkEditCommand, type BulkEditEventStore } from "./bulk-edit-command";
import type { TaskServiceInterface } from "@minsky/domain/tasks/taskService";
import type { Task } from "@minsky/domain/tasks/types";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeBackendCalls {
  setKind: Array<[string, string]>;
  updateTags: Array<[string, string[]]>;
}

function makeFakeService(tasks: Task[], calls: FakeBackendCalls, failOn: Set<string> = new Set()) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const backend = {
    name: "fake",
    setTaskKind: async (id: string, kind: string) => {
      if (failOn.has(id)) throw new Error(`backend write failed for ${id}`);
      calls.setKind.push([id, kind]);
      const task = byId.get(id);
      if (task) task.kind = kind;
    },
    updateTags: async (id: string, tags: string[]) => {
      if (failOn.has(id)) throw new Error(`backend write failed for ${id}`);
      calls.updateTags.push([id, tags]);
      const task = byId.get(id);
      if (task) task.tags = tags;
    },
  };
  return {
    getTasks: async (ids: string[]) => ids.map((id) => byId.get(id)).filter(Boolean),
    parsePrefixFromId: () => "mt",
    getBackendByPrefix: () => backend,
  } as unknown as TaskServiceInterface;
}

class FakeEventStore implements BulkEditEventStore {
  dryRuns: Record<string, unknown>[] = [];
  executed: Record<string, unknown>[] = [];
  failDryRunWrite = false;

  async recordDryRun(payload: Record<string, unknown>): Promise<boolean> {
    if (this.failDryRunWrite) return false;
    this.dryRuns.push(payload);
    return true;
  }
  async recordExecuted(payload: Record<string, unknown>): Promise<boolean> {
    this.executed.push(payload);
    return true;
  }
  async findDryRunPayload(token: string): Promise<Record<string, unknown> | null> {
    return this.dryRuns.find((p) => p.token === token) ?? null;
  }
  async findExecuted(token: string): Promise<{ executedAt: string; partial: boolean } | null> {
    const match = [...this.executed].reverse().find((p) => p.token === token);
    if (!match) return null;
    return { executedAt: "2026-07-17T00:00:00.000Z", partial: match.partial === true };
  }
}

const makeTask = (id: string, kind = "implementation", tags: string[] = []): Task =>
  ({ id, title: `Task ${id}`, status: "TODO", kind, tags }) as Task;

function setup(tasks: Task[], failOn: Set<string> = new Set()) {
  const calls: FakeBackendCalls = { setKind: [], updateTags: [] };
  const store = new FakeEventStore();
  const service = makeFakeService(tasks, calls, failOn);
  const command = createTasksBulkEditCommand(undefined, () => service, store);
  return { command, store, calls };
}

const run = (command: any, params: Record<string, unknown>) =>
  command.execute({ json: true, ...params });

// ---------------------------------------------------------------------------
// Dry-run
// ---------------------------------------------------------------------------

describe("tasks.bulk-edit dry-run", () => {
  test("15-task tag edit returns the change set and a token, and records the audit event", async () => {
    const ids = Array.from({ length: 15 }, (_, i) => `mt#${100 + i}`);
    const { command, store } = setup(ids.map((id) => makeTask(id)));

    const result = await run(command, { ids, addTag: "sweep" });

    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.count).toBe(15);
    expect(result.token).toMatch(/^[0-9a-f]{64}$/);
    expect(result.changeSet).toHaveLength(15);
    expect(store.dryRuns).toHaveLength(1);
    expect(store.dryRuns[0]?.token).toBe(result.token);
  });

  test("no-op targets produce no token and no audit event", async () => {
    const { command, store } = setup([makeTask("mt#1", "implementation", ["sweep"])]);
    const result = await run(command, { ids: ["mt#1"], addTag: "sweep" });
    expect(result.count).toBe(0);
    expect(result.token).toBeUndefined();
    expect(store.dryRuns).toHaveLength(0);
  });

  test("fails loudly when the dry-run audit record cannot be persisted", async () => {
    const { command, store } = setup([makeTask("mt#1")]);
    store.failDryRunWrite = true;
    await expect(run(command, { ids: ["mt#1"], addTag: "x" })).rejects.toThrow(
      /unredeemable token/
    );
  });

  test("refuses more than 500 targets", async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `mt#${i + 1}`);
    const { command } = setup(ids.map((id) => makeTask(id)));
    await expect(run(command, { ids, addTag: "x" })).rejects.toThrow(/500-target cap/);
  });

  test("errors on missing tasks, naming them", async () => {
    const { command } = setup([makeTask("mt#1")]);
    await expect(run(command, { ids: ["mt#1", "mt#2"], addTag: "x" })).rejects.toThrow(/mt#2/);
  });

  test("requires at least one edit operation", async () => {
    const { command } = setup([makeTask("mt#1")]);
    await expect(run(command, { ids: ["mt#1"] })).rejects.toThrow(/At least one edit operation/);
  });
});

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

describe("tasks.bulk-edit execute", () => {
  test("applies the approved change set with the token, then re-execute is an idempotent no-op", async () => {
    const ids = ["mt#1", "mt#2"];
    const { command, store, calls } = setup(ids.map((id) => makeTask(id)));

    const dryRun = await run(command, { ids, kind: "state-ops" });
    const result = await run(command, {
      ids,
      kind: "state-ops",
      execute: true,
      token: dryRun.token,
    });

    expect(result.executed).toBe(true);
    expect(result.applied).toBe(2);
    expect(calls.setKind).toEqual([
      ["mt#1", "state-ops"],
      ["mt#2", "state-ops"],
    ]);
    expect(store.executed).toHaveLength(1);

    const again = await run(command, {
      ids,
      kind: "state-ops",
      execute: true,
      token: dryRun.token,
    });
    expect(again.idempotent).toBe(true);
    expect(calls.setKind).toHaveLength(2);
  });

  test("execute without a token is refused", async () => {
    const { command } = setup([makeTask("mt#1")]);
    await expect(run(command, { ids: ["mt#1"], addTag: "x", execute: true })).rejects.toThrow(
      /requires the dry-run token/
    );
  });

  test("execute with an unknown token is refused", async () => {
    const { command } = setup([makeTask("mt#1")]);
    await expect(
      run(command, { ids: ["mt#1"], addTag: "x", execute: true, token: "f".repeat(64) })
    ).rejects.toThrow(/Unknown dry-run token/);
  });

  test("execute with a malformed token is refused before any lookup", async () => {
    const { command } = setup([makeTask("mt#1")]);
    await expect(
      run(command, { ids: ["mt#1"], addTag: "x", execute: true, token: "not-a-token" })
    ).rejects.toThrow(/Malformed token/);
  });

  test("aborts naming the drift when a target changed between dry-run and execute", async () => {
    const tasks = [makeTask("mt#1"), makeTask("mt#2")];
    const { command, calls } = setup(tasks);

    const dryRun = await run(command, { ids: ["mt#1", "mt#2"], kind: "umbrella" });
    // Out-of-band change to one target between dry-run and execute:
    const drifter = tasks[1];
    if (drifter) drifter.kind = "state-ops";

    await expect(
      run(command, { ids: ["mt#1", "mt#2"], kind: "umbrella", execute: true, token: dryRun.token })
    ).rejects.toThrow(/mt#2 kind: expected implementation/);
    expect(calls.setKind).toHaveLength(0);
  });

  test("refuses a token minted for different ids or edits", async () => {
    const { command } = setup([makeTask("mt#1"), makeTask("mt#2")]);
    const dryRun = await run(command, { ids: ["mt#1"], addTag: "x" });
    await expect(
      run(command, { ids: ["mt#1", "mt#2"], addTag: "x", execute: true, token: dryRun.token })
    ).rejects.toThrow(/different ids\/edits combination/);
  });

  test("targets already in the desired state at execute time are skipped, not drift", async () => {
    const tasks = [makeTask("mt#1"), makeTask("mt#2")];
    const { command, calls } = setup(tasks);

    const dryRun = await run(command, { ids: ["mt#1", "mt#2"], addTag: "done" });
    // One target picked up the tag out-of-band — matches the AFTER state.
    const early = tasks[0];
    if (early) early.tags = ["done"];

    const result = await run(command, {
      ids: ["mt#1", "mt#2"],
      addTag: "done",
      execute: true,
      token: dryRun.token,
    });
    expect(result.executed).toBe(true);
    expect(result.applied).toBe(1);
    expect(result.skippedAlreadyApplied).toBe(1);
    expect(calls.updateTags).toEqual([["mt#2", ["done"]]]);
  });

  test("a partial failure does NOT consume the token — retry resumes the remaining records", async () => {
    const tasks = [makeTask("mt#1"), makeTask("mt#2")];
    const failOn = new Set(["mt#2"]);
    const { command, store, calls } = setup(tasks, failOn);

    const dryRun = await run(command, { ids: ["mt#1", "mt#2"], kind: "umbrella" });

    // First execute: mt#1 applies, mt#2 fails — throws naming the resume path,
    // and the executed event is recorded partial (an audit record, not consumption).
    await expect(
      run(command, { ids: ["mt#1", "mt#2"], kind: "umbrella", execute: true, token: dryRun.token })
    ).rejects.toThrow(/remains redeemable/);
    expect(store.executed).toHaveLength(1);
    expect(store.executed[0]?.partial).toBe(true);
    expect(calls.setKind).toEqual([["mt#1", "umbrella"]]);

    // Backend recovers; same-token retry is NOT short-circuited and applies mt#2.
    failOn.clear();
    const retry = await run(command, {
      ids: ["mt#1", "mt#2"],
      kind: "umbrella",
      execute: true,
      token: dryRun.token,
    });
    expect(retry.executed).toBe(true);
    expect(retry.applied).toBe(1);
    expect(retry.skippedAlreadyApplied).toBe(1);
    expect(store.executed).toHaveLength(2);
    expect(store.executed[1]?.partial).toBe(false);

    // Third execute: now fully consumed — idempotent no-op.
    const third = await run(command, {
      ids: ["mt#1", "mt#2"],
      kind: "umbrella",
      execute: true,
      token: dryRun.token,
    });
    expect(third.idempotent).toBe(true);
    expect(calls.setKind).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Kind-change status stranding (mt#3137)
// ---------------------------------------------------------------------------

describe("tasks.bulk-edit — kind-change status stranding (mt#3137)", () => {
  /** umbrella's states exclude READY, so implementation/READY → umbrella strands. */
  const readyTask = (id: string): Task =>
    ({ id, title: `Task ${id}`, status: "READY", kind: "implementation", tags: [] }) as Task;

  test("dry-run blocks a stranding record and still converts a compatible sibling", async () => {
    const { command } = setup([readyTask("mt#1"), makeTask("mt#2")]);

    const result = await run(command, { ids: ["mt#1", "mt#2"], kind: "umbrella" });

    expect(result.count).toBe(1);
    expect(result.changeSet.map((r: { taskId: string }) => r.taskId)).toEqual(["mt#2"]);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].taskId).toBe("mt#1");
  });

  test("an all-blocked dry-run does NOT claim the tasks are already in the desired state", async () => {
    const { command } = setup([readyTask("mt#1")]);

    const result = await run(command, { ids: ["mt#1"], kind: "umbrella" });

    expect(result.count).toBe(0);
    expect(result.blocked).toHaveLength(1);
    expect(result.message).toContain("blocked");
    expect(result.message).not.toContain("already in the desired state");
  });

  // PR #2389 R1 — the reviewer's blocking finding. Status is NOT part of a
  // change record, so a status change between dry-run and execute is invisible
  // to the drift check: the record still reads implementation→umbrella and the
  // current kind still matches `before`, so it would be applied. The
  // execute-time re-check must catch it BEFORE any write.
  test("execute refuses when a record became stranding AFTER the dry-run", async () => {
    const safe = makeTask("mt#1"); // status TODO — safe for umbrella at dry-run
    const { command, calls } = setup([safe]);

    const dry = await run(command, { ids: ["mt#1"], kind: "umbrella" });
    expect(dry.count).toBe(1);
    expect(dry.blocked).toHaveLength(0);

    // Another actor moves it to a status umbrella does not recognize.
    safe.status = "READY";

    await expect(
      run(command, { ids: ["mt#1"], kind: "umbrella", execute: true, token: dry.token })
    ).rejects.toThrow(/would strand/i);

    // And crucially: nothing was written.
    expect(calls.setKind).toEqual([]);
  });

  test("execute still applies when the status remains compatible", async () => {
    const safe = makeTask("mt#1");
    const { command, calls } = setup([safe]);

    const dry = await run(command, { ids: ["mt#1"], kind: "umbrella" });
    const result = await run(command, {
      ids: ["mt#1"],
      kind: "umbrella",
      execute: true,
      token: dry.token,
    });

    expect(result.success).toBe(true);
    expect(calls.setKind).toEqual([["mt#1", "umbrella"]]);
  });
});
