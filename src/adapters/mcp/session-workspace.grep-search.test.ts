/**
 * `session.grep_search` glob-matching contract (mt#3163).
 *
 * The defect: `include_pattern` was forwarded to ripgrep as `--glob` while the
 * search root was passed as an ABSOLUTE path. Ripgrep matches a glob containing
 * a `/` against the path it generates, so a repo-relative pattern like
 * `src/cockpit/server.ts` matched zero files and the tool returned an empty
 * result indistinguishable from "no matches" — the caller's reasonable reading
 * being "that code does not exist."
 *
 * These tests exercise ripgrep for real against a temp tree rather than mocking
 * it, because the bug lived entirely in rg's glob-vs-root semantics: a mocked rg
 * would have happily "matched" and proven nothing. `pre-fix invocation` below is
 * the negative control — it runs the OLD shape (absolute search root) and pins
 * that it finds nothing, so the fixed cases cannot pass vacuously.
 */
/* eslint-disable custom/no-real-fs-in-tests -- ripgrep searches the real filesystem; a real temp tree IS the contract under test */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { rgPathToAbsolute, RG_SEARCH_TARGET } from "./session-workspace";

const NEEDLE = "GREP_SEARCH_NEEDLE";

/** Repo-relative fixture paths — also the glob patterns under test. */
const COCKPIT_SERVER = "src/cockpit/server.ts";
const OTHER_SERVER = "src/other/server.ts";
const COCKPIT_TEST = "src/cockpit/server.test.ts";

let workspace: string;

/** The fixture path as the tool is expected to report it: absolute. */
function expected(relativePath: string): string {
  return path.join(workspace, relativePath);
}

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "grep-search-"));
  fs.mkdirSync(path.join(workspace, "src", "cockpit"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "src", "other"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "src", "cockpit", "server.ts"), `const a = "${NEEDLE}";\n`);
  fs.writeFileSync(path.join(workspace, "src", "other", "server.ts"), `const b = "${NEEDLE}";\n`);
  fs.writeFileSync(
    path.join(workspace, "src", "cockpit", "server.test.ts"),
    `test("${NEEDLE}", () => {});\n`
  );
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

/**
 * Runs ripgrep the way the handler does after the fix: cwd at the workspace,
 * searching `RG_SEARCH_TARGET`. `absoluteRoot: true` reproduces the PRE-fix
 * invocation instead, for the negative control.
 */
function runRg(globArgs: string[], opts: { absoluteRoot?: boolean } = {}): string[] {
  const target = opts.absoluteRoot ? workspace : RG_SEARCH_TARGET;
  const proc = Bun.spawnSync(
    ["rg", "--color", "never", "--line-number", "--no-heading", ...globArgs, NEEDLE, target],
    { cwd: workspace, stdout: "pipe", stderr: "pipe" }
  );
  const out = proc.stdout.toString().trim();
  return out ? out.split("\n") : [];
}

/** The file each match line belongs to, absolutized the way the handler does. */
function matchedFiles(lines: string[]): string[] {
  return lines
    .map((line) => line.match(/^([^:]+):\d+:/)?.[1])
    .filter((p): p is string => Boolean(p))
    .map((p) => rgPathToAbsolute(p, workspace));
}

describe("include_pattern accepts repo-relative globs (mt#3163)", () => {
  test("a path-shaped include_pattern matches the intended file (AT1)", () => {
    const files = matchedFiles(runRg(["--glob", COCKPIT_SERVER]));
    expect(files.length).toBeGreaterThan(0);
    expect(files).toEqual([expected(COCKPIT_SERVER)]);
  });

  test("pre-fix invocation (absolute search root) finds NOTHING — negative control", () => {
    // The whole defect in one assertion. If this ever starts returning matches,
    // the tests above have stopped proving anything.
    expect(runRg(["--glob", COCKPIT_SERVER], { absoluteRoot: true })).toEqual([]);
  });

  test("a directory-spanning glob matches only the intended files (AT2)", () => {
    const files = matchedFiles(runRg(["--glob", "src/**/*.test.ts"]));
    expect(files).toEqual([expected(COCKPIT_TEST)]);
  });

  test("a basename-only glob still matches both files — regression guard (AT3)", () => {
    // Worked before the fix and must keep working: it never depended on the
    // root being relative.
    const files = matchedFiles(runRg(["--glob", "server.ts"])).sort();
    expect(files).toEqual([expected(COCKPIT_SERVER), expected(OTHER_SERVER)].sort());
  });

  test("an already-double-star-prefixed glob still matches — regression guard (AT4)", () => {
    // Callers who worked around this by prefixing the glob must not break.
    const files = matchedFiles(runRg(["--glob", `**/${COCKPIT_SERVER}`]));
    expect(files).toEqual([expected(COCKPIT_SERVER)]);
  });

  test("exclude_pattern excludes a repo-relative subtree (AT5)", () => {
    const files = matchedFiles(runRg(["--glob", "!src/cockpit/**"]));
    expect(files).toEqual([expected(OTHER_SERVER)]);
  });

  test("a genuinely non-matching glob still returns nothing (AT6)", () => {
    // The empty result must stay REACHABLE — the fix must not make every
    // pattern match something.
    expect(runRg(["--glob", "src/does-not-exist.ts"])).toEqual([]);
  });
});

describe("rgPathToAbsolute", () => {
  test("strips the `./` ripgrep prefixes relative paths with", () => {
    expect(rgPathToAbsolute(`./${COCKPIT_SERVER}`, "/ws")).toBe(`/ws/${COCKPIT_SERVER}`);
  });

  test("absolutizes a bare relative path", () => {
    expect(rgPathToAbsolute(COCKPIT_SERVER, "/ws")).toBe(`/ws/${COCKPIT_SERVER}`);
  });

  test("passes an already-absolute path through untouched", () => {
    // Keeps the function correct if rg is ever invoked with an absolute root
    // again, rather than producing `/ws//abs/path`.
    expect(rgPathToAbsolute("/abs/elsewhere/server.ts", "/ws")).toBe("/abs/elsewhere/server.ts");
  });

  test("does not strip a leading dot that is part of a real name", () => {
    expect(rgPathToAbsolute(".github/workflows/ci.yml", "/ws")).toBe(
      "/ws/.github/workflows/ci.yml"
    );
  });
});
