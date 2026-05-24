/**
 * Tests for the Critic Constitution builder.
 *
 * The tool-access section must only appear when the caller asserts tools are
 * available — mt#1126 minsky-reviewer finding #3 surfaced that including it
 * unconditionally lies to providers that can't call tools (Gemini, Anthropic).
 *
 * Scope-aware calibration sections (mt#1188) are tested in the second describe
 * block below. The normal-scope path must be byte-identical to the pre-mt#1188
 * prompt.
 */

import { describe, expect, test } from "bun:test";
import {
  buildCriticConstitution,
  buildReviewPrompt,
  buildReviewThreadsSection,
  CRITIC_CONSTITUTION,
  extractOutOfRepoReferences,
  type ReviewPromptInput,
} from "./prompt";
import type { ReviewThread } from "./github-client";

// Shared string constants used across multiple test assertions.
// Extracted to prevent the no-magic-string-duplication lint rule from triggering.
const NO_TOOLS_SECTION_HEADING = "## Cross-file claims without tool access";
const IN_REPO_CARVE_OUT_PHRASE = "This rule does NOT apply to in-repo paths";
const SCOPE_CALIBRATION_HEADING = "## Scope-aware calibration";
const RESERVE_BLOCKING = "reserve BLOCKING severity";
const DIFF_VS_DESC_EXCEPTION = "Exception — diff-vs-description mismatch on in-repo paths";
const INTERNAL_SCRATCH = "internal scratch";

// Verification-mode preamble (mt#1656 / mt#1640 Fix 1) signature phrases.
// Extracted to satisfy custom/no-magic-string-duplication.
const VERIFICATION_PREAMBLE_R2_PHRASE = "subsequent round of review";
const VERIFICATION_PREAMBLE_TASK_PHRASE = "verification, not fresh adversarial discovery";

describe("buildCriticConstitution", () => {
  test("includes the Tool access section when toolsAvailable=true", () => {
    const prompt = buildCriticConstitution(true);
    expect(prompt).toContain("## Tool access");
    expect(prompt).toContain("read_file(path)");
    expect(prompt).toContain("list_directory(path)");
    expect(prompt).not.toContain("## Cross-file claims without tool access");
  });

  test("omits the Tool access section and substitutes no-tools guidance when toolsAvailable=false", () => {
    const prompt = buildCriticConstitution(false);
    expect(prompt).not.toContain("## Tool access");
    expect(prompt).not.toContain("read_file(path)");
    expect(prompt).not.toContain("list_directory(path)");
    expect(prompt).toContain(NO_TOOLS_SECTION_HEADING);
    expect(prompt).toContain("You do NOT have file-reading tools");
  });

  test("both variants include the preamble, principles, failure modes, and output format", () => {
    for (const toolsAvailable of [true, false]) {
      const prompt = buildCriticConstitution(toolsAvailable);
      expect(prompt).toContain("adversarial reviewer");
      expect(prompt).toContain("## Principles");
      expect(prompt).toContain("## Failure modes to watch for specifically");
      expect(prompt).toContain("## Output format");
      expect(prompt).toContain("REQUEST_CHANGES");
    }
  });

  test("NEEDS VERIFICATION guidance appears in both variants", () => {
    // Both contexts steer the model toward marking cross-file claims as
    // NEEDS VERIFICATION — the prompt just differs on WHY (tools available
    // but not yet used vs. no tools at all).
    expect(buildCriticConstitution(true)).toContain("NEEDS VERIFICATION");
    expect(buildCriticConstitution(false)).toContain("NEEDS VERIFICATION");
  });

  test("normal scope (default) is byte-identical to pre-mt#1188 prompt (no extra section)", () => {
    // The normal-scope path must not inject any extra sections — preserves
    // backwards compatibility for callers that don't pass a scope.
    const defaultPrompt = buildCriticConstitution(true);
    const explicitNormal = buildCriticConstitution(true, "normal");
    expect(defaultPrompt).toBe(explicitNormal);
    expect(defaultPrompt).not.toContain(SCOPE_CALIBRATION_HEADING);
  });
});

describe("CRITIC_CONSTITUTION legacy export", () => {
  test("matches buildCriticConstitution(true) for backwards compatibility", () => {
    expect(CRITIC_CONSTITUTION).toBe(buildCriticConstitution(true));
  });
});

// ----- Verification-mode preamble (mt#1656 / mt#1640 Fix 1) -----
//
// When priorReviewsPresent=true, swap the standard adversarial preamble for
// a verification-mode preamble that defaults to APPROVE when prior BLOCKING
// findings have been addressed and no critical defects remain. The reframe
// cancels the asymmetric incentive (find-SOMETHING-every-round) that produces
// the no-stopping-rule iteration pattern named in mt#1640.

