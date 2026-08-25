/**
 * Supervisor tick tests (mt#4571).
 *
 * These cover the task's acceptance tests AT1-AT5 against a fixture DAG and
 * injected actuators. The DAG walk is the behaviour the whole feature is: if
 * "dispatch A, wait, then dispatch B when A completes, with nobody watching"
 * is wrong, nothing else about the feature matters.
 *
 * `runSupervisionTick` is called repeatedly with FRESH dependency objects where
 * the test is about surviving a restart — the tick holds no state between calls
 * by construction, and asserting that is AT2.
 */
import { describe, test, expect } from "bun:test";
import {
  HOLD_ABANDONED,
  HOLD_ALL_BLOCKED,
  HOLD_FRONTIER_EMPTY,
  HOLD_LIVE_WRITER,
  HOLD_WIP_LIMIT,
  SUPERVISION_STALL_THRESHOLD_MS,
  isSupervisionStalled,
  runSupervisionTick,
} from "./supervision-tick";
import {
  FakeSpawner,
  FakeSupervisionStore,
  FakeTaskGraph,
  type FakeTask,
} from "./__fixtures__/fake-supervision-store";
import { computeUmbrellaFrontier } from "../tasks/umbrella-frontier";
import type { SupervisionTickDeps } from "./types";

/** The AT1/AT2 fixture: umbrella U with children A and B, where B depends on A. */
function twoNodeDag(): FakeTask[] {
  return [
    { id: "mt#900", title: "umbrella", status: "IN-PROGRESS" },
    { id: "mt#901", title: "child A", status: "READY", parent: "mt#900" },
    {
      id: "mt#902",
      title: "child B",
      status: "READY",
      parent: "mt#900",
      dependsOn: ["mt#901"],
    },
  ];
}

function buildDeps(
  store: FakeSupervisionStore,
  graph: FakeTaskGraph,
  spawner: FakeSpawner,
  now: Date = new Date("2026-08-25T12:00:00Z")
): SupervisionTickDeps {
  const warnings: string[] = [];
  const deps: SupervisionTickDeps & { warnings: string[] } = {
    store,
    computeFrontier: (umbrellaTaskId, statusFilter) =>
      computeUmbrellaFrontier(umbrellaTaskId, statusFilter, {
        listChildren: graph.listChildren,
        getDependsRelationships: graph.getDependsRelationships,
        getTasks: graph.getTasks,
      }),
    getTaskStatuses: graph.getTaskStatuses,
    drivenSessionLiveness: spawner.drivenSessionLiveness,
    hasLiveWriterForTask: spawner.hasLiveWriterForTask,
    dispatchChild: spawner.dispatchChild,
    now: () => now,
    logWarn: (m) => warnings.push(m),
    warnings,
  };
  return deps;
}

describe("runSupervisionTick — the DAG walk (AT1)", () => {
  test("dispatches only the unblocked child, then the dependent one after its prerequisite completes", async () => {
    const store = new FakeSupervisionStore();
    const graph = new FakeTaskGraph(twoNodeDag());
    const spawner = new FakeSpawner();
    store.addSupervision({ umbrellaTaskId: "mt#900", statusFilter: ["READY"] });

    // Tick 1: only A is dispatchable. B depends on A, which is not terminal.
    const first = await runSupervisionTick(buildDeps(store, graph, spawner));
    expect(first.ok).toBe(true);
    expect(first.advances[0]?.dispatched).toEqual(["mt#901"]);
    expect(spawner.calls.map((c) => c.taskId)).toEqual(["mt#901"]);

    // Tick 2: nothing changed. B must still be held, and A must NOT be
    // dispatched a second time.
    const second = await runSupervisionTick(buildDeps(store, graph, spawner));
    expect(second.advances[0]?.dispatched).toEqual([]);
    expect(spawner.calls).toHaveLength(1);

    // A completes the ordinary way: its task reaches a terminal status.
    graph.setStatus("mt#901", "DONE");

    // Tick 3: A settles and B is now unblocked — with no operator action
    // anywhere in this sequence.
    const third = await runSupervisionTick(buildDeps(store, graph, spawner));
    expect(third.advances[0]?.settled).toEqual([
      { taskId: "mt#901", status: "succeeded", settledBy: "task-status" },
    ]);
    expect(third.advances[0]?.dispatched).toEqual(["mt#902"]);
    expect(spawner.calls.map((c) => c.taskId)).toEqual(["mt#901", "mt#902"]);
  });

  test("settles from pr.merged when the event is present, naming that signal", async () => {
    const store = new FakeSupervisionStore();
    const graph = new FakeTaskGraph(twoNodeDag());
    const spawner = new FakeSpawner();
    store.addSupervision({ umbrellaTaskId: "mt#900", statusFilter: ["READY"] });

    await runSupervisionTick(buildDeps(store, graph, spawner));

    // The PR merged, but the task status has NOT been updated — which is the
    // real-world case mt#4574 describes: applyPostMergeStateSync writes the
    // status without emitting task.status_changed, and a status read can lag.
    store.mergedEvents.push({ taskId: "mt#901", at: new Date("2026-08-25T11:00:00Z") });

    const tick = await runSupervisionTick(buildDeps(store, graph, spawner));
    expect(tick.advances[0]?.settled).toEqual([
      { taskId: "mt#901", status: "succeeded", settledBy: "pr.merged" },
    ]);
  });
});

