/**
 * Tests for scripts/backfill-findings-from-webhook-events.ts (mt#3295).
 *
 * Covers only the pure helpers (extractReviewDelivery, assignRounds) — the
 * script's main() does real DB I/O and is exercised via the script's own
 * --dry-run mode by an operator, per the scripts' established pattern
 * (mirrors mine-ground-truth-corpus.test.ts covering only its pure helpers).
 */

import { describe, test, expect } from "bun:test";
import { extractReviewDelivery, assignRounds } from "./backfill-findings-from-webhook-events";

const BOT_LOGIN = "minsky-reviewer[bot]";

function buildPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "submitted",
    review: {
      commit_id: "abc123",
      body: "**[BLOCKING]** src/foo.ts:10 - Something is broken.",
      user: { login: BOT_LOGIN },
    },
    pull_request: { number: 42 },
    repository: { name: "minsky", owner: { login: "edobry" } },
    ...overrides,
  };
}

describe("extractReviewDelivery", () => {
  test("extracts a well-formed bot review submission", () => {
    const parsed = extractReviewDelivery(buildPayload());
    expect(parsed).toEqual({
      owner: "edobry",
      repo: "minsky",
      prNumber: 42,
      headSha: "abc123",
      reviewBody: "**[BLOCKING]** src/foo.ts:10 - Something is broken.",
    });
  });

  test("returns null for a non-submitted action", () => {
    expect(extractReviewDelivery(buildPayload({ action: "edited" }))).toBeNull();
  });

  test("returns null for a review not authored by the reviewer bot", () => {
    const payload = buildPayload();
    (payload["review"] as Record<string, unknown>)["user"] = { login: "some-human" };
    expect(extractReviewDelivery(payload)).toBeNull();
  });

  test("returns null for a non-object payload", () => {
    expect(extractReviewDelivery(null)).toBeNull();
    expect(extractReviewDelivery("not an object")).toBeNull();
    expect(extractReviewDelivery(42)).toBeNull();
  });

  test("returns null when required fields are missing", () => {
    expect(extractReviewDelivery({ action: "submitted" })).toBeNull();
    expect(
      extractReviewDelivery({
        action: "submitted",
        review: { user: { login: BOT_LOGIN } },
        pull_request: { number: 1 },
        repository: { name: "minsky", owner: { login: "edobry" } },
      })
    ).toBeNull();
  });

  test("returns null when pull_request.number is not a number", () => {
    const payload = buildPayload();
    (payload["pull_request"] as Record<string, unknown>)["number"] = "42";
    expect(extractReviewDelivery(payload)).toBeNull();
  });
});

describe("assignRounds", () => {
  test("assigns 1-based rounds in order", () => {
    const deliveries = [
      { owner: "edobry", repo: "minsky", prNumber: 1, headSha: "a", reviewBody: "r1" },
      { owner: "edobry", repo: "minsky", prNumber: 1, headSha: "b", reviewBody: "r2" },
      { owner: "edobry", repo: "minsky", prNumber: 1, headSha: "c", reviewBody: "r3" },
    ];
    const withRounds = assignRounds(deliveries);
    expect(withRounds.map((d) => d.round)).toEqual([1, 2, 3]);
  });

  test("returns an empty array for no deliveries", () => {
    expect(assignRounds([])).toEqual([]);
  });
});
