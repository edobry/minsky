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
 * Strip EVERY `if (import.meta.main) { ... }` gate block from `source`
 * (looping until none remain — PR #1948 R1 fix: a single-pass strip only
 * removed the FIRST such block, so a file with more than one gate would
 * leave a second gate's legitimately-guarded `main()` call in the
 * remainder and false-positive it as ungated). Brace-balance counting finds
 * each block's matching close (handles nested braces correctly, unlike a
 * naive non-greedy regex).
 *
 * Also strips the no-braces one-liner form, `if (import.meta.main) <stmt>;`
 * (e.g. `if (import.meta.main) main();`) — a valid gate shape the
 * brace-balance walker doesn't recognize on its own (PR #1948 R1 fix: this
 * form previously false-positived as ungated).
 */
function stripEntrypointGateBlocks(source: string): string {
  let result = source;
  const braceGateRe = /if\s*\(\s*import\.meta\.main\s*\)\s*\{/;
  for (;;) {
    const match = braceGateRe.exec(result);
    if (!match) break;

    const openBraceIdx = match.index + match[0].length - 1;
    let depth = 0;
    let endIdx = -1;
    for (let i = openBraceIdx; i < result.length; i++) {
      const ch = result[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          endIdx = i;
          break;
        }
      }
    }
    if (endIdx === -1) break; // malformed (unbalanced braces) — bail rather than loop forever

    result = result.slice(0, match.index) + result.slice(endIdx + 1);
  }

  // One-liner (no-brace) gate form: `if (import.meta.main) <stmt>;` — strip
  // every occurrence, not just the first (`g` flag).
  const oneLinerGateRe = /if\s*\(\s*import\.meta\.main\s*\)\s*(?!\{)[^;{}]*;/g;
  result = result.replace(oneLinerGateRe, "");

  return result;
}

/**
 * True iff `source` contains an UNGATED call to `main(...)` — a zero-arg
 * invocation of the identifier `main`, in ANY position (not just
 * line-start — PR #1948 R1 fix: the original line-anchored regex missed a
 * call embedded mid-line, e.g. inside a same-line `if (x) main().catch(...)`,
 * and missed IIFE-wrapped forms like `(async () => { await main(); })();`
 * where the call sits on an indented inner line but the OUTER expression is
 * what's actually ungated).
 *
 * Excludes two shapes that are never the regression this test guards
 * against:
 *   - Function DECLARATIONS (`function main(`, `async function main(`,
 *     `export function main(`) — defining `main` is not invoking it.
 *   - Property/method calls on some other value (`obj.main()`,
 *     `this.main()`) — a call to a DIFFERENT `main`, not this file's own
 *     module-scope entrypoint function.
 *
 * `source` is expected to already have every `if (import.meta.main) { ... }`
 * / one-liner gate block stripped via {@link stripEntrypointGateBlocks} —
 * this function has no gate-awareness of its own.
 */
function hasUngatedMainCall(source: string): boolean {
  const callRe = /\bmain\s*\(\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = callRe.exec(source)) !== null) {
    const before = source.slice(0, match.index).trimEnd();
    if (before.endsWith("function")) continue; // "function main(" / "async function main(" declaration
    if (before.endsWith(".")) continue; // "obj.main()" — a different main, not this file's entrypoint
    return true;
  }
  return false;
}

/**
 * Strip `//` line comments and `/* ... *\/` block comments from `source` — a
 * pragmatic (not fully lexical) pass, sufficient for this scanner's guard
 * files. NEEDED because several guards' own JSDoc/header comments literally
 * say things like "Mirrors `main()`'s orchestration" in prose (documenting
 * the `run()` ⇄ `main()` relationship per ADR-028 Phase 2a/2b) — without
 * stripping comments first, {@link hasUngatedMainCall}'s token scan
 * false-positives on every such mention (confirmed empirically: the
 * unstripped scan flagged all 15 real UserPromptSubmit guards). Not a
 * general-purpose lexer — does not special-case `//`/`/*` occurring inside
 * string or template literals — but none of the files under scan embed
 * either inside a string in a way that would collide with a real call site.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** Full pipeline: strip comments, then strip every entrypoint-gate block, leaving only the code a real `main()` invocation could live in. */
function toScannableSource(source: string): string {
  return stripEntrypointGateBlocks(stripComments(source));
}

// Shared fixture fragments — extracted to constants (rather than repeated
// per-test string literals) to avoid `custom/no-magic-string-duplication`
// warnings across the many small fixtures below.
const MAIN_DECL = "async function main(): Promise<void> {\n  return;\n}";
const GATE_BRACE_OPEN = "if (import.meta.main) {";
const GATE_ONE_LINER_PREFIX = "if (import.meta.main)";

