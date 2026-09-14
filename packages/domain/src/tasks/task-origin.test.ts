/**
 * `tasks.origin` → the autonomy classifier's human-origin evidence (mt#5136).
 *
 * Two layers, both here so the mapping and its wiring cannot drift apart:
 *
 * - `humanOriginFromChannel` — the one function every classifier call site
 *   goes through. Only `human` is evidence FOR; `agent` / `automated` are
 *   evidence AGAINST; a NULL row (predates the column) is no evidence.
 * - `TaskRoutingService.findAvailableTasksWithClass` — the `tasks_available`
 *   path, driven with a stub task service whose rows carry `origin`, so the
 *   spec's AT3 is observed THROUGH the wiring rather than by calling the pure
 *   classifier with a hand-set boolean (autonomy-class.test.ts already does
 *   that half).
 */

import { describe, test, expect } from "bun:test";
import { computeAutonomyClass, humanOriginFromChannel } from "./autonomy-class";
import { TaskRoutingService } from "./task-routing-service";
import type { TaskGraphService } from "./task-graph-service";
import type { TaskServiceInterface } from "./taskService";
import type { Task } from "./types";
import type { AutonomySignalSource } from "./autonomy-class-store";
import { TASK_ORIGIN_VALUES } from "../provenance/types";

describe("humanOriginFromChannel", () => {
  test("only `human` is evidence for; the other channels are evidence against; NULL is no evidence", () => {
    expect(humanOriginFromChannel("human")).toBe(true);
    expect(humanOriginFromChannel("agent")).toBe(false);
    expect(humanOriginFromChannel("automated")).toBe(false);
    expect(humanOriginFromChannel(null)).toBeUndefined();
    expect(humanOriginFromChannel(undefined)).toBeUndefined();
  });

  test("the enum the column is built from is exactly the provenance vocabulary", () => {
    expect([...TASK_ORIGIN_VALUES]).toEqual(["human", "agent", "automated"]);
  });
});

/** Every `contained` conjunct except origin, which each test supplies through the mapping. */
function containedShapeInput(origin: "human" | "agent" | "automated" | null) {
  return {
    id: "mt#1",
    kind: "implementation",
    status: "READY",
    tags: [] as string[],
    title: "Fix the widget",
    spec: {
      scope:
        "In scope: `packages/domain/src/tasks/widget.ts` and its test.\n\nOut of scope: everything else.",
      summary: "The widget drops the last item. A reproducing test is at widget.test.ts.",
      origin: null,
    },
    humanOrigin: humanOriginFromChannel(origin),
  };
}

describe("computeAutonomyClass through the channel mapping (AT3)", () => {
  test("a human-filed, READY, reproducing-test task outside the listed surfaces is contained", () => {
    const r = computeAutonomyClass(containedShapeInput("human"));
    expect(r.class).toBe("contained");
    expect(r.reasons).toContain("human origin");
  });

  test("the same task filed by an agent, a loop, or before the column is pull-only, naming the missing signal", () => {
    for (const origin of ["agent", "automated", null] as const) {
      const r = computeAutonomyClass(containedShapeInput(origin));
      expect(r.class).toBe("pull-only");
      expect(r.reasons).toContain("no human-origin evidence");
    }
  });
});

// ─── The wiring: tasks_available reads the row's origin ───────────────────────

const CONTAINED_SPEC = {
  scope:
    "In scope: `packages/domain/src/tasks/widget.ts` and its test.\n\nOut of scope: everything else.",
  summary: "The widget drops the last item. A reproducing test is at widget.test.ts.",
  origin: null,
};

function signalSourceFor(ids: string[]): AutonomySignalSource {
  return {
    loadSpecSignals: async (wanted) =>
      new Map(wanted.filter((id) => ids.includes(id)).map((id) => [id, CONTAINED_SPEC])),
  };
}

function stubGraph(): TaskGraphService {
  return { getRelationshipsForTasks: async () => [] } as unknown as TaskGraphService;
}

function serviceOver(tasks: Task[]): TaskRoutingService {
  const taskService = {
    listTasks: async () => tasks,
    getTask: async (id: string) => tasks.find((t) => t.id === id) ?? null,
    getTasks: async (ids: string[]) => tasks.filter((t) => ids.includes(t.id)),
  } as unknown as TaskServiceInterface;
  return new TaskRoutingService(stubGraph(), taskService, signalSourceFor(tasks.map((t) => t.id)));
}

describe("TaskRoutingService reads tasks.origin for the class (mt#5136 wiring)", () => {
  test("a READY contained-shaped task resolves contained only when its row says human", async () => {
    const tasks: Task[] = [
      {
        id: "mt#h",
        title: "Fix the widget",
        status: "READY",
        kind: "implementation",
        origin: "human",
      },
      {
        id: "mt#a",
        title: "Fix the widget",
        status: "READY",
        kind: "implementation",
        origin: "agent",
      },
      {
        id: "mt#m",
        title: "Fix the widget",
        status: "READY",
        kind: "implementation",
        origin: "automated",
      },
      {
        id: "mt#n",
        title: "Fix the widget",
        status: "READY",
        kind: "implementation",
        origin: null,
      },
      { id: "mt#u", title: "Fix the widget", status: "READY", kind: "implementation" },
    ];
    const result = await serviceOver(tasks).findAvailableTasksWithClass({
      statusFilter: ["READY"],
      limit: 10,
    });
    const classOf = new Map(result.tasks.map((t) => [t.taskId, t.autonomyClass]));
    expect(classOf.get("mt#h")).toBe("contained");
    expect(classOf.get("mt#a")).toBe("pull-only");
    expect(classOf.get("mt#m")).toBe("pull-only");
    expect(classOf.get("mt#n")).toBe("pull-only");
    expect(classOf.get("mt#u")).toBe("pull-only");
    // Every one of them is servable — the class changes which, not whether.
    expect(result.excludedByClass).toEqual({ principalGated: 0, unknown: 0 });
  });
});
