/**
 * compileCheckTargets tests (mt#2497, extended mt#2304).
 *
 * The pre-commit compile-check opts each target in only when its `.minsky/`
 * source dir exists. mt#2497 added `claude-agents` after reconciling the
 * source↔output drift; before that, agent outputs could drift ahead of their
 * sources unguarded. mt#2304 added `claude-hooks` after moving hook sources
 * to `.minsky/hooks/`. These tests pin the mapping so no target's guard can
 * be silently dropped again.
 */
import { describe, test, expect } from "bun:test";
import {
  compileCheckTargets,
  claudeHooksCompileAffected,
  classifyCompileHooksRegenError,
} from "./pre-commit";
import { regenerateStagedClaudeHooks } from "./claude-hooks-compile-regen";

describe("compileCheckTargets (mt#2497, extended mt#2304)", () => {
  test("includes claude-agents when .minsky/agents/ is present", () => {
    expect(compileCheckTargets({ skills: true, rules: true, agents: true, hooks: false })).toEqual([
      "claude-skills",
      "cursor-rules-ts",
      "claude-agents",
    ]);
  });

  test("excludes claude-agents when .minsky/agents/ is absent", () => {
    const targets = compileCheckTargets({
      skills: true,
      rules: true,
      agents: false,
      hooks: false,
    });
    expect(targets).not.toContain("claude-agents");
    expect(targets).toEqual(["claude-skills", "cursor-rules-ts"]);
  });

  test("includes claude-hooks when .minsky/hooks/ is present", () => {
    expect(compileCheckTargets({ skills: true, rules: true, agents: true, hooks: true })).toEqual([
      "claude-skills",
      "cursor-rules-ts",
      "claude-agents",
      "claude-hooks",
    ]);
  });

  test("excludes claude-hooks when .minsky/hooks/ is absent", () => {
    const targets = compileCheckTargets({
      skills: true,
      rules: true,
      agents: true,
      hooks: false,
    });
    expect(targets).not.toContain("claude-hooks");
  });

  test("each target is independently opted in by its source dir", () => {
    expect(
      compileCheckTargets({ skills: false, rules: false, agents: true, hooks: false })
    ).toEqual(["claude-agents"]);
    expect(
      compileCheckTargets({ skills: true, rules: false, agents: false, hooks: false })
    ).toEqual(["claude-skills"]);
    expect(
      compileCheckTargets({ skills: false, rules: false, agents: false, hooks: true })
    ).toEqual(["claude-hooks"]);
  });

  test("no source dirs → empty target list (check skipped)", () => {
    expect(
      compileCheckTargets({ skills: false, rules: false, agents: false, hooks: false })
    ).toEqual([]);
  });
});

describe("claudeHooksCompileAffected (mt#2977)", () => {
  test("true when a .minsky/hooks source is staged", () => {
    expect(claudeHooksCompileAffected([".minsky/hooks/check-branch-fresh.ts"])).toBe(true);
  });

  test("false when ONLY a .claude/hooks output is staged (sources-only gate, PR #2223)", () => {
    expect(claudeHooksCompileAffected([".claude/hooks/check-branch-fresh.ts"])).toBe(false);
  });

  test("true when hooks paths are mixed with unrelated staged files", () => {
    expect(
      claudeHooksCompileAffected(["src/foo.ts", "README.md", ".minsky/hooks/registry.ts"])
    ).toBe(true);
  });

  test("false when no hooks source is staged", () => {
    expect(claudeHooksCompileAffected(["src/hooks/pre-commit.ts", ".minsky/rules/foo.mdc"])).toBe(
      false
    );
  });

  test("false for an empty staged set", () => {
    expect(claudeHooksCompileAffected([])).toBe(false);
  });

  test("matches only a real path prefix, not an incidental substring", () => {
    expect(
      claudeHooksCompileAffected(["docs/.minsky-hooks-notes.md", "vendor/.claude/hooks.ts"])
    ).toBe(false);
  });
});

