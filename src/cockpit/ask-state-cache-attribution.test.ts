/**
 * Tests for the mt#3564 additions to the ask-state cache producer: the second id source
 * (conversation-attributed asks) and the extra fields the injection consumer needs.
 *
 * Kept in its own file rather than appended to `ask-state-cache.test.ts` so the
 * attribution extension's provenance stays legible — the original file covers the
 * calibration-watermark path this one deliberately leaves alone.
 */
/* eslint-disable custom/no-real-fs-in-tests -- this suite exercises the REAL read/write roundtrip of an on-disk store in an isolated mkdtemp dir; a mock fs would test the mock rather than the atomic-write and parse-tolerance behaviour under test. Precedent: ask-routing-deferral-detector.test.ts. */
/* eslint-disable @typescript-eslint/no-non-null-assertion -- asserting on a snapshot the preceding expectation has already proven non-null; the nullable dance obscures what each test checks. */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectAttributedAskIds,
  readAttributedAskIds,
  collectAllTrackedAskIds,
  renderChosen,
  toIsoOrUndefined,
  buildAskStateSnapshot,
  MAX_CHOSEN_CHARS,
  type UnsafeSql,
} from "./ask-state-cache";

const ASK_A = "2422ee3c-7e28-49d0-88f2-bbabbed6c65e";
const ASK_B = "20196753-5d83-4105-9d60-0e0e11c17daf";

let dir: string;
let mapPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mt3564-producer-"));
  mapPath = join(dir, "ask-conversation-map.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("collectAttributedAskIds", () => {
  test("collects uuid keys from the map's entries", () => {
    const parsed = {
      entries: {
        [ASK_A]: { conversationId: "c", recordedAt: "2026-08-22T00:00:00.000Z" },
        [ASK_B]: { conversationId: "c", recordedAt: "2026-08-22T00:00:00.000Z" },
      },
    };
    expect(collectAttributedAskIds(parsed).sort()).toEqual([ASK_B, ASK_A].sort());
  });

  test("drops non-uuid keys, which would fail the ::uuid[] cast for the whole batch", () => {
    const parsed = {
      entries: {
        [ASK_A]: { conversationId: "c", recordedAt: "x" },
        "ask#8014": { conversationId: "c", recordedAt: "x" },
        "": { conversationId: "c", recordedAt: "x" },
      },
    };
    expect(collectAttributedAskIds(parsed)).toEqual([ASK_A]);
  });

  test("returns empty for every malformed shape", () => {
    for (const bad of [null, 42, "x", [], {}, { entries: null }, { entries: [] }]) {
      expect(collectAttributedAskIds(bad)).toEqual([]);
    }
  });
});

describe("readAttributedAskIds", () => {
  test("empty when the map file is absent — the steady state before any ask is filed", () => {
    expect(readAttributedAskIds(mapPath)).toEqual([]);
  });

  test("empty, not a throw, when the map file is unparseable", () => {
    writeFileSync(mapPath, "{{{ not json");
    expect(readAttributedAskIds(mapPath)).toEqual([]);
  });

  test("reads ids from a well-formed map", () => {
    writeFileSync(
      mapPath,
      JSON.stringify({
        entries: { [ASK_A]: { conversationId: "c", recordedAt: "2026-08-22T00:00:00.000Z" } },
      })
    );
    expect(readAttributedAskIds(mapPath)).toEqual([ASK_A]);
  });
});

describe("collectAllTrackedAskIds", () => {
  test("unions both sources and de-duplicates an ask present in each", () => {
    // Watermark store lives at <repoRoot>/.minsky/calibration-review-watermarks.json.
    const repoRoot = join(dir, "repo");
    require("node:fs").mkdirSync(join(repoRoot, ".minsky"), { recursive: true });
    writeFileSync(
      join(repoRoot, ".minsky", "calibration-review-watermarks.json"),
      JSON.stringify({ someLog: { openAskId: ASK_A } })
    );
    writeFileSync(
      mapPath,
      JSON.stringify({
        entries: {
          [ASK_A]: { conversationId: "c", recordedAt: "x" },
          [ASK_B]: { conversationId: "c", recordedAt: "x" },
        },
      })
    );

    const ids = collectAllTrackedAskIds(repoRoot, mapPath);
    expect(ids.sort()).toEqual([ASK_A, ASK_B].sort());
    expect(ids.filter((id) => id === ASK_A)).toHaveLength(1);
  });
});

describe("renderChosen", () => {
  test("passes a string payload through", () => {
    expect(renderChosen("approve")).toBe("approve");
  });

  test("stringifies a structured payload", () => {
    expect(renderChosen({ value: "approve" })).toBe('{"value":"approve"}');
  });

  test("returns undefined for null/undefined, so the field is omitted rather than 'null'", () => {
    expect(renderChosen(null)).toBeUndefined();
    expect(renderChosen(undefined)).toBeUndefined();
  });

  test("truncates past MAX_CHOSEN_CHARS so one answer cannot dominate the injection", () => {
    const rendered = renderChosen("x".repeat(1000))!;
    expect(rendered.length).toBe(MAX_CHOSEN_CHARS + 1); // + the ellipsis
    expect(rendered.endsWith("…")).toBe(true);
  });
});

describe("toIsoOrUndefined", () => {
  test("normalizes a Date, which is what postgres-js returns for timestamptz", () => {
    expect(toIsoOrUndefined(new Date("2026-08-22T12:00:00.000Z"))).toBe("2026-08-22T12:00:00.000Z");
  });

  test("normalizes a string, which is what the test stub returns", () => {
    expect(toIsoOrUndefined("2026-08-22T12:00:00Z")).toBe("2026-08-22T12:00:00.000Z");
  });

  test("returns undefined for null, empty, unparseable, and an invalid Date", () => {
    expect(toIsoOrUndefined(null)).toBeUndefined();
    expect(toIsoOrUndefined("")).toBeUndefined();
    expect(toIsoOrUndefined("nope")).toBeUndefined();
    expect(toIsoOrUndefined(new Date("nope"))).toBeUndefined();
  });
});

describe("buildAskStateSnapshot carries the consumer's fields", () => {
  const sqlReturning = (rows: Array<Record<string, unknown>>): UnsafeSql => ({
    unsafe: async () => rows,
  });

  test("maps title, respondedAt and chosen onto a found entry", async () => {
    const snapshot = await buildAskStateSnapshot(
      sqlReturning([
        {
          id: ASK_A,
          state: "responded",
          short_id: "ask#8014",
          title: "Pick a merge policy",
          responded_at: "2026-08-22T12:00:00Z",
          response: { responder: "operator", payload: "approve" },
        },
      ]),
      [ASK_A]
    );

    expect(snapshot![ASK_A]).toEqual({
      found: true,
      state: "responded",
      open: false,
      shortId: "ask#8014",
      title: "Pick a merge policy",
      respondedAt: "2026-08-22T12:00:00.000Z",
      chosen: "approve",
    });
  });

  test("omits the new fields when the row carries none, rather than writing nulls", async () => {
    const snapshot = await buildAskStateSnapshot(
      sqlReturning([{ id: ASK_A, state: "suspended", short_id: null, response: null }]),
      [ASK_A]
    );
    expect(snapshot![ASK_A]).toEqual({ found: true, state: "suspended", open: true });
  });

  test("still seeds a requested-but-absent ask as not-found", async () => {
    const snapshot = await buildAskStateSnapshot(sqlReturning([]), [ASK_A]);
    expect(snapshot![ASK_A]).toEqual({ found: false });
  });
});
