/* eslint-disable custom/no-real-fs-in-tests -- testing real fs I/O (atomic cache write + read-back) IS the contract here; matches prod-state-cache.test.ts */
/**
 * Producer-half tests for the short-id -> UUID map cache (mt#3914).
 *
 * The `sql` surface is INJECTED rather than patched: `buildShortIdEntries` takes
 * it as a parameter, so observing a failed family or a malformed row needs no
 * module spy (`testing-standards.mdc §Testable Design`).
 */
import { describe, test, expect, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  buildShortIdEntries,
  refreshShortIdMapCache,
  shortIdNumericPart,
  writeShortIdMapCache,
  type ShortIdMapRecord,
  type UnsafeSql,
} from "./short-id-map-cache";

const ASK_UUID = "b3a3da5f-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const MEM_UUID = "1aa78e4a-5148-461c-b3a0-e7bba039d704";
const WS_UUID = "525dae4d-fd35-48fb-ad5a-d899865a9cb5";

const tempDirs: string[] = [];

function tempCachePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "short-id-map-"));
  tempDirs.push(dir);
  return path.join(dir, "short-id-map.json");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A stub whose response depends on which table the query names.
 *
 * Rows are keyed by `uuid` because that is the ALIAS the producer selects — the
 * UUID column differs per family (`sessions` has no `id`), so the stub models
 * the aliased shape rather than the raw column. An earlier version returned
 * `{short_id, id}` and therefore could not have caught a wrong column name;
 * `emits the per-family UUID column` below pins that directly.
 */
function stubSql(
  byTable: Record<string, Array<Record<string, unknown>> | Error>
): UnsafeSql & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    unsafe: async (query: string) => {
      queries.push(query);
      const table = Object.keys(byTable).find((t) => query.includes(` public.${t} `));
      const result = table ? byTable[table] : undefined;
      if (result instanceof Error) throw result;
      return result ?? [];
    },
  };
}

describe("shortIdNumericPart", () => {
  test("strips the prefix from a stored short id", () => {
    expect(shortIdNumericPart("ask#7415")).toBe("7415");
    expect(shortIdNumericPart("mem#623")).toBe("623");
    expect(shortIdNumericPart("  ws#12  ")).toBe("12");
  });

  test("returns null for anything that is not <letters>#<digits>", () => {
    expect(shortIdNumericPart("7415")).toBeNull();
    expect(shortIdNumericPart("ask#")).toBeNull();
    expect(shortIdNumericPart("ask#12a")).toBeNull();
    expect(shortIdNumericPart(null)).toBeNull();
    expect(shortIdNumericPart(42)).toBeNull();
  });
});

describe("buildShortIdEntries", () => {
  test("keys each family by the numeric part and maps to the UUID", async () => {
    const sql = stubSql({
      asks: [{ short_id: "ask#6891", uuid: ASK_UUID }],
      memories: [{ short_id: "mem#623", uuid: MEM_UUID }],
      sessions: [{ short_id: "ws#12", uuid: WS_UUID }],
    });
    expect(await buildShortIdEntries(sql)).toEqual({
      ask: { "6891": ASK_UUID },
      memory: { "623": MEM_UUID },
      session: { "12": WS_UUID },
    });
  });

  test("skips rows with a malformed short id or a missing uuid", async () => {
    const sql = stubSql({
      asks: [
        { short_id: "ask#1", uuid: ASK_UUID },
        { short_id: "garbage", uuid: ASK_UUID },
        { short_id: "ask#2", uuid: null },
        { short_id: "ask#3", uuid: "" },
      ],
    });
    const entries = await buildShortIdEntries(sql);
    expect(entries?.ask).toEqual({ "1": ASK_UUID });
  });

  test("one failing family does not cost the others", async () => {
    const sql = stubSql({
      asks: new Error("relation does not exist"),
      memories: [{ short_id: "mem#623", uuid: MEM_UUID }],
    });
    const entries = await buildShortIdEntries(sql);
    expect(entries?.memory).toEqual({ "623": MEM_UUID });
    expect(entries?.ask).toBeUndefined();
  });

  test("emits the per-family UUID column, schema-qualified", async () => {
    // Regression for the defect the live check found (and the stub tests could
    // not): `public.sessions` has no `id` column — its UUID is `session` — and
    // an UNQUALIFIED `sessions` also matches Supabase's `auth.sessions`, which
    // does have an `id`, so the wrong table can be read without erroring.
    const sql = stubSql({});
    await buildShortIdEntries(sql);

    expect(sql.queries).toHaveLength(3);
    expect(sql.queries[0]).toContain("SELECT short_id, id AS uuid FROM public.asks ");
    expect(sql.queries[1]).toContain("SELECT short_id, id AS uuid FROM public.memories ");
    expect(sql.queries[2]).toContain("SELECT short_id, session AS uuid FROM public.sessions ");
    for (const query of sql.queries) expect(query).not.toMatch(/FROM (?!public\.)/);
  });

  test("returns null when EVERY family fails, so the caller leaves the last-good map alone", async () => {
    const sql = stubSql({
      asks: new Error("down"),
      memories: new Error("down"),
      sessions: new Error("down"),
    });
    expect(await buildShortIdEntries(sql)).toBeNull();
  });
});

describe("writeShortIdMapCache / refreshShortIdMapCache", () => {
  test("writes a record carrying refreshedAt and one key per family", async () => {
    const cachePath = tempCachePath();
    const sql = stubSql({
      asks: [{ short_id: "ask#6891", uuid: ASK_UUID }],
      memories: [{ short_id: "mem#623", uuid: MEM_UUID }],
      sessions: [{ short_id: "ws#12", uuid: WS_UUID }],
    });

    expect(await refreshShortIdMapCache(sql, 1_754_848_800_000, cachePath)).toBe(true);

    const record = JSON.parse(String(fs.readFileSync(cachePath, "utf8"))) as ShortIdMapRecord;
    expect(record.refreshedAt).toBe(1_754_848_800_000);
    expect(record.entries.ask?.["6891"]).toBe(ASK_UUID);
    expect(record.entries.memory?.["623"]).toBe(MEM_UUID);
    expect(record.entries.session?.["12"]).toBe(WS_UUID);
  });

  test("a null sql connection leaves an existing cache untouched", async () => {
    const cachePath = tempCachePath();
    writeShortIdMapCache({ ask: { "1": ASK_UUID } }, 1, cachePath);

    expect(await refreshShortIdMapCache(null, 2, cachePath)).toBe(false);

    const record = JSON.parse(String(fs.readFileSync(cachePath, "utf8"))) as ShortIdMapRecord;
    expect(record.refreshedAt).toBe(1);
    expect(record.entries.ask?.["1"]).toBe(ASK_UUID);
  });

  test("a fully-failed read leaves an existing cache untouched", async () => {
    const cachePath = tempCachePath();
    writeShortIdMapCache({ ask: { "1": ASK_UUID } }, 1, cachePath);
    const sql = stubSql({
      asks: new Error("down"),
      memories: new Error("down"),
      sessions: new Error("down"),
    });

    expect(await refreshShortIdMapCache(sql, 2, cachePath)).toBe(false);

    const record = JSON.parse(String(fs.readFileSync(cachePath, "utf8"))) as ShortIdMapRecord;
    expect(record.refreshedAt).toBe(1);
  });
});
