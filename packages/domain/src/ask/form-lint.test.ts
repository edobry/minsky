/**
 * Tests for the Ask form-lint checks (mt#2798).
 *
 * Covers each of the three v1 mechanical checks in isolation, a well-formed
 * ask producing zero warnings, and the paired zero-warnings/all-three-warnings
 * regression fixtures derived from ask 6807fb14 (R5 of the
 * escalation-packaging family — see the task spec's Context section).
 *
 * The REWRITTEN fixture below is the verbatim current content of ask
 * 6807fb14 (fetched via `asks_list` at implementation time — the rewrite
 * landed via `asks.edit` on 2026-07-15T16:53:17.141Z per its
 * `metadata.editHistory`).
 *
 * The ORIGINAL fixture is a reconstruction from the task spec's Context
 * section description (title, opening justification shape, the `mcp__`
 * tool-call quote, "the implementer App" click-path with no URL, ~200
 * words) — `asks.edit`'s editHistory records only the touched field names,
 * not a diff, so the literal pre-edit text is not retrievable from the Ask
 * record itself. The reconstruction satisfies every property named in the
 * spec's Context section and the Acceptance Tests' synthetic-bad-ask
 * description (contains `mcp__`, > 150 words, authorization.approve with a
 * portal keyword, no URL).
 */

import { describe, expect, test } from "bun:test";
import {
  computeFormLintMatches,
  computeFormWarnings,
  countWords,
  FORM_LINT_WORD_BUDGET,
  type FormLintInput,
} from "./form-lint";
import type { AskKind } from "./types";

const AUTHORIZATION_APPROVE: AskKind = "authorization.approve";
const DIRECTION_DECIDE: AskKind = "direction.decide";

// Centralized FormLintCheck literal references (defangs
// custom/no-magic-string-duplication across the assertions below).
const CHECK_INTERNAL_TOOL_ID = "internal-tool-id" as const;
const CHECK_OVER_WORD_BUDGET = "over-word-budget" as const;
const CHECK_PORTAL_NO_LINK = "portal-no-link" as const;

// ---------------------------------------------------------------------------
// countWords
// ---------------------------------------------------------------------------

