/**
 * Tests for the process-wide GitHub rate-limit snapshot store (mt#2888).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  recordRateLimitHeaders,
  getLastGithubRateLimitSnapshot,
  resetGithubRateLimitStateForTests,
} from "./github-rate-limit-state";

const REMAINING_HEADER = "x-ratelimit-remaining";
const LIMIT_HEADER = "x-ratelimit-limit";
const RESET_HEADER = "x-ratelimit-reset";
const RESOURCE_HEADER = "x-ratelimit-resource";

describe("recordRateLimitHeaders / getLastGithubRateLimitSnapshot", () => {
  // beforeEach: the snapshot store is process-wide module state; under
  // bunfig randomize:true another test file (e.g. github-error-handler.test)
  // may have recorded headers before this file runs, so the null-state test
  // must start from an explicit reset, not module-load freshness (the
  // CI-only ordering failure on PR #2018 R3). afterEach keeps this file
  // from leaking state onward.
  beforeEach(() => {
    resetGithubRateLimitStateForTests();
  });
  afterEach(() => {
    resetGithubRateLimitStateForTests();
  });

  test("returns null before any headers are recorded", () => {
    expect(getLastGithubRateLimitSnapshot()).toBeNull();
  });

  test("captures remaining/limit/reset from GitHub's documented header names", () => {
    const resetEpochSeconds = Math.floor(Date.parse("2026-07-16T23:22:00Z") / 1000);
    recordRateLimitHeaders({
      [REMAINING_HEADER]: "42",
      [LIMIT_HEADER]: "5000",
      [RESET_HEADER]: String(resetEpochSeconds),
      [RESOURCE_HEADER]: "core",
    });

    const snapshot = getLastGithubRateLimitSnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot?.remaining).toBe(42);
    expect(snapshot?.limit).toBe(5000);
    expect(snapshot?.reset).toBe("2026-07-16T23:22:00.000Z");
    expect(snapshot?.resource).toBe("core");
    expect(typeof snapshot?.observedAt).toBe("string");
  });

  test("a later call overwrites the earlier snapshot (last-observed semantics)", () => {
    recordRateLimitHeaders({ [REMAINING_HEADER]: "100", [RESET_HEADER]: "1000" });
    recordRateLimitHeaders({ [REMAINING_HEADER]: "10", [RESET_HEADER]: "2000" });
    expect(getLastGithubRateLimitSnapshot()?.remaining).toBe(10);
  });

  test("silently no-ops on missing headers object", () => {
    recordRateLimitHeaders(undefined);
    recordRateLimitHeaders(null);
    expect(getLastGithubRateLimitSnapshot()).toBeNull();
  });

  test("silently no-ops when remaining or reset is absent", () => {
    recordRateLimitHeaders({ [LIMIT_HEADER]: "5000" });
    expect(getLastGithubRateLimitSnapshot()).toBeNull();
  });

  test("silently no-ops on unparseable numeric values", () => {
    recordRateLimitHeaders({ [REMAINING_HEADER]: "not-a-number", [RESET_HEADER]: "1000" });
    expect(getLastGithubRateLimitSnapshot()).toBeNull();
  });

  test("falls back to remaining when limit is unparseable", () => {
    recordRateLimitHeaders({
      [REMAINING_HEADER]: "7",
      [LIMIT_HEADER]: "not-a-number",
      [RESET_HEADER]: "1000",
    });
    expect(getLastGithubRateLimitSnapshot()?.limit).toBe(7);
  });
});
