/* eslint-disable custom/no-real-fs-in-tests --
 * Containment regression test: this test EXISTS to grep the real source tree
 * for `elicitation/create` references outside the Ask transport adapter.
 * The whole point is to inspect actual filesystem contents — DI mocks would
 * defeat the test. mt#1457 spec §Acceptance Tests requires this regression
 * check; the rule's intent (don't read prod files in business-logic tests)
 * doesn't apply here.
 */
/**
 * Regression test: no `elicitation/create` calls outside packages/domain/src/ask/transports/.
 *
 * Shape B's structural commitment is that the Ask subsystem owns elicitation
 * dispatch. Direct callers elsewhere — emitting `elicitation/create` or
 * calling `Server.elicitInput` outside the transport adapter — would
 * silently bypass the router, the capability registry, and the persisted
 * Ask record. Shape C (mt#1331) extends this rule to ALL prompts, not
 * just Ask flows; this test pins the v1 invariant.
 *
 * The check scans the tree in-process (Bun Glob + file reads) rather than
 * spawning `rg`: GitHub's ubuntu runners don't ship ripgrep, and the old
 * spawnSync path returned `stdout: null` there — a TypeError instead of the
 * intended loud failure (mt#2665, surfaced once CI stopped truncating the
 * suite). In-process scanning removes the environment dependence entirely.
 *
 * Reference: mt#1457 spec §Acceptance Tests — "Repository grep for
 * `elicitation/create` outside `packages/domain/src/ask/transports/` returns zero
 * matches."
 */

import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Helper — locate the project root from this test file
// ---------------------------------------------------------------------------

function findProjectRoot(): string {
  // __dirname-equivalent in bun. Walk up from the test file until the
  // monorepo root. mt#2108 moved this file under packages/domain/src/..,
  // which has its OWN package.json (a workspace package) — walking up to
  // the nearest package.json stops one level too early and silently
  // rescopes the search to packages/domain instead of the whole repo
  // (mt#2608). bunfig.toml only exists at the monorepo root, so use that
  // as the marker instead.
  let dir = import.meta.dir;
  while (dir !== "/" && !existsSync(join(dir, "bunfig.toml"))) {
    dir = join(dir, "..");
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Helper — in-process containment scan (no external tools; mt#2665)
// ---------------------------------------------------------------------------

/**
 * Scan production .ts sources under src/ and packages/<pkg>/src/ for a
 * literal substring, returning "file:line: text" hits. The positive globs
 * structurally exclude node_modules / dist / docs (only <pkg>/src trees are
 * walked).
 *
 * Legitimate exceptions (both tests):
 *   - packages/domain/src/ask/transports/ (the transport adapter itself)
 *   - src/mcp/client-capabilities.ts (structural type + JSDoc references only)
 *   - *.test.ts (tests describing the literal in prose are fine)
 */
function scanForLiteral(root: string, literal: string): string[] {
  const hits: string[] = [];
  for (const pattern of ["src/**/*.ts", "packages/*/src/**/*.ts"]) {
    const glob = new Glob(pattern);
    for (const rel of glob.scanSync({ cwd: root })) {
      if (rel.endsWith(".test.ts")) continue;
      if (rel.startsWith(join("packages", "domain", "src", "ask", "transports"))) continue;
      if (rel === join("src", "mcp", "client-capabilities.ts")) continue;
      const lines = readFileSync(join(root, rel), "utf-8").split("\n");
      lines.forEach((line, i) => {
        if (line.includes(literal)) {
          hits.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      });
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("elicitation-containment", () => {
  test("no `elicitation/create` literal outside packages/domain/src/ask/transports", () => {
    // The literal we care about: 'elicitation/create' appearing as code text.
    // mt#2108 moved the Ask transport adapter to packages/domain/src/ask/
    // transports/ (mt#2608).
    const hits = scanForLiteral(findProjectRoot(), "elicitation/create");
    expect(hits.join("\n"), "elicitation/create found outside the transport").toBe("");
  });

  test("no `.elicitInput(` calls outside packages/domain/src/ask/transports and src/mcp", () => {
    // The SDK method name `elicitInput` is the JavaScript-level invocation
    // of `elicitation/create`. The capability registry exports a structural
    // type for it (in src/mcp/client-capabilities.ts) — that file is the
    // legitimate exception, alongside the transport adapter (moved to
    // packages/domain/src/ask/transports/ by mt#2108; see mt#2608).
    const hits = scanForLiteral(findProjectRoot(), ".elicitInput(");
    expect(hits.join("\n"), ".elicitInput( found outside transport + mcp/client-capabilities").toBe(
      ""
    );
  });
});
