/**
 * Tests for the transcript timeline rules (mt#3261).
 *
 * Timezone discipline: these must pass in ANY `TZ`, so nothing asserts an
 * absolute rendered string. Local-time output is checked structurally (shape +
 * relative behavior), and every day-boundary case is built from the LOCAL Date
 * constructor so "different local day" is true by construction rather than by
 * accident of the runner's offset.
 */
import { describe, expect, test } from "bun:test";
import {
  TURN_GAP_THRESHOLD_MS,
  formatGap,
  formatLocalDay,
  formatLocalTime,
  isDifferentLocalDay,
  turnSeparator,
} from "./conversation-timeline";

/** Local wall-clock instant -> ISO, so tests are timezone-independent. */
function localIso(y: number, m: number, d: number, hh = 12, mm = 0, ss = 0): string {
  return new Date(y, m - 1, d, hh, mm, ss).toISOString();
}

describe("formatLocalTime", () => {
  test("renders HH:MM:SS in 24-hour form", () => {
    expect(formatLocalTime(localIso(2026, 7, 26, 14, 22, 7))).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  test("reflects LOCAL wall-clock, not UTC", () => {
    // The regression this guards: the previous implementation used
    // `toISOString().slice(11, 19)`, which renders UTC regardless of TZ.
    const iso = localIso(2026, 7, 26, 9, 5, 3);
    expect(formatLocalTime(iso)).toBe("09:05:03");
  });

  test("returns the input unchanged when it is not a parseable date", () => {
    expect(formatLocalTime("not-a-date")).toBe("not-a-date");
  });
});

describe("formatLocalDay", () => {
  test("produces a non-empty label distinct from the raw ISO string", () => {
    const iso = localIso(2026, 7, 26);
    const label = formatLocalDay(iso);
    expect(label.length).toBeGreaterThan(0);
    expect(label).not.toBe(iso);
  });

  test("returns the input unchanged when it is not a parseable date", () => {
    expect(formatLocalDay("garbage")).toBe("garbage");
  });
});

describe("isDifferentLocalDay", () => {
  test("false within one local day even across many hours", () => {
    expect(isDifferentLocalDay(localIso(2026, 7, 26, 0, 5), localIso(2026, 7, 26, 23, 55))).toBe(
      false
    );
  });

  test("true across a local midnight", () => {
    expect(isDifferentLocalDay(localIso(2026, 7, 26, 23, 55), localIso(2026, 7, 27, 0, 5))).toBe(
      true
    );
  });

  test("false when either side is unparseable (never invent a boundary)", () => {
    expect(isDifferentLocalDay("nope", localIso(2026, 7, 26))).toBe(false);
    expect(isDifferentLocalDay(localIso(2026, 7, 26), "nope")).toBe(false);
  });
});

describe("formatGap", () => {
  test("minutes under an hour", () => {
    expect(formatGap(25 * 60_000)).toBe("25m");
  });

  test("hours drop the minutes when exact", () => {
    expect(formatGap(2 * 3_600_000)).toBe("2h");
  });

  test("hours keep the minutes when non-zero", () => {
    expect(formatGap(2 * 3_600_000 + 30 * 60_000)).toBe("2h 30m");
  });

  test("days past 24h", () => {
    expect(formatGap(50 * 3_600_000)).toBe("2d");
  });
});

describe("turnSeparator", () => {
  test("no separator above the first rendered turn", () => {
    expect(turnSeparator(undefined, localIso(2026, 7, 26))).toBeNull();
  });

  test("no separator for an ordinary short pause", () => {
    const a = localIso(2026, 7, 26, 12, 0, 0);
    const b = localIso(2026, 7, 26, 12, 0, 30);
    expect(turnSeparator(a, b)).toBeNull();
  });

  test("gap separator once the pause reaches the measured p99 threshold", () => {
    const a = localIso(2026, 7, 26, 12, 0, 0);
    const b = new Date(new Date(a).getTime() + TURN_GAP_THRESHOLD_MS).toISOString();
    expect(turnSeparator(a, b)).toEqual({ kind: "gap", label: formatGap(TURN_GAP_THRESHOLD_MS) });
  });

  test("no gap separator one millisecond below the threshold", () => {
    const a = localIso(2026, 7, 26, 12, 0, 0);
    const b = new Date(new Date(a).getTime() + TURN_GAP_THRESHOLD_MS - 1).toISOString();
    expect(turnSeparator(a, b)).toBeNull();
  });

  test("a day boundary wins over a gap that also qualifies", () => {
    const a = localIso(2026, 7, 26, 23, 0, 0);
    const b = localIso(2026, 7, 27, 12, 0, 0); // 13h later AND a new local day
    const sep = turnSeparator(a, b);
    expect(sep?.kind).toBe("day");
  });

  test("a day boundary is marked even when the pause itself is short", () => {
    const a = localIso(2026, 7, 26, 23, 59, 50);
    const b = localIso(2026, 7, 27, 0, 0, 10); // 20 seconds, but across midnight
    expect(turnSeparator(a, b)?.kind).toBe("day");
  });

  test("respects an injected threshold", () => {
    const a = localIso(2026, 7, 26, 12, 0, 0);
    const b = localIso(2026, 7, 26, 12, 2, 0); // 2 minutes
    expect(turnSeparator(a, b, 60_000)?.kind).toBe("gap");
    expect(turnSeparator(a, b, 10 * 60_000)).toBeNull();
  });

  test("unparseable timestamps produce no separator rather than a bogus one", () => {
    expect(turnSeparator("nope", localIso(2026, 7, 26))).toBeNull();
  });
});
