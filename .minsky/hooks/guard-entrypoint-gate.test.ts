/* eslint-disable custom/no-real-fs-in-tests -- this test statically reads the REAL guard-module source files listed in GUARD_REGISTRY (readFileSync) to scan their actual on-disk content; there is nothing to mock, the source files under test ARE the fixture */
// Parity check — mt#2835.
//
// The root cause of mt#2835 (auto-session-title.ts's ungated module-level
// `main().catch(() => process.exit(0))` killing the whole
// dispatch-userpromptsubmit.ts process on import) is a REGRESSION CLASS, not
// a one-off: any registered guard module whose source calls `main()` at
// module scope, outside an `if (import.meta.main) { ... }` gate, will
// self-invoke the instant the dispatcher's `reg.module()` dynamically
// imports it — regardless of which lifecycle event or dispatcher it's
// registered under.
//
// This test statically scans every module referenced by `GUARD_REGISTRY`
// (`./registry.ts`) and flags any file with a top-level `main()` invocation
// that survives stripping the `if (import.meta.main) { ... }` block. A
// static source scan is cheaper and more reliable here than a
// subprocess-import liveness probe (spawning + importing every one of the 16
// registered modules individually) — the failure mode is purely syntactic
// (an ungated call site), so a text-level check catches it deterministically
// without incurring 16 subprocess spawns per test run.
//
// Re-introducing the bug (removing the `if (import.meta.main)` gate around
// `auto-session-title.ts`'s `main()` call) makes this test fail — see the
// PR body's execution evidence for a recorded red/green pair.
//
// @see mt#2835 — this task (root-cause + fix spec)
// @see .minsky/hooks/registry.ts — GUARD_REGISTRY, the single source of truth this test walks
// @see .minsky/hooks/auto-session-title.ts — the guard this bug lived in
// @see .minsky/hooks/dispatch-userpromptsubmit.e2e.test.ts — the sibling e2e canary (dynamic, exercises the real dispatcher process end-to-end)

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { GUARD_REGISTRY } from "./registry";
import type { GuardRegistration } from "./registry";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Extract the relative import specifier (e.g. `"./auto-session-title"`) from
 * a registration's `module` loader function by inspecting its source text —
 * every registration in `./registry.ts` follows the literal shape
 * `() => import("./<name>").then((m) => ({ run: m.run }))`, so a simple
 * regex over `Function.prototype.toString()` is sufficient (and avoids
 * actually invoking the dynamic import, which is exactly the operation this
 * test must NOT trigger for an ungated guard — invoking the import is how
 * the bug fires in production).
 */
function resolveModuleSpecifier(moduleFn: GuardRegistration["module"]): string {
  const src = moduleFn.toString();
  const match = src.match(/import\(\s*["'](\.\/[^"']+)["']\s*\)/);
  if (!match || !match[1]) {
    throw new Error(
      `Could not resolve import() specifier from registration module function: ${src}`
    );
  }
  return match[1];
}

function resolveModuleFilePath(specifier: string): string {
  // specifier is like "./auto-session-title" -> "<hooksDir>/auto-session-title.ts"
  return join(HOOKS_DIR, `${specifier.slice(2)}.ts`);
}

/**
 * Remove the first `if (import.meta.main) { ... }` block from `source`,
 * using brace-balance counting to find the matching close (handles nested
 * braces inside the block correctly, unlike a naive non-greedy regex).
 * Returns `source` UNCHANGED if no such block is found at all — callers
 * distinguish "no gate present" from "gate present" via a separate check.
 */
function stripEntrypointGateBlock(source: string): string {
  const gateRe = /if\s*\(\s*import\.meta\.main\s*\)\s*\{/;
  const match = gateRe.exec(source);
  if (!match) return source;

  const openBraceIdx = match.index + match[0].length - 1;
  let depth = 0;
  let endIdx = -1;
  for (let i = openBraceIdx; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }
  if (endIdx === -1) return source; // malformed (unbalanced braces) — leave as-is, don't crash

  return source.slice(0, match.index) + source.slice(endIdx + 1);
}

/**
 * True iff `source` contains a bare top-level call invoking `main(...)` —
 * i.e. a source line (module scope, arbitrary leading whitespace) that
 * starts with `main()` or `await main()`. Deliberately does NOT match
 * function declarations (`function main(`, `async function main(`,
 * `export function main(`) since those never start a line with the literal
 * token `main(` or `await main(`.
 */
function hasUngatedMainCall(source: string): boolean {
  return /^[ \t]*(?:await\s+)?main\(\s*\)/m.test(source);
}

describe("GUARD_REGISTRY entrypoint-gate parity (mt#2835)", () => {
  test("no registered guard module executes module-level main() ungated by if (import.meta.main)", () => {
    const ungated: string[] = [];

    for (const reg of GUARD_REGISTRY) {
      const specifier = resolveModuleSpecifier(reg.module);
      const filePath = resolveModuleFilePath(specifier);
      const source = readFileSync(filePath, "utf8");
      const withoutGate = stripEntrypointGateBlock(source);

      if (hasUngatedMainCall(withoutGate)) {
        ungated.push(reg.name);
      }
    }

    expect(ungated).toEqual([]);
  });

  test("sanity: the scanner actually detects an ungated main() call (regression-detection self-check)", () => {
    const fixtureSource = [
      "async function main(): Promise<void> {",
      "  return;",
      "}",
      "",
      "main().catch(() => process.exit(0));",
      "",
    ].join("\n");

    expect(hasUngatedMainCall(stripEntrypointGateBlock(fixtureSource))).toBe(true);
  });

  test("sanity: a properly-gated main() call is not flagged", () => {
    const fixtureSource = [
      "async function main(): Promise<void> {",
      "  return;",
      "}",
      "",
      "if (import.meta.main) {",
      "  await main();",
      "}",
      "",
    ].join("\n");

    expect(hasUngatedMainCall(stripEntrypointGateBlock(fixtureSource))).toBe(false);
  });
});
