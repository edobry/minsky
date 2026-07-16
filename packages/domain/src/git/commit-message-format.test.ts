/**
 * Tests for the shared commit-message-format validator (mt#2821).
 *
 * This validator is the single source of truth `commitImpl` (fast-fail,
 * before shelling out to `git commit`) and the `commit-msg` git hook
 * (`src/hooks/commit-msg.ts`, the backstop for out-of-Minsky commits) both
 * call — these tests pin its behavior directly so both call sites stay in
 * lockstep.
 */
import { describe, expect, test } from "bun:test";
import {
  validateCommitMessageFormat,
  CONVENTIONAL_COMMIT_SUBJECT_MAX_LEN,
  FORBIDDEN_COMMIT_MESSAGES,
} from "./commit-message-format";

describe("validateCommitMessageFormat", () => {
  test("accepts a well-formed conventional commit message", () => {
    const result = validateCommitMessageFormat("feat(mt#2821): add commit message fail-fast");
    expect(result.valid).toBe(true);
  });

  test("accepts a message with a body", () => {
    const result = validateCommitMessageFormat(
      "fix(mt#2821): correct validation ordering\n\nLonger explanation of the change."
    );
    expect(result.valid).toBe(true);
  });

  test("accepts every conventional commit type", () => {
    for (const type of [
      "feat",
      "fix",
      "docs",
      "style",
      "refactor",
      "perf",
      "test",
      "chore",
      "ci",
      "build",
      "revert",
    ]) {
      const result = validateCommitMessageFormat(`${type}(mt#1): example description`);
      expect(result.valid).toBe(true);
    }
  });

  test("rejects a message with no conventional-commit prefix", () => {
    const result = validateCommitMessageFormat("just a plain message with no type prefix");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("conventional commits format");
  });

  test("rejects forbidden placeholder messages", () => {
    for (const placeholder of FORBIDDEN_COMMIT_MESSAGES) {
      const result = validateCommitMessageFormat(placeholder);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Forbidden placeholder message");
    }
  });

  test("rejects wip(...) even with a conventional-looking scope (the mt#1524 bug)", () => {
    const result = validateCommitMessageFormat("wip(mt#1524): foo");
    expect(result.valid).toBe(false);
  });

  test("rejects an unknown type", () => {
    const result = validateCommitMessageFormat("bogus(mt#1): description");
    expect(result.valid).toBe(false);
  });

  test("rejects a subject description over the max length", () => {
    const tooLong = `feat(mt#1): ${"x".repeat(CONVENTIONAL_COMMIT_SUBJECT_MAX_LEN + 20)}`;
    const result = validateCommitMessageFormat(tooLong);
    expect(result.valid).toBe(false);
  });

  test("accepts a subject description at exactly the max length", () => {
    const atMax = `feat(mt#1): ${"x".repeat(CONVENTIONAL_COMMIT_SUBJECT_MAX_LEN)}`;
    const result = validateCommitMessageFormat(atMax);
    expect(result.valid).toBe(true);
  });

  test("treats an empty/whitespace-only message as valid (not this validator's concern)", () => {
    expect(validateCommitMessageFormat("").valid).toBe(true);
    expect(validateCommitMessageFormat("   \n  ").valid).toBe(true);
  });

  test("does not reject a message that merely starts with 'Merge ' (branch-specific rule lives in the hook)", () => {
    const result = validateCommitMessageFormat("Merge branch 'main' into feature");
    expect(result.valid).toBe(true);
  });

  test("only validates the first line, ignoring an unrelated body", () => {
    const result = validateCommitMessageFormat(
      "feat(mt#1): valid title\n\nrandom body text that would not match the pattern on its own"
    );
    expect(result.valid).toBe(true);
  });
});
