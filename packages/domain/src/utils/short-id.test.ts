/**
 * Tests for the generic numeric short-id minting util (mt#2963).
 *
 * Covers:
 *  - formatShortId / parseShortId — pure formatting/parsing round-trip
 *  - nextShortId — monotonic allocation over live ∪ tombstone ids, including
 *    the delete-then-create-never-reissues regression case (mirrors mt#2205's
 *    computeNextTaskId coverage, generalized to an arbitrary prefix)
 *  - multi-entity isolation — a `mem#` tombstone must not perturb `ask#`
 *    allocation and vice versa (the "global per-entity-type sequence" design
 *    constraint from the mt#2963 spec)
 */
import { describe, test, expect } from "bun:test";
import { formatShortId, parseShortId, nextShortId } from "./short-id";

describe("formatShortId", () => {
  test("joins prefix and number with '#'", () => {
    expect(formatShortId("ask", 7)).toBe("ask#7");
    expect(formatShortId("mt", 1)).toBe("mt#1");
    expect(formatShortId("ws", 42)).toBe("ws#42");
  });
});

describe("parseShortId", () => {
  test("parses a well-formed short id", () => {
    expect(parseShortId("ask#7")).toEqual({ prefix: "ask", n: 7 });
    expect(parseShortId("mt#12345")).toEqual({ prefix: "mt", n: 12345 });
  });

  test("trims surrounding whitespace", () => {
    expect(parseShortId("  ask#7  ")).toEqual({ prefix: "ask", n: 7 });
  });

  test("returns null for empty/whitespace-only input", () => {
    expect(parseShortId("")).toBeNull();
    expect(parseShortId("   ")).toBeNull();
  });

  test("returns null when there is no '#' separator", () => {
    expect(parseShortId("ask7")).toBeNull();
  });

  test("returns null for a non-numeric suffix", () => {
    expect(parseShortId("mt#notanumber")).toBeNull();
  });

  test("returns null for trailing garbage after the digits", () => {
    expect(parseShortId("mt#5abc")).toBeNull();
  });

  test("returns null for a zero or negative suffix", () => {
    expect(parseShortId("ask#0")).toBeNull();
    expect(parseShortId("ask#-1")).toBeNull();
  });

  test("returns null when the prefix starts with a digit", () => {
    expect(parseShortId("7ask#7")).toBeNull();
  });

  test("round-trips with formatShortId", () => {
    const token = formatShortId("mem", 99);
    expect(parseShortId(token)).toEqual({ prefix: "mem", n: 99 });
  });
});

describe("nextShortId (mt#2963 — generalized computeNextTaskId)", () => {
  test("empty state allocates <prefix>#1", () => {
    expect(nextShortId("ask", [], [])).toBe("ask#1");
    expect(nextShortId("mem", [], [])).toBe("mem#1");
  });

  test("max over live ids + 1", () => {
    expect(nextShortId("ask", ["ask#1", "ask#2", "ask#3"], [])).toBe("ask#4");
  });

  test("tombstones raise the high-water mark above live ids", () => {
    // Live max is 5, but a higher id (7) was deleted — next must clear 7.
    expect(nextShortId("ask", ["ask#5"], ["ask#7"])).toBe("ask#8");
  });

  test("REGRESSION: create -> delete -> create does not reuse the freed id", () => {
    // ask#3 was the highest ask, then deleted (now a tombstone, no live rows).
    // A naive MAX(live)+1 would return ask#3 again (reuse). With the
    // tombstone included, the next id is ask#4 — the freed id is retired.
    expect(nextShortId("ask", [], ["ask#3"])).toBe("ask#4");
  });

  test("ids with a different prefix are ignored", () => {
    expect(nextShortId("ask", ["mem#999", "ws#888", "ask#2", "mt#500"], [])).toBe("ask#3");
  });

  test("unparseable ids are ignored", () => {
    expect(nextShortId("ask", ["ask#notanumber", "ask#2"], [])).toBe("ask#3");
  });

  test("only tombstones, no live rows", () => {
    expect(nextShortId("ask", [], ["ask#1", "ask#10", "ask#4"])).toBe("ask#11");
  });

  test("multi-entity isolation: a mem# tombstone does not perturb ask# allocation", () => {
    // Same numeric magnitude on a different prefix must not leak across
    // entity types — this is the "global PER-ENTITY-TYPE sequence" design
    // constraint (mt#2963 spec), not a single cross-entity counter.
    expect(nextShortId("ask", ["ask#1"], ["mem#50"])).toBe("ask#2");
    expect(nextShortId("mem", ["mem#1"], ["ask#50"])).toBe("mem#2");
  });

  test("mirrors computeNextTaskId's mt# behavior when called with prefix 'mt'", () => {
    expect(nextShortId("mt", [], [])).toBe("mt#1");
    expect(nextShortId("mt", ["mt#1", "mt#2", "mt#3"], [])).toBe("mt#4");
    expect(nextShortId("mt", ["mt#5"], ["mt#7"])).toBe("mt#8");
    expect(nextShortId("mt", [], ["mt#3"])).toBe("mt#4");
    expect(nextShortId("mt", ["md#999", "gh#888", "mt#2", "mt#notanumber"], [])).toBe("mt#3");
    expect(nextShortId("mt", [], ["mt#1", "mt#10", "mt#4"])).toBe("mt#11");
  });
});
