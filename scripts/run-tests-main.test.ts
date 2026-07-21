import { describe, expect, it } from "bun:test";
import {
  discoverTestFiles,
  EXCLUDE_DIR_PREFIXES,
  shouldExclude,
  toBunTestArgs,
} from "./run-tests-main";

/* eslint-disable custom/no-real-fs-in-tests -- the discoverTestFiles cross-collision invariant
   test below walks the REAL repo file tree (readdirSync/statSync) to check every discovered
   test-file path against EXCLUDE_DIR_PREFIXES; exercising real fs traversal against the actual
   repo IS the contract under test (the invariant only means something against real, current
   paths), mirroring scripts/run-tests-main-sharded.test.ts's identical justification for the
   same rule. */

// The real, currently-existing file pair in this repo whose relative paths
// exhibit the substring collision this file's tests reproduce (see
// scripts/run-tests-main-sharded.ts's header docstring / this file's own
// header docstring "Cross-file substring-collision hardening" for the full
// explanation): `REAL_COLLISION_SHORT_PATH` is a literal substring of
// `REAL_COLLISION_LONG_PATH`.
const REAL_COLLISION_SHORT_PATH = "src/composition/container.test.ts";

const BUN_TEST_PRELOAD_ARGS = ["--preload", "./tests/setup.ts", "--timeout=15000"];

describe("shouldExclude", () => {
  it("excludes an exact prefix path and anything nested under it", () => {
    expect(shouldExclude("src/mcp")).toBe(true);
    expect(shouldExclude("src/mcp/server.test.ts")).toBe(true);
    expect(shouldExclude("src/mcp/middleware/memory-bundle.test.ts")).toBe(true);
  });

  it("does not exclude a sibling directory that merely shares a prefix string", () => {
    expect(shouldExclude("src/mcpx/foo.test.ts")).toBe(false);
  });

  it("includes a regular src file", () => {
    expect(shouldExclude("src/domain/tasks.test.ts")).toBe(false);
  });
});

describe("toBunTestArgs", () => {
  it("prefixes every file path with ./", () => {
    expect(toBunTestArgs(["src/a.test.ts", "src/b.test.ts"])).toEqual([
      "./src/a.test.ts",
      "./src/b.test.ts",
    ]);
  });

  it("returns an empty array for an empty input", () => {
    expect(toBunTestArgs([])).toEqual([]);
  });
});

describe("discoverTestFiles / shouldExclude (mt#3014 substring-collision invariant)", () => {
  it("never returns a file under any EXCLUDE_DIR_PREFIXES directory", () => {
    const files = discoverTestFiles();
    for (const prefix of EXCLUDE_DIR_PREFIXES) {
      expect(files.some((f) => f === prefix || f.startsWith(`${prefix}/`))).toBe(false);
    }
  });

  it(
    "structural invariant: no included file's path is a literal substring of an excluded " +
      "file's path (would leak an excluded file into run-tests-main.ts's bun test invocation " +
      "even WITHOUT the ./-prefix fix -- this test documents that today's file tree has zero " +
      "such collisions, so a future addition that introduces one fails loudly here instead of " +
      "silently reintroducing the mt#2665 truncation risk)",
    () => {
      const included = discoverTestFiles();
      const includedSet = new Set(included);

      // Walk the whole repo (minus bun's hard-excluded node_modules/.git) the
      // same way scripts/run-tests-main.ts's own `walk` does, but WITHOUT
      // applying shouldExclude, to get the full candidate pool bun itself
      // would consider (bunfig.toml's pathIgnorePatterns has NO effect once
      // any positional arg is supplied -- see this file's header docstring).
      const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
      const { join, relative } = require("node:path") as typeof import("node:path");

      function walkAll(dir: string, out: string[]): void {
        let entries: string[];
        try {
          entries = readdirSync(dir);
        } catch {
          return;
        }
        for (const entry of entries) {
          const full = join(dir, entry);
          const rel = relative(".", full).split("\\").join("/");
          if (rel === "node_modules" || rel.startsWith("node_modules/")) continue;
          if (rel === ".git" || rel.startsWith(".git/")) continue;
          let info: ReturnType<typeof statSync>;
          try {
            info = statSync(full);
          } catch {
            continue;
          }
          if (info.isDirectory()) walkAll(full, out);
          else if (entry.endsWith(".test.ts")) out.push(rel);
        }
      }

      const allFiles: string[] = [];
      walkAll(".", allFiles);
      const excludedFiles = allFiles.filter((f) => !includedSet.has(f));

      const collisions: Array<{ excluded: string; matchedArg: string }> = [];
      for (const excluded of excludedFiles) {
        for (const inc of included) {
          if (excluded.includes(inc)) {
            collisions.push({ excluded, matchedArg: inc });
          }
        }
      }

      expect(collisions).toEqual([]);
    }
  );
});

describe(
  "cross-file substring-collision: the real src/composition/container.test.ts collision " +
    "(mt#3014, mirrors scripts/run-tests-main-sharded.test.ts's already-validated repro)",
  () => {
    it("an UN-prefixed positional arg leaks the sibling file in (the bug this fix closes)", async () => {
      const proc = Bun.spawn(["bun", "test", ...BUN_TEST_PRELOAD_ARGS, REAL_COLLISION_SHORT_PATH], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stderr] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      // Both files ran -- 2 files, not 1 -- demonstrating the un-prefixed collision.
      expect(/Ran \d+ tests? across 2 files?/.test(stderr)).toBe(true);
    }, 30000);

    it("the ./-prefixed positional arg (this fix's toBunTestArgs) runs ONLY the intended file", async () => {
      const [prefixedArg] = toBunTestArgs([REAL_COLLISION_SHORT_PATH]);
      const proc = Bun.spawn(["bun", "test", ...BUN_TEST_PRELOAD_ARGS, prefixedArg], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stderr] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      expect(/Ran \d+ tests? across 1 files?/.test(stderr)).toBe(true);
    }, 30000);
  }
);
