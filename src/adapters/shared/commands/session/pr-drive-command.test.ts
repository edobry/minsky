/**
 * Unit tests for the session.pr.drive adapter's text-mode rendering
 * (mt#2647). Locks the rendering contract for each terminal state.
 */

import { describe, expect, test } from "bun:test";
import { formatDriveMessage } from "./pr-drive-command";
import type { SessionPrDriveResult } from "@minsky/domain/session/commands/pr-drive-subcommand";

const REVIEWER_BOT = "minsky-reviewer[bot]";
const CHANGES_REQUESTED_STATE = "CHANGES_REQUESTED" as const;

describe("formatDriveMessage", () => {
  test("READY_TO_MERGE renders review + checks summary and next-step instruction", () => {
    const result: SessionPrDriveResult = {
      state: "READY_TO_MERGE",
      review: {
        reviewId: 1,
        state: "APPROVED",
        submittedAt: "2026-07-07T00:00:00Z",
        reviewerLogin: REVIEWER_BOT,
        body: "",
      },
      checks: {
        allPassed: true,
        summary: { total: 3, passed: 3, failed: 0, pending: 0 },
        checks: [],
      },
      elapsedMs: 45_000,
    };
    const msg = formatDriveMessage(result);
    expect(msg).toContain("READY_TO_MERGE");
    expect(msg).toContain(REVIEWER_BOT);
    expect(msg).toContain("3/3 passed");
    expect(msg).toContain("45s");
    expect(msg).toContain("call session.pr.merge");
  });

  test("READY_TO_MERGE with skipped checks renders the skipped note", () => {
    const result: SessionPrDriveResult = {
      state: "READY_TO_MERGE",
      review: {
        reviewId: 1,
        state: "APPROVED",
        submittedAt: "2026-07-07T00:00:00Z",
        reviewerLogin: REVIEWER_BOT,
        body: "",
      },
      checks: null,
      elapsedMs: 5_000,
    };
    const msg = formatDriveMessage(result);
    expect(msg).toContain("skipped (skipChecks)");
  });

  test("CHANGES_REQUESTED stops and includes body + re-invoke hint", () => {
    const result: SessionPrDriveResult = {
      state: CHANGES_REQUESTED_STATE,
      review: {
        reviewId: 2,
        state: CHANGES_REQUESTED_STATE,
        submittedAt: "2026-07-07T00:10:00Z",
        reviewerLogin: REVIEWER_BOT,
        body: "fix the null check",
        htmlUrl: "https://github.com/edobry/minsky/pull/1#pullrequestreview-2",
      },
      elapsedMs: 30_000,
    };
    const msg = formatDriveMessage(result);
    expect(msg).toContain(CHANGES_REQUESTED_STATE);
    expect(msg).toContain("stopping, not merging");
    expect(msg).toContain("fix the null check");
    expect(msg).toContain("2026-07-07T00:10:00Z");
    expect(msg).toContain('Re-invoke with since: "2026-07-07T00:10:00Z"');
  });

  test("COMMENT stops and is never described as approval", () => {
    const result: SessionPrDriveResult = {
      state: "COMMENT",
      review: {
        reviewId: 3,
        state: "COMMENTED",
        submittedAt: "2026-07-07T00:20:00Z",
        reviewerLogin: REVIEWER_BOT,
        body: "no blockers, just a note",
      },
      elapsedMs: 10_000,
    };
    const msg = formatDriveMessage(result);
    expect(msg).toContain("COMMENT");
    expect(msg).toContain("stopping, not merging");
    expect(msg).not.toContain("READY_TO_MERGE");
  });

  test("CHECKS_FAILED renders the checks summary", () => {
    const result: SessionPrDriveResult = {
      state: "CHECKS_FAILED",
      review: {
        reviewId: 4,
        state: "APPROVED",
        submittedAt: "2026-07-07T00:30:00Z",
        reviewerLogin: REVIEWER_BOT,
        body: "",
      },
      checks: {
        allPassed: false,
        summary: { total: 2, passed: 1, failed: 1, pending: 0 },
        checks: [],
      },
      elapsedMs: 60_000,
    };
    const msg = formatDriveMessage(result);
    expect(msg).toContain("checks failed");
    expect(msg).toContain("1/2 passed");
    expect(msg).toContain("1 failed");
  });

  test("CHECKS_TIMEOUT renders distinctly from CHECKS_FAILED", () => {
    const result: SessionPrDriveResult = {
      state: "CHECKS_TIMEOUT",
      review: {
        reviewId: 5,
        state: "APPROVED",
        submittedAt: "2026-07-07T00:40:00Z",
        reviewerLogin: REVIEWER_BOT,
        body: "",
      },
      checks: {
        allPassed: false,
        timedOut: true,
        summary: { total: 2, passed: 1, failed: 0, pending: 1 },
        checks: [],
      },
      elapsedMs: 600_000,
    };
    const msg = formatDriveMessage(result);
    expect(msg).toContain("checks timed out");
    expect(msg).toContain("1 pending");
  });

  test("REVIEW_TIMEOUT renders elapsed, poll count, and threshold", () => {
    const result: SessionPrDriveResult = {
      state: "REVIEW_TIMEOUT",
      elapsedMs: 600_000,
      pollCount: 21,
      sinceUsed: "2026-07-07T00:00:00.000Z",
      lastSeenReviews: [],
    };
    const msg = formatDriveMessage(result);
    expect(msg).toContain("No matching review after 600s");
    expect(msg).toContain("21 poll(s)");
    expect(msg).toContain("2026-07-07T00:00:00.000Z");
  });
});