describe("GUARD_REGISTRY entrypoint-gate parity (mt#2835)", () => {
  test("no registered guard module executes module-level main() ungated by if (import.meta.main)", () => {
    const ungated: string[] = [];

    for (const reg of GUARD_REGISTRY) {
      const specifier = resolveModuleSpecifier(reg.module);
      const filePath = resolveModuleFilePath(specifier);
      const source = readFileSync(filePath, "utf8");

      if (hasUngatedMainCall(toScannableSource(source))) {
        ungated.push(reg.name);
      }
    }

    expect(ungated).toEqual([]);
  });

  test("sanity: the scanner correctly ignores `main()` mentioned only in a comment (comment-stripping self-check)", () => {
    const fixtureSource = `// Mirrors \`main()\`'s orchestration but returns a GuardOutcome instead
/**
 * Guard-dispatcher entry point. Mirrors \`main()\`'s orchestration.
 */
${MAIN_DECL}
${GATE_BRACE_OPEN}
  await main();
}
`;

    expect(hasUngatedMainCall(toScannableSource(fixtureSource))).toBe(false);
  });

  test("sanity: the scanner actually detects an ungated main() call (regression-detection self-check)", () => {
    const fixtureSource = `${MAIN_DECL}
main().catch(() => process.exit(0));
`;

    expect(hasUngatedMainCall(toScannableSource(fixtureSource))).toBe(true);
  });

  test("sanity: a properly-gated main() call (brace form) is not flagged", () => {
    const fixtureSource = `${MAIN_DECL}
${GATE_BRACE_OPEN}
  await main();
}
`;

    expect(hasUngatedMainCall(toScannableSource(fixtureSource))).toBe(false);
  });

  test("sanity: a properly-gated main() call (no-brace one-liner form) is not flagged (PR #1948 R1)", () => {
    const fixtureSource = `${MAIN_DECL}
${GATE_ONE_LINER_PREFIX} main();
`;

    expect(hasUngatedMainCall(toScannableSource(fixtureSource))).toBe(false);
  });

  test("sanity: a properly-gated no-brace one-liner using await main() is not flagged", () => {
    const fixtureSource = `${MAIN_DECL}
${GATE_ONE_LINER_PREFIX} await main();
`;

    expect(hasUngatedMainCall(toScannableSource(fixtureSource))).toBe(false);
  });

  test("sanity: an ungated IIFE-wrapped main() call is flagged (PR #1948 R1)", () => {
    const fixtureSource = `${MAIN_DECL}
(async () => {
  await main();
})();
`;

    expect(hasUngatedMainCall(toScannableSource(fixtureSource))).toBe(true);
  });

  test("sanity: a gated IIFE-wrapped main() call is not flagged", () => {
    const fixtureSource = `${MAIN_DECL}
${GATE_BRACE_OPEN}
  await (async () => {
    await main();
  })();
}
`;

    expect(hasUngatedMainCall(toScannableSource(fixtureSource))).toBe(false);
  });

  test("sanity: an ungated same-line call after other code is flagged (line-start-anchoring gap, PR #1948 R1)", () => {
    const fixtureSource = `${MAIN_DECL}
if (someUnrelatedCondition) main().catch(() => process.exit(0));
`;

    expect(hasUngatedMainCall(toScannableSource(fixtureSource))).toBe(true);
  });

  test("sanity: an ungated void main() call is flagged (mixed-shape coverage, PR #1948 R1)", () => {
    const fixtureSource = `${MAIN_DECL}
void main();
`;

    expect(hasUngatedMainCall(toScannableSource(fixtureSource))).toBe(true);
  });

  test("sanity: multiple gate blocks in one file are ALL stripped, not just the first (PR #1948 R1)", () => {
    const fixtureSource = `${MAIN_DECL}
if (someFlag) {
  doSomethingUnrelated();
}

${GATE_BRACE_OPEN}
  await main();
}

${GATE_BRACE_OPEN}
  console.log('a second, redundant gate block — still must not false-positive');
}
`;

    expect(hasUngatedMainCall(toScannableSource(fixtureSource))).toBe(false);
  });

  test("sanity: a call to an unrelated object's .main() method is not flagged (false-positive guard)", () => {
    const fixtureSource = "someModule.main();\n";

    expect(hasUngatedMainCall(toScannableSource(fixtureSource))).toBe(false);
  });

  test("sanity: a bare function declaration with no invocation at all is not flagged", () => {
    expect(hasUngatedMainCall(toScannableSource(MAIN_DECL))).toBe(false);
  });
});
