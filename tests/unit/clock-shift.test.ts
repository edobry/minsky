/**
 * Unit tests for the clock-shift shim (mt#4726).
 *
 * Lives in `tests/unit/` rather than beside `tests/clock-shift.ts` because top-level
 * `tests/*.test.ts` files are in NO suite: `ROOTS` in `scripts/run-tests-main.ts` lists specific
 * `tests/` SUBDIRECTORIES, and no `test:*` script targets `./tests` itself. Four such files sit
 * there unreachable today — recorded on mt#3935, which owns that class. A test for the detector
 * that catches unrun fixtures must not itself be unrun.
 *
 * Every assertion here drives the exported functions against an explicit constructor or a stub
 * target, never `globalThis` — so these pass identically whether or not the surrounding run is
 * itself clock-shifted.
 */

import { describe, expect, test } from "bun:test";
import {
  CLOCK_SHIFT_ENV_VAR,
  createShiftedDateConstructor,
  describeOffset,
  installClockShift,
  parseShiftMs,
  type ClockShiftTarget,
} from "../clock-shift";
import {
  assertExemptionsWellFormed,
  CLOCK_SHIFT_EXEMPTIONS,
  isClockShiftExempt,
  type ClockShiftExemption,
} from "../clock-shift-exemptions";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The genuine constructor, obtained in a way that is immune to an ambient shift.
 *
 * `const RealDate = Date` is WRONG here and was this file's first version. Under a clock-shifted
 * run the preload has already replaced the global before this module evaluates, so that captures
 * the PROXY — and `installClockShift` then correctly refuses to double-wrap it, so three tests
 * below failed asserting the binding had changed. The shifted run caught it on its first real
 * invocation, which is the whole mechanism working: a test that silently assumes the ambient clock
 * is real is exactly the class mt#4726 exists to surface, and this file was an instance of it.
 *
 * `Date.prototype.constructor` is stable under the shift: the proxy forwards `prototype` to the
 * real `Date.prototype` (that forwarding is what keeps `instanceof` working across the native
 * boundary), and that object's `constructor` is the genuine built-in. The test immediately below
 * pins that property, so a future change to the shim cannot quietly invalidate this line.
 */
const RealDate = Date.prototype.constructor as DateConstructor;

const envWith = (value: string): Record<string, string | undefined> => ({
  [CLOCK_SHIFT_ENV_VAR]: value,
});

describe("parseShiftMs", () => {
  test("returns null when the variable is absent", () => {
    expect(parseShiftMs({})).toBeNull();
  });

  test("returns null for an empty or whitespace-only value", () => {
    expect(parseShiftMs(envWith(""))).toBeNull();
    expect(parseShiftMs(envWith("   "))).toBeNull();
  });

  test("converts days to milliseconds", () => {
    expect(parseShiftMs(envWith("30"))).toBe(30 * MS_PER_DAY);
    expect(parseShiftMs(envWith("1"))).toBe(MS_PER_DAY);
  });

  test("accepts a negative horizon, for a fixture that only works after some instant", () => {
    expect(parseShiftMs(envWith("-30"))).toBe(-30 * MS_PER_DAY);
  });

  test("treats an explicit 0 as a real (no-op) offset, not as absent", () => {
    // Distinguishing these matters: the runner refuses a 0-day horizon rather than running a
    // suite that reports nothing, and it can only do that if parse does not collapse 0 to null.
    expect(parseShiftMs(envWith("0"))).toBe(0);
  });

  test("throws on a set-but-unparseable value rather than degrading to inert", () => {
    // An inert nightly is indistinguishable from a clean one, so a typo must be loud.
    expect(() => parseShiftMs(envWith("thirty"))).toThrow(/not a finite number of days/);
    expect(() => parseShiftMs(envWith("NaN"))).toThrow(/not a finite number of days/);
  });
});

