import { describe, expect, test } from "bun:test";
import {
  aggregateFireLogDeltas,
  type FireLogRollupDelta,
  type FireLogRollupSourceRow,
} from "./fire-log-rollup";

function row(over: Partial<FireLogRollupSourceRow> = {}): FireLogRollupSourceRow {
  return {
    stream: "fire-log",
    guardName: "wall-of-text-detector",
    occurredAt: new Date("2026-08-19T12:00:00Z"),
    ...over,
  };
}

/** Assert a single delta came back and hand it over, without a non-null assertion. */
function only(deltas: readonly FireLogRollupDelta[]): FireLogRollupDelta {
  expect(deltas).toHaveLength(1);
  const [first] = deltas;
  if (first === undefined) throw new Error("expected exactly one delta");
  return first;
}

describe("aggregateFireLogDeltas", () => {
  test("an empty batch produces no deltas — an ingest tick that appended nothing must not write", () => {
    expect(aggregateFireLogDeltas([])).toEqual([]);
  });

  test("counts rows per guard and carries the batch's min/max occurredAt", () => {
    const delta = only(
      aggregateFireLogDeltas([
        row({ occurredAt: new Date("2026-08-19T10:00:00Z") }),
        row({ occurredAt: new Date("2026-08-19T14:00:00Z") }),
        row({ occurredAt: new Date("2026-08-19T12:00:00Z") }),
      ])
    );

    expect(delta.guardName).toBe("wall-of-text-detector");
    expect(delta.addedFires).toBe(3);
    expect(delta.minOccurredAt).toEqual(new Date("2026-08-19T10:00:00Z"));
    expect(delta.maxOccurredAt).toEqual(new Date("2026-08-19T14:00:00Z"));
  });

  test("separates guards, so one batch can advance several rollup rows", () => {
    const deltas = aggregateFireLogDeltas([
      row({ guardName: "a" }),
      row({ guardName: "b" }),
      row({ guardName: "a" }),
    ]);

    const byName = new Map(deltas.map((d) => [d.guardName, d.addedFires]));
    expect(byName.get("a")).toBe(2);
    expect(byName.get("b")).toBe(1);
  });

  test("ignores rows from other streams — they ride the same insert batch", () => {
    const deltas = aggregateFireLogDeltas([
      row({ stream: "guard-health" }),
      row({ stream: "wall-of-text" }),
    ]);
    expect(deltas).toEqual([]);
  });

  test("ignores rows with a NULL guard name, matching fireLogWhere's IS NOT NULL", () => {
    expect(aggregateFireLogDeltas([row({ guardName: null })])).toEqual([]);
  });

  test("COUNTS an empty-string guard name, because SQL's IS NOT NULL does (PR #3191 R1)", () => {
    // Skipping `""` here reads as tidying up malformed data and is a drift bug:
    // the backfill and rebuild both count such a row, so dropping it in the
    // incremental fold makes the rollup's value depend on whether it was last
    // maintained or rebuilt. The predicate must be the SQL predicate.
    const delta = only(aggregateFireLogDeltas([row({ guardName: "" }), row({ guardName: "" })]));
    expect(delta.guardName).toBe("");
    expect(delta.addedFires).toBe(2);
  });

  test("a null occurredAt still COUNTS — the replaced query used count(*), which includes it", () => {
    const delta = only(
      aggregateFireLogDeltas([
        row({ occurredAt: null }),
        row({ occurredAt: null }),
        row({ occurredAt: null }),
      ])
    );

    expect(delta.addedFires).toBe(3);
    // min/max skip nulls exactly as SQL min()/max() do.
    expect(delta.minOccurredAt).toBeNull();
    expect(delta.maxOccurredAt).toBeNull();
  });

  test("a real timestamp wins over a null accumulator rather than being discarded", () => {
    // Order matters here: the first row seeds the accumulator with null, so a
    // naive `if (occurredAt < min)` comparison against null would keep null
    // forever (every comparison with null is false).
    const delta = only(
      aggregateFireLogDeltas([
        row({ occurredAt: null }),
        row({ occurredAt: new Date("2026-08-19T09:00:00Z") }),
        row({ occurredAt: null }),
        row({ occurredAt: new Date("2026-08-19T17:00:00Z") }),
      ])
    );

    expect(delta.addedFires).toBe(4);
    expect(delta.minOccurredAt).toEqual(new Date("2026-08-19T09:00:00Z"));
    expect(delta.maxOccurredAt).toEqual(new Date("2026-08-19T17:00:00Z"));
  });

  test("a later null does not clobber an established min/max", () => {
    const delta = only(
      aggregateFireLogDeltas([
        row({ occurredAt: new Date("2026-08-19T09:00:00Z") }),
        row({ occurredAt: null }),
      ])
    );

    expect(delta.minOccurredAt).toEqual(new Date("2026-08-19T09:00:00Z"));
    expect(delta.maxOccurredAt).toEqual(new Date("2026-08-19T09:00:00Z"));
  });

  test("a mixed batch folds only its fire-log, named-guard rows", () => {
    const delta = only(
      aggregateFireLogDeltas([
        row({ guardName: "keep" }),
        row({ stream: "guard-health", guardName: "drop-stream" }),
        row({ guardName: null }),
        row({ guardName: "keep" }),
      ])
    );

    expect(delta).toMatchObject({ guardName: "keep", addedFires: 2 });
  });
});
