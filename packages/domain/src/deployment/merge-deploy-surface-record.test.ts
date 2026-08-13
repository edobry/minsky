#!/usr/bin/env bun
/**
 * Unit tests for merge-deploy-surface-record.ts (mt#3819).
 *
 * The round-trip matters as much as the pure helpers: this record is the only
 * thing carrying the merge-time deploy-surface verdict across to the per-turn
 * detector, and both sides fail OPEN, so a silently-broken write or read looks
 * exactly like "this PR touched no deploy surface".
 */

import { describe, test, expect } from "bun:test";
import {
  MAX_RECORDS,
  lookupMergeDeploySurface,
  parseStore,
  readStore,
  classifyAndRecordMergeDeploySurface,
  recordMergeDeploySurface,
  trimStore,
  type MergeDeploySurfaceRecord,
  type MergeDeploySurfaceStore,
  type RecordFs,
} from "./merge-deploy-surface-record";

const RECORD_PATH = "/state/minsky/merge-deploy-surface.json";

/** In-memory {@link RecordFs}; `failWrites` reproduces an unwritable target. */
function makeFs(
  seed: Record<string, string> = {},
  opts: { failWrites?: boolean } = {}
): RecordFs & { files: Record<string, string>; dirs: Set<string> } {
  const files: Record<string, string> = { ...seed };
  const dirs = new Set<string>();
  return {
    files,
    dirs,
    exists: (p) => p in files || dirs.has(p),
    readFile: (p) => {
      const hit = files[p];
      if (hit === undefined) throw new Error(`ENOENT: ${p}`);
      return hit;
    },
    writeFile: (p, c) => {
      if (opts.failWrites) throw new Error(`EACCES: ${p}`);
      files[p] = c;
    },
    mkdirp: (p) => {
      dirs.add(p);
    },
  };
}

function record(over: Partial<MergeDeploySurfaceRecord> = {}): MergeDeploySurfaceRecord {
  return {
    hadDeploySurface: true,
    deploySurfaceFiles: ["services/reviewer/Dockerfile"],
    recordedAt: "2026-08-08T00:00:00.000Z",
    ...over,
  };
}

describe("parseStore", () => {
  test("round-trips a well-formed store", () => {
    const store: MergeDeploySurfaceStore = { "mt#1": record() };
    expect(parseStore(JSON.stringify(store))).toEqual(store);
  });

  test("returns an empty store for malformed JSON rather than throwing", () => {
    expect(parseStore("{not json")).toEqual({});
  });

  test("returns an empty store for a JSON array", () => {
    expect(parseStore("[1,2,3]")).toEqual({});
  });

  test("drops entries missing hadDeploySurface or recordedAt", () => {
    const raw = JSON.stringify({
      good: record(),
      noFlag: { deploySurfaceFiles: [], recordedAt: "2026-08-08T00:00:00.000Z" },
      noStamp: { hadDeploySurface: true, deploySurfaceFiles: [] },
    });
    expect(Object.keys(parseStore(raw))).toEqual(["good"]);
  });

  test("coerces a non-array deploySurfaceFiles to an empty list", () => {
    const raw = JSON.stringify({
      k: {
        hadDeploySurface: false,
        deploySurfaceFiles: "nope",
        recordedAt: "2026-08-08T00:00:00.000Z",
      },
    });
    expect(parseStore(raw).k?.deploySurfaceFiles).toEqual([]);
  });
});

describe("trimStore", () => {
  test("keeps the store untouched when under the cap", () => {
    const store: MergeDeploySurfaceStore = { a: record(), b: record() };
    expect(trimStore(store, 5)).toEqual(store);
  });

  test("keeps the newest entries and drops the oldest", () => {
    const store: MergeDeploySurfaceStore = {
      old: record({ recordedAt: "2026-01-01T00:00:00.000Z" }),
      mid: record({ recordedAt: "2026-06-01T00:00:00.000Z" }),
      new: record({ recordedAt: "2026-08-01T00:00:00.000Z" }),
    };
    expect(Object.keys(trimStore(store, 2)).sort()).toEqual(["mid", "new"]);
  });

  test("MAX_RECORDS bounds the file so it cannot grow without limit", () => {
    const store: MergeDeploySurfaceStore = {};
    for (let i = 0; i < MAX_RECORDS + 25; i++) {
      store[`mt#${i}`] = record({
        recordedAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
      });
    }
    expect(Object.keys(trimStore(store)).length).toBe(MAX_RECORDS);
  });
});