describe("describeOffset", () => {
  test("renders a signed day count", () => {
    expect(describeOffset(30 * MS_PER_DAY)).toBe("clock shifted +30d");
    expect(describeOffset(-30 * MS_PER_DAY)).toBe("clock shifted -30d");
  });
});

describe("createShiftedDateConstructor", () => {
  const offsetMs = 30 * MS_PER_DAY;
  const Shifted = createShiftedDateConstructor(RealDate, offsetMs);

  test("Date.now() reads the shifted clock", () => {
    const delta = Shifted.now() - RealDate.now();
    // A generous band: the two reads are microseconds apart, but the assertion is about the
    // offset being applied at all, not about scheduler precision.
    expect(delta).toBeGreaterThan(offsetMs - 60_000);
    expect(delta).toBeLessThan(offsetMs + 60_000);
  });

  test("argless `new Date()` reads the shifted clock", () => {
    const delta = new Shifted().getTime() - RealDate.now();
    expect(delta).toBeGreaterThan(offsetMs - 60_000);
    expect(delta).toBeLessThan(offsetMs + 60_000);
  });

  test("an explicit timestamp is passed through untouched", () => {
    expect(new Shifted(0).getTime()).toBe(0);
    expect(new Shifted(1_700_000_000_000).getTime()).toBe(1_700_000_000_000);
  });

  test("an explicit date string is passed through untouched", () => {
    expect(new Shifted("2026-08-22T12:00:00.000Z").toISOString()).toBe("2026-08-22T12:00:00.000Z");
  });

  test("multi-argument construction is passed through untouched", () => {
    const viaShifted = new Shifted(2026, 0, 2, 3, 4, 5);
    const viaReal = new RealDate(2026, 0, 2, 3, 4, 5);
    expect(viaShifted.getTime()).toBe(viaReal.getTime());
  });

  test("a natively constructed Date is still an instanceof the shifted constructor", () => {
    // The regression this whole Proxy design exists for. AT1's probe used
    // `class ShiftedDate extends Date`, which made `fs.stat().mtime instanceof Date` FALSE and
    // failed two transcript-source tests on identity rather than on time. `realDate` here is the
    // same shape as one bun hands back from a native call: a real Date built by the real
    // constructor, with no knowledge of the proxy.
    const realDate = new RealDate(0);
    expect(realDate instanceof Shifted).toBe(true);
    expect(realDate).toBeInstanceOf(Shifted);
  });

  test("a shifted-constructor Date is still an instanceof the real constructor", () => {
    expect(new Shifted(0) instanceof RealDate).toBe(true);
  });

  test("prototype is the very same object, which is what makes instanceof work", () => {
    expect(Shifted.prototype).toBe(RealDate.prototype);
  });

  test("prototype.constructor still names the genuine built-in, not the proxy", () => {
    // Load-bearing beyond tidiness: it is how this file recovers an unshifted constructor when
    // the surrounding run is itself clock-shifted (see RealDate's docblock above). If the shim
    // ever starts trapping `prototype`, this fails here rather than as three confusing failures
    // that only appear in the nightly.
    expect(Shifted.prototype.constructor).toBe(RealDate);
    expect(Shifted.prototype.constructor).not.toBe(Shifted);
  });

  test("static methods that do not read the clock are forwarded unchanged", () => {
    expect(Shifted.parse("2026-08-22T12:00:00.000Z")).toBe(
      RealDate.parse("2026-08-22T12:00:00.000Z")
    );
    expect(Shifted.UTC(2026, 0, 1)).toBe(RealDate.UTC(2026, 0, 1));
  });

  test("called as a function it returns a shifted time string, per spec ignoring its args", () => {
    const asFunction = (Shifted as unknown as (...args: unknown[]) => string)();
    // `Date()` returns a string, never a Date — and the string must reflect the shifted clock.
    expect(typeof asFunction).toBe("string");
    const parsed = RealDate.parse(asFunction);
    const delta = parsed - RealDate.now();
    // Second-resolution: `toString()` drops milliseconds, so allow a wider lower bound.
    expect(delta).toBeGreaterThan(offsetMs - 60_000);
    expect(delta).toBeLessThan(offsetMs + 60_000);
  });

  test("subclassing the shifted constructor still produces working Dates", () => {
    class Timestamped extends Shifted {
      label(): string {
        return `t=${this.getTime()}`;
      }
    }
    const instance = new Timestamped(0);
    expect(instance.label()).toBe("t=0");
    expect(instance).toBeInstanceOf(Shifted);
    expect(instance).toBeInstanceOf(RealDate);
  });
});

