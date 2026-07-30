import { describe, test, expect } from "bun:test";
import { APPROVAL_TOKEN, APPROVAL_TOKEN_EXAMPLES, isApproveShapedToken } from "./ask-approval";

describe("APPROVAL_TOKEN", () => {
  test("accepts the documented approve-shaped tokens, case-insensitively", () => {
    for (const token of ["approve", "approved", "yes", "Approve", "APPROVED", "Yes"]) {
      expect(APPROVAL_TOKEN.test(token)).toBe(true);
    }
  });

  test("rejects descriptive labels and near-miss tokens", () => {
    for (const token of [
      "Approve the override and merge",
      "ok",
      "sure",
      "affirmative",
      "approve!",
      "not approved",
      "",
    ]) {
      expect(APPROVAL_TOKEN.test(token)).toBe(false);
    }
  });

  test("every example in APPROVAL_TOKEN_EXAMPLES actually matches the regex", () => {
    // Keeps the human-readable examples list from drifting out of sync with
    // the pattern it is meant to describe.
    for (const example of APPROVAL_TOKEN_EXAMPLES) {
      expect(APPROVAL_TOKEN.test(example)).toBe(true);
    }
  });
});

describe("isApproveShapedToken", () => {
  test("true for approve-shaped string values, trimming whitespace", () => {
    expect(isApproveShapedToken("approve")).toBe(true);
    expect(isApproveShapedToken(" approved \n")).toBe(true);
    expect(isApproveShapedToken("YES")).toBe(true);
  });

  test("false for non-string values", () => {
    expect(isApproveShapedToken(undefined)).toBe(false);
    expect(isApproveShapedToken(null)).toBe(false);
    expect(isApproveShapedToken(true)).toBe(false);
    expect(isApproveShapedToken({ value: "approve" })).toBe(false);
  });

  test("false for a descriptive label used as the value", () => {
    // The exact shape asks_create defaults `value` to when no explicit
    // value is supplied — a descriptive button label is NOT an
    // approve-shaped token.
    expect(isApproveShapedToken("Approve the override and merge")).toBe(false);
  });
});