describe("lookupMergeDeploySurface", () => {
  test("matches whichever candidate key is present", () => {
    const store: MergeDeploySurfaceStore = { "mt#3819": record() };
    // The merge may have been invoked by sessionId; the task id is the key.
    const found = lookupMergeDeploySurface(["some-session-uuid", "mt#3819"], store);
    expect(found?.deploySurfaceFiles).toEqual(["services/reviewer/Dockerfile"]);
  });

  test("returns null (UNKNOWN) when no candidate matches", () => {
    expect(lookupMergeDeploySurface(["mt#9999"], { "mt#1": record() })).toBeNull();
  });

  test("returns null on an empty candidate list", () => {
    expect(lookupMergeDeploySurface([], { "mt#1": record() })).toBeNull();
  });
});

describe("readStore / recordMergeDeploySurface round-trip", () => {
  test("a recorded verdict reads back identically", () => {
    const fs = makeFs();
    const rec = record();
    expect(recordMergeDeploySurface("mt#3819", rec, RECORD_PATH, fs)).toBe(true);
    expect(readStore(RECORD_PATH, fs)["mt#3819"]).toEqual(rec);
  });

  test("records a NEGATIVE verdict distinguishably from an absent one", () => {
    const fs = makeFs();
    recordMergeDeploySurface(
      "mt#3819",
      record({ hadDeploySurface: false, deploySurfaceFiles: [] }),
      RECORD_PATH,
      fs
    );

    const store = readStore(RECORD_PATH, fs);
    expect(store["mt#3819"]?.hadDeploySurface).toBe(false);
    // The distinction the consumer depends on: a recorded "no surface" is a
    // verdict, while a missing key is UNKNOWN and must fall back.
    expect(lookupMergeDeploySurface(["mt#3819"], store)).not.toBeNull();
    expect(lookupMergeDeploySurface(["mt#0000"], store)).toBeNull();
  });

  test("a second merge does not clobber the first", () => {
    const fs = makeFs();
    recordMergeDeploySurface(
      "mt#1",
      record({ deploySurfaceFiles: ["Dockerfile"] }),
      RECORD_PATH,
      fs
    );
    recordMergeDeploySurface(
      "mt#2",
      record({ deploySurfaceFiles: ["infra/index.ts"] }),
      RECORD_PATH,
      fs
    );

    const store = readStore(RECORD_PATH, fs);
    expect(store["mt#1"]?.deploySurfaceFiles).toEqual(["Dockerfile"]);
    expect(store["mt#2"]?.deploySurfaceFiles).toEqual(["infra/index.ts"]);
  });

  test("readStore returns an empty store when the file is absent", () => {
    expect(readStore(RECORD_PATH, makeFs())).toEqual({});
  });

  test("readStore fails OPEN on corrupt content rather than throwing", () => {
    expect(readStore(RECORD_PATH, makeFs({ [RECORD_PATH]: "{corrupt" }))).toEqual({});
  });

  test("an empty key is refused — it would collide with every lookup miss", () => {
    expect(recordMergeDeploySurface("", record(), RECORD_PATH, makeFs())).toBe(false);
  });

  test("an unwritable target returns false instead of throwing (the gate must not break)", () => {
    const fs = makeFs({}, { failWrites: true });
    expect(recordMergeDeploySurface("mt#1", record(), RECORD_PATH, fs)).toBe(false);
  });
});

