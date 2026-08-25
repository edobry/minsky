/**
 * Tests for the MCP server-command resolver (mt#4475).
 *
 * The behavioural end-to-end proof lives in `src/commands/mcp/direct-client.test.ts`,
 * which spawns a real server with `minsky` removed from `$PATH`. What these tests
 * cover is the branch table, which that test exercises only one path of.
 *
 * No `spyOn` anywhere: the pure core takes the two process values as arguments,
 * so the branches are reachable without patching `process.argv` or `Bun.main`.
 */

import { describe, expect, test } from "bun:test";

import {
  resolveMinskyCommand,
  resolveMinskyCommandFrom,
  resolveMinskyServerSpawn,
} from "./resolve-server-command";

const BUN = "/Users/x/.bun/bin/bun";
const ENTRY = "/repo/src/cli.ts";
const COMPILED = "/usr/local/bin/minsky";

describe("resolveMinskyCommandFrom", () => {
  test("source mode: returns the interpreter AND the entry script", () => {
    // The live path on every invocation shape this repo produces — including
    // `minsky …` itself, because the installed `minsky` is a symlink to a .ts
    // file with a `#!/usr/bin/env bun` shebang rather than a compiled binary.
    expect(resolveMinskyCommandFrom(BUN, ENTRY)).toEqual([BUN, ENTRY]);
  });

  test("compiled single-file: returns the binary alone", () => {
    // Defensive branch — `bun run build` emits dist/minsky.js (a bundle run
    // under bun), not a self-contained executable, so nothing in this repo
    // produces this shape today. It exists so that if one ever does, the entry
    // is not passed to a binary that would treat it as a subcommand.
    expect(resolveMinskyCommandFrom(COMPILED, COMPILED)).toEqual([COMPILED]);
  });

  test("no entry script: returns the executable alone", () => {
    expect(resolveMinskyCommandFrom(BUN, undefined)).toEqual([BUN]);
  });

  test("falls back to the bare name when argv[0] is absent", () => {
    // Restores the OLD $PATH-dependent behaviour, deliberately: a spawn that
    // fails with "not found in $PATH" beats one that fails with an empty
    // command and no explanation. Should not occur in practice.
    expect(resolveMinskyCommandFrom(undefined, ENTRY)).toEqual(["minsky"]);
    expect(resolveMinskyCommandFrom("", ENTRY)).toEqual(["minsky"]);
  });

  test("never returns an empty array, on any input combination", () => {
    // The property every caller depends on — `spawn(cmd[0], …)` with an
    // undefined head is the failure mode the fallback above exists to prevent.
    for (const exec of [undefined, "", BUN, COMPILED]) {
      for (const entry of [undefined, "", ENTRY, COMPILED]) {
        expect(resolveMinskyCommandFrom(exec, entry).length).toBeGreaterThan(0);
      }
    }
  });
});

describe("resolveMinskyCommand (live process)", () => {
  test("resolves this very process to a runnable command", () => {
    const command = resolveMinskyCommand();
    expect(command.length).toBeGreaterThan(0);
    // Under `bun test` the runner is the executable and the test file is the
    // entry, so this asserts the two-element shape without pinning either path.
    expect(command[0]).toContain("bun");
    expect(command[0]).not.toBe("minsky");
  });
});

describe("resolveMinskyServerSpawn", () => {
  test("splits the resolved command into spawn's (command, args) pair", () => {
    const { command, args } = resolveMinskyServerSpawn(["mcp", "start"]);
    // The entry script must land in args BEFORE the subcommand — `bun mcp start
    // <entry>` would be nonsense. This ordering is the whole reason the helper
    // exists rather than each call site doing its own concatenation.
    expect(command).toContain("bun");
    expect(args.slice(-2)).toEqual(["mcp", "start"]);
    expect(args.length).toBeGreaterThan(2);
  });

  test("carries extra server args through, after the subcommand", () => {
    const { args } = resolveMinskyServerSpawn(["mcp", "start", "--repo", "/tmp/r"]);
    expect(args.slice(-4)).toEqual(["mcp", "start", "--repo", "/tmp/r"]);
  });
});