describe("runSupervisionTick — surviving the operator leaving (AT2)", () => {
  test("advances across ticks that share no in-memory state with the dispatching one", async () => {
    const store = new FakeSupervisionStore();
    const graph = new FakeTaskGraph(twoNodeDag());
    store.addSupervision({ umbrellaTaskId: "mt#900", statusFilter: ["READY"] });

    // A is dispatched by one spawner instance...
    const firstSpawner = new FakeSpawner();
    await runSupervisionTick(buildDeps(store, graph, firstSpawner));
    expect(firstSpawner.calls.map((c) => c.taskId)).toEqual(["mt#901"]);

    graph.setStatus("mt#901", "DONE");

    // ...and B is dispatched by a DIFFERENT one, standing in for a daemon that
    // restarted in between. Nothing carries over but the store.
    const secondSpawner = new FakeSpawner();
    const tick = await runSupervisionTick(buildDeps(store, graph, secondSpawner));
    expect(tick.advances[0]?.dispatched).toEqual(["mt#902"]);
    expect(secondSpawner.calls.map((c) => c.taskId)).toEqual(["mt#902"]);
  });

  test("a driven session whose liveness is unknown keeps its slot rather than being stranded", async () => {
    // A restarted daemon has no in-memory record of a child it started before
    // the restart. Treating that as an exit would strand every dispatch across
    // every restart — exactly what this feature has to survive.
    const store = new FakeSupervisionStore();
    const graph = new FakeTaskGraph(twoNodeDag());
    store.addSupervision({ umbrellaTaskId: "mt#900", statusFilter: ["READY"] });

    const spawner = new FakeSpawner();
    await runSupervisionTick(buildDeps(store, graph, spawner));

    const amnesiac = new FakeSpawner(); // knows nothing -> reports "unknown"
    const tick = await runSupervisionTick(buildDeps(store, graph, amnesiac));

    expect(tick.advances[0]?.settled).toEqual([]);
    expect(store.dispatches[0]?.status).toBe("dispatched");
  });
});

