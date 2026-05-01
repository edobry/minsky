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

  test("envelope renders a `feat(mt#X): partial: ...` example that the hook accepts", async () => {
    const taskId = "mt#1524";
    const sessionId = "test-session";
    const result = generateSubagentPrompt({
      sessionDir: "/tmp/sessiondir",
      sessionId,
      taskId,
      type: "implementation",
      instructions: "test instructions",
      harness: "claude-code",
      workspacePath: "/tmp/nonexistent-workspace",
      skillLoader: emptySkillLoader,
    });
    const prompt = result.prompt;

    // Sanity: the rendered prompt must NOT contain the old `wip(...)` form.
    expect(prompt).not.toContain("wip(mt#");

    // Sanity: the new form is present (taskId interpolated into example).
    expect(prompt).toContain(`feat(mt#${taskId}): partial:`);

    // The example commit message embedded in the envelope must pass the hook.
    const exampleCommit = `feat(${taskId}): partial: implemented router skeleton`;
    const hook = new CommitMsgHook("/tmp/commit-msg", {
      readFileSync: () => exampleCommit,
      execSync: () => "task/mt-1524",
    });
    const hookResult = await hook.run();
    expect(hookResult.success).toBe(true);
  });
});
