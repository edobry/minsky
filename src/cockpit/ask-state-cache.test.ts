// Tests for ask-state-cache.ts (mt#3744) — the PRODUCER half of the
// calibration-review cadence detector's disposition-state lookup.
//
// Every test injects its IO (a stub `sql`, a parsed watermark object) per
// `custom/no-real-fs-in-tests`; the write path is covered by asserting what
// `refreshAskStateCache` hands its writer rather than by touching disk.

import { describe, expect, test } from "bun:test";
import {
  buildAskStateSnapshot,
  collectWatermarkAskIds,
  OPEN_ASK_STATES,
  type AskStateEntry,
  type UnsafeSql,
} from "./ask-state-cache";

const ASK_A = "483dbcb0-788a-4159-9d8a-ba718ba1f2b0";
const ASK_B = "109807e1-0ec6-49ff-9759-805a1bb02a64";
const LOG_A = ".minsky/policy-coverage-calibration.jsonl";
const LOG_B = ".minsky/ask-routing-deferral-calibration.jsonl";

/** A stub raw-SQL connection returning fixed rows, recording the params it was handed. */
function stubSql(
  rows: Array<Record<string, unknown>>
): UnsafeSql & { calls: Array<{ query: string; params?: unknown[] }> } {
  const calls: Array<{ query: string; params?: unknown[] }> = [];
  return {
    calls,
    unsafe: async (query: string, params?: unknown[]) => {
      calls.push({ query, params });
      return rows;
    },
  };
}

/** A stub that always throws, standing in for an unreachable or erroring database. */
const throwingSql: UnsafeSql = {
  unsafe: async () => {
    throw new Error("connection refused");
  },
};

describe("collectWatermarkAskIds", () => {
  test("collects every openAskId in the store", () => {
    const ids = collectWatermarkAskIds({
      [LOG_A]: { lastReviewedCount: 10, openAskId: ASK_A },
      [LOG_B]: { lastReviewedCount: 20, openAskId: ASK_B },
    });
    expect(ids.sort()).toEqual([ASK_A, ASK_B].sort());
  });

  test("returns nothing when no entry carries an openAskId — the steady state", () => {
    // The ordinary case: the watermark store only carries openAskId between a calibration
    // review and its disposition, so an empty result must be normal rather than a fault.
    expect(
      collectWatermarkAskIds({
        [LOG_A]: { lastReviewedCount: 10, lastReviewedAt: "2026-08-10T17:46:38.781Z" },
      })
    ).toEqual([]);
  });

  test("deduplicates an ask referenced by two logs", () => {
    // A single review can cover several logs and file ONE disposition ask for all of them,
    // which is how the same id lands on multiple entries.
    const ids = collectWatermarkAskIds({
      [LOG_A]: { openAskId: ASK_A },
      [LOG_B]: { openAskId: ASK_A },
    });
    expect(ids).toEqual([ASK_A]);
  });

  test("drops non-UUID ids rather than letting one poison the batch", () => {
    // Load-bearing: the ids go into a `::uuid[]` cast, so a single malformed value would
    // fail the query for every OTHER id too — turning one bad entry into a total outage.
    const ids = collectWatermarkAskIds({
      [LOG_A]: { openAskId: "ask#6136" },
      [LOG_B]: { openAskId: ASK_B },
    });
    expect(ids).toEqual([ASK_B]);
  });

  test.each([
    ["null", null],
    ["a string", "nope"],
    ["an array", [{ openAskId: ASK_A }]],
    ["an entry that is not an object", { [LOG_A]: 7 }],
    ["an openAskId that is not a string", { [LOG_A]: { openAskId: 42 } }],
  ])("tolerates %s without throwing", (_label, input) => {
    // The watermark file is hand-edited by the /calibration-review skill and gitignored, so
    // it carries no schema guarantee. A throw here would take down the whole sweep tick.
    expect(collectWatermarkAskIds(input)).toEqual([]);
  });
});

