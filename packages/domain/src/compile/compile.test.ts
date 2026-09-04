/**
 * Unit tests for the mt#2803 bare-invocation target-probing fix on the new
 * (definition-derived) compile pipeline.
 *
 * Scope: the probe-based default-target resolution added by mt#2803
 * (`minskyCompileTargetsFromPresence`, `probeMinskyCompileTargets`, and
 * `runMinskyCompile`'s dispatch branching) — NOT the individual targets'
 * compile output content, which is covered by their own test files
 * (claude-skills.test.ts, claude-agents.test.ts, claude-hooks.test.ts,
 * cursor-rules-ts.test.ts). Every new-pipeline target already accepts an
 * injectable `MinskyCompileFsDeps`, so these tests use a fully in-memory
 * fake fs rather than touching real disk.
 */

import { describe, it, expect } from "bun:test";
import {
  runMinskyCompile,
  probeMinskyCompileTargets,
  minskyCompileTargetsFromPresence,
  minskyCompileTargetsWithGateReport,
} from "./compile";
import type { MinskyCompileFsDeps } from "./types";

const WS = "/workspace";

// ─── In-memory fake fs ────────────────────────────────────────────────────────

/**
 * Builds a MinskyCompileFsDeps backed by a plain object store. Files are
 * keyed by absolute path; a directory is considered to "exist" (for
 * `access`/`readdir`) whenever at least one stored key starts with its path
 * as a prefix — mirrors the ENOENT-on-missing-dir semantics every
 * new-pipeline target already handles via try/catch.
 */
