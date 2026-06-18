/**
 * compileCheckTargets tests (mt#2497).
 *
 * The pre-commit compile-check opts each target in only when its `.minsky/`
 * source dir exists. mt#2497 added `claude-agents` after reconciling the
 * source↔output drift; before that, agent outputs could drift ahead of their
 * sources unguarded. These tests pin the mapping so the agent guard can't be
 * silently dropped again.
 */
import { describe, test, expect } from "bun:test";
import { compileCheckTargets } from "./pre-commit";

describe("compileCheckTargets (mt#2497)", () => {
  test("includes claude-agents when .minsky/agents/ is present", () => {
    expect(compileCheckTargets({ skills: true, rules: true, agents: true })).toEqual([
      "claude-skills",
      "cursor-rules-ts",
      "claude-agents",
    ]);
  });

  test("excludes claude-agents when .minsky/agents/ is absent", () => {
    const targets = compileCheckTargets({ skills: true, rules: true, agents: false });
    expect(targets).not.toContain("claude-agents");
    expect(targets).toEqual(["claude-skills", "cursor-rules-ts"]);
  });

  test("each target is independently opted in by its source dir", () => {
    expect(compileCheckTargets({ skills: false, rules: false, agents: true })).toEqual([
      "claude-agents",
    ]);
    expect(compileCheckTargets({ skills: true, rules: false, agents: false })).toEqual([
      "claude-skills",
    ]);
  });

  test("no source dirs → empty target list (check skipped)", () => {
    expect(compileCheckTargets({ skills: false, rules: false, agents: false })).toEqual([]);
  });
});
