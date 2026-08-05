import { describe, test, expect } from "bun:test";
import { mergeStreamLines, timestampOf, parseArgs } from "./consolidate-evaluation-stream-logs";

const rec = (ts: string, extra = "") =>
  JSON.stringify({ timestamp: ts, hook: "silent-stretch", extra });

describe("mergeStreamLines (mt#3745)", () => {
  test("merges stray records into the repo's and sorts by timestamp", () => {
    const existing = [rec("2026-08-01T10:00:00Z"), rec("2026-08-03T10:00:00Z")];
    const stray = [rec("2026-08-02T10:00:00Z")];

    const merged = mergeStreamLines(existing, stray);

    expect(merged).toHaveLength(3);
    expect(merged.map(timestampOf)).toEqual([
      "2026-08-01T10:00:00Z",
      "2026-08-02T10:00:00Z",
      "2026-08-03T10:00:00Z",
    ]);
  });

  test("does not duplicate a record the repo log already has — the idempotency property", () => {
    const shared = rec("2026-08-02T10:00:00Z");
    const existing = [rec("2026-08-01T10:00:00Z"), shared];

    // Running twice must be indistinguishable from running once.
    const once = mergeStreamLines(existing, [shared]);
    const twice = mergeStreamLines(once, [shared]);

    expect(once).toHaveLength(2);
    expect(twice).toEqual(once);
  });

  test("keeps an unparseable line rather than dropping it, sorted to the front", () => {
    // The stream is append-only evidence, not a schema-validated store: losing
    // a malformed record during a recovery pass would be the worse failure.
    const merged = mergeStreamLines([rec("2026-08-01T10:00:00Z")], ["{not json"]);

    expect(merged).toHaveLength(2);
    expect(merged[0]).toBe("{not json");
  });

  test("an empty stray set leaves the repo log untouched", () => {
    const existing = [rec("2026-08-01T10:00:00Z")];
    expect(mergeStreamLines(existing, [])).toEqual(existing);
  });
});

describe("timestampOf", () => {
  test("reads the timestamp field", () => {
    expect(timestampOf(rec("2026-08-01T10:00:00Z"))).toBe("2026-08-01T10:00:00Z");
  });

  test("returns the empty string for a record with no usable timestamp", () => {
    expect(timestampOf(JSON.stringify({ hook: "x" }))).toBe("");
    expect(timestampOf(JSON.stringify({ timestamp: 42 }))).toBe("");
    expect(timestampOf("{not json")).toBe("");
  });
});

describe("parseArgs", () => {
  test("dry run is the default", () => {
    expect(parseArgs([])).toEqual({ execute: false, limit: undefined });
  });

  test("--execute and --limit are read", () => {
    expect(parseArgs(["--execute", "--limit", "3"])).toEqual({ execute: true, limit: 3 });
  });

  test("a non-numeric or non-positive --limit is ignored rather than silently bounding the scan", () => {
    expect(parseArgs(["--limit", "abc"]).limit).toBeUndefined();
    expect(parseArgs(["--limit", "0"]).limit).toBeUndefined();
  });
});