describe("buildCriticConstitution — verification-mode preamble (mt#1656)", () => {
  test("priorReviewsPresent=false (default) uses the standard adversarial preamble", () => {
    const prompt = buildCriticConstitution(true, "normal", false);
    // Standard preamble's "Your role is structurally adversarial" sentence
    // must be present.
    expect(prompt).toContain("Your role is structurally adversarial");
    // Standard preamble's asymmetric-incentive sentence must be present.
    expect(prompt).toContain('A review that says "looks good to me" is a failed review');
    // Verification-specific phrasing must NOT appear in R1 mode.
    expect(prompt).not.toContain(VERIFICATION_PREAMBLE_R2_PHRASE);
    expect(prompt).not.toContain(VERIFICATION_PREAMBLE_TASK_PHRASE);
  });

  test("priorReviewsPresent=true substitutes the verification-mode preamble", () => {
    const prompt = buildCriticConstitution(true, "normal", false, true);
    // Verification preamble identifies itself as R≥2.
    expect(prompt).toContain(VERIFICATION_PREAMBLE_R2_PHRASE);
    expect(prompt).toContain(VERIFICATION_PREAMBLE_TASK_PHRASE);
    // Standard preamble's asymmetric-incentive sentence must NOT appear in
    // verification mode (it's the precise framing being swapped out).
    expect(prompt).not.toContain('A review that says "looks good to me" is a failed review');
    expect(prompt).not.toContain("Your role is structurally adversarial");
  });

  test("verification preamble explicitly names the two legitimate-new-BLOCKING criteria", () => {
    const prompt = buildCriticConstitution(true, "normal", false, true);
    // (a) introduced by the fix itself
    expect(prompt).toContain("introduced or modified by the fix commit itself");
    // (b) critical issues R1 missed and would block production
    expect(prompt).toContain("critical correctness, security, or data-loss issue that R1 missed");
    expect(prompt).toContain("would block production");
  });

  test("verification preamble explicitly names the default-APPROVE branch", () => {
    const prompt = buildCriticConstitution(true, "normal", false, true);
    expect(prompt).toContain("If neither (a) nor (b) applies, your event verdict is APPROVE");
  });

  test("verification preamble names bikeshedding-class concerns to suppress", () => {
    const prompt = buildCriticConstitution(true, "normal", false, true);
    // The categories the preamble explicitly enumerates as suppressible at R≥2.
    expect(prompt).toContain("regex robustness on inputs that won't occur");
    expect(prompt).toContain("allowlist completeness");
    expect(prompt).toContain("error-message phrasing");
  });

  test("verification preamble preserves the severity-monotonicity paragraph verbatim", () => {
    const prompt = buildCriticConstitution(true, "normal", false, true);
    // The current-commit-only / no-re-litigate constraint is load-bearing in
    // both modes and must be preserved verbatim in the verification preamble.
    expect(prompt).toContain("You do NOT re-litigate prior rounds");
    expect(prompt).toContain(
      "Re-escalating a prior NON-BLOCKING or PRE-EXISTING finding to BLOCKING without new code evidence"
    );
    expect(prompt).toContain("it is what your role IS");
  });

  test("verification preamble paragraph 3 opens with 'Your verification has structure' (intentional one-word swap)", () => {
    // Paragraph 3 of the verification preamble opens "Your verification has
    // structure" instead of the standard preamble's "Your adversariality has
    // structure" — an intentional adjustment to fit the reframed role. The
    // substantive constraint that follows (no-re-litigate / severity-
    // monotonicity) is preserved verbatim. Locked here so the deviation is
    // testable rather than implicit.
    const prompt = buildCriticConstitution(true, "normal", false, true);
    expect(prompt).toContain("Your verification has structure");
    expect(prompt).not.toContain("Your adversariality has structure");
  });

  test("priorReviewsPresent works across scope buckets and output-tools modes", () => {
    // The verification preamble swap is independent of scope and output-tools
    // mode. All four combinations must include the verification framing.
    const matrix: Array<{
      scope: "normal" | "trivial-or-docs" | "test-only";
      outputTools: boolean;
    }> = [
      { scope: "normal", outputTools: false },
      { scope: "normal", outputTools: true },
      { scope: "trivial-or-docs", outputTools: false },
      { scope: "test-only", outputTools: true },
    ];
    for (const { scope, outputTools } of matrix) {
      const prompt = buildCriticConstitution(true, scope, outputTools, true);
      expect(prompt).toContain(VERIFICATION_PREAMBLE_R2_PHRASE);
      expect(prompt).toContain(VERIFICATION_PREAMBLE_TASK_PHRASE);
    }
  });

  test("priorReviewsPresent=true with toolsAvailable=false still swaps the preamble", () => {
    // The verification-mode swap is orthogonal to tool availability. Even on
    // the no-tools path (Gemini, Anthropic, fork-blocked), R≥2 reviews still
    // get the verification preamble.
    const prompt = buildCriticConstitution(false, "normal", false, true);
    expect(prompt).toContain(VERIFICATION_PREAMBLE_R2_PHRASE);
    expect(prompt).toContain(VERIFICATION_PREAMBLE_TASK_PHRASE);
  });

  test("default value for priorReviewsPresent is false (legacy CRITIC_CONSTITUTION unchanged)", () => {
    // Backward compatibility: the legacy export must not switch into
    // verification mode silently. CRITIC_CONSTITUTION is built without the
    // priorReviewsPresent flag and must remain byte-identical to the
    // 4-arg false call.
    expect(CRITIC_CONSTITUTION).toBe(buildCriticConstitution(true, "normal", false, false));
    expect(CRITIC_CONSTITUTION).not.toContain(VERIFICATION_PREAMBLE_R2_PHRASE);
  });
});

// ----- TOOL_ACCESS_SECTION envelope documentation (mt#1216) -----
//
// The model parses tool results as JSON envelopes (mt#1216 unified the two
// prior result shapes into `{ ok, … }` envelopes). The prompt MUST document
// those fields so the model can reason about the result format; otherwise
// it regresses to treating the whole JSON blob as file content.

describe("buildCriticConstitution — TOOL_ACCESS_SECTION envelope fields", () => {
  const prompt = buildCriticConstitution(true);

  test("documents the envelope discriminator", () => {
    expect(prompt).toContain('"ok": true');
    expect(prompt).toContain('"ok": false');
  });

  test("documents read_file fields: content, truncated, binary, size", () => {
    expect(prompt).toContain('"content"');
    expect(prompt).toContain('"truncated"');
    expect(prompt).toContain('"binary"');
    expect(prompt).toContain('"size"');
  });

  test("documents list_directory fields: entries + the four entry types", () => {
    expect(prompt).toContain('"entries"');
    expect(prompt).toContain('"file"');
    expect(prompt).toContain('"dir"');
    expect(prompt).toContain('"symlink"');
    expect(prompt).toContain('"submodule"');
  });

  test("documents the not_found error sentinel", () => {
    expect(prompt).toContain('"not_found"');
  });

  test("documents the error field on the failure branch", () => {
    expect(prompt).toContain('"error"');
  });

  test("no-tools variant still does NOT mention envelope fields (those docs are off when tools are off)", () => {
    const noTools = buildCriticConstitution(false);
    expect(noTools).not.toContain('"ok": true');
    expect(noTools).not.toContain('"truncated"');
    expect(noTools).not.toContain('"entries"');
  });
});