describe("runSupervisionTick — bounded autonomy (SC7)", () => {
  test("refuses at the WIP limit with the reason stated, and never queues", async () => {
    const store = new FakeSupervisionStore();
    const graph = new FakeTaskGraph([
      { id: "mt#900", title: "umbrella", status: "IN-PROGRESS" },
      { id: "mt#901", title: "A", status: "READY", parent: "mt#900" },
      { id: "mt#902", title: "B", status: "READY", parent: "mt#900" },
      { id: "mt#903", title: "C", status: "READY", parent: "mt#900" },
    ]);
    const spawner = new FakeSpawner();
    store.addSupervision({ umbrellaTaskId: "mt#900", statusFilter: ["READY"], wipLimit: 2 });

    const first = await runSupervisionTick(buildDeps(store, graph, spawner));
    expect(first.advances[0]?.dispatched).toHaveLength(2);

    // Third child is dispatchable and there is no slot. The tick must say so
    // rather than dispatch it or silently do nothing.
    const second = await runSupervisionTick(buildDeps(store, graph, spawner));
    expect(second.advances[0]?.dispatched).toEqual([]);
    expect(second.advances[0]?.holdReason).toBe(HOLD_WIP_LIMIT);
    expect(spawner.calls).toHaveLength(2);

    // A slot frees; the held child is picked up with no re-queueing anywhere.
    const dispatchedTaskIds = spawner.calls.map((c) => c.taskId);
    graph.setStatus(dispatchedTaskIds[0] as string, "DONE");
    const third = await runSupervisionTick(buildDeps(store, graph, spawner));
    expect(third.advances[0]?.dispatched).toHaveLength(1);
  });

  test("does not re-dispatch a child that already failed", async () => {
    // An automatic retry would burn a WIP slot indefinitely on work that needs
    // a human to look at it. The failure is a record (SC10), not a loop.
    const store = new FakeSupervisionStore();
    const graph = new FakeTaskGraph(twoNodeDag());
    const spawner = new FakeSpawner();
    store.addSupervision({ umbrellaTaskId: "mt#900", statusFilter: ["READY"] });

    await runSupervisionTick(buildDeps(store, graph, spawner));
    const localId = spawner.localIdFor("mt#901");
    spawner.liveness.set(localId as string, "crashed");

    const second = await runSupervisionTick(buildDeps(store, graph, spawner));
    expect(second.advances[0]?.settled).toEqual([
      { taskId: "mt#901", status: "failed", settledBy: "session-exit" },
    ]);

    // A is still READY and still in the frontier — and must stay undispatched.
    const third = await runSupervisionTick(buildDeps(store, graph, spawner));
    expect(third.advances[0]?.dispatched).toEqual([]);
    expect(spawner.calls.map((c) => c.taskId)).toEqual(["mt#901"]);
  });

  test("holds with all-children-blocked when every child has an unmet dependency", async () => {
    const store = new FakeSupervisionStore();
    const graph = new FakeTaskGraph([
      { id: "mt#900", title: "umbrella", status: "IN-PROGRESS" },
      { id: "mt#901", title: "A", status: "READY", parent: "mt#900", dependsOn: ["mt#800"] },
      { id: "mt#800", title: "external prerequisite", status: "IN-PROGRESS" },
    ]);
    const spawner = new FakeSpawner();
    store.addSupervision({ umbrellaTaskId: "mt#900", statusFilter: ["READY"] });

    const tick = await runSupervisionTick(buildDeps(store, graph, spawner));
    expect(tick.advances[0]?.dispatched).toEqual([]);
    expect(tick.advances[0]?.holdReason).toBe(HOLD_ALL_BLOCKED);
  });
});

describe("runSupervisionTick — failure and completion records (AT4, SC10)", () => {
  test("a session that exits cleanly with the task still open is recorded as stranded", async () => {
    const store = new FakeSupervisionStore();
    const graph = new FakeTaskGraph(twoNodeDag());
    const spawner = new FakeSpawner();
    store.addSupervision({ umbrellaTaskId: "mt#900", statusFilter: ["READY"] });

    await runSupervisionTick(buildDeps(store, graph, spawner));
    spawner.liveness.set(spawner.localIdFor("mt#901") as string, "exited");

    await runSupervisionTick(buildDeps(store, graph, spawner));

    const row = store.dispatches.find((d) => d.taskId === "mt#901");
    expect(row?.status).toBe("stranded");
    expect(row?.settledBy).toBe("session-exit");
    // The record has to say WHY without anyone reading a log.
    expect(row?.lastError).toContain("READY");
  });

  test("a spawn failure is recorded and does not abandon the rest of the frontier", async () => {
    const store = new FakeSupervisionStore();
    const graph = new FakeTaskGraph([
      { id: "mt#900", title: "umbrella", status: "IN-PROGRESS" },
      { id: "mt#901", title: "A", status: "READY", parent: "mt#900" },
      { id: "mt#902", title: "B", status: "READY", parent: "mt#900" },
    ]);
    const spawner = new FakeSpawner();
    spawner.failFor.add("mt#901");
    store.addSupervision({ umbrellaTaskId: "mt#900", statusFilter: ["READY"] });

    const tick = await runSupervisionTick(buildDeps(store, graph, spawner));

    expect(tick.ok).toBe(false);
    expect(tick.advances[0]?.error).toContain("spawn refused for mt#901");
    // B still went out.
    expect(tick.advances[0]?.dispatched).toEqual(["mt#902"]);
  });

  test("completes when nothing is in flight and no child is dispatchable", async () => {
    const store = new FakeSupervisionStore();
    const graph = new FakeTaskGraph(twoNodeDag());
    const spawner = new FakeSpawner();
    const supervision = store.addSupervision({
      umbrellaTaskId: "mt#900",
      statusFilter: ["READY"],
    });

    graph.setStatus("mt#901", "DONE");
    graph.setStatus("mt#902", "DONE");

    const tick = await runSupervisionTick(buildDeps(store, graph, spawner));
    expect(tick.advances[0]?.completed).toBe(true);
    expect(tick.advances[0]?.holdReason).toBe(HOLD_FRONTIER_EMPTY);
    expect(store.supervisions.get(supervision.id)?.status).toBe("completed");
  });
});

