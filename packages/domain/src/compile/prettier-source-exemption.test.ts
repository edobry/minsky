/* eslint-disable custom/no-real-fs-in-tests -- Part 2 IS a census of the real `.prettierignore` against the real `.minsky/` source trees; an injected fs would assert something about the mock rather than about the repo, which is the one thing it exists to check. Part 1 below uses an in-memory fs and needs no exemption. */
/**
 * mt#4622 — Prettier must not reformat the markdown SOURCES that the skill and
 * agent compile targets emit VERBATIM.
 *
 * `.prettierignore` has exempted the compiled OUTPUT (`.claude/skills/`,
 * `.claude/agents/`) since mt#2555, on the stated grounds that "the compiler emits
 * the source markdown verbatim". That reasoning constrains BOTH sides of the
 * equality and only one side was exempted, so lint-staged went on reformatting the
 * SOURCE — producing the same deadlock from the other direction: the source is
 * rewritten at pre-commit Step 1, and `runCompileCheck` at Step 9b then finds the
 * output (compiled from the PRE-format source) stale and blocks the commit.
 *
 * The two parts are deliberately different in kind, and both are load-bearing:
 *
 *   Part 1 pins the COUPLING — reformatting a source, with nothing else changing,
 *          makes its compiled output stale. This is the hazard the exemption exists
 *          to remove. If someone later decides the exemption is unnecessary, this is
 *          the test that says why it is not.
 *   Part 2 pins the FIX — the real `.prettierignore` actually covers the real source
 *          population, asked of Prettier's OWN resolver rather than by re-implementing
 *          gitignore semantics (whose anchoring rules this very file's mt#3880 comment
 *          records as easy to misread).
 *
 * Part 1 would still pass with the exemption reverted; Part 2 would still pass if the
 * compiler stopped emitting verbatim. Neither alone protects the invariant.
 *
 * The path literals below are also what give the fast related-test selector its
 * data-read edge (mt#4224) — without one that resolves to a real file, a change to
 * `.prettierignore` selects no tests at all and CI is the first signal. See the comment
 * on PRETTIERIGNORE for the exact spelling that requirement imposes.
 */

import { describe, test, expect } from "bun:test";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getFileInfo } from "prettier";
import { makeClaudeSkillsTarget } from "./targets/claude-skills";
import { checkStaleness } from "./staleness";
import type { MinskyCompileFsDeps } from "./types";

// packages/domain/src/compile → repo root is four levels up.
const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");

// The leading `./` on these two is LOAD-BEARING, not sloppiness — do not "tidy" it away.
// The selector's data-read edge (mt#4224) is extracted by PATH_LITERAL_RE in
// scripts/find-related-tests.ts, which requires a literal to contain a `/` AND a dotted
// extension. A bare `".prettierignore"` has neither, so it forms no edge and a change to
// `.prettierignore` selects ZERO tests — measured, before this comment existed. `"./"`
// satisfies the pattern and `toRepoRelative` strips it straight back off, so the edge
// forms and `join` is unaffected. Verified with `bun scripts/run-related-tests.ts
// .prettierignore`, which must name this file.
const PRETTIERIGNORE = join(REPO_ROOT, "./.prettierignore");
const GITIGNORE = join(REPO_ROOT, "./.gitignore");

const SKILLS_SOURCE_DIR = join(REPO_ROOT, ".minsky", "skills");
const AGENTS_SOURCE_DIR = join(REPO_ROOT, ".minsky", "agents");

/** Ask Prettier itself whether it would format this path, using the repo's own ignore files. */
async function prettierIgnores(absPath: string): Promise<boolean> {
  const info = await getFileInfo(absPath, { ignorePath: [GITIGNORE, PRETTIERIGNORE] });
  return info.ignored;
}

// ─── Part 1: the coupling the exemption exists to remove (in-memory fs) ───────

const WORKSPACE = "/workspace";
const SKILL_DIR = `${WORKSPACE}/.minsky/skills/coupled`;
const SOURCE_PATH = `${SKILL_DIR}/SKILL.md`;
const OUTPUT_PATH = `${WORKSPACE}/.claude/skills/coupled/SKILL.md`;

/**
 * A skill source written in markdown Prettier would rewrite: `*italic*` becomes
 * `_italic_` and the table cells get padded. Both are pure formatting — the rendered
 * document is identical, which is exactly why this is easy to walk past.
 */
const SOURCE_UNFORMATTED = `---
name: coupled
description: Pins the source-format-to-output-staleness coupling.
user-invocable: true
---

# Coupled

An *italic* word, and a table Prettier would pad:

| | A |
| --- | --- |
| row | one |
`;

/** The same document after Prettier — byte-different, semantically identical. */
const SOURCE_FORMATTED = SOURCE_UNFORMATTED.replace("*italic*", "_italic_")
  .replace("| | A |", "|     | A   |")
  .replace("| row | one |", "| row | one |");