describe("out-of-repo reference clause", () => {
  test("enumerates recognized out-of-repo path patterns", () => {
    const prompt = buildCriticConstitution(true);
    expect(prompt).toContain("~/.claude");
    expect(prompt).toContain("$HOME");
    expect(prompt).toContain("Out-of-repo references");
  });

  test("absolute_system scope is explicitly bounded — /home and /Users are excluded from that pattern", () => {
    // Narrative alignment for mt#1339 BLOCKING #1: the prompt text must
    // enumerate the exact set of absolute_system paths (/etc, /usr, /var,
    // /opt, /tmp, /root) and explicitly state that /home and /Users are NOT
    // included — both paths are routinely in-repo on developer and CI machines.
    const prompt = buildCriticConstitution(true);
    // The exhaustive list must be present.
    expect(prompt).toContain("/etc/");
    expect(prompt).toContain("/opt/");
    expect(prompt).toContain("/tmp/");
    expect(prompt).toContain("/root/");
    // The exclusion note must be explicit so no reader infers /home or /Users
    // are detected under the absolute_system pattern.
    expect(prompt).toContain("/home/");
    expect(prompt).toContain("/Users/");
    expect(prompt).toContain("NOT included");
  });

  test("instructs reviewer to treat out-of-repo paths as NON-BLOCKING", () => {
    const prompt = buildCriticConstitution(true);
    // The clause must be present in both tool-access variants
    expect(prompt).toContain("NON-BLOCKING");
    expect(prompt).toContain("out-of-repo path");
    expect(prompt).toContain("reviewer cannot verify");
  });

  test("preserves in-repo path finding guidance in tools variant", () => {
    const prompt = buildCriticConstitution(true);
    // The clause must explicitly carve out in-repo paths as still-blocking
    expect(prompt).toContain("src/foo.ts");
    expect(prompt).toContain(IN_REPO_CARVE_OUT_PHRASE);
  });

  test("out-of-repo clause appears in no-tools variant too", () => {
    const prompt = buildCriticConstitution(false);
    expect(prompt).toContain("~/.claude");
    expect(prompt).toContain("Out-of-repo references");
    expect(prompt).toContain("out-of-repo path");
  });

  test("tools variant retains 'may be BLOCKING' carve-out for in-repo paths in out-of-repo section", () => {
    const prompt = buildCriticConstitution(true);
    // The with-tools variant can verify in-repo claims via read_file, so the
    // original carve-out ("may be BLOCKING") must remain present.
    expect(prompt).toContain(IN_REPO_CARVE_OUT_PHRASE);
    // Verify the carve-out sentence explicitly allows BLOCKING for in-repo findings.
    expect(prompt).toContain("may be BLOCKING");
  });

  test("no-tools variant replaces 'may be BLOCKING' in-repo carve-out with NON-BLOCKING requirement", () => {
    const prompt = buildCriticConstitution(false);
    // Without tools, in-repo paths claimed-but-not-in-diff cannot be verified
    // beyond the diff, so the out-of-repo section must NOT contain the original
    // IN_REPO_CARVE_OUT_PHRASE carve-out that allowed BLOCKING.
    expect(prompt).not.toContain(IN_REPO_CARVE_OUT_PHRASE);
    // Instead it must contain the weakened no-tools language.
    expect(prompt).toContain("no-tools variant");
    expect(prompt).toContain("must be marked NON-BLOCKING");
  });

  test("no-tools variant out-of-repo section includes the diff-vs-description exception inline", () => {
    const prompt = buildCriticConstitution(false);
    // The diff-vs-description exception is now stated inline in the out-of-repo
    // section (inside buildInRepoCarveOut(false)) so the rule and its exception
    // are contiguous — the old structure put "must NON-BLOCKING" in out-of-repo
    // and "may be BLOCKING" in a later section, risking the model applying the
    // strong "must" and missing the exception.
    const outOfRepoStart = prompt.indexOf("## Out-of-repo references\n");
    const crossFileStart = prompt.indexOf(NO_TOOLS_SECTION_HEADING);
    expect(outOfRepoStart).toBeGreaterThan(0);
    expect(crossFileStart).toBeGreaterThan(outOfRepoStart);
    const outOfRepoSectionText = prompt.slice(outOfRepoStart, crossFileStart);
    // The exception must now be present in the out-of-repo section so the rule
    // and exception are in one place.
    expect(outOfRepoSectionText).toContain(DIFF_VS_DESC_EXCEPTION);
    expect(outOfRepoSectionText).toContain("may be BLOCKING");
  });
});

