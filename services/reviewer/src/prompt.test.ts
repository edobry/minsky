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
  CRITIC_CONSTITUTION,
  extractOutOfRepoReferences,
  type ReviewPromptInput,
} from "./prompt";

// Shared string constants used across multiple test assertions.
// Extracted to prevent the no-magic-string-duplication lint rule from triggering.
const NO_TOOLS_SECTION_HEADING = "## Cross-file claims without tool access";
const IN_REPO_CARVE_OUT_PHRASE = "This rule does NOT apply to in-repo paths";
const SCOPE_CALIBRATION_HEADING = "## Scope-aware calibration";
const RESERVE_BLOCKING = "reserve BLOCKING severity";
const DIFF_VS_DESC_EXCEPTION = "Exception — diff-vs-description mismatch on in-repo paths";

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
    expect(refs[0].path).toBe("~/.claude/projects/foo/memory/MEMORY.md");
    expect(refs[0].kind).toBe("home_tilde");
    expect(refs[0].source).toBe("PR description");
  });

  test("matches $HOME/... paths (env_home)", () => {
    const refs = extractOutOfRepoReferences(
      "Writes to $HOME/.config/minsky/settings.json on init.",
      "task spec"
    );
    expect(refs).toHaveLength(1);
    expect(refs[0].path).toBe("$HOME/.config/minsky/settings.json");
    expect(refs[0].kind).toBe("env_home");
    expect(refs[0].source).toBe("task spec");
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
    expect(refs[0].path).toBe("/Users/edobry/.local/state/minsky/sessions/abc123-def456");
    expect(refs[0].kind).toBe("session_workspace");
  });

  test("matches Linux session workspace path under /home/.../minsky/sessions/...", () => {
    const refs = extractOutOfRepoReferences(
      "Runner checkout at /home/runner/.local/state/minsky/sessions/xyz.",
      "task spec"
    );
    expect(refs).toHaveLength(1);
    expect(refs[0].path).toBe("/home/runner/.local/state/minsky/sessions/xyz");
    expect(refs[0].kind).toBe("session_workspace");
  });

  test("deduplicates repeated references within the same source", () => {
    const refs = extractOutOfRepoReferences(
      "First `~/.claude/foo.md`, again `~/.claude/foo.md`, and once more `~/.claude/foo.md`.",
      "PR description"
    );
    expect(refs).toHaveLength(1);
    expect(refs[0].path).toBe("~/.claude/foo.md");
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
