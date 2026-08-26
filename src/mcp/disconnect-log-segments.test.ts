/**
 * Tests for the disconnect-log monthly segmentation (mt#4495).
 *
 * Every filesystem touch goes through the injectable `SegmentFsDeps` seam, so
 * nothing here needs a tmpdir. That is the whole reason the seam exists — the
 * interesting behaviour is the roll DECISION and the segment ENUMERATION, and
 * neither needs a real file to be exercised.
 */
import { describe, test, expect } from "bun:test";
import {
  monthOf,
  segmentPathFor,
  monthOfSegmentPath,
  decideRoll,
  listSegmentPaths,
  listCorpusPaths,
  readTail,
  rollIfNeeded,
  SEGMENT_MAX_BYTES,
  type SegmentFsDeps,
} from "./disconnect-log-segments";

const ACTIVE = "/state/minsky/mcp-disconnect-log.json";
const segmentPath = (month: string) => `/state/minsky/mcp-disconnect-log-${month}.json`;
const SEG_2026_05 = segmentPath("2026-05");
const SEG_2026_06 = segmentPath("2026-06");
const SEG_2026_07 = segmentPath("2026-07");

/** In-memory filesystem standing in for `SegmentFsDeps`. */
function fakeFs(files: Record<string, string>): SegmentFsDeps & { files: Record<string, string> } {
  const store = { ...files };
  const encoder = new TextEncoder();
  const openHandles = new Map<number, string>();
  let nextFd = 10;

  return {
    files: store,
    existsSync: (p) => Object.prototype.hasOwnProperty.call(store, p),
    statSync: (p) => {
      if (!Object.prototype.hasOwnProperty.call(store, p)) throw new Error(`ENOENT: ${p}`);
      return { size: encoder.encode(store[p] as string).length };
    },
    readdirSync: (dir) =>
      Object.keys(store)
        .filter((p) => p.slice(0, p.lastIndexOf("/")) === dir)
        .map((p) => p.slice(p.lastIndexOf("/") + 1)),
    renameSync: (from, to) => {
      if (!Object.prototype.hasOwnProperty.call(store, from)) throw new Error(`ENOENT: ${from}`);
      store[to] = store[from] as string;
      delete store[from];
    },
    openSync: (p) => {
      if (!Object.prototype.hasOwnProperty.call(store, p)) throw new Error(`ENOENT: ${p}`);
      const fd = nextFd++;
      openHandles.set(fd, p);
      return fd;
    },
    readSync: (fd, buf, offset, length, position) => {
      const p = openHandles.get(fd);
      if (p === undefined) throw new Error(`EBADF: ${fd}`);
      const bytes = encoder.encode(store[p] as string);
      const end = Math.min(bytes.length, position + length);
      const slice = bytes.subarray(position, end);
      buf.set(slice, offset);
      return slice.length;
    },
    closeSync: (fd) => void openHandles.delete(fd),
  };
}

const rec = (ts: string) => `${JSON.stringify({ timestamp: ts, kind: "disconnect" })}\n`;

describe("monthOf / segment naming (mt#4495)", () => {
  test("extracts the month from an ISO timestamp", () => {
    expect(monthOf("2026-08-25T16:51:09.669Z")).toBe("2026-08");
  });

  test("returns empty for anything not YYYY-MM shaped", () => {
    expect(monthOf("")).toBe("");
    expect(monthOf("nonsense")).toBe("");
    expect(monthOf("20260825")).toBe("");
  });

  test("segment path inserts the month before the extension", () => {
    expect(segmentPathFor(ACTIVE, "2026-07")).toBe(SEG_2026_07);
  });

  test("segment-name parsing round-trips, and rejects near-misses", () => {
    expect(monthOfSegmentPath(ACTIVE, segmentPathFor(ACTIVE, "2026-07"))).toBe("2026-07");
    // The active file itself is not a segment.
    expect(monthOfSegmentPath(ACTIVE, ACTIVE)).toBe("");
    // A backup written by the mt#4558 normalizer must not be read as a segment,
    // or a census would double-count every record it holds.
    expect(
      monthOfSegmentPath(
        ACTIVE,
        "/state/minsky/mcp-disconnect-log.json.backup-2026-08-25T16-00-00Z"
      )
    ).toBe("");
    // Neither must the sweep's high-water-mark file.
    expect(monthOfSegmentPath(ACTIVE, "/state/minsky/mcp-disconnect-sweep-hwm.json")).toBe("");
  });
});

