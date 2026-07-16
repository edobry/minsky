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

  it("maps every presence flag to its target id, in claude-skills/cursor-rules-ts/claude-agents/claude-hooks order", () => {
    expect(
      minskyCompileTargetsFromPresence({ skills: true, rules: true, agents: true, hooks: true })
    ).toEqual(["claude-skills", "cursor-rules-ts", "claude-agents", "claude-hooks"]);
  });

  it("includes only the present targets, preserving the canonical order", () => {
    expect(
      minskyCompileTargetsFromPresence({ skills: true, rules: false, agents: true, hooks: false })
    ).toEqual(["claude-skills", "claude-agents"]);
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
    expect(targets).toEqual(["claude-skills", "cursor-rules-ts", "claude-agents", "claude-hooks"]);
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
});
