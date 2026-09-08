/**
 * The class invariant behind mt#5027: no credential provider puts a Minsky task
 * id in front of a user.
 *
 * mt#5022 shipped `"… so no check is claimed (mt#5022 SC3)"` as a `detail`
 * string. The reviewer flagged it NON-BLOCKING on PR #3665; I overrode the flag
 * on the reasoning that this operator is a developer. The principal then hit it
 * in the live cockpit and said it read as weird. Two independent signals on one
 * string is what makes this worth a class check rather than another string edit
 * — the per-instance fix does not stop the next provider from doing the same
 * thing.
 *
 * Why the sweep is over SOURCE rather than over returned `detail` values: most
 * providers reach a network to produce one (`github` calls `GET /user/repos`,
 * `anthropic` calls `GET /v1/models`), so exercising every provider's failure
 * path would mean real HTTP in a unit test. Reading the source covers every
 * string literal — the ones behind a network branch included — with no I/O
 * beyond the files themselves.
 */
/* eslint-disable custom/no-real-fs-in-tests -- this file's entire purpose is
 * sweeping the REAL provider directory. An in-memory fs fake would assert the
 * invariant against a fixture whose author chose its contents, which is exactly
 * the failure this exists to catch: the failure mode is "someone adds a
 * provider, or a string, carrying a task id", and a mocked directory cannot
 * grow a file nobody told it about. Same justification as
 * `.minsky/hooks/hook-module-inventory.test.ts`. */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listCredentialProviders } from "./index";

const PROVIDERS_DIR = import.meta.dir;

/** A Minsky task id, in the form that appears in this corpus. */
const TASK_ID = /mt#\d+/;

/**
 * Strip comments, so what remains is code — including every string literal a
 * user can end up reading.
 *
 * Two forms only, and the narrowness is the point: block comments, and lines
 * whose FIRST non-whitespace is `//` or `*`. A general `//` strip would eat the
 * `//` inside `https://code.claude.com/en/docs/settings`, which is a real
 * `acquireUrl` in this directory — and eating string content would let the
 * sweep pass by deleting the very thing it inspects.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

function providerSourceFiles(): string[] {
  return readdirSync(PROVIDERS_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "index.ts")
    .sort();
}

describe("no provider puts a task id in front of a user (mt#5027)", () => {
  test("the sweep reaches a real corpus", () => {
    // Liveness before the negative assertions below (mem#1020): a sweep over an
    // empty file list returns "clean" forever and proves nothing, and would
    // survive its own negative control, because "nothing matched" is stable
    // whether or not the code under test is broken.
    const files = providerSourceFiles();
    expect(files.length).toBeGreaterThanOrEqual(7);
    expect(files).toContain("claude-code-token.ts");
  });

  test("stripComments removes comments and preserves string literals", () => {
    // The discriminator every assertion below depends on. If this over-stripped,
    // the sweep would pass by destroying its own input — the inert-fixture shape
    // from mem#1020, one level up.
    const sample = [
      "/* mt#1 in a block comment */",
      "// mt#2 in a line comment",
      " * mt#3 in a docblock continuation",
      'const u = "https://example.test/path#mt#4";',
    ].join("\n");
    const stripped = stripComments(sample);

    expect(stripped).not.toContain("mt#1");
    expect(stripped).not.toContain("mt#2");
    expect(stripped).not.toContain("mt#3");
    expect(stripped).toContain("mt#4");
  });

  for (const file of providerSourceFiles()) {
    test(`${file} carries no task id outside comments`, () => {
      const stripped = stripComments(readFileSync(join(PROVIDERS_DIR, file), "utf8"));
      // Report the offending text rather than a bare boolean, so a failure names
      // what to delete instead of sending the reader back to grep.
      expect(stripped.match(TASK_ID)?.[0] ?? null).toBeNull();
    });
  }

  test("no registered provider's static copy carries a task id", () => {
    // The source sweep covers literals; this covers the values actually exposed
    // on the provider objects, which is what the cockpit renders.
    for (const provider of listCredentialProviders()) {
      expect(provider.displayName).not.toMatch(TASK_ID);
      expect(provider.scopeGuidance).not.toMatch(TASK_ID);
    }
  });

  test("the registry is non-empty, so the loop above asserts something", () => {
    expect(listCredentialProviders().length).toBeGreaterThanOrEqual(7);
  });
});
