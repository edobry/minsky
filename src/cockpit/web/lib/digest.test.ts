/**
 * Tests for the Tier-2 digest derivation (mt#2869).
 *
 * Pure coverage: grouping by task, fleet-bucket fallback + pinned-last
 * ordering, count classification, exception extraction (deploy.fail /
 * blocked hook.fired / BLOCKED transition), latest-status derivation,
 * summary-sentence rendering, and the day-window bounds.
 */
import { describe, test, expect } from "bun:test";
import {
  buildDigest,
  groupKeyFor,
  exceptionFor,
  summarizeCounts,
  dayWindow,
  FLEET_GROUP_KEY,
  type DigestEventRow,
} from "./digest";

let nextId = 0;

/** Shared event-type constant (template-literal pattern — single source of truth). */
const STATUS_EVENT = "task.status_changed";

function row(
  eventType: string,
  overrides: Partial<DigestEventRow> & { payload?: Record<string, unknown> } = {}
): DigestEventRow {
  nextId += 1;
  return {
    id: `evt-${nextId}`,
    eventType,
    payload: overrides.payload ?? null,
    relatedTaskId: overrides.relatedTaskId ?? null,
    relatedSessionId: overrides.relatedSessionId ?? null,
    createdAt: overrides.createdAt ?? `2026-07-17T10:00:${String(nextId % 60).padStart(2, "0")}Z`,
  };
}

describe("groupKeyFor", () => {
  test("prefers relatedTaskId, falls back to payload.taskId, then fleet", () => {
    expect(groupKeyFor(row("pr.merged", { relatedTaskId: "mt#1" }))).toBe("mt#1");
    expect(groupKeyFor(row("pr.merged", { payload: { taskId: "mt#2" } }))).toBe("mt#2");
    expect(groupKeyFor(row("mcp.disconnect"))).toBe(FLEET_GROUP_KEY);
  });
});

describe("exceptionFor", () => {
  test("deploy.fail and blocked/overridden hook firings are exceptions", () => {
    expect(exceptionFor(row("deploy.fail", { payload: { service: "minsky-mcp" } }))?.label).toBe(
      "deploy FAILED (minsky-mcp)"
    );
    expect(
      exceptionFor(row("hook.fired", { payload: { hook: "bypass-merge", decision: "blocked" } }))
        ?.label
    ).toBe("bypass-merge blocked");
    expect(
      exceptionFor(row("hook.fired", { payload: { hook: "freshness", decision: "overridden" } }))
        ?.label
    ).toBe("freshness overridden");
  });

  test("routine events and non-blocking hook records are not exceptions", () => {
    expect(exceptionFor(row("pr.merged", { payload: { prNumber: 5 } }))).toBeNull();
    expect(
      exceptionFor(row("hook.fired", { payload: { hook: "x", decision: "allowed" } }))
    ).toBeNull();
    expect(exceptionFor(row(STATUS_EVENT, { payload: { newStatus: "DONE" } }))).toBeNull();
  });

  test("a BLOCKED transition is an exception", () => {
    expect(exceptionFor(row(STATUS_EVENT, { payload: { newStatus: "BLOCKED" } }))?.label).toBe(
      "task BLOCKED"
    );
  });
});

