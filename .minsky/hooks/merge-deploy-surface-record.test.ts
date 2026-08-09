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