describe("extractOutOfRepoReferences", () => {
  test("matches ~/.claude/... paths (home_tilde)", () => {
    const refs = extractOutOfRepoReferences(
      "See `~/.claude/projects/foo/memory/MEMORY.md` for details.",
      "PR description"
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]?.path).toBe("~/.claude/projects/foo/memory/MEMORY.md");
    expect(refs[0]?.kind).toBe("home_tilde");
    expect(refs[0]?.source).toBe("PR description");
  });

  test("matches $HOME/... paths (env_home)", () => {
    const refs = extractOutOfRepoReferences(
      "Writes to $HOME/.config/minsky/settings.json on init.",
      "task spec"
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]?.path).toBe("$HOME/.config/minsky/settings.json");
    expect(refs[0]?.kind).toBe("env_home");
    expect(refs[0]?.source).toBe("task spec");
  });

  test("matches /etc, /usr, /var system paths", () => {
    const refs = extractOutOfRepoReferences(
      "Edits /etc/hosts and /var/log/app.log at runtime.",
      "PR description"
    );
    const paths = refs.map((r) => r.path).sort();
    expect(paths).toEqual(["/etc/hosts", "/var/log/app.log"]);
    expect(refs.every((r) => r.kind === "absolute_system")).toBe(true);
  });

  test("matches /opt, /tmp, /root paths", () => {
    const refs = extractOutOfRepoReferences(
      "Reads /opt/app/config.yaml, writes /tmp/scratch/x.log, and /root/.bashrc.",
      "PR description"
    );
    const paths = refs.map((r) => r.path).sort();
    expect(paths).toEqual(["/opt/app/config.yaml", "/root/.bashrc", "/tmp/scratch/x.log"]);
    expect(refs.every((r) => r.kind === "absolute_system")).toBe(true);
  });

  test("does NOT match in-repo relative paths", () => {
    const refs = extractOutOfRepoReferences(
      "Changes src/foo.ts, tests/bar.test.ts, and docs/architecture.md.",
      "PR description"
    );
    expect(refs).toHaveLength(0);
  });

  test("does NOT match URL paths with /etc or /usr segments", () => {
    const refs = extractOutOfRepoReferences(
      "See https://example.com/etc/docs and http://host.com/usr/info.",
      "PR description"
    );
    expect(refs).toHaveLength(0);
  });

  test("does NOT match macOS in-repo path under /Users/.../Projects/...", () => {
    // Regression guard for the old absolute_system regex allowlist, which
    // included `Users` and matched every macOS developer's repo path.
    const refs = extractOutOfRepoReferences(
      "See /Users/edobry/Projects/minsky/src/domain/tasks.ts for details.",
      "PR description"
    );
    expect(refs).toHaveLength(0);
  });

  test("does NOT match Linux in-repo path under /home/.../code/...", () => {
    // Regression guard: /home/ must not match in-repo paths on CI runners either.
    const refs = extractOutOfRepoReferences(
      "CI runs /home/dev/code/app/src/entrypoint.ts on each push.",
      "PR description"
    );
    expect(refs).toHaveLength(0);
  });

  test("matches macOS session workspace path under /Users/.../minsky/sessions/...", () => {
    // The session_workspace pattern is gated on the `minsky/sessions/` sub-path,
    // so it reliably distinguishes session workspaces from dev-machine in-repo paths.
    const refs = extractOutOfRepoReferences(
      "Session lives at /Users/edobry/.local/state/minsky/sessions/abc123-def456.",
      "PR description"
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]?.path).toBe("/Users/edobry/.local/state/minsky/sessions/abc123-def456");
    expect(refs[0]?.kind).toBe("session_workspace");
  });

  test("matches Linux session workspace path under /home/.../minsky/sessions/...", () => {
    const refs = extractOutOfRepoReferences(
      "Runner checkout at /home/runner/.local/state/minsky/sessions/xyz.",
      "task spec"
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]?.path).toBe("/home/runner/.local/state/minsky/sessions/xyz");
    expect(refs[0]?.kind).toBe("session_workspace");
  });

  test("deduplicates repeated references within the same source", () => {
    const refs = extractOutOfRepoReferences(
      "First `~/.claude/foo.md`, again `~/.claude/foo.md`, and once more `~/.claude/foo.md`.",
      "PR description"
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]?.path).toBe("~/.claude/foo.md");
  });

  test("strips trailing sentence punctuation", () => {
    const refs = extractOutOfRepoReferences(
      "See ~/.claude/notes.md. And /etc/hosts, and $HOME/bin/foo;",
      "PR description"
    );
    const paths = refs.map((r) => r.path).sort();
    expect(paths).toEqual(["$HOME/bin/foo", "/etc/hosts", "~/.claude/notes.md"]);
  });

  test("returns empty array for empty input", () => {
    expect(extractOutOfRepoReferences("", "PR description")).toEqual([]);
  });
});