describe("buildAskStateSnapshot", () => {
  test("writes one entry per REQUESTED id, not per returned row", () => {
    // The acceptance test's shape, and the property the consumer's `not-in-snapshot` branch
    // depends on: an id present in the request must be present in the snapshot either way.
    const sql = stubSql([{ id: ASK_A, state: "closed", short_id: "ask#5425" }]);
    return buildAskStateSnapshot(sql, [ASK_A, ASK_B]).then((asks) => {
      expect(Object.keys(asks ?? {}).sort()).toEqual([ASK_A, ASK_B].sort());
    });
  });

  test("an id the query did not return is recorded as found:false, never omitted", async () => {
    const asks = await buildAskStateSnapshot(stubSql([]), [ASK_A]);
    expect(asks?.[ASK_A]).toEqual({ found: false });
  });

  test("carries the tool-call seam's delivery watermark across (mt#4476)", async () => {
    const asks = await buildAskStateSnapshot(
      stubSql([
        {
          id: ASK_A,
          state: "responded",
          responded_at: "2026-08-24T15:00:00.000Z",
          wake_delivered_at: "2026-08-24T15:00:07.000Z",
        },
      ]),
      [ASK_A]
    );

    const entry = asks?.[ASK_A];
    expect(entry?.found).toBe(true);
    // This field is the only route the two delivery seams have to each other: the
    // prompt-seam hook writes no DB by design, so without this it would re-announce
    // an answer the tool-call seam already delivered.
    expect(entry).toMatchObject({ wakeDeliveredAt: "2026-08-24T15:00:07.000Z" });
  });

  test("omits the watermark when the wake was written but never drained", async () => {
    const asks = await buildAskStateSnapshot(
      stubSql([{ id: ASK_A, state: "responded", responded_at: "2026-08-24T15:00:00.000Z" }]),
      [ASK_A]
    );

    // Absent, not null. The subquery filters on `drained_at IS NOT NULL`, so an
    // undrained wake produces no timestamp — and the prompt seam must still announce,
    // because nothing has actually reached the agent yet.
    expect(asks?.[ASK_A]).not.toHaveProperty("wakeDeliveredAt");
  });

  test("precomputes `open` from the producer-owned state set", async () => {
    const asks = await buildAskStateSnapshot(
      stubSql([
        { id: ASK_A, state: "suspended", short_id: "ask#6136" },
        { id: ASK_B, state: "closed", short_id: "ask#5425" },
      ]),
      [ASK_A, ASK_B]
    );
    expect(asks?.[ASK_A]).toEqual({
      found: true,
      state: "suspended",
      open: true,
      shortId: "ask#6136",
    });
    expect((asks?.[ASK_B] as Extract<AskStateEntry, { found: true }>).open).toBe(false);
  });

  test("every state in OPEN_ASK_STATES precomputes open:true", async () => {
    // Guards the two halves against drift: if a state is added to the set, this fails unless
    // the precompute follows it.
    for (const state of OPEN_ASK_STATES) {
      const asks = await buildAskStateSnapshot(stubSql([{ id: ASK_A, state }]), [ASK_A]);
      expect((asks?.[ASK_A] as Extract<AskStateEntry, { found: true }>).open).toBe(true);
    }
  });

  test("an empty request is a successful empty snapshot, not a failure", async () => {
    // This is what lets the consumer distinguish "the producer ran and nothing is pending"
    // from "the producer has never run" — returning null here would collapse the two.
    expect(await buildAskStateSnapshot(stubSql([]), [])).toEqual({});
  });

  test("a failed query returns null so the caller leaves the last-good snapshot alone", async () => {
    // Fail-open. Blanking the cache on a transient outage would replace a merely-stale
    // snapshot with "no snapshot exists", which reads as a worse fault than it is.
    expect(await buildAskStateSnapshot(throwingSql, [ASK_A])).toBeNull();
  });

  test("passes the ids as a bound parameter rather than interpolating them", async () => {
    const sql = stubSql([]);
    await buildAskStateSnapshot(sql, [ASK_A, ASK_B]);
    expect(sql.calls).toHaveLength(1);
    expect(sql.calls[0]?.params).toEqual([[ASK_A, ASK_B]]);
    expect(sql.calls[0]?.query).not.toContain(ASK_A);
  });

  test("skips rows whose id or state is not a string", async () => {
    const asks = await buildAskStateSnapshot(
      stubSql([
        { id: ASK_A, state: null },
        { id: 42, state: "closed" },
      ]),
      [ASK_A]
    );
    expect(asks?.[ASK_A]).toEqual({ found: false });
  });
});
