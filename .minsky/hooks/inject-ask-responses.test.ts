/**
 * Tests for the answered-ask injection hook (mt#3564).
 *
 * The two behaviours worth guarding hardest are the ones whose failure is SILENT:
 * fire-once (SC3 — a single response must not re-inject every turn) and the render
 * bound (SC7 — the merged injection block drops over-budget fragments by priority, so
 * an unbounded render can drop this very notice and reproduce the gap it closes).
 */
/* eslint-disable custom/no-real-fs-in-tests -- this file exercises the REAL two-file
   join the hook performs in production (attribution map + ask-state cache, both written
   by separate module graphs) in an isolated mkdtemp dir. Injecting a mock fs would test
   the mock: the defect class this guards against is precisely a hook reading a file
   shape production never writes (mt#3182). Mirrors the precedent in
   ask-routing-deferral-detector.test.ts and canary-runner.test.ts. */
/* eslint-disable @typescript-eslint/no-non-null-assertion -- asserting on a render that
   the preceding expectation has already proven non-null; the alternative is a nullable
   dance that obscures what each test is checking. */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  selectSettledAsks,
  formatAskResponses,
  coerceCacheRecord,
  readInjectionWatermark,
  writeInjectionWatermark,
  isOverridden,
  run,
  MAX_ENUMERATED_ASKS,
  MAX_TITLE_CHARS,
  type AskStateCacheRecord,
  type SettledAsk,
} from "./inject-ask-responses";
import { recordAskConversation } from "./ask-conversation-map";
import type { ClaudeHookInput } from "./types";

const CONVERSATION_ID = "c8fc3ca9-c3d6-4916-bbfe-99917f4ae596";
const ASK_A = "2422ee3c-7e28-49d0-88f2-bbabbed6c65e";
const NOW = "2026-08-22T12:00:00.000Z";
const STATE_DIR_ENV = "MINSKY_STATE_DIR";
const MAP_FILE = "ask-conversation-map.json";
const ASK_TITLE = "Pick a merge policy";

let dir: string;
const originalStateDir = process.env[STATE_DIR_ENV];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mt3564-inject-"));
  process.env[STATE_DIR_ENV] = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (originalStateDir === undefined) delete process.env[STATE_DIR_ENV];
  else process.env[STATE_DIR_ENV] = originalStateDir;
});

const cache = (asks: AskStateCacheRecord["asks"]): AskStateCacheRecord => ({
  checkedAt: NOW,
  asks,
});

describe("coerceCacheRecord", () => {
  test("returns null for every shape that is not a cache record", () => {
    for (const bad of [null, 42, "x", [], {}, { checkedAt: 1, asks: {} }, { checkedAt: NOW }]) {
      expect(coerceCacheRecord(bad)).toBeNull();
    }
  });

  test("accepts a well-formed record", () => {
    expect(coerceCacheRecord({ checkedAt: NOW, asks: {} })).toEqual({ checkedAt: NOW, asks: {} });
  });
});

