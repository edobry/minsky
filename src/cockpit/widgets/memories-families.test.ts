import { describe, test, expect } from "bun:test";
import {
  buildFamiliesPayload,
  createMemoriesFamiliesWidget,
  type FamilyMemoryStatsRow,
  type FamilyTaskLinkRow,
} from "./memories-families";

const AWV_TAG = "family:assertion-without-verification";
const MULTI_FIX_TAG = "family:multi-fix";
const WIDGET_ID = "memories-families";

describe("buildFamiliesPayload (mt#4763)", () => {
  test("joins memory-side stats with task-side links by tag, sorted by member count desc", () => {
    const memoryStats: FamilyMemoryStatsRow[] = [
      {
        tag: AWV_TAG,
        count: 66,
        firstAt: "2026-01-01T00:00:00.000Z",
        lastAt: "2026-08-20T00:00:00.000Z",
      },
      {
        tag: "family:scope-creep",
        count: 12,
        firstAt: "2026-03-01T00:00:00.000Z",
        lastAt: "2026-07-01T00:00:00.000Z",
      },
    ];
    const taskLinks: FamilyTaskLinkRow[] = [
      { tag: AWV_TAG, taskId: "mt#4749" },
      { tag: AWV_TAG, taskId: "mt#4749" }, // dedup check
      { tag: "family:scope-creep", taskId: "mt#1200" },
    ];

    const result = buildFamiliesPayload(memoryStats, taskLinks);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      slug: "assertion-without-verification",
      tag: AWV_TAG,
      memberCount: 66,
      firstMemberAt: "2026-01-01T00:00:00.000Z",
      mostRecentMemberAt: "2026-08-20T00:00:00.000Z",
      structuralFixTasks: ["mt#4749"],
    });
    expect(result[1]).toMatchObject({
      slug: "scope-creep",
      memberCount: 12,
      structuralFixTasks: ["mt#1200"],
    });
  });

  test("a family with no linked task gets an empty structuralFixTasks array, not undefined", () => {
    const memoryStats: FamilyMemoryStatsRow[] = [
      { tag: "family:orphan", count: 3, firstAt: new Date(0), lastAt: new Date(0) },
    ];
    const result = buildFamiliesPayload(memoryStats, []);
    expect(result[0]?.structuralFixTasks).toEqual([]);
  });

  test("multiple distinct tasks carrying the same family tag are all listed, sorted", () => {
    const memoryStats: FamilyMemoryStatsRow[] = [
      { tag: MULTI_FIX_TAG, count: 5, firstAt: new Date(0), lastAt: new Date(0) },
    ];
    const taskLinks: FamilyTaskLinkRow[] = [
      { tag: MULTI_FIX_TAG, taskId: "mt#200" },
      { tag: MULTI_FIX_TAG, taskId: "mt#100" },
    ];
    const result = buildFamiliesPayload(memoryStats, taskLinks);
    expect(result[0]?.structuralFixTasks).toEqual(["mt#100", "mt#200"]);
  });

  test("ties in member count break alphabetically by slug", () => {
    const memoryStats: FamilyMemoryStatsRow[] = [
      { tag: "family:b-family", count: 4, firstAt: new Date(0), lastAt: new Date(0) },
      { tag: "family:a-family", count: 4, firstAt: new Date(0), lastAt: new Date(0) },
    ];
    const result = buildFamiliesPayload(memoryStats, []);
    expect(result.map((r) => r.slug)).toEqual(["a-family", "b-family"]);
  });

  test("empty memory stats produces an empty result regardless of task links", () => {
    expect(buildFamiliesPayload([], [{ tag: "family:whatever", taskId: "mt#1" }])).toEqual([]);
  });
});

describe("createMemoriesFamiliesWidget — degraded states (mt#4763)", () => {
  test("returns degraded when the db getter resolves null", async () => {
    const widget = createMemoriesFamiliesWidget(async () => null);
    const result = await widget.fetch({ id: WIDGET_ID, query: {} });
    expect(result.state).toBe("degraded");
  });

  test("returns degraded (not a throw) when the db getter itself rejects", async () => {
    const widget = createMemoriesFamiliesWidget(async () => {
      throw new Error("connection refused");
    });
    const result = await widget.fetch({ id: WIDGET_ID, query: {} });
    expect(result.state).toBe("degraded");
    if (result.state === "degraded") {
      expect(result.reason).toContain("memories families");
    }
  });

  test("widget id and title are stable", () => {
    const widget = createMemoriesFamiliesWidget(async () => null);
    expect(widget.id).toBe(WIDGET_ID);
    expect(widget.title).toBe("Memories — Families");
  });
});