describe("buildReviewPrompt out-of-repo section", () => {
  const OUT_OF_REPO_HEADING = "## Out-of-repo references observed";
  const baseInput: ReviewPromptInput = {
    prNumber: 999,
    prTitle: "Test PR",
    prBody: "",
    taskSpec: null,
    diff: "diff --git a/foo b/foo",
    authorshipTier: 3,
    branchName: "task/test",
    baseBranch: "main",
  };

  test("injects Out-of-repo references section when PR body contains matches", () => {
    const prompt = buildReviewPrompt({
      ...baseInput,
      prBody: "Updated `~/.claude/projects/foo/memory/MEMORY.md` per review feedback.",
    });
    expect(prompt).toContain(OUT_OF_REPO_HEADING);
    expect(prompt).toContain("`~/.claude/projects/foo/memory/MEMORY.md`");
    expect(prompt).toContain("(PR description)");
    expect(prompt).toContain("NON-BLOCKING");
  });

  test("injects section when task spec contains matches", () => {
    const prompt = buildReviewPrompt({
      ...baseInput,
      taskSpec: "Writes to $HOME/.config/minsky/settings.json on first run.",
    });
    expect(prompt).toContain(OUT_OF_REPO_HEADING);
    expect(prompt).toContain("`$HOME/.config/minsky/settings.json`");
    expect(prompt).toContain("(task spec)");
  });

  test("omits section entirely when neither PR body nor task spec contain matches", () => {
    const prompt = buildReviewPrompt({
      ...baseInput,
      prBody: "Refactors src/foo.ts and updates tests/bar.test.ts.",
      taskSpec: "Edit services/reviewer/src/prompt.ts.",
    });
    expect(prompt).not.toContain(OUT_OF_REPO_HEADING);
  });

  test("places section between Task Specification and Diff", () => {
    const prompt = buildReviewPrompt({
      ...baseInput,
      prBody: "Touches ~/.claude/notes.md",
      taskSpec: "Spec content.",
    });
    const specIdx = prompt.indexOf("## Task Specification");
    const outOfRepoIdx = prompt.indexOf(OUT_OF_REPO_HEADING);
    const diffIdx = prompt.indexOf("## Diff");
    expect(specIdx).toBeGreaterThan(0);
    expect(outOfRepoIdx).toBeGreaterThan(specIdx);
    expect(diffIdx).toBeGreaterThan(outOfRepoIdx);
  });

  test("merges matches from both PR body and task spec", () => {
    const prompt = buildReviewPrompt({
      ...baseInput,
      prBody: "PR touches ~/.claude/a.md",
      taskSpec: "Spec mentions $HOME/b.md",
    });
    expect(prompt).toContain("`~/.claude/a.md` (PR description)");
    expect(prompt).toContain("`$HOME/b.md` (task spec)");
  });

  test("deduplicates across PR body and task spec, aggregating sources on one line", () => {
    const prompt = buildReviewPrompt({
      ...baseInput,
      prBody: "PR touches ~/.claude/shared.md",
      taskSpec: "Spec also references ~/.claude/shared.md",
    });
    // Should appear as one bullet with both sources, not two separate bullets.
    expect(prompt).toContain("`~/.claude/shared.md` (PR description, task spec)");
    // Sanity check: no double entry.
    const occurrences = prompt.split("`~/.claude/shared.md`").length - 1;
    expect(occurrences).toBe(1);
  });

  test("section header reports distinct count, not raw count", () => {
    const prompt = buildReviewPrompt({
      ...baseInput,
      prBody: "See ~/.claude/same.md",
      taskSpec: "Also ~/.claude/same.md",
    });
    // Distinct count is 1 even though the path appears in both sources.
    expect(prompt).toContain("found 1 distinct path reference(s)");
  });
});

describe("no-tools in-repo diff-vs-description exception clause", () => {
  test("carves out diff-vs-description mismatch on in-repo paths from the MUST-non-blocking rule", () => {
    const prompt = buildCriticConstitution(false);
    // The exception is now inline in the out-of-repo section (inside
    // buildInRepoCarveOut(false)) so the rule and exception are contiguous.
    expect(prompt).toContain(DIFF_VS_DESC_EXCEPTION);
    expect(prompt).toContain("may be BLOCKING");
    // The exception must explicitly NOT apply to out-of-repo paths.
    expect(prompt).toContain("does NOT apply to out-of-repo paths");
  });

  test("exception clause only appears in the no-tools variant, not the tools variant", () => {
    const withTools = buildCriticConstitution(true);
    // Tools variant has its own verification mechanism (read_file /
    // list_directory), so the diff-vs-description exception is specific to
    // the no-tools path (inside buildInRepoCarveOut(false)).
    expect(withTools).not.toContain("Exception — diff-vs-description mismatch on in-repo paths");
  });
});

describe("buildCriticConstitution — output tools mode (mt#1401)", () => {
  test("outputToolsActive=true includes tool-emission directive and submit_finding", () => {
    const prompt = buildCriticConstitution(true, "normal", true);
    expect(prompt).toContain("submit_finding");
    expect(prompt).toContain("Emit your review via structured tool calls only");
    expect(prompt).toContain(INTERNAL_SCRATCH);
  });

  test("outputToolsActive=true includes all four output tools", () => {
    const prompt = buildCriticConstitution(true, "normal", true);
    expect(prompt).toContain("submit_finding");
    expect(prompt).toContain("submit_inline_comment");
    expect(prompt).toContain("submit_spec_verification");
    expect(prompt).toContain("conclude_review");
  });

  test("outputToolsActive=true output-tools prompt includes tightened conclude_review directive (mt#1413)", () => {
    const prompt = buildCriticConstitution(true, "normal", true);
    // The tightened language must be present: review is INCOMPLETE without conclude_review
    expect(prompt).toContain("INCOMPLETE without");
    // The FINAL tool call language must be present
    expect(prompt).toContain("FINAL tool call MUST be");
    // The consequence of failure must be stated
    expect(prompt).toContain("will default to COMMENT regardless of your findings");
  });

  test("outputToolsActive=false (prose mode) does NOT include the tightened conclude_review directive", () => {
    const prompt = buildCriticConstitution(true, "normal", false);
    // The prose format does not use the tightened tool-emission language
    expect(prompt).not.toContain("INCOMPLETE without");
    expect(prompt).not.toContain("FINAL tool call MUST be");
  });

  test("outputToolsActive=false (default) preserves prose output format — no submit_finding, no internal scratch", () => {
    const prompt = buildCriticConstitution(true, "normal", false);
    expect(prompt).not.toContain("submit_finding");
    expect(prompt).not.toContain(INTERNAL_SCRATCH);
    // The prose format includes the Findings list heading.
    expect(prompt).toContain("Findings list");
  });

  test("outputToolsActive=false default matches explicit false", () => {
    // The default value must be false; calling with 2 args equals calling with false.
    expect(buildCriticConstitution(true, "normal")).toBe(
      buildCriticConstitution(true, "normal", false)
    );
  });

  test("outputToolsActive=true but toolsAvailable=false falls back to prose (no tool channel)", () => {
    // Without tools wired, the output-tools format is not effective — free-text
    // is the only output channel, so prose instructions must be used.
    const prompt = buildCriticConstitution(false, "normal", true);
    expect(prompt).not.toContain("submit_finding");
    expect(prompt).not.toContain(INTERNAL_SCRATCH);
    expect(prompt).toContain("Findings list");
  });

  test("legacy CRITIC_CONSTITUTION export still matches buildCriticConstitution(true) with default params", () => {
    // Backward-compatibility shim: the two-arg default must equal the zero-extra-arg legacy.
    expect(CRITIC_CONSTITUTION).toBe(buildCriticConstitution(true));
    expect(CRITIC_CONSTITUTION).toBe(buildCriticConstitution(true, "normal", false));
  });
});

