/* eslint-disable custom/no-real-fs-in-tests -- the synthetic-collision describe block below
   spawns real `bun test` subprocesses against real temp-directory fixture files to reproduce
   bun's own positional-arg substring-matching behavior; this IS the contract under test and
   cannot be verified any other way (mirrors scripts/run-tests-main-sharded.test.ts's identical
   justification for its own real-subprocess collision tests). */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { discoverMcpTestFiles, toBunTestArg, verifyIsolatedRun } from "./run-tests-mcp-isolated";

const BUN_TEST_PRELOAD_ARGS = ["--preload", "./tests/setup.ts", "--timeout=15000"];

// Shared fixture path for the verifyIsolatedRun unit tests below (mt#3014 R1
// lint fix: avoids the repeated string literal custom/no-magic-string-duplication
// flags).
const SAMPLE_FILE = "src/mcp/server.test.ts";

describe("discoverMcpTestFiles", () => {
  it("returns the real, sorted src/mcp/**.test.ts file list", () => {
    const files = discoverMcpTestFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(files).toEqual([...files].sort());
    expect(files.every((f) => f.startsWith("src/mcp/"))).toBe(true);
  });

  it("returns an empty array for a directory that doesn't exist", () => {
    expect(discoverMcpTestFiles("./this-directory-does-not-exist")).toEqual([]);
  });
});

describe("toBunTestArg", () => {
  it("prefixes the file path with ./", () => {
    expect(toBunTestArg(SAMPLE_FILE)).toBe(`./${SAMPLE_FILE}`);
  });
});

describe("verifyIsolatedRun", () => {
  it("passes a healthy run with a completion summary and exit 0", () => {
    const v = verifyIsolatedRun(
      SAMPLE_FILE,
      "",
      "5 pass\n0 fail\nRan 5 tests across 1 file. [12.00ms]\n",
      0
    );
    expect(v.passed).toBe(true);
  });

  it("fails closed when no completion summary is printed regardless of exit code (mt#2665 signature)", () => {
    const v = verifyIsolatedRun(SAMPLE_FILE, "", '{"message":"mcp_disconnect"}\n', 0);
    expect(v.passed).toBe(false);
    expect(v.reason).toMatch(/no completion summary/);
  });

  it("fails when a completion summary is present but the exit code is non-zero", () => {
    const v = verifyIsolatedRun(
      SAMPLE_FILE,
      "",
      "4 pass\n1 fail\nRan 5 tests across 1 file. [12.00ms]\n",
      1
    );
    expect(v.passed).toBe(false);
    expect(v.reason).toMatch(/genuine test failure/);
  });

  it("handles the singular 'file' form (no trailing s)", () => {
    const v = verifyIsolatedRun(
      SAMPLE_FILE,
      "",
      "1 pass\n0 fail\nRan 1 tests across 1 file. [1.00ms]\n",
      0
    );
    expect(v.passed).toBe(true);
  });

  it("checks stdout as well as stderr for the summary", () => {
    const v = verifyIsolatedRun(SAMPLE_FILE, "Ran 1 tests across 1 file.\n", "", 0);
    expect(v.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Synthetic cross-file substring-collision repro (mt#3014 acceptance test):
// two fixture files where one's path is a literal substring of the other's,
// demonstrating that an un-prefixed arg breaks this script's ONE-file
// isolation guarantee, and that toBunTestArg's ./-prefix fix restores it. No
// real src/mcp collision exists in the current file tree (verified during
// mt#3014's investigation), so this uses a synthetic fixture rather than a
// real one -- unlike scripts/run-tests-main.test.ts, which reproduces a REAL
// collision that already exists elsewhere in the repo.
// ---------------------------------------------------------------------------
describe("cross-file substring-collision (synthetic fixture, mt#3014 acceptance test)", () => {
  it("an UN-prefixed positional arg leaks a sibling file in, breaking one-file isolation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run-tests-mcp-isolated-collision-"));
    try {
      writeFileSync(
        join(dir, "foo.test.ts"),
        'import { test, expect } from "bun:test";\ntest("foo", () => expect(1).toBe(1));\n'
      );
      writeFileSync(
        join(dir, "foo.test.ts.extra.test.ts"),
        'import { test, expect } from "bun:test";\ntest("extra", () => expect(1).toBe(1));\n'
      );
      const shortArg = "foo.test.ts";
      const proc = Bun.spawn(["bun", "test", "--timeout=15000", shortArg], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stderr] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      // Both fixture files ran -- 2 files, not the intended 1 -- reproducing
      // the isolation-breaking bug this fix closes. "tests?" handles bun's
      // singular "1 test" form (these fixtures have exactly one test each).
      expect(/Ran \d+ tests? across 2 files?/.test(stderr)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("the ./-prefixed positional arg (toBunTestArg, this script's actual fix) runs ONLY the intended file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run-tests-mcp-isolated-collision-"));
    try {
      writeFileSync(
        join(dir, "foo.test.ts"),
        'import { test, expect } from "bun:test";\ntest("foo", () => expect(1).toBe(1));\n'
      );
      writeFileSync(
        join(dir, "foo.test.ts.extra.test.ts"),
        'import { test, expect } from "bun:test";\ntest("extra", () => expect(1).toBe(1));\n'
      );
      const prefixedArg = toBunTestArg("foo.test.ts");
      const proc = Bun.spawn(["bun", "test", "--timeout=15000", prefixedArg], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stderr] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      // "tests?" handles bun's singular "1 test" form (see comment above).
      expect(/Ran \d+ tests? across 1 files?/.test(stderr)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("a REAL src/mcp file run in isolation (with the ./-prefix fix) produces exactly 1 file in its summary", async () => {
    const files = discoverMcpTestFiles();
    const file = files[0];
    expect(file).toBeDefined();
    const proc = Bun.spawn(
      ["bun", "test", ...BUN_TEST_PRELOAD_ARGS, toBunTestArg(file as string)],
      {
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [stderr] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(/Ran \d+ tests? across 1 files?/.test(stderr)).toBe(true);
  }, 30000);
});