describe("runSupervisionTick — single actuator (SC6)", () => {
  test("refuses to spawn onto a task that already has a live driven session", async () => {
    // The supervisor never resumes, so mt#3038's conversation-keyed resume lock
    // guards nothing for it. The multi-writer hazard arrives the other way:
    // resolveTaskWorkspace REUSES an existing workspace, so spawning onto a
    // task an operator is already driving by hand puts two claude processes in
    // one working tree.
    const store = new FakeSupervisionStore();
    const graph = new FakeTaskGraph([
      { id: "mt#900", title: "umbrella", status: "IN-PROGRESS" },
      { id: "mt#901", title: "A", status: "READY", parent: "mt#900" },
      { id: "mt#902", title: "B", status: "READY", parent: "mt#900" },
    ]);
    const spawner = new FakeSpawner();
    spawner.liveWriterFor.add("mt#901");
    store.addSupervision({ umbrellaTaskId: "mt#900", statusFilter: ["READY"] });

    const tick = await runSupervisionTick(buildDeps(store, graph, spawner));

    // B still goes out — a live session on one child says nothing about its
    // siblings, so the check is per candidate rather than once.
    expect(tick.advances[0]?.dispatched).toEqual(["mt#902"]);
    expect(spawner.calls.map((c) => c.taskId)).toEqual(["mt#902"]);
    // And no dispatch row was written for the skipped one, so a later tick can
    // still pick it up once the operator's session ends.
    expect(store.dispatches.map((d) => d.taskId)).toEqual(["mt#902"]);
  });

  test("says why it dispatched nothing when every candidate has a live writer", async () => {
    const store = new FakeSupervisionStore();
    const graph = new FakeTaskGraph([
      { id: "mt#900", title: "umbrella", status: "IN-PROGRESS" },
      { id: "mt#901", title: "A", status: "READY", parent: "mt#900" },
    ]);
    const spawner = new FakeSpawner();
    spawner.liveWriterFor.add("mt#901");
    store.addSupervision({ umbrellaTaskId: "mt#900", statusFilter: ["READY"] });

    const tick = await runSupervisionTick(buildDeps(store, graph, spawner));

    expect(tick.advances[0]?.dispatched).toEqual([]);
    // A silent empty tick here would read identically to having nothing to do.
    expect(tick.advances[0]?.holdReason).toBe(HOLD_LIVE_WRITER);
  });

  test("a skipped candidate does not consume a WIP slot", async () => {
    const store = new FakeSupervisionStore();
    const graph = new FakeTaskGraph([
      { id: "mt#900", title: "umbrella", status: "IN-PROGRESS" },
      { id: "mt#901", title: "A", status: "READY", parent: "mt#900" },
      { id: "mt#902", title: "B", status: "READY", parent: "mt#900" },
    ]);
    const spawner = new FakeSpawner();
    spawner.liveWriterFor.add("mt#901");
    store.addSupervision({ umbrellaTaskId: "mt#900", statusFilter: ["READY"], wipLimit: 1 });

    const tick = await runSupervisionTick(buildDeps(store, graph, spawner));

    // With a limit of 1, skipping A must not burn the only slot — B goes out.
    expect(tick.advances[0]?.dispatched).toEqual(["mt#902"]);
  });

  test("does nothing and says so when another actuator holds the lock", async () => {
    const store = new FakeSupervisionStore();
    const graph = new FakeTaskGraph(twoNodeDag());
    const spawner = new FakeSpawner();
    const supervision = store.addSupervision({
      umbrellaTaskId: "mt#900",
      statusFilter: ["READY"],
    });
    store.lockedElsewhere = supervision.id;

    const tick = await runSupervisionTick(buildDeps(store, graph, spawner));

    expect(spawner.calls).toEqual([]);
    expect(tick.advances[0]?.lockAcquired).toBe(false);
    expect(tick.advances[0]?.holdReason).toBe("lock-held-elsewhere");
    // Not an error: another daemon doing the work is the correct outcome.
    expect(tick.ok).toBe(true);
  });
});

