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
import { compileCheckTargets } from "./pre-commit";

describe("compileCheckTargets (mt#2497, extended mt#2304, mt#3058)", () => {
  test("includes claude-agents when .minsky/agents/ is present", () => {
    expect(compileCheckTargets({ skills: true, rules: true, agents: true, hooks: false })).toEqual([
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
    expect(compileCheckTargets({ skills: true, rules: true, agents: true, hooks: true })).toEqual([
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
      compileCheckTargets({ skills: false, rules: true, agents: false, hooks: false })
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
});
