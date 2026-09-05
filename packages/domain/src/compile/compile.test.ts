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
// The banner the monolithic writers emit — imported so a fixture claiming to be
// "a file Minsky generated" cannot drift from what Minsky actually writes.
import { MONOLITHIC_GENERATED_BANNER } from "../rules/compile/banner-constants";

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

/**
 * "This project already has a CLAUDE.md that Minsky generated" — the case every
 * pre-mt#5003 test was implicitly written under, and this repository's own case.
 *
 * Since mt#5003 `claude.md` is selected ONLY for that case: an absent CLAUDE.md
 * is no longer created, and the always-apply rules go to `.claude/rules/`
 * instead. The default is deliberately the new behaviour, so a caller that
 * forgets to probe ownership does not silently keep creating the file — which
 * means the fixtures that want the four-target list have to say so.
 */
const OWNS_CLAUDE_MD = { claudeMd: "generated", agentsMd: "generated" } as const;

/** A project whose CLAUDE.md is the user's, and whose AGENTS.md is ours. */
const FOREIGN_CLAUDE_MD = { claudeMd: "foreign", agentsMd: "generated" } as const;

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
      minskyCompileTargetsFromPresence({
        skills: true,
        rules: true,
        agents: true,
        hooks: true,
        ownership: OWNS_CLAUDE_MD,
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

  it("mt#3058: .minsky/rules/ presence maps to all four rules-sourced targets", () => {
    expect(
      minskyCompileTargetsFromPresence({
        skills: false,
        rules: true,
        agents: false,
        hooks: false,
        ownership: OWNS_CLAUDE_MD,
      })
    ).toEqual(["cursor-rules-ts", "claude.md", "agents.md", "claude-rules"]);
  });

  it("mt#5003: with no CLAUDE.md of ours, claude.md is NOT selected", () => {
    // The new default, stated as its own case rather than left implicit in the
    // fixtures above: a fresh project gets the rules through `.claude/rules/`,
    // and nothing creates a CLAUDE.md for it.
    expect(
      minskyCompileTargetsFromPresence({
        skills: false,
        rules: true,
        agents: false,
        hooks: false,
      })
    ).toEqual(["cursor-rules-ts", "agents.md", "claude-rules"]);
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
    // Carries `ownership` because every test in this block was written when
    // `claude.md` was selected unconditionally — see OWNS_CLAUDE_MD above.
    const RULES_ONLY = {
      skills: false,
      rules: true,
      agents: false,
      hooks: false,
      ownership: OWNS_CLAUDE_MD,
    };
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
            // Every ownership combination, including the two mt#5003 added
            // ("absent", "unreadable"). The tri-state is what makes this
            // enumeration finite and total — the previous pair of booleans could
            // express `{foreign, owned}` together, which is not a real state.
            for (const ownership of [
              undefined,
              { claudeMd: "generated", agentsMd: "generated" },
              { claudeMd: "foreign", agentsMd: "generated" },
              { claudeMd: "generated", agentsMd: "foreign" },
              { claudeMd: "foreign", agentsMd: "foreign" },
              { claudeMd: "absent", agentsMd: "absent" },
              { claudeMd: "unreadable", agentsMd: "unreadable" },
            ] as const) {
              const input = { ...RULES_ONLY, harness, existingOutputs, ownership };
              expect(minskyCompileTargetsWithGateReport(input).targets).toEqual(
                minskyCompileTargetsFromPresence(input)
              );
            }
          }
        }
      });
    });

    // ─── Foreign-ownership gate (mt#4986 SC3) ───────────────────────────────
    //
    // The harness gate above reads a file's PRESENCE as evidence the user
    // consumes our output. That is what this narrows: a file that is there but
    // is the user's own is not consent, it is the thing to protect.
    describe("foreign-ownership gate (mt#4986 SC3)", () => {
      it("drops claude.md when CLAUDE.md is the user's", () => {
        // CLAUDE.md had NO presence gate at all — it was pushed unconditionally
        // — so this is an added gate, not a narrowed one. That distinction is
        // why a literal reading of "narrow the presence rule" would have missed
        // the file the task is named for.
        expect(
          minskyCompileTargetsFromPresence({
            ...RULES_ONLY,
            ownership: FOREIGN_CLAUDE_MD,
          })
        ).toEqual(["cursor-rules-ts", "agents.md", "claude-rules"]);
      });

      it("drops agents.md when AGENTS.md is the user's, on ANY harness", () => {
        // Independent of the harness escape: `existingOutputs.agentsMd` is only
        // ever consulted under claude-code, so narrowing it alone would leave a
        // Cursor project's hand-written AGENTS.md unprotected.
        for (const harness of [undefined, "cursor", "claude-code"]) {
          expect(
            minskyCompileTargetsFromPresence({
              ...RULES_ONLY,
              harness,
              existingOutputs: { cursorRules: true, agentsMd: true },
              ownership: { claudeMd: "generated", agentsMd: "foreign" },
            })
          ).not.toContain("agents.md");
        }
      });

      it("leaves the per-file targets alone", () => {
        // `.cursor/rules/` and `.claude/rules/` already coexist correctly with
        // hand-authored files, so this gate must not touch them.
        const targets = minskyCompileTargetsFromPresence({
          ...RULES_ONLY,
          ownership: { claudeMd: "foreign", agentsMd: "foreign" },
        });
        expect(targets).toEqual(["cursor-rules-ts", "claude-rules"]);
      });

      it("changes nothing when both monolithic outputs are ours", () => {
        expect(
          minskyCompileTargetsFromPresence({ ...RULES_ONLY, ownership: OWNS_CLAUDE_MD })
        ).toEqual(minskyCompileTargetsFromPresence(RULES_ONLY));
      });

      it("mt#5003: an ABSENT CLAUDE.md is gated with its own kind, not as foreign", () => {
        // The two read very differently to an operator: "your file was left
        // alone" on a project that has no such file would be alarming and false.
        const { gatedOut } = minskyCompileTargetsWithGateReport({
          ...RULES_ONLY,
          ownership: { claudeMd: "absent", agentsMd: "generated" },
        });

        const claudeMd = gatedOut.find((g) => g.target === "claude.md");
        expect(claudeMd?.kind).toBe("absent");
        expect(claudeMd?.reason).toContain(".claude/rules/");
        expect(claudeMd?.reason).not.toContain("treated as yours");
      });

      it("mt#5003: an UNREADABLE CLAUDE.md is treated as not-ours, never written", () => {
        const { targets, gatedOut } = minskyCompileTargetsWithGateReport({
          ...RULES_ONLY,
          ownership: { claudeMd: "unreadable", agentsMd: "generated" },
        });

        expect(targets).not.toContain("claude.md");
        expect(gatedOut.find((g) => g.target === "claude.md")?.kind).toBe("foreign");
      });

      it("marks the skip kind foreign, so a caller does not offer --target as the fix", () => {
        // The two gates have OPPOSITE remedies: `--target` opts into a harness
        // skip and would overwrite the file a foreign skip is protecting.
        const { gatedOut } = minskyCompileTargetsWithGateReport({
          ...RULES_ONLY,
          ownership: FOREIGN_CLAUDE_MD,
        });

        expect(gatedOut).toHaveLength(1);
        expect(gatedOut[0]?.target).toBe("claude.md");
        expect(gatedOut[0]?.kind).toBe("foreign");
        expect(gatedOut[0]?.reason).toContain("banner");
        expect(gatedOut[0]?.reason).not.toContain("--target");
      });

      it("keeps the harness kind distinguishable from the foreign kind", () => {
        const { gatedOut } = minskyCompileTargetsWithGateReport({
          ...RULES_ONLY,
          harness: "claude-code",
          existingOutputs: NO_OUTPUTS,
          ownership: FOREIGN_CLAUDE_MD,
        });

        const byTarget = Object.fromEntries(gatedOut.map((g) => [g.target, g.kind]));
        expect(byTarget["cursor-rules-ts"]).toBe("harness");
        expect(byTarget["agents.md"]).toBe("harness");
        expect(byTarget["claude.md"]).toBe("foreign");
      });
    });
  });
});

