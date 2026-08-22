/**
 * Tests for the ask -> conversation attribution store (mt#3564).
 *
 * The retention policy is the part worth testing hardest: `ENTRY_MAX_AGE_MS` is this
 * task's answer to "an ask answered while no conversation is running is not lost", so a
 * silent regression there turns a delivered notice into a dropped one with no error.
 */
/* eslint-disable custom/no-real-fs-in-tests -- this suite exercises the REAL read/write roundtrip of an on-disk store in an isolated mkdtemp dir; a mock fs would test the mock rather than the atomic-write and parse-tolerance behaviour under test. Precedent: ask-routing-deferral-detector.test.ts. */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  coerceMap,
  pruneEntries,
  readAskConversationMap,
  recordAskConversation,
  askIdsForConversation,
  allAttributedAskIds,
  ENTRY_MAX_AGE_MS,
  MAX_ENTRIES,
  type AskConversationEntry,
} from "./ask-conversation-map";

let dir: string;
let mapPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mt3564-map-"));
  mapPath = join(dir, "ask-conversation-map.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const entry = (conversationId: string, recordedAt: string): AskConversationEntry => ({
  conversationId,
  recordedAt,
});

describe("coerceMap", () => {
  test("returns an empty map for every non-map shape", () => {
    for (const bad of [null, undefined, 42, "str", [], { entries: [] }, { entries: 7 }]) {
      expect(coerceMap(bad)).toEqual({ entries: {} });
    }
  });

  test("drops entries missing a conversationId or recordedAt rather than throwing", () => {
    const parsed = {
      entries: {
        good: { conversationId: "conv-1", recordedAt: "2026-08-22T00:00:00.000Z" },
        noConv: { recordedAt: "2026-08-22T00:00:00.000Z" },
        noDate: { conversationId: "conv-2" },
        notObject: "nope",
      },
    };
    expect(Object.keys(coerceMap(parsed).entries)).toEqual(["good"]);
  });

  test("preserves shortId when present and omits it when not", () => {
    const parsed = {
      entries: {
        a: { conversationId: "c", recordedAt: "2026-08-22T00:00:00.000Z", shortId: "ask#1" },
        b: { conversationId: "c", recordedAt: "2026-08-22T00:00:00.000Z", shortId: "" },
      },
    };
    const map = coerceMap(parsed);
    expect(map.entries["a"]?.shortId).toBe("ask#1");
    expect(map.entries["b"]?.shortId).toBeUndefined();
  });
});

describe("pruneEntries", () => {
  const now = Date.parse("2026-08-22T12:00:00.000Z");

  test("keeps an entry inside the retention window", () => {
    const recent = new Date(now - ENTRY_MAX_AGE_MS + 60_000).toISOString();
    const kept = pruneEntries({ a: entry("c", recent) }, now);
    expect(Object.keys(kept)).toEqual(["a"]);
  });

  test("drops an entry past the retention window", () => {
    const old = new Date(now - ENTRY_MAX_AGE_MS - 60_000).toISOString();
    expect(pruneEntries({ a: entry("c", old) }, now)).toEqual({});
  });

  test("retains long enough for the originating incident's ~16h answer latency", () => {
    // ask#6687 was filed at 04:08Z and answered at 20:06Z the same day. A window that
    // could not span that would drop exactly the slow answers this hook exists to
    // deliver, so this asserts the POLICY, not just the arithmetic.
    const sixteenHours = 16 * 60 * 60 * 1000;
    expect(ENTRY_MAX_AGE_MS).toBeGreaterThan(sixteenHours);
  });

  test("drops an entry whose recordedAt does not parse, rather than keeping it forever", () => {
    expect(pruneEntries({ a: entry("c", "not-a-date") }, now)).toEqual({});
  });

  test("caps at MAX_ENTRIES, keeping the newest", () => {
    const entries: Record<string, AskConversationEntry> = {};
    for (let i = 0; i < MAX_ENTRIES + 25; i++) {
      entries[`ask-${i}`] = entry("c", new Date(now - i * 1000).toISOString());
    }
    const kept = pruneEntries(entries, now);
    expect(Object.keys(kept)).toHaveLength(MAX_ENTRIES);
    // ask-0 is newest, ask-(MAX_ENTRIES+24) oldest.
    expect(kept["ask-0"]).toBeDefined();
    expect(kept[`ask-${MAX_ENTRIES + 24}`]).toBeUndefined();
  });
});

describe("readAskConversationMap", () => {
  test("returns an empty map when the file is absent", () => {
    expect(readAskConversationMap(mapPath)).toEqual({ entries: {} });
  });

  test("returns an empty map — not a throw — when the file is unparseable", () => {
    writeFileSync(mapPath, "{ not json");
    expect(readAskConversationMap(mapPath)).toEqual({ entries: {} });
  });
});

describe("recordAskConversation", () => {
  const now = "2026-08-22T12:00:00.000Z";

  test("writes an entry that reads back", () => {
    expect(recordAskConversation("ask-a", entry("conv-1", now), now, mapPath)).toBe(true);
    expect(existsSync(mapPath)).toBe(true);
    expect(readAskConversationMap(mapPath).entries["ask-a"]?.conversationId).toBe("conv-1");
  });

  test("merges rather than replacing, so a second ask does not evict the first", () => {
    recordAskConversation("ask-a", entry("conv-1", now), now, mapPath);
    recordAskConversation("ask-b", entry("conv-2", now), now, mapPath);
    expect(allAttributedAskIds(readAskConversationMap(mapPath)).sort()).toEqual(["ask-a", "ask-b"]);
  });

  test("prunes on write, so the file cannot accumulate expired entries", () => {
    const stale = new Date(Date.parse(now) - ENTRY_MAX_AGE_MS - 1000).toISOString();
    writeFileSync(mapPath, JSON.stringify({ entries: { old: entry("conv-old", stale) } }));
    recordAskConversation("ask-new", entry("conv-1", now), now, mapPath);
    const map = readAskConversationMap(mapPath);
    expect(map.entries["old"]).toBeUndefined();
    expect(map.entries["ask-new"]).toBeDefined();
  });

  test("leaves no temp file behind", () => {
    recordAskConversation("ask-a", entry("conv-1", now), now, mapPath);
    expect(readFileSync(mapPath, "utf-8").endsWith("\n")).toBe(true);
    expect(existsSync(`${mapPath}.tmp-${process.pid}`)).toBe(false);
  });

  test("returns false instead of throwing when the path is unwritable", () => {
    // A directory where the file should be: mkdirSync succeeds, writeFileSync cannot.
    const blocked = join(dir, "blocked");
    require("node:fs").mkdirSync(blocked, { recursive: true });
    expect(recordAskConversation("ask-a", entry("c", now), now, blocked)).toBe(false);
  });
});

describe("askIdsForConversation", () => {
  const now = "2026-08-22T12:00:00.000Z";

  test("returns only the asks belonging to the named conversation", () => {
    const map = {
      entries: {
        a: entry("conv-1", now),
        b: entry("conv-2", now),
        c: entry("conv-1", now),
      },
    };
    expect(askIdsForConversation(map, "conv-1").sort()).toEqual(["a", "c"]);
    expect(askIdsForConversation(map, "conv-2")).toEqual(["b"]);
    expect(askIdsForConversation(map, "conv-absent")).toEqual([]);
  });
});
