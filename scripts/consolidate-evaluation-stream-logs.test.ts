/* eslint-disable custom/no-real-fs-in-tests -- the --execute path's behavior IS
   filesystem effects (backup written, merged log written, stray files removed,
   second run a no-op). An injected fs would move the assertions off the
   property under test. Uses mkdtemp scratch dirs only. */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mergeStreamLines,
  timestampOf,
  parseArgs,
  consolidateStreams,
} from "./consolidate-evaluation-stream-logs";

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

// ---------------------------------------------------------------------------
// End-to-end --execute (mt#3745 AT4)
// ---------------------------------------------------------------------------

const STREAM = "silent-stretch";
const STREAM_FILE = `${STREAM}-evaluations.jsonl`;

interface Tree {
  repoRoot: string;
  sessionsRoot: string;
  repoLog: string;
  strayLogs: string[];
  cleanup: () => void;
}

/** A repo log with one record, plus two session workspaces holding one stray each. */
function makeTree(): Tree {
  const repoRoot = mkdtempSync(join(tmpdir(), "mt3745-e2e-repo-"));
  const sessionsRoot = mkdtempSync(join(tmpdir(), "mt3745-e2e-sessions-"));

  mkdirSync(join(repoRoot, ".minsky"), { recursive: true });
  const repoLog = join(repoRoot, ".minsky", STREAM_FILE);
  writeFileSync(repoLog, `${rec("2026-08-02T00:00:00Z")}\n`, "utf-8");

  const strayLogs: string[] = [];
  for (const [id, ts] of [
    ["sess-a", "2026-08-01T00:00:00Z"],
    ["sess-b", "2026-08-03T00:00:00Z"],
  ] as const) {
    const dir = join(sessionsRoot, id, ".minsky");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, STREAM_FILE);
    writeFileSync(p, `${rec(ts)}\n`, "utf-8");
    strayLogs.push(p);
  }

  return {
    repoRoot,
    sessionsRoot,
    repoLog,
    strayLogs,
    cleanup: () => {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(sessionsRoot, { recursive: true, force: true });
    },
  };
}

function resultFor(results: ReturnType<typeof consolidateStreams>, name: string) {
  const r = results.find((x) => x.streamName === name);
  if (!r) throw new Error(`no result for ${name}`);
  return r;
}

describe("consolidateStreams --execute (mt#3745 AT4)", () => {
  test("dry run reports the counts and mutates nothing", () => {
    const tree = makeTree();
    try {
      const before = readFileSync(tree.repoLog, "utf-8");

      const r = resultFor(
        consolidateStreams({
          repoRoot: tree.repoRoot,
          sessionsRoot: tree.sessionsRoot,
          execute: false,
        }),
        STREAM
      );

      expect(r.repoRecords).toBe(1);
      expect(r.strayFiles).toBe(2);
      expect(r.recovered).toBe(2);
      expect(r.afterMerge).toBe(3);

      // Nothing moved: the repo log is byte-identical and both strays survive.
      expect(readFileSync(tree.repoLog, "utf-8")).toBe(before);
      for (const p of tree.strayLogs) expect(existsSync(p)).toBe(true);
      expect(existsSync(`${tree.repoLog}.bak`)).toBe(false);
    } finally {
      tree.cleanup();
    }
  });

  test("--execute backs up, writes the merge sorted, and removes the strays", () => {
    const tree = makeTree();
    try {
      consolidateStreams({
        repoRoot: tree.repoRoot,
        sessionsRoot: tree.sessionsRoot,
        execute: true,
      });

      // Backup holds the pre-merge content.
      expect(existsSync(`${tree.repoLog}.bak`)).toBe(true);
      expect(readFileSync(`${tree.repoLog}.bak`, "utf-8").trim().split("\n")).toHaveLength(1);

      // Merged, sorted by timestamp.
      const lines = readFileSync(tree.repoLog, "utf-8").trim().split("\n");
      expect(lines).toHaveLength(3);
      expect(lines.map(timestampOf)).toEqual([
        "2026-08-01T00:00:00Z",
        "2026-08-02T00:00:00Z",
        "2026-08-03T00:00:00Z",
      ]);

      // AT6's property in miniature: no stray file left behind.
      for (const p of tree.strayLogs) expect(existsSync(p)).toBe(false);
    } finally {
      tree.cleanup();
    }
  });

  test("a second --execute is a no-op — the idempotency the recovery relies on", () => {
    const tree = makeTree();
    try {
      consolidateStreams({
        repoRoot: tree.repoRoot,
        sessionsRoot: tree.sessionsRoot,
        execute: true,
      });
      const afterFirst = readFileSync(tree.repoLog, "utf-8");

      const r = resultFor(
        consolidateStreams({
          repoRoot: tree.repoRoot,
          sessionsRoot: tree.sessionsRoot,
          execute: true,
        }),
        STREAM
      );

      expect(r.strayFiles).toBe(0);
      expect(r.recovered).toBe(0);
      expect(readFileSync(tree.repoLog, "utf-8")).toBe(afterFirst);
    } finally {
      tree.cleanup();
    }
  });

  test("--limit bounds how many stray files are taken in one pass", () => {
    const tree = makeTree();
    try {
      const r = resultFor(
        consolidateStreams({
          repoRoot: tree.repoRoot,
          sessionsRoot: tree.sessionsRoot,
          execute: false,
          limit: 1,
        }),
        STREAM
      );
      expect(r.strayFiles).toBe(1);
      expect(r.recovered).toBe(1);
    } finally {
      tree.cleanup();
    }
  });

  test("a stream with no strays is left completely alone", () => {
    const tree = makeTree();
    try {
      const r = resultFor(
        consolidateStreams({
          repoRoot: tree.repoRoot,
          sessionsRoot: tree.sessionsRoot,
          execute: true,
        }),
        "stop-at-decision"
      );
      expect(r.strayFiles).toBe(0);
      expect(r.afterMerge).toBe(0);
      expect(existsSync(join(tree.repoRoot, ".minsky", "stop-at-decision-evaluations.jsonl"))).toBe(
        false
      );
    } finally {
      tree.cleanup();
    }
  });
});
