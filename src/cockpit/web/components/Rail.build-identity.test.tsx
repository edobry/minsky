/**
 * Build-identity display in the Rail footer (mt#3241).
 *
 * The defect this pins: the footer reported ONE sha under the unqualified label
 * "Running commit". That sha is the DAEMON's — frozen at its first /api/health
 * call, accurate for the process — but readers took it for the bundle they were
 * looking at, which the tray rebuilds independently. On 2026-07-29 that reading
 * cost a diagnostic round.
 *
 * These assert the three states plus the two degraded ones, on the pure helper,
 * so they need no DOM and no live server. The geometry-free part of this task is
 * fully covered here; nothing about it requires a browser.
 */
import { describe, test, expect } from "bun:test";
import { describeBuildIdentity, readBundleCommit } from "./Rail";

describe("describeBuildIdentity", () => {
  test("bundle and daemon agree — one sha, both layers named in the tooltip", () => {
    const result = describeBuildIdentity("abc1234", "abc1234");

    expect(result).not.toBeNull();
    expect(result?.text).toBe("abc1234");
    expect(result?.diverged).toBe(false);
    // The label has to say WHICH layers agree, or the ambiguity survives the fix.
    expect(result?.title).toContain("UI bundle and server process");
    expect(result?.title).toContain("abc1234");
  });

  test("bundle newer than daemon — BOTH shas shown, flagged diverged", () => {
    // The originating scenario: tray rebuilt dist from a newer commit, daemon
    // still running the older code.
    const result = describeBuildIdentity("8411fde9d", "fc21cd9c6");

    expect(result?.diverged).toBe(true);
    // Both must be visible — showing only one is the defect.
    expect(result?.text).toContain("fc21cd9c6");
    expect(result?.text).toContain("8411fde9d");
    // And which is which must be legible, not positional.
    expect(result?.text).toBe("ui fc21cd9c6 · svc 8411fde9d");
    expect(result?.title).toContain("versioned independently");
  });

  test("divergence is not reported as an error state", () => {
    // It is the normal condition between a bundle rebuild and the next daemon
    // restart. If this ever reads as a failure, the badge becomes noise and gets
    // ignored — which is how it stopped being trustworthy the first time.
    const result = describeBuildIdentity("8411fde9d", "fc21cd9c6");

    expect(result?.title).not.toContain("error");
    expect(result?.title).not.toContain("stale");
    expect(result?.title).toContain("lags until it restarts");
  });

  test("bundle commit unavailable — falls back to the daemon sha, still labelled", () => {
    // A Docker or non-git build injects "unknown".
    const result = describeBuildIdentity("abc1234", "unknown");

    expect(result?.text).toBe("abc1234");
    expect(result?.diverged).toBe(false);
    expect(result?.title).toContain("Server process built from abc1234");
    expect(result?.title).toContain("Bundle build commit unavailable");
  });

  test("daemon commit unavailable — bundle sha still shown", () => {
    // Regression guard: the old render was gated on the daemon value, so a null
    // there dropped the badge entirely — including the half that actually answers
    // "what am I looking at".
    const result = describeBuildIdentity(null, "fc21cd9c6");

    expect(result?.text).toBe("fc21cd9c6");
    expect(result?.title).toContain("UI bundle built from fc21cd9c6");
    expect(result?.title).toContain("Server process commit unavailable");
  });

  test("neither available — renders nothing rather than an empty or bogus badge", () => {
    expect(describeBuildIdentity(null, "unknown")).toBeNull();
    expect(describeBuildIdentity(null, "")).toBeNull();
  });
});

describe("readBundleCommit", () => {
  /**
   * PR #2475 R1 caught this: the footer originally referenced `__BUILD_COMMIT__`
   * directly. It is a vite `define` — a compile-time text substitution, not a
   * runtime global — so in THIS environment (bun test, no vite) the identifier is
   * undeclared and evaluating it throws.
   *
   * Measured before fixing: a bare `const v = __BUILD_COMMIT__` here threw
   * `ReferenceError`. That means the pre-fix `RailFooter` would have thrown on
   * render in any non-bundled context, and the original test file could not see
   * it because it only exercised the pure function.
   *
   * The fact that these tests run at all under `bun test` is what makes them a
   * real guard: this file IS the non-bundled context.
   */
  test("returns a string instead of throwing when the vite define is absent", () => {
    // The call itself is the assertion — pre-fix, this line threw.
    expect(() => readBundleCommit()).not.toThrow();
    expect(typeof readBundleCommit()).toBe("string");
  });

  test("reports \"unknown\" when the define is absent, so the badge degrades", () => {
    // No vite here, so the define cannot have been substituted. Anything other
    // than "unknown" would mean the guard is reading something it shouldn't.
    expect(readBundleCommit()).toBe("unknown");
  });

  test("feeds describeBuildIdentity a value it treats as unavailable", () => {
    // End-to-end for the degraded path the footer actually takes under test:
    // guard -> "unknown" -> daemon-only display, still labelled.
    const identity = describeBuildIdentity("abc1234", readBundleCommit());
    expect(identity?.text).toBe("abc1234");
    expect(identity?.title).toContain("Bundle build commit unavailable");
  });
});
