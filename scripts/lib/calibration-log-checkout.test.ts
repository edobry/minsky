/**
 * mt#4971 / PR #3624 R1 — the log-path → checkout derivation, and what it refuses to guess.
 *
 * Pure functions over strings; no filesystem, so no `no-real-fs-in-tests` exemption is needed.
 */

import { describe, expect, test } from "bun:test";
import { checkoutForLegacyLogPath, transcriptRootFallbackNotice } from "./calibration-log-checkout";

describe("checkoutForLegacyLogPath", () => {
  test("recovers the checkout from the pre-mt#4748 layout", () => {
    // The coupling the reviewer flagged as broken: `--calibration-log <other>/…` steering
    // transcript selection to THAT checkout.
    expect(
      checkoutForLegacyLogPath("/Users/x/Projects/minsky/.minsky/wall-of-text-calibration.jsonl")
    ).toBe("/Users/x/Projects/minsky");
    expect(checkoutForLegacyLogPath("/a/b/c/.minsky/anything.jsonl")).toBe("/a/b/c");
  });

  test("refuses a state-dir path rather than computing a wrong checkout", () => {
    // `dirname(dirname(…))` here yields `/Users/x/.local/state/minsky`, which is not a checkout.
    // Returning that confidently is worse than returning nothing, which is the whole point.
    expect(
      checkoutForLegacyLogPath(
        "/Users/x/.local/state/minsky/projects/a0809beec3ba7e98/wall-of-text-calibration.jsonl"
      )
    ).toBeNull();
  });

  test("refuses shapes that name no checkout", () => {
    expect(checkoutForLegacyLogPath("wall-of-text-calibration.jsonl")).toBeNull();
    expect(checkoutForLegacyLogPath("/somewhere/else/wall-of-text-calibration.jsonl")).toBeNull();
    // A root-level `.minsky` degenerates: `dirname("/.minsky")` is "/", not a checkout.
    expect(checkoutForLegacyLogPath("/.minsky/x.jsonl")).toBeNull();
  });

  test("keys on the parent directory, not on a substring anywhere in the path", () => {
    // A checkout that happens to be NAMED `.minsky-something`, or a `.minsky` segment further
    // up, must not be mistaken for the legacy layout.
    expect(checkoutForLegacyLogPath("/a/.minsky/hooks/x.jsonl")).toBeNull();
    expect(checkoutForLegacyLogPath("/a/.minsky-archive/x.jsonl")).toBeNull();
  });
});

describe("transcriptRootFallbackNotice", () => {
  test("names both the fallback root and the path that could not steer", () => {
    // The finding was that the fallback was SILENT, so the notice has to carry both halves for
    // the operator to see what happened.
    const notice = transcriptRootFallbackNotice("/state/projects/abc/x.jsonl", "/repo");
    expect(notice).toContain("/repo");
    expect(notice).toContain("/state/projects/abc/x.jsonl");
    expect(notice).toContain("one-way hash");
  });
});
