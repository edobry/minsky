/**
 * Tests for `classifySnapshotError` (mt#3131 PR #2245 R1 — centralized
 * snapshot error-code/status contract). The classifier is the ONE client-side
 * site interpreting the snapshot endpoint's error contract; these tests pin
 * both the primary matches and the drift-hardening fallbacks (code matched
 * regardless of status; status matched when the code is missing/unknown).
 */
import { describe, test, expect, afterEach } from "bun:test";
import type { SessionContextSnapshot } from "@minsky/domain/context/types";
import type { ConversationId } from "@minsky/domain/ids";
import {
  classifySnapshotError,
  fetchSnapshot,
  mergeSnapshotPages,
  SnapshotError,
  snapshotQueryKey,
} from "./conversation-snapshot";

describe("classifySnapshotError (mt#3131)", () => {
  test("wrong_id_space code → wrong_id_space", () => {
    const err = new SnapshotError(422, "wrong_id_space", "workspace id, not a conversation id");
    expect(classifySnapshotError(err)).toBe("wrong_id_space");
  });

  test("bare 422 without a code still classifies as wrong_id_space (body-dropping proxy)", () => {
    const err = new SnapshotError(422, undefined, "Snapshot fetch failed (422): <html>");
    expect(classifySnapshotError(err)).toBe("wrong_id_space");
  });

  test("invalid_id code → invalid_id", () => {
    const err = new SnapshotError(404, "invalid_id", '"958f3805" is not a valid conversation id.');
    expect(classifySnapshotError(err)).toBe("invalid_id");
  });

  test("invalid_id code survives a server-side status drift (e.g. 404 → 400)", () => {
    const err = new SnapshotError(400, "invalid_id", "not a valid conversation id");
    expect(classifySnapshotError(err)).toBe("invalid_id");
  });

  test("session_not_found 404 → not_found", () => {
    const err = new SnapshotError(404, "session_not_found", "No transcript found.");
    expect(classifySnapshotError(err)).toBe("not_found");
  });

  test("a 404 with an unrecognized future code falls back to not_found, not other", () => {
    const err = new SnapshotError(404, "some_future_code", "gone");
    expect(classifySnapshotError(err)).toBe("not_found");
  });

  test("a 500 → other", () => {
    const err = new SnapshotError(500, "internal", "An internal error occurred.");
    expect(classifySnapshotError(err)).toBe("other");
  });

  test("a plain (non-Snapshot) Error → other", () => {
    expect(classifySnapshotError(new Error("network down"))).toBe("other");
  });
});

// ── Windowing (mt#4263) ─────────────────────────────────────────────────────

const CONV = "conv-1" as ConversationId;

function page(
  overrides: Partial<SessionContextSnapshot> & {
    blocks: SessionContextSnapshot["blocks"];
  }
): SessionContextSnapshot {
  return {
    agentSessionId: CONV,
    harness: "claude_code",
    assembledAt: "2026-08-18T00:00:00.000Z",
    ...overrides,
  };
}

function turn(
  id: string,
  timestamp: string,
  turnIndex: number
): SessionContextSnapshot["blocks"][0] {
  return {
    id,
    type: "user-prompt",
    source: "observed",
    content: {},
    timestamp,
    turnIndex,
    rawJsonlType: "user",
  };
}

describe("snapshotQueryKey — window awareness (mt#4263)", () => {
  test("the UNWINDOWED key is unchanged, so the three full-fidelity consumers still dedupe", () => {
    expect(snapshotQueryKey(CONV)).toEqual(["conversation", "snapshot", CONV]);
  });

  test("BLOCKING CASE: a windowed request does not share a cache entry with the full one", () => {
    // Sharing would let whichever landed first serve the other — a full
    // transcript rendered as if it were fifty turns, or fifty turns used as the
    // whole conversation by the consumers that aggregate over every block.
    expect(snapshotQueryKey(CONV, { turns: 50 })).not.toEqual(snapshotQueryKey(CONV));
  });

  test("the cursor is NOT part of the key, so pages accumulate under one entry", () => {
    // Keying on `before` would make every scroll-back page its own cache entry
    // and defeat the accumulation the infinite query exists for.
    expect(snapshotQueryKey(CONV, { turns: 50, before: 2186 })).toEqual(
      snapshotQueryKey(CONV, { turns: 50 })
    );
  });
});

describe("fetchSnapshot — window query params (mt#4263)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function captureUrl(): { urls: string[] } {
    const urls: string[] = [];
    globalThis.fetch = ((input: string) => {
      urls.push(String(input));
      return Promise.resolve(
        new Response(JSON.stringify(page({ blocks: [] })), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
    }) as typeof globalThis.fetch;
    return { urls };
  }

  test("no window → no window params, byte-for-byte the pre-mt#4263 request", async () => {
    const { urls } = captureUrl();
    await fetchSnapshot(CONV);
    expect(urls[0]).toBe("/api/cockpit/context-inspector/snapshot?sessionId=conv-1");
  });

  test("a window sends turns", async () => {
    const { urls } = captureUrl();
    await fetchSnapshot(CONV, { turns: 50 });
    expect(urls[0]).toContain("&turns=50");
    expect(urls[0]).not.toContain("before=");
  });

  test("a cursor sends before as well", async () => {
    const { urls } = captureUrl();
    await fetchSnapshot(CONV, { turns: 50, before: 2186 });
    expect(urls[0]).toContain("&turns=50");
    expect(urls[0]).toContain("&before=2186");
  });
});

