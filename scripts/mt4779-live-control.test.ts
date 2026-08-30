/**
 * TEMPORARY live control for mt#4779 — deliberately vacuous, removed in the
 * next commit. It imports nothing from this repo, so it executes none of this
 * PR's changed lines and the check must flag it.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

describe("mt#4779 live control (temporary)", () => {
  test("asserts on a stdlib function, touching none of this PR's changed code", () => {
    expect(join("a", "b")).toBe("a/b");
  });
});