describe("countWords", () => {
  test("counts whitespace-delimited words", () => {
    expect(countWords("one two three")).toBe(3);
  });

  test("collapses multiple whitespace runs", () => {
    expect(countWords("one   two\nthree")).toBe(3);
  });

  test("returns 0 for empty string", () => {
    expect(countWords("")).toBe(0);
  });

  test("returns 0 for whitespace-only string", () => {
    expect(countWords("   \n\t  ")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

describe("computeFormLintMatches — internal-tool-id check", () => {
  test("fires when question contains an mcp__ tool id", () => {
    const input: FormLintInput = {
      kind: DIRECTION_DECIDE,
      question: "I'll run mcp__minsky__setup_github-app to fix this.",
    };
    const matches = computeFormLintMatches(input);
    expect(matches.some((m) => m.check === CHECK_INTERNAL_TOOL_ID)).toBe(true);
    expect(matches.find((m) => m.check === CHECK_INTERNAL_TOOL_ID)?.message).toBe(
      "internal tool id in principal-facing text"
    );
  });

  test("does not fire when question has no mcp__ reference", () => {
    const input: FormLintInput = {
      kind: DIRECTION_DECIDE,
      question: "Please pick option A or B.",
    };
    expect(computeFormLintMatches(input).some((m) => m.check === CHECK_INTERNAL_TOOL_ID)).toBe(
      false
    );
  });
});

describe("computeFormLintMatches — over-word-budget check", () => {
  test(`fires when question exceeds ${FORM_LINT_WORD_BUDGET} words`, () => {
    const longQuestion = Array.from({ length: FORM_LINT_WORD_BUDGET + 1 }, () => "word").join(" ");
    const input: FormLintInput = { kind: DIRECTION_DECIDE, question: longQuestion };
    const matches = computeFormLintMatches(input);
    expect(matches.some((m) => m.check === CHECK_OVER_WORD_BUDGET)).toBe(true);
    expect(matches.find((m) => m.check === CHECK_OVER_WORD_BUDGET)?.message).toBe(
      "over form budget; move justification to contextRefs"
    );
  });

  test("does not fire at exactly the budget boundary (strictly greater-than)", () => {
    const boundaryQuestion = Array.from({ length: FORM_LINT_WORD_BUDGET }, () => "word").join(" ");
    const input: FormLintInput = { kind: DIRECTION_DECIDE, question: boundaryQuestion };
    expect(computeFormLintMatches(input).some((m) => m.check === CHECK_OVER_WORD_BUDGET)).toBe(
      false
    );
  });

  test("does not fire for a short question", () => {
    const input: FormLintInput = { kind: DIRECTION_DECIDE, question: "Short question." };
    expect(computeFormLintMatches(input).some((m) => m.check === CHECK_OVER_WORD_BUDGET)).toBe(
      false
    );
  });
});

describe("computeFormLintMatches — portal-no-link check", () => {
  test("fires for authorization.approve with a portal keyword and no URL", () => {
    const input: FormLintInput = {
      kind: AUTHORIZATION_APPROVE,
      question: "Please update the settings to grant this permission.",
    };
    const matches = computeFormLintMatches(input);
    expect(matches.some((m) => m.check === CHECK_PORTAL_NO_LINK)).toBe(true);
    expect(matches.find((m) => m.check === CHECK_PORTAL_NO_LINK)?.message).toBe(
      "portal action with no direct link"
    );
  });

  test("does not fire when a URL is present", () => {
    const input: FormLintInput = {
      kind: AUTHORIZATION_APPROVE,
      question: "Open https://github.com/settings/apps/foo/permissions and grant this.",
    };
    expect(computeFormLintMatches(input).some((m) => m.check === CHECK_PORTAL_NO_LINK)).toBe(false);
  });

  test("does not fire for a non-authorization.approve kind, even with portal keywords and no URL", () => {
    const input: FormLintInput = {
      kind: DIRECTION_DECIDE,
      question: "Please update the settings to grant this permission.",
    };
    expect(computeFormLintMatches(input).some((m) => m.check === CHECK_PORTAL_NO_LINK)).toBe(false);
  });

  test("does not fire when no portal keyword is present", () => {
    const input: FormLintInput = {
      kind: AUTHORIZATION_APPROVE,
      question: "Please confirm you want to proceed with the deploy.",
    };
    expect(computeFormLintMatches(input).some((m) => m.check === CHECK_PORTAL_NO_LINK)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Well-formed ask -> zero warnings
// ---------------------------------------------------------------------------

describe("computeFormWarnings — well-formed ask", () => {
  test("produces zero warnings", () => {
    const input: FormLintInput = {
      kind: AUTHORIZATION_APPROVE,
      question:
        "Open https://github.com/settings/apps/minsky-ai/permissions and set Actions to Read and write, then save.",
    };
    expect(computeFormWarnings(input)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Regression fixtures: ask 6807fb14 (escalation-packaging family R5)
// ---------------------------------------------------------------------------

describe("ask 6807fb14 regression fixtures", () => {
  // Verbatim current content of ask 6807fb14, fetched via asks_list at
  // implementation time (the rewrite that resolved the R5 incident).
  const REWRITTEN_QUESTION = [
    "**What you're being asked:** approve one permission on the **minsky-ai** GitHub App so the new CI-rerun tool can work.",
    "",
    "**Fastest path (~30 seconds):**",
    "1. Open https://github.com/settings/apps/minsky-ai/permissions",
    "2. Under **Repository permissions**, set **Actions** to **Read and write**, then **Save changes**",
    "3. GitHub will show an approval prompt for the installation — accept it",
    "",
    "**Or** pick \"File the request for me\" below and I'll submit the permission change on the app for you — GitHub will still send you a one-click approval (owner approval is required either way; that part can't be automated).",
    "",
    '**Why (one line):** the new flaky-CI-retry tool shipped yesterday ([PR #1920](https://github.com/edobry/minsky/pull/1920)) needs it; until then it returns a clear "missing permission" error and nothing else is blocked.',
  ].join("\n");

  // Reconstruction of the ORIGINAL failing ask 6807fb14 text per the task
  // spec's Context section: title/body opens with task/PR justification,
  // offers "[a] I run mcp__minsky__setup_github-app with update + the
  // widened permission set..." and a click-path naming only "the
  // implementer App", no URL, > 150 words.
  const ORIGINAL_QUESTION = [
    'This request is unblocking mt#2775 and the forge_ci_run_rerun tool that shipped in PR #1920. The tool needs the "Actions: read & write" permission on the implementer GitHub App to rerun failed CI checks on demand instead of requiring a fresh commit to retrigger the workflow. Right now the tool returns a clear "missing permission" error when it\'s called, and nothing else in the task graph is blocked by this — but until the permission is granted, the CI-rerun capability stays inert for every task that hits a flaky check, which has been happening several times a week across active sessions.',
    "",
    "There are two ways to get this done, and either one ends at the same GitHub-side owner-approval prompt:",
    "",
    "[a] I run mcp__minsky__setup_github-app with update mode and the widened permission set (Actions: read & write added on top of the app's current scope list). This calls the GitHub Apps manifest API to request the permission change, which still requires the app owner to approve the resulting installation-permission-update prompt before it actually takes effect for any installation — that final approval step cannot be automated away no matter which path we take here.",
    "",
    "[b] You update the implementer App's permissions yourself: open GitHub's Settings, find the implementer App under your installed/owned GitHub Apps, open its permissions page, locate the Actions permission under Repository permissions, change it from read-only to \"Read and write\", and save.",
    "",
    "Let me know which you'd prefer, or whether you'd rather leave it for now.",
  ].join("\n");

  test("REWRITTEN (current) content produces zero warnings", () => {
    expect(
      computeFormWarnings({ kind: AUTHORIZATION_APPROVE, question: REWRITTEN_QUESTION })
    ).toEqual([]);
  });

  test("ORIGINAL text produces all three warnings", () => {
    const matches = computeFormLintMatches({
      kind: AUTHORIZATION_APPROVE,
      question: ORIGINAL_QUESTION,
    });
    const checks = matches.map((m) => m.check).sort();
    expect(checks).toEqual(
      [CHECK_INTERNAL_TOOL_ID, CHECK_OVER_WORD_BUDGET, CHECK_PORTAL_NO_LINK].sort()
    );
  });

  test("ORIGINAL text is indeed over the word budget (sanity check on the fixture)", () => {
    expect(countWords(ORIGINAL_QUESTION)).toBeGreaterThan(FORM_LINT_WORD_BUDGET);
  });
});