/** A mutable in-memory fs whose source file can be swapped between compile and check. */
function makeMutableFs(initial: Record<string, string>): {
  fs: MinskyCompileFsDeps;
  set(path: string, content: string): void;
} {
  const files: Record<string, string> = { ...initial };
  const fs: MinskyCompileFsDeps = {
    async readFile(path: string): Promise<string> {
      const content = files[path];
      if (content === undefined) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      }
      return content;
    },
    async writeFile(path: string, data: string): Promise<void> {
      files[path] = data;
    },
    async mkdir(): Promise<undefined> {
      return undefined;
    },
    async readdir(path: string): Promise<string[]> {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const names = new Set<string>();
      for (const key of Object.keys(files)) {
        if (key.startsWith(prefix)) {
          const segment = key.slice(prefix.length).split("/")[0];
          if (segment !== undefined) names.add(segment);
        }
      }
      return Array.from(names);
    },
    async access(path: string): Promise<void> {
      if (files[path] === undefined) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      }
    },
    async chmod(): Promise<void> {
      // permissions are not modelled here
    },
  };
  return { fs, set: (path, content) => void (files[path] = content) };
}

/** Compile, then run the same staleness check `compile --check` runs. */
async function compileThenCheck(
  fs: MinskyCompileFsDeps,
  { recompile }: { recompile: boolean }
): Promise<{ stale: boolean; staleFile?: string }> {
  const target = makeClaudeSkillsTarget(
    async () => ({}),
    () => {},
    () => {}
  );
  if (recompile) {
    await target.compile({}, WORKSPACE, fs);
  }
  const dry = await target.compile({ dryRun: true }, WORKSPACE, fs);
  return checkStaleness(target, {}, WORKSPACE, new Map(dry.contentsByPath), fs, {
    skipOrphanDetection: true,
  });
}

describe("mt#4622 Part 1: reformatting a source staleness-breaks its compiled output", () => {
  test("control — an untouched source leaves its output up to date", async () => {
    const { fs } = makeMutableFs({ [SOURCE_PATH]: SOURCE_UNFORMATTED });
    await compileThenCheck(fs, { recompile: true });

    const result = await compileThenCheck(fs, { recompile: false });

    expect(result.stale).toBe(false);
  });

  test("reformatting ONLY the source — no recompile — makes the output stale", async () => {
    const { fs, set } = makeMutableFs({ [SOURCE_PATH]: SOURCE_UNFORMATTED });
    await compileThenCheck(fs, { recompile: true });

    // Exactly what lint-staged does to a staged `.md` at pre-commit Step 1.
    set(SOURCE_PATH, SOURCE_FORMATTED);
    const result = await compileThenCheck(fs, { recompile: false });

    expect(result.stale).toBe(true);
    expect(result.staleFile).toBe(OUTPUT_PATH);
  });

  test("a recompile clears it — the defect is transient, not a permanent wedge", async () => {
    const { fs, set } = makeMutableFs({ [SOURCE_PATH]: SOURCE_UNFORMATTED });
    await compileThenCheck(fs, { recompile: true });
    set(SOURCE_PATH, SOURCE_FORMATTED);

    const result = await compileThenCheck(fs, { recompile: true });

    expect(result.stale).toBe(false);
  });
});

// ─── Part 2: the real `.prettierignore` covers the real source population ─────

/** Every `<dir>/<name>/*.md` under a `.minsky/` source tree, as absolute paths. */
function markdownSourcesUnder(sourceDir: string): string[] {
  if (!existsSync(sourceDir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(sourceDir, entry.name);
    for (const file of readdirSync(dir)) {
      if (file.endsWith(".md")) found.push(join(dir, file));
    }
  }
  return found;
}

describe("mt#4622 Part 2: markdown compile sources are exempt from Prettier", () => {
  test("the source trees are actually populated (guards a vacuous pass)", () => {
    // Without this, an empty or mis-resolved directory makes every assertion below
    // pass over zero files — the shape mem#704 calls a probe that cannot fail.
    expect(markdownSourcesUnder(SKILLS_SOURCE_DIR).length).toBeGreaterThan(0);
    expect(markdownSourcesUnder(AGENTS_SOURCE_DIR).length).toBeGreaterThan(0);
  });

  test("every markdown source under .minsky/skills and .minsky/agents is ignored", async () => {
    const sources = [
      ...markdownSourcesUnder(SKILLS_SOURCE_DIR),
      ...markdownSourcesUnder(AGENTS_SOURCE_DIR),
    ];

    const formatted: string[] = [];
    for (const source of sources) {
      if (!(await prettierIgnores(source))) formatted.push(source);
    }

    // Naming the offenders matters: the fix is a pattern, and a pattern that covers
    // most of a tree fails in a way a bare count cannot describe.
    expect(formatted).toEqual([]);
  });

  test("the exemption is markdown-only — TypeScript definitions stay formatted", async () => {
    const definitions = [
      join(SKILLS_SOURCE_DIR, "cockpit-design", "skill.ts"),
      join(AGENTS_SOURCE_DIR, "auditor", "agent.ts"),
    ].filter((p) => existsSync(p));
    expect(definitions.length).toBeGreaterThan(0);

    for (const definition of definitions) {
      expect(await prettierIgnores(definition)).toBe(false);
    }
  });

  test("ordinary repo markdown is still formatted — the ignore is not a blanket", async () => {
    // The negative control for Part 2: an over-broad pattern (`**/*.md`, or a stray
    // `.minsky/`) would satisfy every assertion above and silently stop formatting the
    // repo's documentation.
    expect(await prettierIgnores(join(REPO_ROOT, "README.md"))).toBe(false);
  });
});