describe("probeMinskyCompileTargets (mt#2803)", () => {
  /**
   * A `CLAUDE.md` Minsky generated, as a fixture entry.
   *
   * Since mt#5003 the probe selects `claude.md` only when one of ours is on
   * disk, so a fixture that wants the pre-mt#5003 target list has to include it.
   * Written with the shared banner constant rather than a literal so a fixture
   * claiming to be ours cannot drift from what Minsky actually writes.
   */
  const ownedClaudeMd = (): Record<string, string> => ({
    [`${WS}/CLAUDE.md`]: `${MONOLITHIC_GENERATED_BANNER}\n\n# Project Instructions\n`,
  });

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
      ...ownedClaudeMd(),
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

  it("mt#5003: the same repo WITHOUT a CLAUDE.md of ours omits claude.md", async () => {
    // The discriminating pair for the whole task, end-to-end through the probe:
    // identical source dirs, one fixture difference, one target difference.
    const { fs } = makeFakeFs({
      [`${WS}/.minsky/skills/.keep`]: "",
      [`${WS}/.minsky/rules/.keep`]: "",
      [`${WS}/.minsky/agents/.keep`]: "",
      [`${WS}/.minsky/hooks/.keep`]: "",
    });
    expect(await probeMinskyCompileTargets(WS, fs)).toEqual([
      "claude-skills",
      "cursor-rules-ts",
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
      ...ownedClaudeMd(),
      [`${WS}/.minsky/config.local.yaml`]: CLAUDE_CODE_LOCAL_CONFIG,
    });
    expect(await probeMinskyCompileTargets(WS, fs)).toEqual(["claude.md", "claude-rules"]);
  });

  it("mt#4866: an existing .cursor/rules keeps cursor-rules-ts under claude-code", async () => {
    const { fs } = makeFakeFs({
      [`${WS}/.minsky/rules/.keep`]: "",
      ...ownedClaudeMd(),
      [`${WS}/.minsky/config.local.yaml`]: CLAUDE_CODE_LOCAL_CONFIG,
      [`${WS}/.cursor/rules/existing.mdc`]: "---\nname: existing\n---\n",
    });
    expect(await probeMinskyCompileTargets(WS, fs)).toEqual([
      "cursor-rules-ts",
      "claude.md",
      "claude-rules",
    ]);
  });

  // mt#4986 narrowed mt#4866's already-exists escape: the file must be OURS,
  // not merely present. The fixture therefore carries the banner, which is what
  // an AGENTS.md this escape was written for actually looks like — a previous
  // `minsky compile` wrote it. A bare `"# Agents\n"` here would be a
  // hand-written file, and asserting that it keeps the target would pin the
  // exact behaviour mt#4986 exists to remove.
  it("mt#4866: an existing GENERATED AGENTS.md keeps agents.md under claude-code", async () => {
    const { fs } = makeFakeFs({
      [`${WS}/.minsky/rules/.keep`]: "",
      ...ownedClaudeMd(),
      [`${WS}/.minsky/config.local.yaml`]: CLAUDE_CODE_LOCAL_CONFIG,
      [`${WS}/AGENTS.md`]: `${MONOLITHIC_GENERATED_BANNER}\n\n# Agents\n`,
    });
    expect(await probeMinskyCompileTargets(WS, fs)).toEqual([
      "claude.md",
      "agents.md",
      "claude-rules",
    ]);
  });

  // The other side of the same narrowing (mt#4986 SC3), end-to-end through the
  // probe rather than the pure mapping: presence alone no longer unlocks it.
  it("mt#4986: a hand-written AGENTS.md does NOT keep agents.md", async () => {
    const { fs } = makeFakeFs({
      [`${WS}/.minsky/rules/.keep`]: "",
      ...ownedClaudeMd(),
      [`${WS}/.minsky/config.local.yaml`]: CLAUDE_CODE_LOCAL_CONFIG,
      [`${WS}/AGENTS.md`]: "# Agents\n\nCodex reads this. Do not clobber.\n",
    });
    expect(await probeMinskyCompileTargets(WS, fs)).toEqual(["claude.md", "claude-rules"]);
  });

  it("mt#4986: a hand-written CLAUDE.md drops claude.md, which had no gate at all before", async () => {
    const { fs } = makeFakeFs({
      [`${WS}/.minsky/rules/.keep`]: "",
      ...ownedClaudeMd(),
      [`${WS}/.minsky/config.local.yaml`]: CLAUDE_CODE_LOCAL_CONFIG,
      [`${WS}/CLAUDE.md`]: "# Widget house rules\n\n- We use tabs, not spaces.\n",
    });
    expect(await probeMinskyCompileTargets(WS, fs)).toEqual(["claude-rules"]);
  });

  // The regression guard for this repository: both outputs exist here AND both
  // carry the banner, so both gates must be inert. If this ever goes red,
  // `minsky compile` has started skipping targets Minsky itself commits.
  it("mt#4866: with BOTH outputs present the target set is unchanged", async () => {
    const { fs } = makeFakeFs({
      [`${WS}/.minsky/rules/.keep`]: "",
      ...ownedClaudeMd(),
      [`${WS}/.minsky/config.local.yaml`]: CLAUDE_CODE_LOCAL_CONFIG,
      [`${WS}/.cursor/rules/existing.mdc`]: "---\nname: existing\n---\n",
      [`${WS}/AGENTS.md`]: `${MONOLITHIC_GENERATED_BANNER}\n\n# Agents\n`,
      [`${WS}/CLAUDE.md`]: `${MONOLITHIC_GENERATED_BANNER}\n\n# Project Instructions\n`,
    });
    expect(await probeMinskyCompileTargets(WS, fs)).toEqual([
      "cursor-rules-ts",
      "claude.md",
      "agents.md",
      "claude-rules",
    ]);
  });

  it("mt#4866: no recorded harness leaves the target set unchanged", async () => {
    const { fs } = makeFakeFs({ [`${WS}/.minsky/rules/.keep`]: "", ...ownedClaudeMd() });
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
      ...ownedClaudeMd(),
      [`${WS}/.minsky/config.yaml`]: "workspace:\n  harness: claude-code\n",
    });
    expect(await probeMinskyCompileTargets(WS, fs)).toEqual(["claude.md", "claude-rules"]);
  });

  // Fails OPEN. An unparseable config must not silently stop writing outputs a
  // project depends on — the failure direction is toward writing more, not less.
  it("mt#4866: an unparseable config gates nothing", async () => {
    const { fs } = makeFakeFs({
      [`${WS}/.minsky/rules/.keep`]: "",
      ...ownedClaudeMd(),
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
