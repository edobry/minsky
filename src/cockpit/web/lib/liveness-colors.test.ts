/**
 * Tests for the shared liveness-dot color mapping (mt#2909).
 */
import { describe, expect, test } from "bun:test";
import { livenessDotClass, type Liveness } from "./liveness-colors";

describe("livenessDotClass", () => {
  const cases: [Liveness, string][] = [
    ["healthy", "bg-liveness-healthy"],
    ["idle", "bg-liveness-idle"],
    ["stale", "bg-liveness-stale"],
    ["orphaned", "bg-liveness-orphaned"],
    [null, ""],
  ];

  test.each(cases)("%s -> %s", (liveness, expected) => {
    expect(livenessDotClass(liveness)).toBe(expected);
  });
});