describe("buildCriticConstitution — Markdown formatting guidance (mt#1590)", () => {
  const MARKDOWN_FORMATTING_HEADING = "### Markdown formatting";
  const INLINE_CODE_PHRASE = "Apply inline code (single backticks)";
  const FENCED_CODE_PHRASE = "fenced code blocks with the appropriate language tag";
  const CLOSING_PHRASE = "Your goal is high-signal review";

  test("prose output format (outputToolsActive=false) includes Markdown formatting subsection", () => {
    const prompt = buildCriticConstitution(true, "normal", false);
    expect(prompt).toContain(MARKDOWN_FORMATTING_HEADING);
    expect(prompt).toContain(INLINE_CODE_PHRASE);
    expect(prompt).toContain(FENCED_CODE_PHRASE);
  });

  test("tools output format (outputToolsActive=true) includes Markdown formatting subsection", () => {
    const prompt = buildCriticConstitution(true, "normal", true);
    expect(prompt).toContain(MARKDOWN_FORMATTING_HEADING);
    expect(prompt).toContain(INLINE_CODE_PHRASE);
    expect(prompt).toContain(FENCED_CODE_PHRASE);
  });

  test("prose format guidance enumerates identifiers, function calls, file paths, and env vars", () => {
    const prompt = buildCriticConstitution(true, "normal", false);
    expect(prompt).toContain("Identifiers");
    expect(prompt).toContain("Function calls including parens");
    expect(prompt).toContain("File paths");
    expect(prompt).toContain("environment variables");
  });

  test("tools format guidance enumerates identifiers, function calls, file paths, and env vars", () => {
    const prompt = buildCriticConstitution(true, "normal", true);
    expect(prompt).toContain("Identifiers");
    expect(prompt).toContain("Function calls including parens");
    expect(prompt).toContain("File paths");
    expect(prompt).toContain("environment variables");
  });

  test("both output formats mention file:line reference backtick convention", () => {
    for (const outputToolsActive of [false, true]) {
      const prompt = buildCriticConstitution(true, "normal", outputToolsActive);
      expect(prompt).toContain("File:line references");
    }
  });

  test("Markdown formatting subsection appears before closing paragraph in prose format", () => {
    const prompt = buildCriticConstitution(true, "normal", false);
    const markdownIdx = prompt.indexOf(MARKDOWN_FORMATTING_HEADING);
    const closingIdx = prompt.indexOf(CLOSING_PHRASE);
    expect(markdownIdx).toBeGreaterThan(0);
    expect(markdownIdx).toBeLessThan(closingIdx);
  });

  test("Markdown formatting subsection appears before closing paragraph in tools format", () => {
    const prompt = buildCriticConstitution(true, "normal", true);
    const markdownIdx = prompt.indexOf(MARKDOWN_FORMATTING_HEADING);
    const closingIdx = prompt.indexOf(CLOSING_PHRASE);
    expect(markdownIdx).toBeGreaterThan(0);
    expect(markdownIdx).toBeLessThan(closingIdx);
  });

  test("tools format Markdown guidance includes the evidence field (PR #955 R1 fix)", () => {
    // The submit_spec_verification tool has an evidence field that frequently
    // contains file:line references and code identifiers. Omitting it from
    // the formatting field-list creates inconsistent expectations across
    // tool-emitted fields and contradicts uniform-formatting intent.
    const prompt = buildCriticConstitution(true, "normal", true);
    const formattingIdx = prompt.indexOf(MARKDOWN_FORMATTING_HEADING);
    const closingIdx = prompt.indexOf(CLOSING_PHRASE, formattingIdx);
    const formattingSection = prompt.slice(formattingIdx, closingIdx);
    expect(formattingSection).toContain("evidence");
    expect(formattingSection).toContain("submit_spec_verification");
  });
});