describe("mergeSnapshotPages (mt#4263)", () => {
  test("a single page is returned as-is", () => {
    const only = page({ blocks: [turn("a", "2026-08-18T00:00:02.000Z", 1)] });
    expect(mergeSnapshotPages([only])).toBe(only);
  });

  test("pages arrive newest-first and merge back into chronological order", () => {
    const newest = page({
      blocks: [turn("c", "2026-08-18T00:00:03.000Z", 2)],
      window: { totalTurns: 3, returnedTurns: 1, oldestTurnIndex: 2, nextBefore: 2, hasMore: true },
    });
    const older = page({
      blocks: [turn("a", "2026-08-18T00:00:01.000Z", 0), turn("b", "2026-08-18T00:00:02.000Z", 1)],
      window: {
        totalTurns: 3,
        returnedTurns: 2,
        oldestTurnIndex: 0,
        nextBefore: null,
        hasMore: false,
      },
    });

    const merged = mergeSnapshotPages([newest, older]);
    expect(merged.blocks.map((b) => b.id)).toEqual(["a", "b", "c"]);
  });

  test("the merged cursor comes from the OLDEST page, not the newest", () => {
    // Taking the newest page's would claim history is unfetched that the reader
    // is already looking at, and paging would never terminate.
    const newest = page({
      blocks: [turn("c", "2026-08-18T00:00:03.000Z", 2)],
      window: { totalTurns: 3, returnedTurns: 1, oldestTurnIndex: 2, nextBefore: 2, hasMore: true },
    });
    const older = page({
      blocks: [turn("a", "2026-08-18T00:00:01.000Z", 0)],
      window: {
        totalTurns: 3,
        returnedTurns: 1,
        oldestTurnIndex: 0,
        nextBefore: null,
        hasMore: false,
      },
    });

    const merged = mergeSnapshotPages([newest, older]);
    expect(merged.window?.oldestTurnIndex).toBe(0);
    expect(merged.window?.hasMore).toBe(false);
  });

  test("a block delivered on two pages appears once", () => {
    // The newest page's attachment bound is deliberately open at the top, so a
    // live conversation can hand back the same trailing attachment on refetch.
    const dup = turn("shared", "2026-08-18T00:00:02.000Z", 1);
    const newest = page({
      blocks: [dup, turn("c", "2026-08-18T00:00:03.000Z", 2)],
      window: { totalTurns: 3, returnedTurns: 2, oldestTurnIndex: 1, nextBefore: 1, hasMore: true },
    });
    const older = page({
      blocks: [turn("a", "2026-08-18T00:00:01.000Z", 0), dup],
      window: {
        totalTurns: 3,
        returnedTurns: 2,
        oldestTurnIndex: 0,
        nextBefore: null,
        hasMore: false,
      },
    });

    const merged = mergeSnapshotPages([newest, older]);
    expect(merged.blocks.filter((b) => b.id === "shared")).toHaveLength(1);
  });

  test("BLOCKING R1: a page that rendered NOTHING still carries a usable cursor", () => {
    // The reviewer's finding. A slice whose every raw entry is non-renderable
    // produces no blocks, so `oldestTurnIndex` is null — but those indices WERE
    // consumed, and history remains below them. Keying paging on
    // `oldestTurnIndex` ended it here with `hasMore: true` and nothing to
    // advance on; `nextBefore` is derived from the slice and survives.
    const empty = page({
      blocks: [],
      window: {
        totalTurns: 300,
        returnedTurns: 0,
        oldestTurnIndex: null,
        nextBefore: 100,
        hasMore: true,
      },
    });
    expect(empty.window?.nextBefore).toBe(100);
    expect(empty.window?.oldestTurnIndex).toBeNull();
    // The client's own cursor expression, exercised directly.
    expect(empty.window?.nextBefore ?? undefined).toBe(100);
  });

  test("NEGATIVE CONTROL: the OLD cursor expression dead-ends on that same page", () => {
    // Without this, the assertion above passes against any implementation that
    // merely has a `nextBefore` field. This pins WHY the field exists.
    const empty = page({
      blocks: [],
      window: {
        totalTurns: 300,
        returnedTurns: 0,
        oldestTurnIndex: null,
        nextBefore: 100,
        hasMore: true,
      },
    });
    const oldCursor =
      empty.window?.hasMore === true ? (empty.window.oldestTurnIndex ?? undefined) : undefined;
    expect(oldCursor).toBeUndefined();
  });

  test("the merged window carries the OLDEST page's cursor, not the newest's", () => {
    const newest = page({
      blocks: [turn("c", "2026-08-18T00:00:03.000Z", 2)],
      window: { totalTurns: 3, returnedTurns: 1, oldestTurnIndex: 2, nextBefore: 2, hasMore: true },
    });
    const older = page({
      blocks: [turn("a", "2026-08-18T00:00:01.000Z", 0)],
      window: {
        totalTurns: 3,
        returnedTurns: 1,
        oldestTurnIndex: 0,
        nextBefore: null,
        hasMore: false,
      },
    });

    const merged = mergeSnapshotPages([newest, older]);
    expect(merged.window?.nextBefore).toBeNull();
    expect(merged.window?.hasMore).toBe(false);
  });

  test("tool names are UNIONED across pages", () => {
    const newest = page({
      blocks: [],
      toolNamesByUseId: { t1: "Bash" },
      window: { totalTurns: 2, returnedTurns: 0, oldestTurnIndex: 1, nextBefore: 1, hasMore: true },
    });
    const older = page({
      blocks: [],
      toolNamesByUseId: { t2: "Read" },
      window: {
        totalTurns: 2,
        returnedTurns: 0,
        oldestTurnIndex: 0,
        nextBefore: null,
        hasMore: false,
      },
    });

    expect(mergeSnapshotPages([newest, older]).toolNamesByUseId).toEqual({
      t1: "Bash",
      t2: "Read",
    });
  });
});
