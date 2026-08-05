/**
 * Tests for the pinned-checker resolution (mt#3657).
 *
 * The unit tests below cover the decision core. The repo-invariant tests at the bottom are the
 * ones that matter most: they assert the property that was silently false for three months —
 * that the compiler this repo RUNS is the compiler it DECLARES — and that no call site has
 * drifted back to `bunx`.
 */

/* eslint-disable custom/no-real-fs-in-tests -- the repo-invariant tests below are ABOUT this
   repo's real files (package.json's pin, the call sites' actual commands, the installed
   binary's actual version). Injecting a fake filesystem would make them assert a fixture
   instead of the property, which is exactly the failure mode they exist to catch. */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

import {
  decideTsgoBinary,
  parsePinnedTsgoVersion,
  readPinnedTsgoVersion,
  resolveTsgoBinary,
  TSGO_BIN_RELATIVE,
  TSGO_PACKAGE,
} from "./tsgo-binary";
import { parseTsgoVersionOutput } from "../adapters/shared/commands/validate";

/** This repo's root, from this file's location — no cwd dependency. */
const REPO_ROOT = join(import.meta.dir, "..", "..");

/**
 * A sample version string for the parser unit tests. Deliberately NOT read from package.json:
 * these tests assert the PARSER, and coupling them to the live pin would make them pass
 * vacuously if the pin were ever removed. The live pin is compared against the live binary in
 * the repo-invariant block instead.
 */
const SAMPLE_VERSION = "7.0.0-dev.20260419.1";

/** A hypothetical monorepo root and a workspace under it — the hoisted-install shape. */
const FAKE_ROOT = "/repo";
const FAKE_WORKSPACE = "/repo/services/reviewer";

describe("decideTsgoBinary", () => {
  test("resolves the local bin when it exists", () => {
    const result = decideTsgoBinary(FAKE_ROOT, (p) => p === join(FAKE_ROOT, TSGO_BIN_RELATIVE));
    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") throw new Error("unreachable");
    expect(result.binaryPath).toBe(join(FAKE_ROOT, TSGO_BIN_RELATIVE));
    expect(result.installRoot).toBe(FAKE_ROOT);
  });

  test("walks UP to a hoisted install — a workspace has no node_modules of its own", () => {
    // The regression this pins: `services/reviewer` is a workspace with its own tsconfig and
    // NO local `node_modules/.bin`. Resolving only in the target directory reported it as
    // "checker missing" and stopped typechecking it entirely — caught by
    // scripts/smoke-validate-typecheck-workspaces.ts (AT-3) during this task's own
    // implementation, not by any unit test that existed at the time.
    const hoisted = join(FAKE_ROOT, TSGO_BIN_RELATIVE);
    const result = decideTsgoBinary(FAKE_WORKSPACE, (p) => p === hoisted);
    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") throw new Error("unreachable");
    expect(result.binaryPath).toBe(hoisted);
    // The pin lives where the install lives, not where the check runs.
    expect(result.installRoot).toBe(FAKE_ROOT);
  });

  test("prefers the NEAREST install when both a workspace and the root have one", () => {
    const result = decideTsgoBinary(FAKE_WORKSPACE, () => true);
    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") throw new Error("unreachable");
    expect(result.installRoot).toBe(FAKE_WORKSPACE);
  });

  test("reports a TOOL failure naming the search and the remedy when nothing is found", () => {
    const result = decideTsgoBinary(FAKE_WORKSPACE, () => false);
    expect(result.kind).toBe("missing");
    if (result.kind !== "missing") throw new Error("unreachable");
    expect(result.searchedPaths[0]).toBe(join(FAKE_WORKSPACE, TSGO_BIN_RELATIVE));
    // It walked all the way up rather than giving up at the start directory.
    expect(result.searchedPaths).toContain(join(FAKE_ROOT, TSGO_BIN_RELATIVE));
    expect(result.message).toContain("bun install");
    expect(result.message).toContain(TSGO_PACKAGE);
    // The load-bearing half: a caller must not read this as "no type errors".
    expect(result.message).toContain("TOOL failure");
  });

  test("terminates at the filesystem root instead of looping", () => {
    // `dirname("/") === "/"`, so a naive loop never exits. Reaching this assertion at all is
    // the test; the count check keeps it honest about having actually walked.
    const result = decideTsgoBinary("/a/b/c", () => false);
    expect(result.kind).toBe("missing");
    if (result.kind !== "missing") throw new Error("unreachable");
    expect(result.searchedPaths).toEqual([
      "/a/b/c/node_modules/.bin/tsgo",
      "/a/b/node_modules/.bin/tsgo",
      "/a/node_modules/.bin/tsgo",
      "/node_modules/.bin/tsgo",
    ]);
  });

  test("never falls back to bunx — the missing branch offers no alternative command", () => {
    // The fallback is the defect: `bunx @typescript/native-preview` does not run the pinned
    // dependency, so restoring it on a broken install would reintroduce the drift at exactly
    // the wrong moment.
    const result = decideTsgoBinary(FAKE_ROOT, () => false);
    expect(JSON.stringify(result)).not.toContain("bunx");
  });
});

