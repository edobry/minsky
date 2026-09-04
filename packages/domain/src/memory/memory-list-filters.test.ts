/**
 * Age-threshold arithmetic for the list filters (mt#4767).
 *
 * `daysBefore` is the shared boundary behind both `unreadOrCold` and `cold`. It takes
 * an injected clock rather than reading `Date.now()`, so these assertions pin
 * an exact instant instead of a tolerance window — see
 * `testing-standards.mdc §The clock is injected, never read at the point of use`.
 *
 * The `cold` vs `unreadOrCold` DISJOINTNESS these thresholds serve is a property of
 * SQL predicates, so it is asserted where it can actually be observed: against
 * the live corpus, by `scripts/verify-memory-worklists.ts` (mt#4767 AT3).
 */
import { describe, test, expect } from "bun:test";
import { daysBefore } from "./memory-service";
import { DEFAULT_COLD_DAYS } from "./types";

/** A fixed clock. Every expectation below is exact against this instant. */
const NOW = Date.parse("2026-08-31T00:00:00.000Z");

describe("daysBefore", () => {
  test("subtracts whole days exactly", () => {
    expect(daysBefore(NOW, 14).toISOString()).toBe("2026-08-17T00:00:00.000Z");
  });

  test("0 days is the instant itself", () => {
    expect(daysBefore(NOW, 0).getTime()).toBe(NOW);
  });

  test("the 90-day default the unreadOrCold filter uses", () => {
    expect(daysBefore(NOW, 90).toISOString()).toBe("2026-06-02T00:00:00.000Z");
  });

  test("crosses a month boundary without drift", () => {
    expect(daysBefore(Date.parse("2026-03-01T12:00:00.000Z"), 1).toISOString()).toBe(
      "2026-02-28T12:00:00.000Z"
    );
  });

  test("is monotonic — a larger threshold reaches further back", () => {
    expect(daysBefore(NOW, 30).getTime()).toBeLessThan(daysBefore(NOW, 14).getTime());
  });
});

describe("DEFAULT_COLD_DAYS", () => {
  test("is 14, the knee of the measured read distribution", () => {
    // Not a round number chosen for looks (decision-defaults §Thresholds).
    // Measured 2026-08-31 over 1,093 ever-read records: 805 read within 7
    // days, 152 more within 14, then 112 / 18 / 6 across 14-30d, 30-60d and
    // beyond. If this value ever changes, re-derive it from the corpus rather
    // than adjusting it by feel.
    expect(DEFAULT_COLD_DAYS).toBe(14);
  });

  test("is well below the unreadOrCold filter's 90-day default", () => {
    // At 90 days the cold filter matched exactly ONE record, because the
    // corpus has only tracked last_accessed_at since 2026-05-27. A cold
    // threshold at the unreadOrCold default would be a permanently-empty worklist.
    expect(DEFAULT_COLD_DAYS).toBeLessThan(90);
  });
});
