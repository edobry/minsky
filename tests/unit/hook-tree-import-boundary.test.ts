/**
 * `src/**` must not import `.minsky/hooks/**` (mt#4010 SC6 / AT8).
 *
 * The hook tree is not part of the root TypeScript program — `tsconfig.json`'s
 * `include` is `["src", "types", "tests", ...]` and does not claim `.minsky/`.
 * An import from `src/` would pull it in by import-reachability AND bundle it
 * into `dist/minsky.js` via `src/cli.ts`, silently making `.minsky/hooks/**` a
 * deploy surface it currently is not. `src/mcp/guard-health-tracker.ts`
 * documents the convention and duplicates the hook tree's read logic rather
 * than importing it.
 *
 * This is why the cockpit's interceptor catalog is a GENERATED artifact: the
 * generator lives in `scripts/` (which has no such constraint and already
 * imports these modules) and `src/` reads its JSON output.
 *
 * Scope note: this pins the boundary for PRODUCTION source. A `*.test.ts` under
 * `src/` importing the hook tree would not reach the bundle, so tests are
 * excluded rather than the rule being weakened for them.
 *
 * @see mt#4010 §Data-access decision
 * @see scripts/build-interceptor-catalog.ts
 */
/* eslint-disable custom/no-real-fs-in-tests --
 * This test's SUBJECT is the real source tree: it asserts that no file under
 * `src/` imports the hook tree. Injecting a mock fs would make it assert
 * nothing at all — the mock would become the only thing under test.
 *
 * The rule's actual targets are absent here: no fixture files are created on
 * disk, no `tmpdir()`, no timestamp-unique paths, and therefore none of the
 * parallel-test race conditions it exists to prevent. This is a read-only walk
 * over tracked files.
 *
 * Recorded rather than quietly routed around: the PREVIOUS revision shelled out
 * to `grep`, which this rule does not see but which reads the very same
 * filesystem — through a binary whose flags differ between BSD and GNU, and
 * whose non-zero exit is easy to misread as "no matches" (PR #2930 R1).
 */
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/**
 * Matches a module SPECIFIER naming the hook tree — `from "…/.minsky/hooks/x"`,
 * a bare `import "…"`, a dynamic `import(…)`, or a `require(…)`.
 *
 * Textual rather than an AST walk on purpose: the question IS textual — does
 * any specifier name that tree — and a specifier cannot hide from a
 * specifier-shaped pattern.
 */
const HOOK_TREE_IMPORT = /(from|import|require)\s*\(?\s*['"][^'"]*\.minsky\/hooks/;

const SKIPPED_DIRS = new Set(["node_modules", "dist", "build", ".git"]);

/** Every `*.ts` / `*.tsx` file under `dir`, recursively. */
function sourceFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    if (dirent.isDirectory()) {
      if (SKIPPED_DIRS.has(dirent.name)) continue;
      out.push(...sourceFilesUnder(join(dir, dirent.name)));
      continue;
    }
    if (/\.tsx?$/.test(dirent.name) && !/\.(test|spec)\.tsx?$/.test(dirent.name)) {
      out.push(join(dir, dirent.name));
    }
  }
  return out;
}

/**
 * Every `src/**` line that imports a path containing `.minsky/hooks`.
 *
 * Implemented with the filesystem rather than by shelling out to `grep`
 * (PR #2930 R1): a subprocess adds a dependency on a binary whose flags differ
 * between BSD and GNU, and its failure mode — a non-zero exit read as "no
 * matches" — is the one this check must never have.
 */
function findHookTreeImports(): string[] {
  const offenders: string[] = [];
  for (const file of sourceFilesUnder(join(REPO_ROOT, "src"))) {
    // `String(...)` rather than an encoding argument or `.toString()`: under
    // this project's type setup every `readFileSync` overload widens to
    // `string | Buffer`, and on that union `.split` does not exist and
    // `.toString` resolves to the zero-argument signature. Coercing once is
    // unambiguous and costs nothing on the string branch.
    const lines = String(readFileSync(file)).split("\n");
    lines.forEach((line, i) => {
      if (HOOK_TREE_IMPORT.test(line)) {
        offenders.push(`${file.slice(REPO_ROOT.length + 1)}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  return offenders;
}

describe("hook-tree import boundary (mt#4010 SC6)", () => {
  test("no production file under src/ imports .minsky/hooks", () => {
    const offenders = findHookTreeImports();
    expect(offenders).toEqual([]);
  });

  test("the detector actually matches an import specifier (negative control)", () => {
    // Tests the SAME constant the check above uses, not a copy of it: a
    // duplicated pattern here could pass while the real one is broken, which
    // is the failure this control exists to rule out.
    expect(HOOK_TREE_IMPORT.test(`import { X } from "../../.minsky/hooks/registry";`)).toBe(true);
    expect(
      HOOK_TREE_IMPORT.test(`import { Y } from "../../../.minsky/hooks/interceptor-descriptions";`)
    ).toBe(true);
    expect(HOOK_TREE_IMPORT.test(`await import("../../.minsky/hooks/registry")`)).toBe(true);
    // A mere mention in a comment or a string path is NOT an import and must
    // not trip the rule — several src files legitimately reference the tree in
    // prose and in `@see` tags.
    expect(HOOK_TREE_IMPORT.test(` * @see .minsky/hooks/guard-health.ts — the write side`)).toBe(
      false
    );
    expect(HOOK_TREE_IMPORT.test(`const p = ".minsky/hooks/registry.ts";`)).toBe(false);
  });

  test("the walk actually reaches source files (second negative control)", () => {
    // A correct pattern over an EMPTY file list also reports zero offenders.
    // Both halves have to be alive for the check above to mean anything.
    const files = sourceFilesUnder(join(REPO_ROOT, "src"));
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith("src/cockpit/widgets/interceptors.ts"))).toBe(true);
    // Tests are excluded by design — a test importing the hook tree never
    // reaches the bundle.
    expect(files.some((f) => /\.test\.tsx?$/.test(f))).toBe(false);
  });
});