describe("classifyCompileHooksRegenError (mt#2977)", () => {
  test("surfaces stderr detail in logLines and message", () => {
    const { logLines, message } = classifyCompileHooksRegenError({
      stderr: "SyntaxError: unexpected token\n  at registry.ts:12",
      stdout: "",
    });
    expect(message).toContain("SyntaxError: unexpected token");
    expect(logLines[0]).toContain("claude-hooks compile regeneration failed");
    expect(logLines.some((l) => l.includes("compile failure"))).toBe(true);
  });

  test("falls through to stdout when stderr is empty", () => {
    const { message } = classifyCompileHooksRegenError({ stderr: "", stdout: "compile boom" });
    expect(message).toContain("compile boom");
  });

  test("uses Error.message when neither stderr nor stdout is present", () => {
    const { message } = classifyCompileHooksRegenError(new Error("spawn failed"));
    expect(message).toContain("spawn failed");
  });
});

describe("regenerateStagedClaudeHooks orchestration (mt#2977 AT#1-3)", () => {
  const projectRoot = "/repo";
  const HOOK_SRC = ".minsky/hooks/registry.ts";
  const HOOK_OUT = ".claude/hooks/registry.ts";

  function makeDeps(cfg: {
    stagedOut: string;
    diffOut?: string;
    execThrows?: unknown;
    addThrows?: boolean;
  }) {
    const calls = { exec: 0, add: 0, logs: [] as string[] };
    const runGit = async (args: string[]): Promise<string> => {
      if (args.includes("--cached")) return cfg.stagedOut;
      if (args[0] === "add") {
        calls.add++;
        if (cfg.addThrows) throw new Error("add failed");
        return "";
      }
      return cfg.diffOut ?? "";
    };
    const exec = async (): Promise<unknown> => {
      calls.exec++;
      if (cfg.execThrows !== undefined) throw cfg.execThrows;
      return {};
    };
    const logLine = (l: string) => calls.logs.push(l);
    return { deps: { projectRoot, runGit, exec, logLine }, calls };
  }

  test("AT#2: no hooks staged → skips, never compiles", async () => {
    const { deps, calls } = makeDeps({ stagedOut: "src/foo.ts\nREADME.md" });
    const result = await regenerateStagedClaudeHooks(deps);
    expect(result.success).toBe(true);
    expect(result.message).toContain("skipping regen");
    expect(calls.exec).toBe(0);
    expect(calls.add).toBe(0);
  });

  test("AT#1: hooks staged + output drifted → regenerates and restages", async () => {
    const { deps, calls } = makeDeps({ stagedOut: HOOK_SRC, diffOut: HOOK_OUT });
    const result = await regenerateStagedClaudeHooks(deps);
    expect(result.success).toBe(true);
    expect(result.message).toContain("regenerated and staged");
    expect(calls.exec).toBe(1);
    expect(calls.add).toBe(1);
  });

  test("hooks staged but output already up-to-date → no restage", async () => {
    const { deps, calls } = makeDeps({ stagedOut: HOOK_SRC, diffOut: "" });
    const result = await regenerateStagedClaudeHooks(deps);
    expect(result.success).toBe(true);
    expect(result.message).toContain("up-to-date");
    expect(calls.exec).toBe(1);
    expect(calls.add).toBe(0);
  });

  test("AT#3: compile failure → fails loudly, no restage", async () => {
    const { deps, calls } = makeDeps({
      stagedOut: HOOK_SRC,
      execThrows: { stderr: "SyntaxError: boom" },
    });
    const result = await regenerateStagedClaudeHooks(deps);
    expect(result.success).toBe(false);
    expect(result.message).toContain("compile regeneration failed");
    expect(calls.add).toBe(0);
    expect(calls.logs.some((l) => l.includes("SyntaxError: boom"))).toBe(true);
  });

  test("AT#3: restage failure → fails loudly", async () => {
    const { deps } = makeDeps({ stagedOut: HOOK_SRC, diffOut: HOOK_OUT, addThrows: true });
    const result = await regenerateStagedClaudeHooks(deps);
    expect(result.success).toBe(false);
    expect(result.message).toContain("Could not stage regenerated claude-hooks output");
  });
});