describe("decideRoll (mt#4495)", () => {
  test("rolls when the newest record predates the current month", () => {
    const d = decideRoll({
      activeSize: 1000,
      newestRecordMonth: "2026-07",
      currentMonth: "2026-08",
    });
    expect(d).toEqual({ roll: true, month: "2026-07", reason: "calendar" });
  });

  test("does NOT roll within the same month", () => {
    const d = decideRoll({
      activeSize: 1000,
      newestRecordMonth: "2026-08",
      currentMonth: "2026-08",
    });
    expect(d.roll).toBe(false);
    expect(d.reason).toBe("none");
  });

  test("does NOT roll an empty file, even across a month boundary", () => {
    const d = decideRoll({ activeSize: 0, newestRecordMonth: "2026-07", currentMonth: "2026-08" });
    expect(d.roll).toBe(false);
  });

  test("size valve fires within the same month", () => {
    const d = decideRoll({
      activeSize: SEGMENT_MAX_BYTES,
      newestRecordMonth: "2026-08",
      currentMonth: "2026-08",
    });
    expect(d).toEqual({ roll: true, month: "2026-08", reason: "size" });
  });

  test("size valve names the segment for the current month when no record parses", () => {
    const d = decideRoll({
      activeSize: SEGMENT_MAX_BYTES,
      newestRecordMonth: "",
      currentMonth: "2026-08",
    });
    expect(d).toEqual({ roll: true, month: "2026-08", reason: "size" });
  });

  test("the calendar trigger takes precedence over the size valve", () => {
    // Both conditions hold; the segment must be named for the data's month,
    // not the current one, or July's records land in a file called August.
    const d = decideRoll({
      activeSize: SEGMENT_MAX_BYTES,
      newestRecordMonth: "2026-07",
      currentMonth: "2026-08",
    });
    expect(d.reason).toBe("calendar");
    expect(d.month).toBe("2026-07");
  });

  test("a clock that reads earlier than the data does not roll", () => {
    // Guards against a backwards clock rolling every boot in a loop.
    const d = decideRoll({
      activeSize: 1000,
      newestRecordMonth: "2026-08",
      currentMonth: "2026-07",
    });
    expect(d.roll).toBe(false);
  });
});

describe("listSegmentPaths / listCorpusPaths (mt#4495)", () => {
  const withSegments = () =>
    fakeFs({
      [ACTIVE]: rec("2026-08-20T00:00:00.000Z"),
      [SEG_2026_06]: rec("2026-06-01T00:00:00.000Z"),
      [SEG_2026_05]: rec("2026-05-01T00:00:00.000Z"),
      [SEG_2026_07]: rec("2026-07-01T00:00:00.000Z"),
      "/state/minsky/mcp-disconnect-sweep-hwm.json": "{}",
      "/state/minsky/unrelated.json": "{}",
    });

  test("returns segments oldest-first and excludes non-segments", () => {
    expect(listSegmentPaths(ACTIVE, withSegments())).toEqual([
      SEG_2026_05,
      SEG_2026_06,
      SEG_2026_07,
    ]);
  });

  test("sinceMonth bounds the scan", () => {
    expect(listSegmentPaths(ACTIVE, withSegments(), "2026-07")).toEqual([SEG_2026_07]);
  });

  test("the corpus is segments then the active file, chronologically", () => {
    const corpus = listCorpusPaths(ACTIVE, withSegments());
    expect(corpus[corpus.length - 1]).toBe(ACTIVE);
    expect(corpus).toHaveLength(4);
  });

  test("the corpus omits the active file when it does not exist yet", () => {
    const deps = fakeFs({
      [SEG_2026_07]: rec("2026-07-01T00:00:00.000Z"),
    });
    expect(listCorpusPaths(ACTIVE, deps)).toEqual([SEG_2026_07]);
  });

  test("an unreadable directory yields no segments rather than throwing", () => {
    const deps = fakeFs({});
    deps.readdirSync = () => {
      throw new Error("EACCES");
    };
    expect(listSegmentPaths(ACTIVE, deps)).toEqual([]);
  });
});

