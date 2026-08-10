/* eslint-disable custom/no-real-fs-in-tests -- this test's subject IS the file's
   on-disk source text: it asserts a property of module structure that no import
   of the module can observe. Reading the real file is the point. */
// Entrypoint-placement invariant for record-subagent-invocation.ts (mt#3893).
//
// The module's `if (import.meta.main)` block contains a top-level `await`, which
// SUSPENDS module evaluation. Every binding declared below it is therefore in its
// temporal dead zone while the awaited code runs — so a runtime path that reads
// one throws `Cannot access 'X' before initialization`.
//
// ## Why this is a STATIC check and not a process run
//
// The spec that produced this test asserted the check "has to run the hook as a
// PROCESS," on the reasoning that `import.meta.main` is false under `bun test` so
// an importing test cannot reach the entrypoint. The first half is right; the
// conclusion is not, and shipping only a process test would have been a probe that
// cannot fail:
//
// `recordInvocation` calls `ensureHookDomainBootstrap()` FIRST and returns early
// when it fails. On any machine without a reachable Postgres — CI, notably — the
// process never reaches `decideRecordingAction`, so the TDZ branch is never
// executed and the run is green whether or not the bug is present. The existing
// `record-subagent-invocation.test.ts` already documents that exact
// environment-dependence for its own process assertions ("Two legitimate
// outcomes, depending on whether this environment can reach a database").
//
// A structural assertion has neither problem: it is deterministic, needs no
// database, and asserts the INVARIANT ("nothing below the entrypoint") rather than
// one instance of its violation. It also fails for a binding nobody has added yet,
// which a runtime probe of today's code path cannot do.
//
// A live process smoke still runs in `record-subagent-invocation.test.ts`; this
// file is the part that holds in every environment.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MODULE_PATH = join(import.meta.dir, "record-subagent-invocation.ts");

/**
 * The entrypoint guard, matched tolerantly (PR #2741 R1 NON-BLOCKING).
 *
 * An exact-string match on `"if (import.meta.main) {"` would break on formatting
 * the linter is entitled to change — inner spacing, or the brace moving to the
 * next line. A false NEGATIVE there is the dangerous direction: the anchor
 * disappears, nothing is found "below" it, and the check silently passes while
 * the hazard it guards is wide open.
 *
 * Anchored at column 0 so the same text inside a comment or a nested block does
 * not match, and the "exactly once" test below turns any residual ambiguity into
 * a loud failure rather than a wrong anchor.
 */
const ENTRYPOINT_PATTERN = /^if\s*\(\s*import\.meta\.main\s*\)/;

/** The specific constant whose TDZ read caused mt#3893, matched the same way. */
const BROKEN_CONST_PATTERN = /^export\s+const\s+HOOK_UNKNOWN_TASK_ID\b/;

/**
 * Top-level `const` / `let` / `class` declarations — the TDZ-affected forms.
 *
 * Anchored at column 0 so nested declarations inside a function body are ignored:
 * those initialize when their function is CALLED, not at module evaluation, so
 * they carry no hazard. `function` declarations are excluded because they are
 * hoisted AND initialized, which is why the ten functions that used to sit below
 * the entrypoint were harmless while the single `const` was not.
 */
const TDZ_DECLARATION = /^(?:export\s+)?(?:const|let|class)\s+([A-Za-z_$][\w$]*)/;

function readModuleLines(): string[] {
  return readFileSync(MODULE_PATH, "utf8").split("\n");
}

describe("record-subagent-invocation entrypoint placement (mt#3893)", () => {
  test("the entrypoint exists and is found exactly once", () => {
    // Guards the two tests below against silently passing on a renamed or
    // removed entrypoint — a check anchored on a string that no longer appears
    // would vacuously find nothing after it.
    const occurrences = readModuleLines().filter((l) => ENTRYPOINT_PATTERN.test(l)).length;
    expect(
      occurrences,
      "Expected exactly one top-level `if (import.meta.main)` guard. Zero means the anchor the " +
        "checks below depend on has moved or been renamed — they would then scan nothing and " +
        "pass vacuously. More than one means the anchor is ambiguous."
    ).toBe(1);
  });

  test("no TDZ-affected binding is declared below the entrypoint", () => {
    const lines = readModuleLines();
    const entryIndex = lines.findIndex((l) => ENTRYPOINT_PATTERN.test(l));
    expect(entryIndex).toBeGreaterThan(-1);

    const offenders = lines
      .slice(entryIndex + 1)
      .map((line, i) => ({ line, lineNumber: entryIndex + 2 + i }))
      .filter(({ line }) => TDZ_DECLARATION.test(line))
      .map(({ line, lineNumber }) => `${lineNumber}: ${TDZ_DECLARATION.exec(line)?.[1]}`);

    // The message carries the mechanism, because a future author hitting this
    // will be moving code for an unrelated reason and needs to know why it is
    // refused rather than merely that it is.
    expect(
      offenders,
      `These bindings are declared after the top-level-await entrypoint, so they are in their ` +
        `temporal dead zone while it runs. Any runtime path reading one throws ` +
        `"Cannot access 'X' before initialization" — and NO unit test can see it, because ` +
        `import.meta.main is false under bun test. Move them above the entrypoint (or move the ` +
        `entrypoint back to the end of the file). See mt#3893.`
    ).toEqual([]);
  });

  test("the constant that actually broke is above the entrypoint", () => {
    // A regression pin on the specific instance, not just the class. If the
    // general check above is ever weakened, this still fails.
    const lines = readModuleLines();
    const entryIndex = lines.findIndex((l) => ENTRYPOINT_PATTERN.test(l));
    const constIndex = lines.findIndex((l) => BROKEN_CONST_PATTERN.test(l));

    expect(constIndex).toBeGreaterThan(-1);
    expect(constIndex).toBeLessThan(entryIndex);
  });
});