describe("selectSettledAsks", () => {
  test("selects an answered ask", () => {
    const settled = selectSettledAsks(
      [ASK_A],
      cache({ [ASK_A]: { found: true, state: "responded", open: false, respondedAt: NOW } }),
      {}
    );
    expect(settled).toHaveLength(1);
    expect(settled[0]?.answered).toBe(true);
  });

  test("skips an ask that is still open — the operator still owes a response", () => {
    for (const state of ["routed", "suspended"]) {
      const settled = selectSettledAsks(
        [ASK_A],
        cache({ [ASK_A]: { found: true, state, open: true } }),
        {}
      );
      expect(settled).toEqual([]);
    }
  });

  test("distinguishes a settled-without-response ask from an answered one", () => {
    // `closed`/`cancelled` debris is worth telling the agent about — it is no longer
    // awaiting the principal — but calling it ANSWERED would be a false claim.
    const settled = selectSettledAsks(
      [ASK_A],
      cache({ [ASK_A]: { found: true, state: "cancelled", open: false } }),
      {}
    );
    expect(settled).toHaveLength(1);
    expect(settled[0]?.answered).toBe(false);
  });

  test("skips an ask absent from the snapshot — never looked up is not settled", () => {
    expect(selectSettledAsks([ASK_A], cache({}), {})).toEqual([]);
  });

  test("skips a looked-up-but-not-found ask", () => {
    expect(selectSettledAsks([ASK_A], cache({ [ASK_A]: { found: false } }), {})).toEqual([]);
  });

  test("returns nothing when there is no cache at all", () => {
    expect(selectSettledAsks([ASK_A], null, {})).toEqual([]);
  });

  test("FIRE-ONCE: skips an ask whose current marker was already injected", () => {
    const entry = { found: true as const, state: "responded", open: false, respondedAt: NOW };
    const first = selectSettledAsks([ASK_A], cache({ [ASK_A]: entry }), {});
    expect(first).toHaveLength(1);

    const watermark = { [ASK_A]: first[0]!.marker };
    expect(selectSettledAsks([ASK_A], cache({ [ASK_A]: entry }), watermark)).toEqual([]);
  });

  test("RE-FIRES when the ask is re-answered, because the marker changed", () => {
    const before = { found: true as const, state: "responded", open: false, respondedAt: NOW };
    const firstMarker = selectSettledAsks([ASK_A], cache({ [ASK_A]: before }), {})[0]!.marker;

    const after = { ...before, respondedAt: "2026-08-23T09:00:00.000Z", chosen: "new answer" };
    const second = selectSettledAsks([ASK_A], cache({ [ASK_A]: after }), { [ASK_A]: firstMarker });
    expect(second).toHaveLength(1);
  });

  test("falls back to the map's shortId when the snapshot lacks one", () => {
    const settled = selectSettledAsks(
      [ASK_A],
      cache({ [ASK_A]: { found: true, state: "responded", open: false } }),
      {},
      { [ASK_A]: "ask#8014" }
    );
    expect(settled[0]?.shortId).toBe("ask#8014");
  });
});

describe("formatAskResponses", () => {
  const settled = (over: Partial<SettledAsk> = {}): SettledAsk => ({
    askId: ASK_A,
    state: "responded",
    answered: true,
    marker: "m",
    ...over,
  });

  test("returns null when nothing settled — the hook stays silent", () => {
    expect(formatAskResponses([])).toBeNull();
  });

  test("names the ask, that it was answered, and what was chosen", () => {
    const text = formatAskResponses([
      settled({ shortId: "ask#8014", title: ASK_TITLE, chosen: "approve" }),
    ]);
    expect(text).toContain("ask#8014");
    expect(text).toContain(ASK_TITLE);
    expect(text).toContain("ANSWERED");
    expect(text).toContain("approve");
  });

  test("does not claim ANSWERED for an ask that merely went terminal", () => {
    const text = formatAskResponses([settled({ answered: false, state: "cancelled" })]);
    expect(text).not.toContain("ANSWERED");
    expect(text).toContain("cancelled");
  });

  test("elides past MAX_ENUMERATED_ASKS rather than growing with the backlog", () => {
    const many = Array.from({ length: MAX_ENUMERATED_ASKS + 4 }, (_, i) =>
      settled({ askId: `ask-${i}`, shortId: `ask#${i}` })
    );
    const text = formatAskResponses(many)!;
    expect(text).toContain("and 4 more");
    expect(text).toContain(`ask#${MAX_ENUMERATED_ASKS - 1}`);
    expect(text).not.toContain(`ask#${MAX_ENUMERATED_ASKS}`);
  });

  test("truncates a long title", () => {
    const text = formatAskResponses([settled({ title: "T".repeat(500) })])!;
    expect(text).not.toContain("T".repeat(MAX_TITLE_CHARS + 1));
  });

  test("STRUCTURAL BOUND: the saturated worst case stays under the declared 590", () => {
    // The registry annotation declares 590 precisely so this guard stays out of the
    // top-five bucket MERGED_CONTEXT_BUDGET_CHARS is summed from. If this assertion
    // fails, that constant in dispatcher.ts must be re-derived — the render is not
    // free to grow past it.
    const saturated = Array.from({ length: 99 }, (_, i) =>
      settled({
        askId: `00000000-0000-4000-8000-00000000${String(i).padStart(4, "0")}`,
        shortId: "ask#999999",
        title: "T".repeat(MAX_TITLE_CHARS + 40),
        chosen: "C".repeat(140),
      })
    );
    expect(formatAskResponses(saturated)!.length).toBeLessThanOrEqual(590);
  });
});