describe("buildDigest", () => {
  test("groups per task, counts classes, tracks PR refs and latest status", () => {
    const groups = buildDigest([
      row(STATUS_EVENT, {
        relatedTaskId: "mt#100",
        payload: { taskId: "mt#100", newStatus: "IN-PROGRESS" },
        createdAt: "2026-07-17T09:00:00Z",
      }),
      row("changeset.created", {
        relatedTaskId: "mt#100",
        payload: { prNumber: 42, taskId: "mt#100", title: "Make the thing loud" },
        createdAt: "2026-07-17T10:00:00Z",
      }),
      row("pr.merged", {
        relatedTaskId: "mt#100",
        payload: { prNumber: 42, taskId: "mt#100" },
        createdAt: "2026-07-17T11:00:00Z",
      }),
      row(STATUS_EVENT, {
        relatedTaskId: "mt#100",
        payload: { taskId: "mt#100", newStatus: "DONE" },
        createdAt: "2026-07-17T11:00:01Z",
      }),
    ]);

    expect(groups).toHaveLength(1);
    const g = groups[0];
    if (!g) throw new Error("expected one group");
    expect(g.taskId).toBe("mt#100");
    expect(g.title).toBe("Make the thing loud");
    expect(g.counts.statusChanges).toBe(2);
    expect(g.counts.changesetsOpened).toBe(1);
    expect(g.counts.prsMerged).toBe(1);
    expect(g.prNumbers).toEqual([42]);
    expect(g.latestStatus).toBe("DONE");
    expect(g.eventCount).toBe(4);
    expect(g.exceptions).toEqual([]);
  });

  test("latest status derives from time order even when input is shuffled", () => {
    const groups = buildDigest([
      row(STATUS_EVENT, {
        relatedTaskId: "mt#7",
        payload: { newStatus: "DONE" },
        createdAt: "2026-07-17T12:00:00Z",
      }),
      row(STATUS_EVENT, {
        relatedTaskId: "mt#7",
        payload: { newStatus: "IN-REVIEW" },
        createdAt: "2026-07-17T11:00:00Z",
      }),
    ]);
    expect(groups[0]?.latestStatus).toBe("DONE");
  });

  test("unattributed events land in the fleet bucket, pinned last regardless of volume", () => {
    const groups = buildDigest([
      row("mcp.disconnect", { createdAt: "2026-07-17T01:00:00Z" }),
      row("mcp.disconnect", { createdAt: "2026-07-17T02:00:00Z" }),
      row("deploy.live", { createdAt: "2026-07-17T03:00:00Z" }),
      row("pr.merged", { relatedTaskId: "mt#9", payload: { prNumber: 8 } }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.taskId).toBe("mt#9");
    expect(groups[groups.length - 1]?.key).toBe(FLEET_GROUP_KEY);
    expect(groups[groups.length - 1]?.eventCount).toBe(3);
  });

  test("most-active workstream sorts first", () => {
    const groups = buildDigest([
      row("pr.merged", { relatedTaskId: "mt#1", payload: { prNumber: 1 } }),
      row("pr.merged", { relatedTaskId: "mt#2", payload: { prNumber: 2 } }),
      row("ask.created", { relatedTaskId: "mt#2" }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["mt#2", "mt#1"]);
  });

  test("exceptions accumulate on their group", () => {
    const groups = buildDigest([
      row("deploy.fail", {
        relatedTaskId: "mt#3",
        payload: { service: "reviewer" },
      }),
      row("hook.fired", {
        relatedTaskId: "mt#3",
        payload: { hook: "bypass-merge", decision: "blocked" },
      }),
    ]);
    expect(groups[0]?.exceptions.map((e) => e.label)).toEqual([
      "deploy FAILED (reviewer)",
      "bypass-merge blocked",
    ]);
  });
});

describe("summarizeCounts", () => {
  test("renders non-zero clauses only, with pluralization", () => {
    const groups = buildDigest([
      row("pr.merged", { relatedTaskId: "mt#5", payload: { prNumber: 1 } }),
      row("pr.merged", { relatedTaskId: "mt#5", payload: { prNumber: 2 } }),
      row("session.started", { relatedTaskId: "mt#5" }),
      row("ask.created", { relatedTaskId: "mt#5" }),
    ]);
    const first = groups[0];
    if (!first) throw new Error("expected one group");
    const summary = summarizeCounts(first.counts);
    expect(summary).toBe("2 PRs merged · 1 session started · 1 ask raised");
  });

  test("empty when nothing countable happened", () => {
    const groups = buildDigest([row("mcp.disconnect")]);
    const first = groups[0];
    if (!first) throw new Error("expected one group");
    expect(summarizeCounts(first.counts)).toBe("");
  });
});

describe("dayWindow", () => {
  test("offset 0 spans the current local calendar day; offset 1 the day before", () => {
    const now = new Date(2026, 6, 17, 15, 30, 0);
    const today = dayWindow(0, now);
    expect(new Date(today.since).getTime()).toBe(new Date(2026, 6, 17).getTime());
    expect(new Date(today.until).getTime()).toBe(new Date(2026, 6, 18).getTime());
    const yesterday = dayWindow(1, now);
    expect(new Date(yesterday.since).getTime()).toBe(new Date(2026, 6, 16).getTime());
    expect(new Date(yesterday.until).getTime()).toBe(new Date(2026, 6, 17).getTime());
  });
});
