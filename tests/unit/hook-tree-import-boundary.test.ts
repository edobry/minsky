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
import { describe, test, expect } from "bun:test";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/**
 * Every `src/**` line that imports (or re-exports, or dynamically imports) a
 * path containing `.minsky/hooks`. Uses `grep` over the source tree rather than
 * an AST walk: the question is textual — does any module SPECIFIER name that
 * tree — and a specifier cannot hide from a specifier-shaped pattern.
 */
function findHookTreeImports(): string[] {
  const result = Bun.spawnSync(
    [
      "grep",
      "-rEn",
      String.raw`(from|import|require)\s*\(?\s*['"][^'"]*\.minsky/hooks`,
      "--include=*.ts",
      "--include=*.tsx",
      "src/",
    ],
    // `stderr: "pipe"` is required, not cosmetic: Bun's default is to INHERIT
    // stderr, which types `result.stderr` as `never` and would leave the
    // failure branch below unable to report why grep failed.
    { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" }
  );

  const stdout = result.stdout.toString();
  // grep exits 1 with empty stdout when there are NO matches — the passing
  // case. Any other non-zero exit is a real error and must not read as a pass:
  // a grep that failed to run would otherwise report "no offenders" forever.
  if (result.exitCode !== 0 && !(result.exitCode === 1 && stdout.trim() === "")) {
    throw new Error(
      `grep failed (exit ${result.exitCode}): ${result.stderr?.toString() || "no stderr"}`
    );
  }

  return stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .filter((line) => !/\.(test|spec)\.tsx?:/.test(line));
}

describe("hook-tree import boundary (mt#4010 SC6)", () => {
  test("no production file under src/ imports .minsky/hooks", () => {
    const offenders = findHookTreeImports();
    expect(offenders).toEqual([]);
  });

  test("the detector actually matches an import specifier (negative control)", () => {
    // Without this, a broken pattern would report "no offenders" forever and
    // the test above would pass while checking nothing.
    const pattern = new RegExp(String.raw`(from|import|require)\s*\(?\s*['"][^'"]*\.minsky/hooks`);
    expect(pattern.test(`import { X } from "../../.minsky/hooks/registry";`)).toBe(true);
    expect(
      pattern.test(`import { Y } from "../../../.minsky/hooks/interceptor-descriptions";`)
    ).toBe(true);
    // A mere mention in a comment or a string path is NOT an import and must
    // not trip the rule — several src files legitimately reference the tree in
    // prose and in `@see` tags.
    expect(pattern.test(` * @see .minsky/hooks/guard-health.ts — the write side`)).toBe(false);
    expect(pattern.test(`const p = ".minsky/hooks/registry.ts";`)).toBe(false);
  });
});