describe("buildCriticConstitution — scope-aware calibration (mt#1188)", () => {
  test("trivial-or-docs scope includes the calibration section header", () => {
    const prompt = buildCriticConstitution(true, "trivial-or-docs");
    expect(prompt).toContain(SCOPE_CALIBRATION_HEADING);
  });

  test("trivial-or-docs scope includes reserve-BLOCKING instruction", () => {
    const prompt = buildCriticConstitution(true, "trivial-or-docs");
    expect(prompt).toContain(RESERVE_BLOCKING);
  });

  test("trivial-or-docs scope includes (a) security category", () => {
    const prompt = buildCriticConstitution(true, "trivial-or-docs");
    expect(prompt).toContain("(a)");
    expect(prompt.toLowerCase()).toContain("security");
  });

  test("trivial-or-docs scope instructs COMMENT preference over REQUEST_CHANGES", () => {
    const prompt = buildCriticConstitution(true, "trivial-or-docs");
    expect(prompt).toContain("Prefer");
    expect(prompt).toContain("COMMENT");
  });

  test("trivial-or-docs scope identifies itself as trivial / docs-only", () => {
    const prompt = buildCriticConstitution(true, "trivial-or-docs");
    expect(prompt).toContain("trivial / docs-only");
  });

  test("normal scope does NOT include the calibration section", () => {
    const prompt = buildCriticConstitution(true, "normal");
    expect(prompt).not.toContain(SCOPE_CALIBRATION_HEADING);
    expect(prompt).not.toContain(RESERVE_BLOCKING);
  });

  test("test-only scope includes the calibration section with test-specific categories", () => {
    const prompt = buildCriticConstitution(true, "test-only");
    expect(prompt).toContain(SCOPE_CALIBRATION_HEADING);
    expect(prompt).toContain("test-only");
    expect(prompt).toContain(RESERVE_BLOCKING);
    // Must include test-specific BLOCKING categories.
    expect(prompt).toContain("does not actually assert the claim");
    expect(prompt).toContain("race conditions");
  });

  test("test-only scope does NOT contain the docs-only clause", () => {
    const prompt = buildCriticConstitution(true, "test-only");
    expect(prompt).not.toContain("trivial / docs-only");
    expect(prompt).not.toContain("License / legal");
  });

  test("calibration section appears between Principles and Failure modes", () => {
    const prompt = buildCriticConstitution(true, "trivial-or-docs");
    const principlesIdx = prompt.indexOf("## Principles");
    const calibrationIdx = prompt.indexOf(SCOPE_CALIBRATION_HEADING);
    const failureModesIdx = prompt.indexOf("## Failure modes");
    expect(principlesIdx).toBeLessThan(calibrationIdx);
    expect(calibrationIdx).toBeLessThan(failureModesIdx);
  });

  test("scope-aware clause works with toolsAvailable=false too", () => {
    const prompt = buildCriticConstitution(false, "trivial-or-docs");
    expect(prompt).toContain(SCOPE_CALIBRATION_HEADING);
    expect(prompt).toContain(NO_TOOLS_SECTION_HEADING);
    expect(prompt).not.toContain("## Tool access");
  });
});

// ---------------------------------------------------------------------------
// buildReviewThreadsSection (mt#1345)
// ---------------------------------------------------------------------------

// Reviewer bot login constant — prevents magic-string-duplication lint warnings.
const REVIEWER_BOT_LOGIN = "minsky-reviewer[bot]";

function makeReviewThread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id: "PRRT_kwDOX1",
    path: "src/foo.ts",
    line: 42,
    isResolved: false,
    isOutdated: false,
    isCollapsed: false,
    truncatedComments: false,
    comments: [
      {
        databaseId: 100001,
        author: REVIEWER_BOT_LOGIN,
        body: "This null check is missing.",
        createdAt: "2026-05-01T00:00:00Z",
      },
    ],
    ...overrides,
  };
}

describe("buildReviewThreadsSection (mt#1345)", () => {
  const THREADS_HEADING = "## Active Review Threads";

  test("returns empty string when threads array is empty", () => {
    expect(buildReviewThreadsSection([])).toBe("");
  });

  test("returns empty string when all threads are resolved", () => {
    const allResolved = [
      makeReviewThread({ isResolved: true }),
      makeReviewThread({ id: "T_2", isResolved: true }),
    ];
    expect(buildReviewThreadsSection(allResolved)).toBe("");
  });

  test("returns empty string when all threads are outdated", () => {
    const allOutdated = [makeReviewThread({ isOutdated: true })];
    expect(buildReviewThreadsSection(allOutdated)).toBe("");
  });

  test("renders heading and thread ID for active thread", () => {
    const section = buildReviewThreadsSection([makeReviewThread()]);
    expect(section).toContain(THREADS_HEADING);
    expect(section).toContain("PRRT_kwDOX1");
  });

  test("renders file path with line number", () => {
    const section = buildReviewThreadsSection([makeReviewThread()]);
    expect(section).toContain("src/foo.ts:42");
  });

  test("renders file path with range when startLine differs from line", () => {
    const section = buildReviewThreadsSection([makeReviewThread({ startLine: 10, line: 20 })]);
    expect(section).toContain("src/foo.ts:10-20");
  });

  test("renders comment databaseId and author", () => {
    const section = buildReviewThreadsSection([makeReviewThread()]);
    expect(section).toContain("100001");
    expect(section).toContain(REVIEWER_BOT_LOGIN);
  });

  test("renders null author as (deleted account)", () => {
    const section = buildReviewThreadsSection([
      makeReviewThread({
        comments: [
          {
            databaseId: 99999,
            author: null,
            body: "old comment",
            createdAt: "2026-05-01T00:00:00Z",
          },
        ],
      }),
    ]);
    expect(section).toContain("(deleted account)");
  });

  test("includes resolve and reply-with-inReplyTo instructions", () => {
    const section = buildReviewThreadsSection([makeReviewThread()]);
    expect(section).toContain("submit_thread_resolve");
    expect(section).toContain("submit_inline_comment");
    expect(section).toContain("inReplyTo");
  });

  test("human-thread guard instruction present", () => {
    const section = buildReviewThreadsSection([makeReviewThread()]);
    expect(section).toContain(REVIEWER_BOT_LOGIN);
    expect(section).toContain("never auto-resolve human-opened threads");
  });

  test("shows truncatedComments note when flag is true", () => {
    const section = buildReviewThreadsSection([makeReviewThread({ truncatedComments: true })]);
    expect(section).toContain("more than 10 comments");
  });

  test("does NOT show truncatedComments note when flag is false", () => {
    const section = buildReviewThreadsSection([makeReviewThread({ truncatedComments: false })]);
    expect(section).not.toContain("more than 10 comments");
  });

  test("filters out resolved threads, only renders active ones", () => {
    const threads = [
      makeReviewThread({ id: "T_active", isResolved: false }),
      makeReviewThread({ id: "T_resolved", isResolved: true }),
    ];
    const section = buildReviewThreadsSection(threads);
    expect(section).toContain("T_active");
    expect(section).not.toContain("T_resolved");
  });
});

