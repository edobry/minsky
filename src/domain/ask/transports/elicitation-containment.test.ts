/* eslint-disable custom/no-real-fs-in-tests --
 * Containment regression test: this test EXISTS to grep the real source tree
 * for `elicitation/create` references outside the Ask transport adapter.
 * The whole point is to inspect actual filesystem contents — DI mocks would
 * defeat the test. mt#1457 spec §Acceptance Tests requires this regression
 * check; the rule's intent (don't read prod files in business-logic tests)
 * doesn't apply here.
 */
/**
 * Regression test: no `elicitation/create` calls outside src/domain/ask/transports/.
 *
 * Shape B's structural commitment is that the Ask subsystem owns elicitation
 * dispatch. Direct callers elsewhere — emitting `elicitation/create` or
 * calling `Server.elicitInput` outside the transport adapter — would
 * silently bypass the router, the capability registry, and the persisted
 * Ask record. Shape C (mt#1331) extends this rule to ALL prompts, not
 * just Ask flows; this test pins the v1 invariant.
 *
 * The check uses `ripgrep` since it's already a project dev dependency
 * and outperforms a JS recursive find. Falls back to a clear test failure
 * if rg isn't present so the regression intent is preserved.
 *
 * Reference: mt#1457 spec §Acceptance Tests — "Repository grep for
 * `elicitation/create` outside `src/domain/ask/transports/` returns zero
 * matches."
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Helper — locate the project root from this test file
// ---------------------------------------------------------------------------

function findProjectRoot(): string {
  // __dirname-equivalent in bun. Walk up from the test file until package.json.
  let dir = import.meta.dir;
  while (dir !== "/" && !existsSync(join(dir, "package.json"))) {
    dir = join(dir, "..");
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("elicitation-containment", () => {
  test("no `elicitation/create` literal outside src/domain/ask/transports", () => {
    const root = findProjectRoot();

    // The literal we care about: 'elicitation/create' appearing as code text.
    // Limit the search to src/ so node_modules / docs / generated artifacts
    // don't pollute the result.
    //
    // Legitimate exceptions:
    //   - src/domain/ask/transports/** (the transport adapter itself)
    //   - src/mcp/client-capabilities.ts (defines the structural type for
    //     the SDK method `elicitInput` and references the wire-level method
    //     name `elicitation/create` in JSDoc only — no calls)
    const result = spawnSync(
      "rg",
      [
        "--line-number",
        "--no-heading",
        "--with-filename",
        "--glob",
        "src/**/*.ts",
        "--glob",
        "!src/domain/ask/transports/**",
        "--glob",
        "!src/mcp/client-capabilities.ts",
        "--glob",
        "!**/*.test.ts", // tests describing the literal in prose are fine
        "elicitation/create",
        "src",
      ],
      { cwd: root, encoding: "utf-8" }
    );

    // ripgrep exit code: 0 = matches found; 1 = no matches; 2 = error.
    if (result.status === 1) {
      // No matches outside the transport — the invariant holds.
      return;
    }

    if (result.status === 2) {
      // ripgrep itself failed (e.g. binary not present). Fail loudly so the
      // regression intent isn't silently bypassed in environments without rg.
      throw new Error(
        `ripgrep failed (exit ${result.status}). stderr: ${result.stderr}\n` +
          `Install ripgrep or update this test's command. The intent is to ` +
          `assert no elicitation/create calls live outside src/domain/ask/transports.`
      );
    }

    // status === 0 means matches were found — the invariant is broken.
    expect(result.stdout.trim(), "elicitation/create found outside the transport").toBe("");
  });

  test("no `.elicitInput(` calls outside src/domain/ask/transports and src/mcp", () => {
    // The SDK method name `elicitInput` is the JavaScript-level invocation
    // of `elicitation/create`. The capability registry exports a structural
    // type for it (in src/mcp/client-capabilities.ts) — that file is the
    // legitimate exception, alongside the transport adapter.
    const root = findProjectRoot();

    const result = spawnSync(
      "rg",
      [
        "--line-number",
        "--no-heading",
        "--with-filename",
        "--glob",
        "src/**/*.ts",
        "--glob",
        "!src/domain/ask/transports/**",
        "--glob",
        "!src/mcp/client-capabilities.ts",
        "--glob",
        "!**/*.test.ts",
        "\\.elicitInput\\(",
        "src",
      ],
      { cwd: root, encoding: "utf-8" }
    );

    if (result.status === 1) return;

    if (result.status === 2) {
      throw new Error(`ripgrep failed (exit ${result.status}). stderr: ${result.stderr}`);
    }

    expect(
      result.stdout.trim(),
      ".elicitInput( found outside transport + mcp/client-capabilities"
    ).toBe("");
  });
});
