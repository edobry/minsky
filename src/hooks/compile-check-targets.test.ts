/**
 * compileCheckTargets tests (mt#2497, extended mt#2304, mt#3058).
 *
 * The pre-commit compile-check opts each target in only when its `.minsky/`
 * source dir exists. mt#2497 added `claude-agents` after reconciling the
 * source↔output drift; before that, agent outputs could drift ahead of their
 * sources unguarded. mt#2304 added `claude-hooks` after moving hook sources
 * to `.minsky/hooks/`. mt#3058 (the compile-pipeline cutover) added the three
 * former-legacy targets `claude.md`, `agents.md`, and `claude-rules` — all
 * sourced from `.minsky/rules/`, so they gate on `rules` alongside
 * `cursor-rules-ts`. These tests pin the mapping so no target's guard can be
 * silently dropped again.
 */
import { describe, test, expect } from "bun:test";
import {
  compileCheckTargets,
  claudeHooksCompileAffected,
  classifyCompileHooksRegenError,
} from "./pre-commit";
import { regenerateStagedClaudeHooks } from "./claude-hooks-compile-regen";

describe("compileCheckTargets (mt#2497, extended mt#2304, mt#3058)", () => {
  /**
   * This repository's case: both monolithic files carry the generation banner.
   * Spelled out since mt#5003, because `claude.md` is now checked only for a
   * CLAUDE.md Minsky generated — an absent one is no longer created, so
   * demanding its freshness would be asking for a file nothing produces.
   */
  const OURS = { claudeMd: "generated", agentsMd: "generated" } as const;

  test("includes claude-agents when .minsky/agents/ is present", () => {
    expect(
      compileCheckTargets({
        skills: true,
        rules: true,
        agents: true,
        hooks: false,
        ownership: OURS,
      })
    ).toEqual([
      "claude-skills",
      "cursor-rules-ts",
      "claude.md",
      "agents.md",
      "claude-rules",
      "claude-agents",
    ]);
  });

  test("excludes claude-agents when .minsky/agents/ is absent", () => {
    const targets = compileCheckTargets({
      skills: true,
      rules: true,
      agents: false,
      hooks: false,
      ownership: OURS,
    });
    expect(targets).not.toContain("claude-agents");
    expect(targets).toEqual([
      "claude-skills",
      "cursor-rules-ts",
      "claude.md",
      "agents.md",
      "claude-rules",
    ]);
  });

  test("includes claude-hooks when .minsky/hooks/ is present", () => {
    expect(
      compileCheckTargets({
        skills: true,
        rules: true,
        agents: true,
        hooks: true,
        ownership: OURS,
      })
    ).toEqual([
      "claude-skills",
      "cursor-rules-ts",
      "claude.md",
      "agents.md",
      "claude-rules",
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

  test("mt#3058: .minsky/rules/ presence opts in all four rules-sourced targets", () => {
    // cursor-rules-ts + the three former-legacy monolithic/claude-rules targets
    // all gate on `rules`. Cutover requirement: none may be silently dropped.
    expect(
      compileCheckTargets({
        skills: false,
        rules: true,
        agents: false,
        hooks: false,
        ownership: OURS,
      })
    ).toEqual(["cursor-rules-ts", "claude.md", "agents.md", "claude-rules"]);
  });

  test("mt#3058: no rules dir → none of the rules-sourced targets are checked", () => {
    const targets = compileCheckTargets({
      skills: true,
      rules: false,
      agents: false,
      hooks: false,
    });
    expect(targets).toEqual(["claude-skills"]);
    for (const t of ["cursor-rules-ts", "claude.md", "agents.md", "claude-rules"]) {
      expect(targets).not.toContain(t);
    }
  });

  test("each non-rules target is independently opted in by its source dir", () => {
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

  // ─── mt#4866 SC3: stay in sync with minskyCompileTargetsFromPresence ───────
  //
  // This function's own docblock says it is "kept in sync with
  // minskyCompileTargetsFromPresence". SC3 gated cursor-rules-ts and agents.md
  // on the recorded harness there, so the same gate must exist here — otherwise
  // the pre-commit check would demand outputs a bare `minsky compile` no longer
  // produces, and a claude-code project would be told they are stale forever with
  // no invocation able to refresh them.
  describe("harness gate (mt#4866 SC3)", () => {
    // `ownership` carries this repository's case — a CLAUDE.md Minsky
    // generated — which is what every test here was written under. Since
    // mt#5003 `claude.md` is selected only for that case.
    const RULES_ONLY = {
      skills: false,
      rules: true,
      agents: false,
      hooks: false,
      ownership: { claudeMd: "generated", agentsMd: "generated" },
    } as const;
    const NO_OUTPUTS = { cursorRules: false, agentsMd: false };

    test("drops cursor-rules-ts and agents.md under claude-code with no existing outputs", () => {
      expect(
        compileCheckTargets({ ...RULES_ONLY, harness: "claude-code", existingOutputs: NO_OUTPUTS })
      ).toEqual(["claude.md", "claude-rules"]);
    });

    test("keeps an output that already exists, per-target", () => {
      expect(
        compileCheckTargets({
          ...RULES_ONLY,
          harness: "claude-code",
          existingOutputs: { cursorRules: true, agentsMd: false },
        })
      ).toEqual(["cursor-rules-ts", "claude.md", "claude-rules"]);
    });

    // This repository's own case: both outputs are committed here, so the gate
    // is inert and the pre-commit check verifies exactly what it did before.
    test("with BOTH outputs present the target set is unchanged", () => {
      expect(
        compileCheckTargets({
          ...RULES_ONLY,
          harness: "claude-code",
          existingOutputs: { cursorRules: true, agentsMd: true },
        })
      ).toEqual(["cursor-rules-ts", "claude.md", "agents.md", "claude-rules"]);
    });

    test("gates nothing when no harness is recorded (additive for existing callers)", () => {
      expect(compileCheckTargets(RULES_ONLY)).toEqual([
        "cursor-rules-ts",
        "claude.md",
        "agents.md",
        "claude-rules",
      ]);
    });

    test("gates nothing for a different harness", () => {
      expect(
        compileCheckTargets({ ...RULES_ONLY, harness: "cursor", existingOutputs: NO_OUTPUTS })
      ).toEqual(["cursor-rules-ts", "claude.md", "agents.md", "claude-rules"]);
    });
  });

  // ─── mt#4986 SC3: the foreign-ownership gate, mirrored ─────────────────────
  //
  // Same lockstep argument as the harness gate above, one gate later: the
  // compile no longer writes a monolithic output the user owns, so this check
  // must stop demanding it be fresh. Without the mirror, a project with its own
  // CLAUDE.md is told at every commit that it is stale, with no invocation able
  // to refresh it — and the one that would (`--target claude.md`) is refused by
  // the writer, so the operator has no way out at all.
  describe("foreign-ownership gate (mt#4986 SC3)", () => {
    const RULES_ONLY = {
      skills: false,
      rules: true,
      agents: false,
      hooks: false,
      ownership: { claudeMd: "generated", agentsMd: "generated" },
    } as const;

    test("drops claude.md when CLAUDE.md is the user's", () => {
      expect(
        compileCheckTargets({
          ...RULES_ONLY,
          ownership: { claudeMd: "foreign", agentsMd: "generated" },
        })
      ).toEqual(["cursor-rules-ts", "agents.md", "claude-rules"]);
    });

    test("drops agents.md when AGENTS.md is the user's, even with the harness escape open", () => {
      expect(
        compileCheckTargets({
          ...RULES_ONLY,
          harness: "claude-code",
          existingOutputs: { cursorRules: true, agentsMd: true },
          ownership: { claudeMd: "generated", agentsMd: "foreign" },
        })
      ).not.toContain("agents.md");
    });

    // This repository's own case: both monolithic files carry the banner, so
    // the gate is inert and the pre-commit check verifies exactly what it did.
    test("is inert when both monolithic outputs are ours", () => {
      expect(
        compileCheckTargets({
          ...RULES_ONLY,
          ownership: { claudeMd: "generated", agentsMd: "generated" },
        })
      ).toEqual(compileCheckTargets(RULES_ONLY));
    });

    // mt#5003: the mirror must stop demanding freshness for a file the compile
    // no longer creates, or a fresh project is told it is stale at every commit
    // with no invocation able to fix it.
    test("drops claude.md when no CLAUDE.md of ours exists", () => {
      expect(
        compileCheckTargets({
          ...RULES_ONLY,
          ownership: { claudeMd: "absent", agentsMd: "generated" },
        })
      ).not.toContain("claude.md");
    });
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
    statusOut?: string;
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
      // git status --porcelain -- .claude/hooks/
      return cfg.statusOut ?? "";
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
    const { deps, calls } = makeDeps({ stagedOut: HOOK_SRC, statusOut: ` M ${HOOK_OUT}` });
    const result = await regenerateStagedClaudeHooks(deps);
    expect(result.success).toBe(true);
    expect(result.message).toContain("regenerated and staged");
    expect(calls.exec).toBe(1);
    expect(calls.add).toBe(1);
  });

  test("AT#1: brand-new (untracked) hook output is staged (PR #2223 R2)", async () => {
    const { deps, calls } = makeDeps({
      stagedOut: HOOK_SRC,
      statusOut: "?? .claude/hooks/newhook.ts",
    });
    const result = await regenerateStagedClaudeHooks(deps);
    expect(result.success).toBe(true);
    expect(result.message).toContain("regenerated and staged");
    expect(calls.add).toBe(1);
  });

  test("hooks staged but output already up-to-date → no restage", async () => {
    const { deps, calls } = makeDeps({ stagedOut: HOOK_SRC, statusOut: "" });
    const result = await regenerateStagedClaudeHooks(deps);
    expect(result.success).toBe(true);
    expect(result.message).toContain("up-to-date");
    expect(calls.exec).toBe(1);
    expect(calls.add).toBe(0);
  });

  test("already-staged-clean output (M  status) is NOT restaged", async () => {
    const { deps, calls } = makeDeps({ stagedOut: HOOK_SRC, statusOut: `M  ${HOOK_OUT}` });
    const result = await regenerateStagedClaudeHooks(deps);
    expect(result.success).toBe(true);
    expect(result.message).toContain("up-to-date");
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
    const { deps } = makeDeps({
      stagedOut: HOOK_SRC,
      statusOut: ` M ${HOOK_OUT}`,
      addThrows: true,
    });
    const result = await regenerateStagedClaudeHooks(deps);
    expect(result.success).toBe(false);
    expect(result.message).toContain("Could not stage regenerated claude-hooks output");
  });
});
