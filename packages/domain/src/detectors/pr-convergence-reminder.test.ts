/**
 * Decision tests for the drive-PR-to-convergence reminder.
 *
 * Moved here from `.minsky/hooks/drive-pr-to-convergence.test.ts` by mt#4374
 * (SC4). Note what is NOT in this file: no `makeInput` helper, no
 * `ToolHookInput`, no `tool_result` envelope. The decision takes plain values,
 * so the tests construct plain values — mt#4374 AT2.
 */
import { describe, expect, test } from "bun:test";
import {
  DRIVE_TO_CONVERGENCE_REMINDER,
  PR_CREATE_TOOL_NAME,
  decidePrConvergenceReminder,
} from "./pr-convergence-reminder";

describe("decidePrConvergenceReminder", () => {
  test("emits the reminder on a successful session_pr_create", () => {
    expect(decidePrConvergenceReminder({ toolName: PR_CREATE_TOOL_NAME, succeeded: true })).toBe(
      DRIVE_TO_CONVERGENCE_REMINDER
    );
  });

  test("silent on a failed session_pr_create", () => {
    expect(
      decidePrConvergenceReminder({ toolName: PR_CREATE_TOOL_NAME, succeeded: false })
    ).toBeNull();
  });

  test("silent on a non-matching tool name", () => {
    expect(
      decidePrConvergenceReminder({ toolName: "mcp__minsky__session_commit", succeeded: true })
    ).toBeNull();
  });

  test("silent on Bash (covers wildcard PostToolUse matchers that might union)", () => {
    expect(decidePrConvergenceReminder({ toolName: "Bash", succeeded: true })).toBeNull();
  });

  test("silent on session_pr_merge (sibling tool, not in scope)", () => {
    expect(
      decidePrConvergenceReminder({ toolName: "mcp__minsky__session_pr_merge", succeeded: true })
    ).toBeNull();
  });
});

describe("DRIVE_TO_CONVERGENCE_REMINDER content", () => {
  test("references the corpus rule for traceability", () => {
    // The reminder references the corpus rule by section-name shorthand
    // (§User-does-not-review-PRs) and by source file (decision-defaults.mdc).
    // Match both substrings — the exact phrasing of the §-shorthand can
    // change without breaking the rule-citation contract.
    expect(DRIVE_TO_CONVERGENCE_REMINDER).toContain("§User-does-not-review-PRs");
    expect(DRIVE_TO_CONVERGENCE_REMINDER).toContain("decision-defaults.mdc");
  });

  test("names the required next action explicitly", () => {
    expect(DRIVE_TO_CONVERGENCE_REMINDER).toContain("session_pr_wait-for-review");
  });

  test("names the webhook-miss fallback (empty commit wake, not reviewer dispatch)", () => {
    expect(DRIVE_TO_CONVERGENCE_REMINDER).toContain("empty commit");
    expect(DRIVE_TO_CONVERGENCE_REMINDER).toContain("Do NOT dispatch a reviewer subagent");
  });

  test("forbids the originating deferral phrases", () => {
    // Originating-incident phrase from PR #1076.
    expect(DRIVE_TO_CONVERGENCE_REMINDER).toContain("Ping me when done");
    // Slow-ask variants.
    expect(DRIVE_TO_CONVERGENCE_REMINDER).toContain("Let me know when merged");
    expect(DRIVE_TO_CONVERGENCE_REMINDER).toContain("Ready for your review");
  });

  test("includes the slow-ask framing reference", () => {
    expect(DRIVE_TO_CONVERGENCE_REMINDER).toContain("slow-ask variant");
  });

  test("encodes the success branches (APPROVE / CHANGES_REQUESTED)", () => {
    expect(DRIVE_TO_CONVERGENCE_REMINDER).toContain("APPROVE");
    expect(DRIVE_TO_CONVERGENCE_REMINDER).toContain("CHANGES_REQUESTED");
  });
});