describe("runSupervisionTick — abandonment (mt#4335, PR #3356 R1)", () => {
  test("an already-aborted tick spawns nothing at all", async () => {
    const store = new FakeSupervisionStore();
    const graph = new FakeTaskGraph(twoNodeDag());
    const spawner = new FakeSpawner();
    store.addSupervision({ umbrellaTaskId: "mt#900", statusFilter: ["READY"] });

    const controller = new AbortController();
    controller.abort();
    await runSupervisionTick(buildDeps(store, graph, spawner), controller.signal);

    // Most sweeps only read, so abandonment costs a held connection. This one
    // spawns real processes, so continuing past abandonment keeps ACTUATING.
    expect(spawner.calls).toEqual([]);
    expect(store.dispatches).toEqual([]);
  });

  test("aborting mid-pass stops further spawns and says why", async () => {
    const store = new FakeSupervisionStore();
    const graph = new FakeTaskGraph([
      { id: "mt#900", title: "umbrella", status: "IN-PROGRESS" },
      { id: "mt#901", title: "A", status: "READY", parent: "mt#900" },
      { id: "mt#902", title: "B", status: "READY", parent: "mt#900" },
      { id: "mt#903", title: "C", status: "READY", parent: "mt#900" },
    ]);
    const spawner = new FakeSpawner();
    store.addSupervision({ umbrellaTaskId: "mt#900", statusFilter: ["READY"] });

    const controller = new AbortController();
    const deps = buildDeps(store, graph, spawner);
    // Abort as soon as the first child has been dispatched.
    const realDispatch = deps.dispatchChild;
    deps.dispatchChild = async (input) => {
      const result = await realDispatch(input);
      controller.abort();
      return result;
    };

    const tick = await runSupervisionTick(deps, controller.signal);

    expect(tick.advances[0]?.dispatched).toEqual(["mt#901"]);
    expect(spawner.calls).toHaveLength(1);
    expect(tick.advances[0]?.holdReason).toBe(HOLD_ABANDONED);
  });

  test("a tick that is never aborted is unaffected", async () => {
    const store = new FakeSupervisionStore();
    const graph = new FakeTaskGraph(twoNodeDag());
    const spawner = new FakeSpawner();
    store.addSupervision({ umbrellaTaskId: "mt#900", statusFilter: ["READY"] });

    const tick = await runSupervisionTick(
      buildDeps(store, graph, spawner),
      new AbortController().signal
    );
    expect(tick.advances[0]?.dispatched).toEqual(["mt#901"]);
  });
});

describe("isSupervisionStalled — the semantic stall (AT3, SC9)", () => {
  const now = new Date("2026-08-25T20:00:00Z");

  test("is false while the supervision has advanced inside the threshold", () => {
    const lastAdvanceAt = new Date(now.getTime() - SUPERVISION_STALL_THRESHOLD_MS + 60_000);
    expect(isSupervisionStalled({ lastAdvanceAt, lastTickAt: now }, now)).toBe(false);
  });

  test("is true once nothing has advanced for longer than the threshold, even though the tick is healthy", () => {
    // This is the case startSweepMetaWatchdog structurally cannot see: it
    // watches for a DEAD tick, and here the tick is perfectly alive.
    const lastAdvanceAt = new Date(now.getTime() - SUPERVISION_STALL_THRESHOLD_MS - 60_000);
    expect(isSupervisionStalled({ lastAdvanceAt, lastTickAt: now }, now)).toBe(true);
  });

  test("measures from the first tick when the supervision has never advanced", () => {
    // Anchoring only on lastAdvanceAt would make a supervision that has moved
    // nothing since it started invisible forever, because that column is still
    // null — which is precisely the case worth surfacing.
    const lastTickAt = new Date(now.getTime() - SUPERVISION_STALL_THRESHOLD_MS - 60_000);
    expect(isSupervisionStalled({ lastAdvanceAt: null, lastTickAt }, now)).toBe(true);
  });

  test("is false for a supervision that has not ticked at all yet", () => {
    expect(isSupervisionStalled({ lastAdvanceAt: null, lastTickAt: null }, now)).toBe(false);
  });
});