describe("parsePinnedTsgoVersion", () => {
  test("reads the devDependencies pin", () => {
    const text = JSON.stringify({ devDependencies: { [TSGO_PACKAGE]: SAMPLE_VERSION } });
    expect(parsePinnedTsgoVersion(text)).toBe(SAMPLE_VERSION);
  });

  test("returns null for unparseable JSON, a missing block, or a missing pin", () => {
    expect(parsePinnedTsgoVersion("{ not json")).toBeNull();
    expect(parsePinnedTsgoVersion(JSON.stringify({ dependencies: {} }))).toBeNull();
    expect(parsePinnedTsgoVersion(JSON.stringify({ devDependencies: {} }))).toBeNull();
  });
});

describe("parseTsgoVersionOutput", () => {
  test("extracts the version tsgo prints", () => {
    expect(parseTsgoVersionOutput(`Version ${SAMPLE_VERSION}\n`)).toBe(SAMPLE_VERSION);
  });

  test("returns null when the output carries no version", () => {
    expect(parseTsgoVersionOutput("")).toBeNull();
    expect(parseTsgoVersionOutput("some unrelated stderr noise")).toBeNull();
  });
});

describe("repo invariant: the checker that runs is the checker that is pinned", () => {
  test("package.json pins a checker version", () => {
    const pinned = readPinnedTsgoVersion(REPO_ROOT);
    expect(pinned).not.toBeNull();
  });

  test("the resolved binary reports the pinned version", () => {
    const resolution = resolveTsgoBinary(REPO_ROOT);
    if (resolution.kind === "missing") {
      // A tree without `bun install` cannot answer this; say so rather than passing vacuously.
      console.log(`SKIP: ${resolution.message}`);
      expect(resolution.searchedPaths[0]).toContain("node_modules");
      return;
    }

    const proc = Bun.spawnSync([resolution.binaryPath, "--version"]);
    const reported = parseTsgoVersionOutput(proc.stdout.toString());
    const pinned = readPinnedTsgoVersion(REPO_ROOT);

    // THE invariant. `bunx @typescript/native-preview` failed it by three months of drift
    // while every gate reported clean, because nothing ever compared these two values.
    expect(reported).toBe(pinned);
  });
});

describe("repo invariant: no typecheck call site invokes bunx", () => {
  /**
   * The INVOCATION forms only — a quoted argv pair or a quoted command string. Prose and
   * doc comments name `bunx @typescript/native-preview` constantly (that is the whole story
   * of mt#3657) and must not trip this.
   */
  const INVOCATION_PATTERNS = [
    `"bunx", "${TSGO_PACKAGE}"`,
    `"bunx ${TSGO_PACKAGE}`,
    `'bunx ${TSGO_PACKAGE}`,
  ];

  const CALL_SITES = [
    "package.json",
    "src/adapters/shared/commands/validate.ts",
    "src/hooks/pre-commit.ts",
    ".minsky/hooks/typecheck-on-edit.ts",
    ".minsky/hooks/typecheck-on-stop.ts",
  ];

  for (const relPath of CALL_SITES) {
    test(`${relPath} spawns the pinned binary, not bunx`, () => {
      const full = join(REPO_ROOT, relPath);
      expect(existsSync(full)).toBe(true);
      const text = readFileSync(full, "utf8");
      for (const pattern of INVOCATION_PATTERNS) {
        expect(text).not.toContain(pattern);
      }
    });
  }

  test("every typecheck:* script runs tsgo", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8").toString()) as {
      scripts: Record<string, string>;
    };
    const typecheckScripts = Object.entries(pkg.scripts).filter(([name]) =>
      name.startsWith("typecheck:")
    );
    // Guard the guard: if the scripts are ever renamed away, this test must not silently
    // pass over an empty set.
    expect(typecheckScripts.length).toBeGreaterThanOrEqual(4);
    for (const [name, command] of typecheckScripts) {
      expect(`${name}: ${command}`).toContain("tsgo");
      expect(`${name}: ${command}`).not.toContain("bunx");
    }
  });
});
