import { describe, expect, test } from "bun:test";

describe("strict-only utils", () => {
  test("normalizeTaskId has been removed in favor of strict qualified IDs", () => {
    // normalizeTaskId was removed; callers must pass qualified IDs directly.
    // Verify the utils module does not export normalizeTaskId.
    const utils = require("./utils");
    expect(utils.normalizeTaskId).toBeUndefined();
  });
});
