/**
 * Tests for the conventional-commit-types source of truth.
 *
 * These tests pin the consistency invariant that mt#1524 was filed to fix:
 * the commit-msg hook, the session_pr_create/edit enums, and the operating
 * envelope's example commit messages must all agree on the same set of
 * accepted types.
 */
import { describe, expect, test } from "bun:test";
import {
  CONVENTIONAL_COMMIT_TYPES,
  CONVENTIONAL_COMMIT_TYPE_ALTERNATION,
  CONVENTIONAL_COMMIT_TYPES_DISPLAY,
} from "./conventional-commit-types";
import { CommitMsgHook } from "../../hooks/commit-msg";
import { sessionPrCreateCommandParams } from "../../adapters/shared/commands/session/session-parameters";
import { sessionPrEditCommandParams } from "../../adapters/shared/commands/session/session-parameters";
import { generateSubagentPrompt, type SkillLoader } from "../session/prompt-generation";

describe("CONVENTIONAL_COMMIT_TYPES", () => {
  test("includes all 12 expected types", () => {
    expect(CONVENTIONAL_COMMIT_TYPES).toEqual([
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
      "merge",
    ]);
  });

  test("alternation joins with pipes", () => {
    expect(CONVENTIONAL_COMMIT_TYPE_ALTERNATION).toBe(
      "feat|fix|docs|style|refactor|perf|test|chore|ci|build|revert|merge"
    );
  });

  test("display joins with comma+space", () => {
    expect(CONVENTIONAL_COMMIT_TYPES_DISPLAY).toBe(
      "feat, fix, docs, style, refactor, perf, test, chore, ci, build, revert, merge"
    );
  });
});

describe("session_pr_create / session_pr_edit type enums", () => {
  test("session_pr_create.type accepts all 12 conventional types", () => {
    const schema = sessionPrCreateCommandParams.type.schema;
    for (const t of CONVENTIONAL_COMMIT_TYPES) {
      expect(schema.safeParse(t).success).toBe(true);
    }
  });

  test("session_pr_create.type rejects 'wip'", () => {
    const schema = sessionPrCreateCommandParams.type.schema;
    expect(schema.safeParse("wip").success).toBe(false);
  });

  test("session_pr_edit.type accepts all 12 conventional types", () => {
    const schema = sessionPrEditCommandParams.type.schema;
    for (const t of CONVENTIONAL_COMMIT_TYPES) {
      expect(schema.safeParse(t).success).toBe(true);
    }
  });
});

describe("commit-msg hook accepts every type in the central list", () => {
  // Construct a hook with deterministic deps so we can call validateCommitFormat
  // through the public run() path. We feed each candidate via a stub readFileSync.
  function runHookWithMessage(message: string) {
    let captured: string | null = null;
    const hook = new CommitMsgHook("/tmp/commit-msg", {
      readFileSync: () => message,
      execSync: () => "task/mt-1524",
    });
    captured = message;
    return { hook, captured };
  }

  for (const type of CONVENTIONAL_COMMIT_TYPES) {
    test(`commit-msg hook accepts \`${type}(mt#1524): description\``, async () => {
      const { hook } = runHookWithMessage(`${type}(mt#1524): example description here`);
      const result = await hook.run();
      expect(result.success).toBe(true);
    });
  }

  test("commit-msg hook rejects `wip(mt#1524): foo` (the original mt#1524 bug)", async () => {
    const { hook } = runHookWithMessage("wip(mt#1524): foo");
    const result = await hook.run();
    expect(result.success).toBe(false);
  });
});