describe("installClockShift", () => {
  test("is inert and leaves the target's Date binding untouched when the var is unset", () => {
    const target: ClockShiftTarget = { Date: RealDate };
    const status = installClockShift({}, target);

    expect(status.active).toBe(false);
    expect(status.offsetMs).toBe(0);
    // Identity, not behaviour: SC2 requires the unset case to change nothing at all.
    expect(target.Date).toBe(RealDate);
  });

  test("replaces the target's Date binding when the var is set", () => {
    const target: ClockShiftTarget = { Date: RealDate };
    const status = installClockShift(envWith("30"), target);

    expect(status.active).toBe(true);
    expect(status.offsetMs).toBe(30 * MS_PER_DAY);
    expect(target.Date).not.toBe(RealDate);
    expect(target.Date.now() - RealDate.now()).toBeGreaterThan(30 * MS_PER_DAY - 60_000);
  });

  test("is idempotent — a second install does not stack a second offset", () => {
    const target: ClockShiftTarget = { Date: RealDate };
    installClockShift(envWith("30"), target);
    installClockShift(envWith("30"), target);

    const delta = target.Date.now() - RealDate.now();
    // The failure this guards is silent: two stacked proxies would report +60d while every test
    // still passes, so the horizon would be wrong and nothing would say so.
    expect(delta).toBeLessThan(31 * MS_PER_DAY);
    expect(delta).toBeGreaterThan(29 * MS_PER_DAY);
  });

  test("reports the horizon in its summary, so a caller need not re-derive it", () => {
    const target: ClockShiftTarget = { Date: RealDate };
    expect(installClockShift(envWith("30"), target).summary).toBe("clock shifted +30d");
  });
});

describe("clock-shift exemptions", () => {
  test("the committed list is well formed", () => {
    expect(assertExemptionsWellFormed()).toEqual([]);
  });

  test("matches a path whether or not it carries a leading ./", () => {
    const entry = CLOCK_SHIFT_EXEMPTIONS[0];
    expect(entry).toBeDefined();
    const file = entry?.file ?? "";
    expect(isClockShiftExempt(file)).toBe(true);
    expect(isClockShiftExempt(`./${file}`)).toBe(true);
  });

  test("does not match an unrelated file", () => {
    expect(isClockShiftExempt("src/does/not/exist.test.ts")).toBe(false);
  });

  test("rejects a probe-artifact entry with no owning task", () => {
    const orphaned: ClockShiftExemption[] = [
      {
        file: "src/example.test.ts",
        exemptionClass: "probe-artifact",
        reason: "a shim limitation with nobody on the hook for it",
      },
    ];
    expect(assertExemptionsWellFormed(orphaned)).toEqual([
      expect.stringContaining("no `retiredBy` task") as unknown as string,
    ]);
  });

  test("rejects a duplicate entry, which would hide a second reason", () => {
    const duplicated: ClockShiftExemption[] = [
      {
        file: "src/example.test.ts",
        exemptionClass: "intentional-time-coupling",
        reason: "asserts a real calendar date",
      },
      {
        file: "./src/example.test.ts",
        exemptionClass: "intentional-time-coupling",
        reason: "a different reason nobody will ever read",
      },
    ];
    expect(assertExemptionsWellFormed(duplicated)).toContain(
      "duplicate entry for ./src/example.test.ts"
    );
  });
});
