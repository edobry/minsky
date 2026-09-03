/**
 * `memory.list`'s deprecated-alias folding (mt#4799, PR #3593 R1).
 *
 * mt#4799 renamed `MemoryListFilter.stale` / `stalenessDays` to `unreadOrCold` /
 * `unreadOrColdDays` and kept the old names as deprecated params. The inline
 * expression that folded them carried a comment claiming `unreadOrCold` "wins
 * when both are supplied" — which the reviewer caught as false for the flag.
 *
 * These cases pin what the fold ACTUALLY does, including the asymmetry between
 * the two halves, so the next reader gets it from an assertion rather than from
 * inferring semantics off a `||` and a `??`.
 */
import { describe, expect, test } from "bun:test";
import { foldUnreadOrColdAliases } from "./index";

describe("foldUnreadOrColdAliases — the flag ORs", () => {
  test("neither supplied → off", () => {
    expect(foldUnreadOrColdAliases({}).unreadOrCold).toBe(false);
  });

  test("the current name alone turns it on", () => {
    expect(foldUnreadOrColdAliases({ unreadOrCold: true }).unreadOrCold).toBe(true);
  });

  test("the deprecated alias alone turns it on — the whole point of keeping it", () => {
    expect(foldUnreadOrColdAliases({ stale: true }).unreadOrCold).toBe(true);
  });

  test("both true → on", () => {
    expect(foldUnreadOrColdAliases({ unreadOrCold: true, stale: true }).unreadOrCold).toBe(true);
  });

  test("an explicit false on the CURRENT name does NOT veto the alias", () => {
    // This is the case the R1 finding was about. The params declare
    // `defaultValue: false`, so this input is indistinguishable from omitting
    // the flag entirely — there is no "off, and override the alias" value to
    // send, so the fold cannot implement precedence here and does not claim to.
    expect(foldUnreadOrColdAliases({ unreadOrCold: false, stale: true }).unreadOrCold).toBe(true);
  });
});

describe("foldUnreadOrColdAliases — the threshold takes precedence", () => {
  test("neither supplied → undefined, so the domain default (90) applies", () => {
    expect(foldUnreadOrColdAliases({}).unreadOrColdDays).toBeUndefined();
  });

  test("the deprecated alias alone is used", () => {
    expect(foldUnreadOrColdAliases({ stalenessDays: 30 }).unreadOrColdDays).toBe(30);
  });

  test("the current name alone is used", () => {
    expect(foldUnreadOrColdAliases({ unreadOrColdDays: 45 }).unreadOrColdDays).toBe(45);
  });

  test("the current name WINS over the alias — unlike the flag above", () => {
    // `unreadOrColdDays` has no defaultValue, so `undefined` really does mean
    // "not supplied" and `??` is genuine precedence. The asymmetry with the
    // flag is deliberate and is why the two are asserted separately.
    expect(
      foldUnreadOrColdAliases({ unreadOrColdDays: 45, stalenessDays: 30 }).unreadOrColdDays
    ).toBe(45);
  });

  test("a zero threshold from the alias survives the fold rather than being dropped", () => {
    // Asserts the fold adds no filtering of its own: the param schema already
    // rejects 0 upstream (`z.number().int().positive()`), and this pins that
    // the fold does not silently apply a SECOND rule on top of it.
    //
    // Deliberately NOT offered as a `??`-vs-`||` discriminator — it isn't one.
    // With the left operand undefined both yield 0, which a negative control
    // run during PR #3593 R1 confirmed: swapping `??` for `||` left this case
    // green. The input that WOULD separate them (`unreadOrColdDays: 0` beside a
    // non-zero alias) cannot reach here, since the schema rejects the 0 first.
    expect(foldUnreadOrColdAliases({ stalenessDays: 0 }).unreadOrColdDays).toBe(0);
  });
});
