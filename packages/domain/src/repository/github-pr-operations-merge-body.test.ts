/**
 * Tests for buildMergeCommitBody (mt#2215).
 *
 * The helper assembles the merge commit body from the PR body, optional git trailers, and an
 * optional audited-bypass signature, normalizing separators to exactly one blank line between
 * present blocks and keeping git trailers last. Guards against malformed messages when inputs
 * lack (or carry extra) leading/trailing newlines.
 */

import { describe, it, expect } from "bun:test";
import { buildMergeCommitBody } from "./github-pr-operations";

const TRAILERS = "Co-authored-by: minsky-ai[bot] <bot@users.noreply.github.com>";
const AUDIT =
  "\n\nBot self-approval bypass per feedback_self_authored_pr_merge_constraints\nReason: verified false-positive";

describe("buildMergeCommitBody", () => {
  it("joins body + bypass + trailers with single blank lines, trailers last", () => {
    const out = buildMergeCommitBody("PR body line.", TRAILERS, AUDIT);
    expect(out).toBe(
      `PR body line.\n\n` +
        `Bot self-approval bypass per feedback_self_authored_pr_merge_constraints\n` +
        `Reason: verified false-positive\n\n${TRAILERS}`
    );
    // Trailers must come after the audit block (git-trailer parsing requires them last).
    expect(out.indexOf(TRAILERS)).toBeGreaterThan(out.indexOf("Bot self-approval bypass"));
  });

  it("normalizes a body that lacks a trailing newline", () => {
    const out = buildMergeCommitBody("no trailing newline", undefined, AUDIT);
    expect(out).toBe(
      "no trailing newline\n\n" +
        "Bot self-approval bypass per feedback_self_authored_pr_merge_constraints\n" +
        "Reason: verified false-positive"
    );
    // Exactly one blank line between blocks — never zero, never more than one.
    expect(out).not.toContain("\n\n\n");
    expect(out).not.toMatch(/newline\nBot/);
  });

  it("normalizes a body that has extra trailing newlines", () => {
    const out = buildMergeCommitBody("body with trailing newlines\n\n\n", TRAILERS, undefined);
    expect(out).toBe(`body with trailing newlines\n\n${TRAILERS}`);
    expect(out).not.toContain("\n\n\n");
  });

  it("returns just the body when trailers and bypass are absent", () => {
    expect(buildMergeCommitBody("only body", undefined, undefined)).toBe("only body");
  });

  it("omits empty/whitespace-only blocks", () => {
    expect(buildMergeCommitBody("", "   ", "")).toBe("");
    expect(buildMergeCommitBody("body", "", undefined)).toBe("body");
  });

  it("emits body + trailers (no bypass) with a single blank line", () => {
    expect(buildMergeCommitBody("body", TRAILERS, undefined)).toBe(`body\n\n${TRAILERS}`);
  });
});