describe("readTail (mt#4495)", () => {
  test("returns the whole file when it fits inside the window", () => {
    const body = rec("2026-08-01T00:00:00.000Z") + rec("2026-08-02T00:00:00.000Z");
    const out = readTail(ACTIVE, 1024, fakeFs({ [ACTIVE]: body }));
    expect(out.raw).toBe(body);
    expect(out.droppedPartialHead).toBe(false);
  });

  test("drops the leading partial record when the window truncates", () => {
    const lines = Array.from({ length: 50 }, (_, i) =>
      rec(`2026-08-01T00:00:${String(i).padStart(2, "0")}.000Z`)
    ).join("");
    // A window that lands mid-file must not emit a half-record.
    const out = readTail(ACTIVE, 300, fakeFs({ [ACTIVE]: lines }));
    expect(out.droppedPartialHead).toBe(true);
    for (const line of out.raw.split("\n").filter((l) => l.trim() !== "")) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test("returns nothing usable when the window lands inside a single record", () => {
    const oneHugeRecord = `${JSON.stringify({ timestamp: "2026-08-01T00:00:00.000Z", pad: "x".repeat(500) })}\n`;
    const out = readTail(ACTIVE, 50, fakeFs({ [ACTIVE]: oneHugeRecord }));
    expect(out.raw).toBe("");
    expect(out.droppedPartialHead).toBe(true);
  });

  test("a missing or empty file yields empty, not a throw", () => {
    expect(readTail(ACTIVE, 1024, fakeFs({})).raw).toBe("");
    expect(readTail(ACTIVE, 1024, fakeFs({ [ACTIVE]: "" })).raw).toBe("");
  });
});

describe("rollIfNeeded (mt#4495)", () => {
  test("renames the active file to its monthly segment", () => {
    const deps = fakeFs({ [ACTIVE]: rec("2026-07-31T23:59:00.000Z") });
    const target = rollIfNeeded(ACTIVE, { roll: true, month: "2026-07", reason: "calendar" }, deps);
    expect(target).toBe(SEG_2026_07);
    expect(deps.existsSync(ACTIVE)).toBe(false);
    expect(deps.existsSync(SEG_2026_07)).toBe(true);
  });

  test("REGRESSION (R1): an occupied segment name rolls to an ordinal, never refuses", () => {
    // Reviewer R1, PR #3368 — BLOCKING, and reproduced before fixing. The old
    // code returned null when the target existed, which left the prior month's
    // records IN THE ACTIVE FILE. Two harms: the active file is never bounded
    // for that month, and if the existing segment's content overlaps, every
    // overlapping record is counted twice across `listCorpusPaths`.
    const existing = rec("2026-07-01T00:00:00.000Z");
    const deps = fakeFs({
      [ACTIVE]: rec("2026-07-31T23:59:00.000Z"),
      [SEG_2026_07]: existing,
    });
    const target = rollIfNeeded(ACTIVE, { roll: true, month: "2026-07", reason: "calendar" }, deps);

    expect(target).toBe(segmentPath("2026-07-2"));
    // Nothing deleted: the pre-existing segment is byte-identical.
    expect(deps.files[SEG_2026_07]).toBe(existing);
    // And the active file is GONE, so its records cannot be read a second time
    // alongside the segment. This is the assertion the old test was missing.
    expect(deps.existsSync(ACTIVE)).toBe(false);
  });

  test("REGRESSION (R1): every record keeps exactly ONE home across the corpus", () => {
    // The property the ordinal fix actually buys, asserted directly rather than
    // inferred from the rename's return value.
    const deps = fakeFs({
      [ACTIVE]: rec("2026-07-02T00:00:00.000Z") + rec("2026-07-03T00:00:00.000Z"),
      [SEG_2026_07]: rec("2026-07-01T00:00:00.000Z"),
    });
    rollIfNeeded(ACTIVE, { roll: true, month: "2026-07", reason: "calendar" }, deps);

    const seen = new Map<string, number>();
    for (const p of listCorpusPaths(ACTIVE, deps)) {
      for (const line of (deps.files[p] ?? "").split("\n")) {
        const t = line.trim();
        if (!t) continue;
        seen.set(t, (seen.get(t) ?? 0) + 1);
      }
    }
    expect(seen.size).toBe(3);
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
  });

  test("ordinals climb past a second collision, and stop at the ceiling", () => {
    const files: Record<string, string> = { [ACTIVE]: rec("2026-07-31T23:59:00.000Z") };
    files[SEG_2026_07] = rec("2026-07-01T00:00:00.000Z");
    files[segmentPath("2026-07-2")] = rec("2026-07-02T00:00:00.000Z");
    const deps = fakeFs(files);
    expect(rollIfNeeded(ACTIVE, { roll: true, month: "2026-07", reason: "calendar" }, deps)).toBe(
      segmentPath("2026-07-3")
    );
  });

  test("an ordinal segment is still recognised as belonging to its month", () => {
    // If enumeration could not parse `-2026-07-2`, the ordinal fix would create
    // files that the glob picks up and `listSegmentPaths` ignores — two readers
    // disagreeing about what the corpus is.
    expect(monthOfSegmentPath(ACTIVE, segmentPath("2026-07-2"))).toBe("2026-07");
    const deps = fakeFs({
      [SEG_2026_07]: rec("2026-07-01T00:00:00.000Z"),
      [segmentPath("2026-07-2")]: rec("2026-07-02T00:00:00.000Z"),
    });
    expect(listSegmentPaths(ACTIVE, deps)).toHaveLength(2);
  });

  test("does nothing when the decision says not to roll", () => {
    const deps = fakeFs({ [ACTIVE]: rec("2026-08-01T00:00:00.000Z") });
    expect(rollIfNeeded(ACTIVE, { roll: false, month: "", reason: "none" }, deps)).toBeNull();
    expect(deps.existsSync(ACTIVE)).toBe(true);
  });

  test("a rename failure leaves the active file intact rather than throwing", () => {
    const deps = fakeFs({ [ACTIVE]: rec("2026-07-31T23:59:00.000Z") });
    deps.renameSync = () => {
      throw new Error("EPERM");
    };
    expect(
      rollIfNeeded(ACTIVE, { roll: true, month: "2026-07", reason: "calendar" }, deps)
    ).toBeNull();
    expect(deps.existsSync(ACTIVE)).toBe(true);
  });
});