// ---------------------------------------------------------------------------
// buildReviewPrompt — reviewThreads injection (mt#1345)
// ---------------------------------------------------------------------------

describe("buildReviewPrompt — reviewThreads injection (mt#1345)", () => {
  const THREADS_HEADING = "## Active Review Threads";
  const baseInput: ReviewPromptInput = {
    prNumber: 42,
    prTitle: "My PR",
    prBody: "Some description.",
    taskSpec: null,
    diff: "diff --git a/foo b/foo",
    authorshipTier: 3,
    branchName: "task/mt-1345",
    baseBranch: "main",
  };

  test("omits Active Review Threads section when reviewThreads is undefined", () => {
    const prompt = buildReviewPrompt(baseInput);
    expect(prompt).not.toContain(THREADS_HEADING);
  });

  test("omits Active Review Threads section when reviewThreads is empty array", () => {
    const prompt = buildReviewPrompt({ ...baseInput, reviewThreads: [] });
    expect(prompt).not.toContain(THREADS_HEADING);
  });

  test("injects Active Review Threads section when reviewThreads has active threads", () => {
    const threads = [makeReviewThread()];
    const prompt = buildReviewPrompt({ ...baseInput, reviewThreads: threads });
    expect(prompt).toContain(THREADS_HEADING);
    expect(prompt).toContain("PRRT_kwDOX1");
    expect(prompt).toContain("src/foo.ts:42");
  });

  test("Active Review Threads section appears before Diff section", () => {
    const threads = [makeReviewThread()];
    const prompt = buildReviewPrompt({ ...baseInput, reviewThreads: threads });
    const threadsIdx = prompt.indexOf(THREADS_HEADING);
    const diffIdx = prompt.indexOf("## Diff");
    expect(threadsIdx).toBeGreaterThan(0);
    expect(threadsIdx).toBeLessThan(diffIdx);
  });
});

// ---------------------------------------------------------------------------
// mt#2058: Critic Constitution disciplines extension
// ---------------------------------------------------------------------------

const DECISION_GATE_PHRASE = "Decision gate for non-blocking findings";
const ADOPTION_SWEEP_PHRASE = "Adoption sweep for new public exports";
const COVERAGE_COMPLETENESS_PHRASE = "Coverage completeness mandate";
const LIVE_TARGET_PHRASE = "Live-target verification gap";
const BEHAVIORAL_RESIDUE_PHRASE = "Behavioral residue in removal PRs";
const UNMET_CRITERIA_PHRASE = "spec must be updated to reflect actual scope";
const FAILURE_MODES_HEADING = "## Failure modes";

describe("Critic Constitution disciplines (mt#2058)", () => {
  const constitution = buildCriticConstitution(true);

  test("contains decision gate for non-blocking findings (principle 9)", () => {
    expect(constitution).toContain(DECISION_GATE_PHRASE);
    expect(constitution).toContain("in-scope for the current task");
  });

  test("contains adoption sweep mandate (principle 10)", () => {
    expect(constitution).toContain(ADOPTION_SWEEP_PHRASE);
    expect(constitution).toContain("new public export");
  });

  test("contains coverage completeness mandate (principle 11)", () => {
    expect(constitution).toContain(COVERAGE_COMPLETENESS_PHRASE);
    expect(constitution).toContain("100% of the diff");
  });

  test("contains live-target verification failure mode", () => {
    expect(constitution).toContain(LIVE_TARGET_PHRASE);
    expect(constitution).toContain("redacted live-run output");
  });

  test("contains behavioral residue failure mode", () => {
    expect(constitution).toContain(BEHAVIORAL_RESIDUE_PHRASE);
    expect(constitution).toContain("incomplete removal");
  });

  test("contains spec-unmet-criteria protocol in output-tools format", () => {
    const toolsConstitution = buildCriticConstitution(true, "normal", true);
    expect(toolsConstitution).toContain(UNMET_CRITERIA_PHRASE);
  });

  test("new principles appear in the Principles section", () => {
    const principlesStart = constitution.indexOf("## Principles");
    const failureModesStart = constitution.indexOf(FAILURE_MODES_HEADING);
    expect(principlesStart).toBeGreaterThan(-1);
    expect(failureModesStart).toBeGreaterThan(-1);
    const principlesSection = constitution.slice(principlesStart, failureModesStart);
    expect(principlesSection).toContain(DECISION_GATE_PHRASE);
    expect(principlesSection).toContain(ADOPTION_SWEEP_PHRASE);
    expect(principlesSection).toContain(COVERAGE_COMPLETENESS_PHRASE);
  });

  test("new failure modes appear in the Failure modes section", () => {
    const failureModesStart = constitution.indexOf(FAILURE_MODES_HEADING);
    const outOfRepoStart = constitution.indexOf("## Out-of-repo references");
    expect(failureModesStart).toBeGreaterThan(-1);
    expect(outOfRepoStart).toBeGreaterThan(-1);
    const failureSection = constitution.slice(failureModesStart, outOfRepoStart);
    expect(failureSection).toContain(LIVE_TARGET_PHRASE);
    expect(failureSection).toContain(BEHAVIORAL_RESIDUE_PHRASE);
  });

  test("no-tools variant also includes the new disciplines", () => {
    const noToolsConstitution = buildCriticConstitution(false);
    expect(noToolsConstitution).toContain(DECISION_GATE_PHRASE);
    expect(noToolsConstitution).toContain(LIVE_TARGET_PHRASE);
    expect(noToolsConstitution).toContain(BEHAVIORAL_RESIDUE_PHRASE);
    expect(noToolsConstitution).toContain(COVERAGE_COMPLETENESS_PHRASE);
  });
});