describe("trimStore tie-breaking (PR #2734 R1)", () => {
  test("identical timestamps resolve deterministically by key, not by insertion order", () => {
    const stamp = "2026-08-08T00:00:00.000Z";
    const build = (keys: string[]): MergeDeploySurfaceStore =>
      Object.fromEntries(keys.map((k) => [k, record({ recordedAt: stamp })]));

    // Same three keys, two different insertion orders — one merge writes its
    // resolved task id and its raw ids with the SAME recordedAt.
    const a = trimStore(build(["aaa", "bbb", "ccc"]), 2);
    const b = trimStore(build(["ccc", "bbb", "aaa"]), 2);

    expect(Object.keys(a)).toEqual(Object.keys(b));
  });

  test("an unparseable timestamp sorts last instead of throwing", () => {
    const store: MergeDeploySurfaceStore = {
      good: record({ recordedAt: "2026-08-08T00:00:00.000Z" }),
      bad: record({ recordedAt: "not-a-date" }),
    };
    expect(Object.keys(trimStore(store, 1))).toEqual(["good"]);
  });
});

describe("classifyAndRecordMergeDeploySurface (mt#4089)", () => {
  test("classifies a deploy-surface PR and writes one entry per key", () => {
    const fs = makeFs();
    const record = classifyAndRecordMergeDeploySurface(
      [{ filename: "src/mcp/tools/example.ts" }, { filename: "README.md" }],
      ["mt#123", "sess-uuid"],
      RECORD_PATH,
      fs
    );

    expect(record?.hadDeploySurface).toBe(true);
    expect(record?.deploySurfaceFiles).toEqual(["src/mcp/tools/example.ts"]);

    // The same verdict under every key, so the consumer finds it whichever id it saw.
    const store = parseStore(fs.files[RECORD_PATH] ?? "");
    expect(Object.keys(store).sort()).toEqual(["mt#123", "sess-uuid"]);
    expect(store["mt#123"]).toEqual(store["sess-uuid"] as MergeDeploySurfaceRecord);
  });

  test("records a NEGATIVE verdict rather than writing nothing", () => {
    // The absent-record case means UNKNOWN to the consumer and degrades it to the
    // pre-mt#3819 proxy. A docs-only merge must therefore still write, as `false`.
    const fs = makeFs();
    const record = classifyAndRecordMergeDeploySurface(
      [{ filename: "docs/architecture/hooks/some-hook.md" }],
      ["mt#456"],
      RECORD_PATH,
      fs
    );

    expect(record?.hadDeploySurface).toBe(false);
    expect(record?.deploySurfaceFiles).toEqual([]);
    expect(parseStore(fs.files[RECORD_PATH] ?? "")["mt#456"]?.hadDeploySurface).toBe(false);
  });

  test("counts a file renamed OUT of a deploy surface via previous_filename", () => {
    const fs = makeFs();
    const record = classifyAndRecordMergeDeploySurface(
      [{ filename: "scripts/moved.ts", previous_filename: "src/moved.ts" }],
      ["mt#789"],
      RECORD_PATH,
      fs
    );

    expect(record?.hadDeploySurface).toBe(true);
    expect(record?.deploySurfaceFiles).toEqual(["scripts/moved.ts"]);
  });

  test("never throws when the store is unwritable — the merge already happened", () => {
    const fs = makeFs({}, { failWrites: true });
    let result: unknown = "not-set";
    expect(() => {
      result = classifyAndRecordMergeDeploySurface(
        [{ filename: "src/mcp/tools/example.ts" }],
        ["mt#123"],
        RECORD_PATH,
        fs
      );
    }).not.toThrow();
    expect(result).toBeNull();
  });

  test("an empty key set writes nothing and reports it", () => {
    const fs = makeFs();
    expect(
      classifyAndRecordMergeDeploySurface([{ filename: "src/a.ts" }], [], RECORD_PATH, fs)
    ).toBeNull();
    expect(fs.files[RECORD_PATH]).toBeUndefined();
  });
});