describe("operating envelope examples pass the commit-msg hook", () => {
  // Hermetic skill loader that returns no skills, so the prompt-generation
  // path doesn't need filesystem access.
  const emptySkillLoader: SkillLoader = {
    loadAgentSkillNames: () => null,
    loadSkillBody: () => null,
  };

  // Shared expected fragment for envelope assertions; named here so the
  // magic-string-duplication lint rule is satisfied across multiple tests.
  const EXPECTED_ENVELOPE_FRAGMENT = "feat(mt#1524): partial:";

  function renderImplementerPrompt(taskId: string): string {
    return generateSubagentPrompt({
      sessionDir: "/tmp/sessiondir",
      sessionId: "test-session",
      taskId,
      type: "implementation",
      instructions: "test instructions",
      harness: "claude-code",
      workspacePath: "/tmp/nonexistent-workspace",
      skillLoader: emptySkillLoader,
    }).prompt;
  }

  test("envelope renders a `feat(mt#X): partial: ...` example that the hook accepts (numeric taskId)", async () => {
    // Production callers pass numeric-only taskId (see prompt-command.ts and
    // dispatch-command.ts which both call `taskId.replace(/^mt#/, "")`).
    const prompt = renderImplementerPrompt("1524");

    // Sanity: the rendered prompt must NOT contain the old `wip(...)` form.
    expect(prompt).not.toContain("wip(mt#");

    // Sanity: the new form is present with a single `mt#` prefix.
    expect(prompt).toContain(EXPECTED_ENVELOPE_FRAGMENT);

    // Regression guard for the doubled-prefix BLOCKING (PR #938 review):
    // there must be exactly zero `mt#mt#` substrings anywhere in the prompt.
    expect(prompt).not.toContain("mt#mt#");

    // The example commit message embedded in the envelope must pass the hook.
    const exampleCommit = `${EXPECTED_ENVELOPE_FRAGMENT} implemented router skeleton`;
    const hook = new CommitMsgHook("/tmp/commit-msg", {
      readFileSync: () => exampleCommit,
      execSync: () => "task/mt-1524",
    });
    const hookResult = await hook.run();
    expect(hookResult.success).toBe(true);
  });

  test("envelope tolerates display-formatted taskId without doubling the prefix", () => {
    // If a caller mistakenly passes the display-formatted form, the renderer
    // must still produce a single-prefix output — never `mt#mt#1524`.
    const prompt = renderImplementerPrompt("mt#1524");
    expect(prompt).not.toContain("mt#mt#");
    expect(prompt).toContain(EXPECTED_ENVELOPE_FRAGMENT);
  });

  test("envelope handles bare-`#N` taskId form without doubling", () => {
    const prompt = renderImplementerPrompt("#1524");
    expect(prompt).not.toContain("mt##");
    expect(prompt).toContain(EXPECTED_ENVELOPE_FRAGMENT);
  });

  test("envelope handles hyphen-formatted taskId (`mt-1524`) without doubling (PR #938 R2)", () => {
    // Branch-style task IDs use a hyphen separator. The normalizer must strip
    // both `mt#` and `mt-` so an upstream caller passing the branch form
    // doesn't produce `mt#mt-1524` in the rendered output.
    const prompt = renderImplementerPrompt("mt-1524");
    expect(prompt).not.toContain("mt#mt-");
    expect(prompt).not.toContain("mt-1524"); // raw form should never appear
    expect(prompt).toContain(EXPECTED_ENVELOPE_FRAGMENT);
  });

  test("envelope strips chained/doubled prefixes (PR #938 R3 hardening)", () => {
    // Pathological input: an upstream bug doubled the prefix. The normalizer
    // must strip ALL leading prefixes so a single `mt#` survives in the
    // rendered output, never `mt#mt#1524`.
    expect(renderImplementerPrompt("mt#mt#1524")).not.toContain("mt#mt#");
    expect(renderImplementerPrompt("mt#mt#1524")).toContain(EXPECTED_ENVELOPE_FRAGMENT);

    // Mixed-form chain: `mt#mt-1524` should also collapse to a single prefix.
    expect(renderImplementerPrompt("mt#mt-1524")).not.toContain("mt#mt-");
    expect(renderImplementerPrompt("mt#mt-1524")).toContain(EXPECTED_ENVELOPE_FRAGMENT);
  });

  test("envelope preserves non-mt project prefix (PR #938 R4)", () => {
    // Cross-project correctness: an `md#409` task must not be silently
    // rebranded as `mt#409` in the rendered guidance — that would mislead
    // the agent about which task system the work belongs to.
    const mdPrompt = renderImplementerPrompt("md#409");
    expect(mdPrompt).toContain("feat(md#409): partial:");
    expect(mdPrompt).not.toContain("mt#409");
    expect(mdPrompt).toContain('task: "md#409"');

    // Hyphen form likewise: `gh-42` → `gh#42` (canonical hash form), not `mt#42`.
    const ghPrompt = renderImplementerPrompt("gh-42");
    expect(ghPrompt).toContain("feat(gh#42): partial:");
    expect(ghPrompt).not.toContain("mt#42");
  });

  test("envelope preserves malformed taskId verbatim (PR #938 R5)", () => {
    // Inputs whose remainder isn't a non-empty digit string are returned
    // as-is so the malformed input surfaces in the rendered guidance
    // rather than producing a broken display ID like `mt#` or `md#abc123`.
    const emptyDigits = renderImplementerPrompt("mt#");
    // Should NOT contain a freshly-rebranded `mt#` followed by `:` (which
    // would happen if the function returned `mt#`); instead the original
    // input is preserved as a clear signal that something is off.
    expect(emptyDigits).toContain("Task mt#:");
    // And the broken form is NOT silently coerced to a valid-looking ID.
    expect(emptyDigits).not.toContain("Task mt#1524");

    const alphaSuffix = renderImplementerPrompt("md#abc123");
    expect(alphaSuffix).toContain("md#abc123");
    expect(alphaSuffix).not.toContain("mt#abc123");
  });
});

describe("commit-msg hook accepts longer descriptive subjects (PR #938 R2)", () => {
  test("accepts a `partial:`-prefixed subject up to 100 chars", async () => {
    // The envelope's `feat(mt#1524): partial: <what's done>` guidance produces
    // descriptive checkpoint messages that can run longer than the previous
    // 50-char cap. Confirm a realistic 80-char subject passes.
    const longSubject =
      "feat(mt#1524): partial: implemented hook classifier and centralized commit-types";
    expect(longSubject.length).toBeGreaterThan(50);
    expect(longSubject.length).toBeLessThanOrEqual(100);
    const hook = new CommitMsgHook("/tmp/commit-msg", {
      readFileSync: () => longSubject,
      execSync: () => "task/mt-1524",
    });
    const result = await hook.run();
    expect(result.success).toBe(true);
  });

  test("rejects a subject that exceeds 100 chars", async () => {
    const tooLong = `feat(mt#1524): partial: ${"x".repeat(120)} — way past the conventional-commit cap`;
    const hook = new CommitMsgHook("/tmp/commit-msg", {
      readFileSync: () => tooLong,
      execSync: () => "task/mt-1524",
    });
    const result = await hook.run();
    expect(result.success).toBe(false);
  });
});