function makeFakeFs(initialFiles: Record<string, string> = {}): {
  store: Record<string, string>;
  fs: MinskyCompileFsDeps;
} {
  const store: Record<string, string> = { ...initialFiles };

  const hasPrefix = (dirPath: string): boolean => {
    const prefix = dirPath.endsWith("/") ? dirPath : `${dirPath}/`;
    return Object.keys(store).some((key) => key.startsWith(prefix));
  };

  const fs: MinskyCompileFsDeps = {
    async readFile(filePath: string): Promise<string> {
      const content = store[filePath];
      if (content === undefined) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, open '${filePath}'`), {
          code: "ENOENT",
        });
      }
      return content;
    },

    async writeFile(filePath: string, data: string): Promise<void> {
      store[filePath] = data;
    },

    async mkdir(): Promise<string | undefined> {
      return undefined;
    },

    async readdir(dirPath: string): Promise<string[]> {
      const prefix = dirPath.endsWith("/") ? dirPath : `${dirPath}/`;
      const entries = new Set<string>();
      for (const key of Object.keys(store)) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          const [first] = rest.split("/");
          if (first) entries.add(first);
        }
      }
      if (entries.size === 0) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, scandir '${dirPath}'`), {
          code: "ENOENT",
        });
      }
      return Array.from(entries);
    },

    async access(targetPath: string): Promise<void> {
      if (store[targetPath] !== undefined || hasPrefix(targetPath)) return;
      throw Object.assign(new Error(`ENOENT: no such file or directory, access '${targetPath}'`), {
        code: "ENOENT",
      });
    },

    async chmod(): Promise<void> {
      // no-op — permission bits aren't observable through this fake
    },
  };

  return { store, fs };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("minskyCompileTargetsFromPresence (mt#2803)", () => {
  it("returns an empty array when no source dir is present", () => {
    expect(
      minskyCompileTargetsFromPresence({
        skills: false,
        rules: false,
        agents: false,
        hooks: false,
      })
    ).toEqual([]);
  });

  it("maps every presence flag to its target id, in canonical order (mt#2803, mt#3058)", () => {
    expect(
      minskyCompileTargetsFromPresence({ skills: true, rules: true, agents: true, hooks: true })
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

  it("mt#3058: .minsky/rules/ presence maps to all four rules-sourced targets", () => {
    expect(
      minskyCompileTargetsFromPresence({ skills: false, rules: true, agents: false, hooks: false })
    ).toEqual(["cursor-rules-ts", "claude.md", "agents.md", "claude-rules"]);
  });

  it("includes only the present targets, preserving the canonical order", () => {
    expect(
      minskyCompileTargetsFromPresence({ skills: true, rules: false, agents: true, hooks: false })
    ).toEqual(["claude-skills", "claude-agents"]);
  });

  // ─── mt#4866 SC3: the harness gate ────────────────────────────────────────
  //
  // Pre-fix control, measured live 2026-09-04 at `d667c9634`: in a scratch
  // project recording `workspace.harness: claude-code`, with only
  // `.minsky/rules/` present and no `.cursor/` and no `AGENTS.md`,
  // `probeMinskyCompileTargets` returned
  //   ["cursor-rules-ts", "claude.md", "agents.md", "claude-rules"]
  // — two of which Claude Code does not read. Every case above passes unchanged
  // because `harness` is absent there, which is the additive-by-design property.
  describe("harness gate (mt#4866 SC3)", () => {
    const RULES_ONLY = { skills: false, rules: true, agents: false, hooks: false };
    const NO_OUTPUTS = { cursorRules: false, agentsMd: false };

    it("drops cursor-rules-ts and agents.md under claude-code with no existing outputs", () => {
      expect(
        minskyCompileTargetsFromPresence({
          ...RULES_ONLY,
          harness: "claude-code",
          existingOutputs: NO_OUTPUTS,
        })
      ).toEqual(["claude.md", "claude-rules"]);
    });

    // The two channels Claude Code actually implements (mt#3107) must survive —
    // a gate that dropped these would leave the harness with nothing.
    it("keeps claude.md and claude-rules under claude-code", () => {
      const targets = minskyCompileTargetsFromPresence({
        ...RULES_ONLY,
        harness: "claude-code",
        existingOutputs: NO_OUTPUTS,
      });
      expect(targets).toContain("claude.md");
      expect(targets).toContain("claude-rules");
    });

    // SC3 escape (b). This is also what makes the change a no-op in Minsky's own
    // repository, which has both outputs on disk.
    it("keeps an output that already exists, per-target", () => {
      expect(
        minskyCompileTargetsFromPresence({
          ...RULES_ONLY,
          harness: "claude-code",
          existingOutputs: { cursorRules: true, agentsMd: false },
        })
      ).toEqual(["cursor-rules-ts", "claude.md", "claude-rules"]);

      expect(
        minskyCompileTargetsFromPresence({
          ...RULES_ONLY,
          harness: "claude-code",
          existingOutputs: { cursorRules: false, agentsMd: true },
        })
      ).toEqual(["claude.md", "agents.md", "claude-rules"]);
    });

    it("gates nothing for a different harness", () => {
      expect(
        minskyCompileTargetsFromPresence({
          ...RULES_ONLY,
          harness: "cursor",
          existingOutputs: NO_OUTPUTS,
        })
      ).toEqual(["cursor-rules-ts", "claude.md", "agents.md", "claude-rules"]);
    });

    // The additive property, stated as a test: an existing caller that passes
    // neither new field gets exactly the pre-mt#4866 set.
    it("gates nothing when no harness is recorded", () => {
      expect(minskyCompileTargetsFromPresence(RULES_ONLY)).toEqual([
        "cursor-rules-ts",
        "claude.md",
        "agents.md",
        "claude-rules",
      ]);
    });

    it("does not affect non-rules targets", () => {
      expect(
        minskyCompileTargetsFromPresence({
          skills: true,
          rules: false,
          agents: true,
          hooks: true,
          harness: "claude-code",
          existingOutputs: NO_OUTPUTS,
        })
      ).toEqual(["claude-skills", "claude-agents", "claude-hooks"]);
    });

    // PR #3623 R1. A gated-out target simply vanishes from the list, which reads
    // identically to one that was never applicable — so callers need to be able
    // to tell the two apart and say so.
    describe("gate report", () => {
      it("names each gated-out target with a reason naming the escape", () => {
        const { targets, gatedOut } = minskyCompileTargetsWithGateReport({
          ...RULES_ONLY,
          harness: "claude-code",
          existingOutputs: NO_OUTPUTS,
        });

        expect(targets).toEqual(["claude.md", "claude-rules"]);
        expect(gatedOut.map((g) => g.target)).toEqual(["cursor-rules-ts", "agents.md"]);
        for (const entry of gatedOut) {
          expect(entry.reason).toContain("--target");
        }
      });

      it("reports nothing gated when the gate does not fire", () => {
        expect(minskyCompileTargetsWithGateReport(RULES_ONLY).gatedOut).toEqual([]);
        expect(
          minskyCompileTargetsWithGateReport({
            ...RULES_ONLY,
            harness: "claude-code",
            existingOutputs: { cursorRules: true, agentsMd: true },
          }).gatedOut
        ).toEqual([]);
      });

      // The two functions must never disagree; one delegates to the other, and
      // this pins that so a future edit cannot fork them.
      it("agrees with minskyCompileTargetsFromPresence on the target list", () => {
        for (const harness of [undefined, "claude-code", "cursor"]) {
          for (const existingOutputs of [
            NO_OUTPUTS,
            { cursorRules: true, agentsMd: false },
            { cursorRules: true, agentsMd: true },
          ]) {
            const input = { ...RULES_ONLY, harness, existingOutputs };
            expect(minskyCompileTargetsWithGateReport(input).targets).toEqual(
              minskyCompileTargetsFromPresence(input)
            );
          }
        }
      });
    });
  });
});

describe("probeMinskyCompileTargets (mt#2803)", () => {
  it("returns an empty array for a fresh repo (no .minsky/ source dirs)", async () => {
    const { fs } = makeFakeFs();
    const targets = await probeMinskyCompileTargets(WS, fs);
    expect(targets).toEqual([]);
  });

  it("detects each source dir independently", async () => {
    const { fs } = makeFakeFs({
      [`${WS}/.minsky/skills/foo/SKILL.md`]: "---\nname: foo\ndescription: test\n---\ncontent",
      [`${WS}/.minsky/hooks/bar.ts`]: "export {}",
    });
    const targets = await probeMinskyCompileTargets(WS, fs);
    expect(targets).toEqual(["claude-skills", "claude-hooks"]);
  });

  it("detects all four source dirs together", async () => {
    const { fs } = makeFakeFs({
      [`${WS}/.minsky/skills/.keep`]: "",
      [`${WS}/.minsky/rules/.keep`]: "",
      [`${WS}/.minsky/agents/.keep`]: "",
      [`${WS}/.minsky/hooks/.keep`]: "",
    });
    const targets = await probeMinskyCompileTargets(WS, fs);
    expect(targets).toEqual([
      "claude-skills",
      "cursor-rules-ts",
      "claude.md",
      "agents.md",
      "claude-rules",
      "claude-agents",
      "claude-hooks",
    ]);
  });

  // ─── mt#4866 SC3, through the probe ───────────────────────────────────────
  //
  // The block above covers the pure mapping; these cover the probe actually
  // READING the recorded harness and the on-disk outputs. That read is the half
  // the live pre-fix measurement exercised, and the half a mapping-only test
  // would leave unverified.
  const CLAUDE_CODE_LOCAL_CONFIG = "workspace:\n  mainPath: /workspace\n  harness: claude-code\n";

  it("mt#4866: claude-code with no existing outputs drops cursor-rules-ts and agents.md", async () => {
    const { fs } = makeFakeFs({
      [`${WS}/.minsky/rules/.keep`]: "",
      [`${WS}/.minsky/config.local.yaml`]: CLAUDE_CODE_LOCAL_CONFIG,
    });
    expect(await probeMinskyCompileTargets(WS, fs)).toEqual(["claude.md", "claude-rules"]);
  });

  it("mt#4866: an existing .cursor/rules keeps cursor-rules-ts under claude-code", async () => {
    const { fs } = makeFakeFs({
      [`${WS}/.minsky/rules/.keep`]: "",
      [`${WS}/.minsky/config.local.yaml`]: CLAUDE_CODE_LOCAL_CONFIG,
      [`${WS}/.cursor/rules/existing.mdc`]: "---\nname: existing\n---\n",
    });
    expect(await probeMinskyCompileTargets(WS, fs)).toEqual([
      "cursor-rules-ts",
      "claude.md",
      "claude-rules",
    ]);
  });

  it("mt#4866: an existing AGENTS.md keeps agents.md under claude-code", async () => {
    const { fs } = makeFakeFs({
      [`${WS}/.minsky/rules/.keep`]: "",
      [`${WS}/.minsky/config.local.yaml`]: CLAUDE_CODE_LOCAL_CONFIG,
      [`${WS}/AGENTS.md`]: "# Agents\n",
    });
    expect(await probeMinskyCompileTargets(WS, fs)).toEqual([
      "claude.md",
      "agents.md",
      "claude-rules",
    ]);
  });

  // The regression guard for this repository: both outputs exist here, so the
  // gate must be inert. If this ever goes red, `minsky compile` has started
  // skipping targets Minsky itself commits.
  it("mt#4866: with BOTH outputs present the target set is unchanged", async () => {
    const { fs } = makeFakeFs({
      [`${WS}/.minsky/rules/.keep`]: "",
      [`${WS}/.minsky/config.local.yaml`]: CLAUDE_CODE_LOCAL_CONFIG,
      [`${WS}/.cursor/rules/existing.mdc`]: "---\nname: existing\n---\n",
      [`${WS}/AGENTS.md`]: "# Agents\n",
    });
    expect(await probeMinskyCompileTargets(WS, fs)).toEqual([
      "cursor-rules-ts",
      "claude.md",
      "agents.md",
      "claude-rules",
    ]);
  });

  it("mt#4866: no recorded harness leaves the target set unchanged", async () => {
    const { fs } = makeFakeFs({ [`${WS}/.minsky/rules/.keep`]: "" });
    expect(await probeMinskyCompileTargets(WS, fs)).toEqual([
      "cursor-rules-ts",
      "claude.md",
      "agents.md",
      "claude-rules",
    ]);
  });

  it("mt#4866: reads the harness from the committed config when there is no local overlay", async () => {
    const { fs } = makeFakeFs({
      [`${WS}/.minsky/rules/.keep`]: "",
      [`${WS}/.minsky/config.yaml`]: "workspace:\n  harness: claude-code\n",
    });
    expect(await probeMinskyCompileTargets(WS, fs)).toEqual(["claude.md", "claude-rules"]);
  });

  // Fails OPEN. An unparseable config must not silently stop writing outputs a
  // project depends on — the failure direction is toward writing more, not less.
  it("mt#4866: an unparseable config gates nothing", async () => {
    const { fs } = makeFakeFs({
      [`${WS}/.minsky/rules/.keep`]: "",
      [`${WS}/.minsky/config.local.yaml`]: "{{ not: valid: yaml: [",
    });
    expect(await probeMinskyCompileTargets(WS, fs)).toEqual([
      "cursor-rules-ts",
      "claude.md",
      "agents.md",
      "claude-rules",
    ]);
  });
});

describe("runMinskyCompile — bare-invocation default-target resolution (mt#2803)", () => {
  it("falls back to the single claude-skills default on a fresh repo (no .minsky/ source dirs)", async () => {
    const { fs } = makeFakeFs();

    const result = await runMinskyCompile({ workspacePath: WS, fsDeps: fs });

    expect(result.target).toBe("claude-skills");
    expect(result.targets).toBeUndefined();
    expect(result.filesWritten).toEqual([]);
  });

  it("compiles every target with an existing source dir in one bare invocation", async () => {
    // Empty placeholder files: enough for the probe (dir presence) but not
    // recognized as skill/hook sources by either target's own discovery
    // logic — which is exactly the point: this proves the mt#2803 DISPATCH
    // loop actually invoked BOTH targets (not just the first), independent
    // of what either target's compile output looks like.
    const { fs } = makeFakeFs({
      [`${WS}/.minsky/skills/.keep`]: "",
      [`${WS}/.minsky/hooks/.keep`]: "",
    });

    const result = await runMinskyCompile({ workspacePath: WS, fsDeps: fs });

    expect(result.targets).toBeDefined();
    expect(result.targets?.map((t) => t.target)).toEqual(["claude-skills", "claude-hooks"]);
    expect(result.targets?.every((t) => t.filesWritten.length === 0)).toBe(true);
    // Top-level aggregate mirrors the (empty) per-target concatenation.
    expect(result.filesWritten).toEqual([]);
  });

  it("explicit --target compiles exactly one target, ignoring other existing source dirs", async () => {
    const { fs } = makeFakeFs({
      [`${WS}/.minsky/skills/.keep`]: "",
      [`${WS}/.minsky/hooks/.keep`]: "",
    });

    const result = await runMinskyCompile({
      workspacePath: WS,
      target: "claude-hooks",
      fsDeps: fs,
    });

    expect(result.target).toBe("claude-hooks");
    expect(result.targets).toBeUndefined();
  });

  it("throws for an explicit unknown target (unchanged error behavior)", async () => {
    const { fs } = makeFakeFs();
    await expect(
      runMinskyCompile({ workspacePath: WS, target: "not-a-real-target", fsDeps: fs })
    ).rejects.toThrow('Unknown compile target: "not-a-real-target"');
  });

  it('throws a migration hint for the retired "cursor-rules" target (mt#2995)', async () => {
    const { fs } = makeFakeFs();
    await expect(
      runMinskyCompile({ workspacePath: WS, target: "cursor-rules", fsDeps: fs })
    ).rejects.toThrow(/cursor-rules-ts/);
  });
});
