import { describe, expect, it } from "bun:test";
import {
  parseSmokeStatus,
  evaluateSmokeStatus,
  SMOKE_CHECK_OVERRIDE_ENV,
  EXPECTED_REVIEWER_LOGIN,
} from "../../../.minsky/hooks/require-review-before-merge";

describe("parseSmokeStatus", () => {
  it("returns 'pass' for Smoke: pass", () => {
    expect(parseSmokeStatus("**Smoke:** `pass`")).toBe("pass");
  });

  it("returns 'fail' for Smoke: fail", () => {
    expect(parseSmokeStatus("**Smoke:** `fail`")).toBe("fail");
  });

  it("returns 'skipped' for Smoke: skipped", () => {
    expect(parseSmokeStatus("**Smoke:** `skipped`")).toBe("skipped");
  });

  it("returns 'absent' when no Smoke field", () => {
    expect(parseSmokeStatus("## Summary\nLooks good.")).toBe("absent");
  });

  it("handles plain text without backticks or bold", () => {
    expect(parseSmokeStatus("Smoke: pass")).toBe("pass");
  });

  it("handles bold without backticks", () => {
    expect(parseSmokeStatus("**Smoke:** fail")).toBe("fail");
  });

  it("handles case-insensitively", () => {
    expect(parseSmokeStatus("**Smoke:** `PASS`")).toBe("pass");
    expect(parseSmokeStatus("**Smoke:** FAIL")).toBe("fail");
    expect(parseSmokeStatus("**Smoke:** Skipped")).toBe("skipped");
  });

  it("returns absent for empty body", () => {
    expect(parseSmokeStatus("")).toBe("absent");
  });

  it("returns absent for body with only bundle-boot-smoke (not the review Smoke field)", () => {
    expect(parseSmokeStatus("bundle-boot-smoke: success")).toBe("absent");
  });

  it("returns absent for bundle-boot-smoke: skipped (anchoring — not a review Smoke field)", () => {
    expect(parseSmokeStatus("bundle-boot-smoke: skipped")).toBe("absent");
  });

  it("returns absent for malformed Smoke values", () => {
    expect(parseSmokeStatus("Smoke: nope")).toBe("absent");
    expect(parseSmokeStatus("Smoke: maybe")).toBe("absent");
  });

  it("matches Smoke field at line start after other content", () => {
    expect(parseSmokeStatus("## CI status\nAll green\n**Smoke:** `pass`\n## Summary")).toBe("pass");
  });
});

describe("evaluateSmokeStatus", () => {
  const botLogin = EXPECTED_REVIEWER_LOGIN;
  const botOnlyBody = "## Spec verification\nAll good.";

  const makeReview = (body: string, login?: string) => ({
    body,
    commit_id: "abc1234",
    submitted_at: "2026-05-23T12:00:00Z",
    user_login: login,
  });

  it("denies when any review has Smoke: fail", () => {
    const reviews = [makeReview("**Smoke:** `fail`\n## Summary\nBad.", "some-agent")];
    const result = evaluateSmokeStatus(reviews, "42", botLogin);
    expect(result.deny).toBe(true);
    expect(result.reason).toContain("Smoke: fail");
  });

  it("permits when any review has Smoke: pass", () => {
    const reviews = [makeReview("**Smoke:** `pass`\n## Summary\nGood.", "some-agent")];
    const result = evaluateSmokeStatus(reviews, "42", botLogin);
    expect(result.deny).toBe(false);
  });

  it("permits when any review has Smoke: skipped", () => {
    const reviews = [makeReview("**Smoke:** `skipped`\n## Summary\nN/A.", "some-agent")];
    const result = evaluateSmokeStatus(reviews, "42", botLogin);
    expect(result.deny).toBe(false);
  });

  it("permits when all reviews are from bot and no Smoke field", () => {
    const reviews = [makeReview(botOnlyBody, botLogin)];
    const result = evaluateSmokeStatus(reviews, "42", botLogin);
    expect(result.deny).toBe(false);
  });

  it("denies when non-bot review lacks Smoke field", () => {
    const reviews = [makeReview("## Summary\nLooks good.", "some-agent")];
    const result = evaluateSmokeStatus(reviews, "42", botLogin);
    expect(result.deny).toBe(true);
    expect(result.reason).toContain("lacks a Smoke: field");
  });

  it("permits when bot review lacks Smoke but non-bot review has Smoke: pass", () => {
    const reviews = [
      makeReview(botOnlyBody, botLogin),
      makeReview("**Smoke:** `pass`\n## Summary\nGood.", "some-agent"),
    ];
    const result = evaluateSmokeStatus(reviews, "42", botLogin);
    expect(result.deny).toBe(false);
  });

  it("denies when Smoke: fail even if bot review exists", () => {
    const reviews = [
      makeReview(botOnlyBody, botLogin),
      makeReview("**Smoke:** `fail`\n## Summary\nBad.", "some-agent"),
    ];
    const result = evaluateSmokeStatus(reviews, "42", botLogin);
    expect(result.deny).toBe(true);
    expect(result.reason).toContain("Smoke: fail");
  });

  it("denies when human review has empty body (identity carve-out edge case)", () => {
    const reviews = [
      makeReview(botOnlyBody, botLogin),
      {
        body: "",
        commit_id: "abc1234",
        submitted_at: "2026-05-23T12:00:00Z",
        user_login: "some-human",
      },
    ];
    const result = evaluateSmokeStatus(reviews, "42", botLogin);
    expect(result.deny).toBe(true);
    expect(result.reason).toContain("lacks a Smoke: field");
  });

  it("permits on empty reviews array", () => {
    const result = evaluateSmokeStatus([], "42", botLogin);
    expect(result.deny).toBe(false);
  });
});

describe("constants", () => {
  it("exports the override env var name", () => {
    expect(SMOKE_CHECK_OVERRIDE_ENV).toBe("MINSKY_SKIP_SMOKE_CHECK");
  });
});