describe("watermark persistence", () => {
  test("round-trips markers", () => {
    const p = join(dir, "wm.json");
    expect(writeInjectionWatermark({ [ASK_A]: "marker-1" }, p)).toBe(true);
    expect(readInjectionWatermark(p)).toEqual({ [ASK_A]: "marker-1" });
  });

  test("reads an empty object for an absent or malformed file", () => {
    expect(readInjectionWatermark(join(dir, "absent.json"))).toEqual({});
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{{{");
    expect(readInjectionWatermark(bad)).toEqual({});
  });
});

describe("isOverridden", () => {
  test("recognizes the guard name and the wildcard", () => {
    expect(isOverridden({})).toBe(false);
    expect(isOverridden({ MINSKY_HOOK_OVERRIDE: "inject-ask-responses" })).toBe(true);
    expect(isOverridden({ MINSKY_HOOK_OVERRIDE: "all" })).toBe(true);
    expect(isOverridden({ MINSKY_HOOK_OVERRIDE: "other" })).toBe(false);
  });
});

describe("run (end to end over the two real files)", () => {
  const input = (over: Partial<ClaudeHookInput> = {}): ClaudeHookInput =>
    ({
      hook_event_name: "UserPromptSubmit",
      session_id: CONVERSATION_ID,
      ...over,
    }) as ClaudeHookInput;

  function seedCache(asks: AskStateCacheRecord["asks"]): void {
    writeFileSync(join(dir, "ask-state-cache.json"), JSON.stringify(cache(asks)));
  }

  test("injects, then stays silent on the next turn (SC2 + SC3 together)", () => {
    recordAskConversation(
      ASK_A,
      { conversationId: CONVERSATION_ID, shortId: "ask#8014", recordedAt: NOW },
      NOW,
      join(dir, MAP_FILE)
    );
    seedCache({
      [ASK_A]: {
        found: true,
        state: "responded",
        open: false,
        shortId: "ask#8014",
        title: ASK_TITLE,
        respondedAt: NOW,
        chosen: "approve",
      },
    });

    const first = run(input());
    expect(first?.additionalContext).toContain("ask#8014");
    expect(first?.additionalContext).toContain("approve");

    // Second turn, same unchanged state: nothing. This is the assertion that would
    // catch a watermark that never persisted.
    expect(run(input())).toBeNull();
  });

  test("stays silent for a DIFFERENT conversation's turn", () => {
    recordAskConversation(
      ASK_A,
      { conversationId: CONVERSATION_ID, recordedAt: NOW },
      NOW,
      join(dir, MAP_FILE)
    );
    seedCache({ [ASK_A]: { found: true, state: "responded", open: false, respondedAt: NOW } });

    expect(run(input({ session_id: "some-other-conversation" }))).toBeNull();
  });

  test("stays silent with no attribution map, no cache, or a non-UserPromptSubmit event", () => {
    expect(run(input())).toBeNull();

    recordAskConversation(
      ASK_A,
      { conversationId: CONVERSATION_ID, recordedAt: NOW },
      NOW,
      join(dir, MAP_FILE)
    );
    // Attribution present, cache absent — nothing resolvable, so nothing said.
    expect(run(input())).toBeNull();

    seedCache({ [ASK_A]: { found: true, state: "responded", open: false, respondedAt: NOW } });
    expect(run(input({ hook_event_name: "Stop" }))).toBeNull();
  });
});
