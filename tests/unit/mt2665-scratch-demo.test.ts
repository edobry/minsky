// SCRATCH DEMONSTRATION — mt#2665 CI-hardening acceptance test.
//
// This file is deliberately broken to prove that .github/workflows/ci.yml's
// hardened `Test` step now fails the build on a genuine test failure. It is
// committed, pushed, and its resulting CI run captured for the mt#2665 PR
// body — then reverted in a follow-up commit before the PR is opened for
// review. Do NOT leave this file merged into main.
import { describe, expect, test } from "bun:test";

describe("mt#2665 scratch demo (deliberately broken, do not merge)", () => {
  test("deliberately fails to demonstrate the hardened CI Test step", () => {
    expect(1).toBe(2);
  });
});
