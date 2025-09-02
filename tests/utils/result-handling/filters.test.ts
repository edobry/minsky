import { describe, it, expect } from "bun:test";
import {
  parseStatusFilter,
  parseBackendFilter,
  parseTime,
  filterByStatus,
  filterByBackend,
  filterByTimeRange,
} from "../../../src/utils/result-handling/filters";

describe("result-handling/filters: parseStatusFilter", () => {
  it("returns null for undefined or 'all'", () => {
    expect(parseStatusFilter(undefined)).toBeNull();
    expect(parseStatusFilter(null as any)).toBeNull();
    expect(parseStatusFilter("all")).toBeNull();
  });
  it("parses comma-separated statuses", () => {
    const set = parseStatusFilter("open, draft ,MERGED");
    expect(set).not.toBeNull();
    expect(set?.has("open")).toBe(true);
    expect(set?.has("draft")).toBe(true);
    expect(set?.has("merged")).toBe(true);
    expect(set?.has("closed")).toBe(false);
  });
});

describe("result-handling/filters: parseBackendFilter", () => {
  it("normalizes valid backends", () => {
    expect(parseBackendFilter("github")).toBe("github");
    expect(parseBackendFilter("REMOTE")).toBe("remote");
    expect(parseBackendFilter("local")).toBe("local");
  });
  it("returns undefined for invalid", () => {
    expect(parseBackendFilter("gitlab" as any)).toBeUndefined();
    expect(parseBackendFilter("")).toBeUndefined();
  });
});

describe("result-handling/filters: parseTime", () => {
  it("parses YYYY-MM-DD", () => {
    const ts = parseTime("2024-01-01");
    expect(typeof ts).toBe("number");
    expect(ts).not.toBeNull();
  });
  it("parses relative d/h/m within tolerance", () => {
    const before = Date.now();
    const tsH = parseTime("1h")!;
    const after = Date.now();
    // 1h ago should be between before-1h and after-1h
    expect(tsH).toBeGreaterThanOrEqual(before - 3600000 - 50);
    expect(tsH).toBeLessThanOrEqual(after - 3600000 + 50);
  });
  it("returns null for invalid", () => {
    expect(parseTime("not-a-date")).toBeNull();
    expect(parseTime("1x")).toBeNull();
  });
});

type Item = { status?: string; backendType?: string; updatedAt?: string };

describe("result-handling/filters: filterByStatus", () => {
  it("filters by status set", () => {
    const items: Item[] = [{ status: "open" }, { status: "draft" }, { status: "merged" }];
    const res = filterByStatus(items, new Set(["open", "merged"]));
    expect(res.map((i) => i.status)).toEqual(["open", "merged"]);
  });
});

describe("result-handling/filters: filterByBackend", () => {
  it("filters by backend", () => {
    const items: Item[] = [
      { backendType: "github" },
      { backendType: "remote" },
      { backendType: "local" },
    ];
    const res = filterByBackend(items, "github");
    expect(res).toHaveLength(1);
    expect(res[0].backendType).toBe("github");
  });
});

describe("result-handling/filters: filterByTimeRange", () => {
  it("includes items within range and excludes outside", () => {
    const now = Date.now();
    const items: Item[] = [
      { updatedAt: new Date(now - 2 * 3600000).toISOString() }, // 2h ago
      { updatedAt: new Date(now - 3600000).toISOString() }, // 1h ago
      { updatedAt: new Date(now - 5 * 60000).toISOString() }, // 5m ago
    ];
    const since = now - 90 * 60000; // 1.5h ago
    const until = now - 10 * 60000; // 10m ago
    const res = filterByTimeRange(items, since, until);
    expect(res).toHaveLength(1);
    expect(res[0].updatedAt).toBeDefined();
  });
});
