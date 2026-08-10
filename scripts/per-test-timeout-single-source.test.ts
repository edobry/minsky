// mt#3704 — the per-test timeout has exactly one definition.
//
// The defect this guards was not a wrong value; it was a value with no home. A
// flat `--timeout=15000` sat in four runners with no derivation and no
// contention margin, while the wall-clock budgets in the same file next door
// were deliberately sized at ~9x observed runtime. Nothing could have told you
// the number was unexamined, because there was nowhere for its reasoning to
// live.
//
// These assertions are SOURCE-LEVEL on purpose. The property SC1 states is
// about where the number is written, not about a runtime behaviour — the
// runners build their command arrays inline and spawn them, so there is no
// value to observe without refactoring four scripts purely to make them
// assertable. A grep is the honest shape for "this literal appears in exactly
// one place."
//
// Deliberately NOT asserted here: that 100s is the right number. That is a
// judgment recorded in the constant's doc comment and in mt#3704; a test that
// re-stated it would just be the same number twice.

/* eslint-disable custom/no-real-fs-in-tests -- reading the REAL runner sources
   is the entire assertion. The property under test is "this literal appears in
   exactly one place in the repo"; an injected/in-memory fs would let the test
   pass against fixture content while the actual scripts drifted, which is the
   failure mode it exists to catch. Read-only, no temp dirs, no writes. */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FULL_SUITE_PER_TEST_TIMEOUT_MS } from "./spawn-with-watchdog";

const SCRIPTS_DIR = import.meta.dir;
const CONSTANT_NAME = "FULL_SUITE_PER_TEST_TIMEOUT_MS";
const OLD_LITERAL = "--timeout=15000";

/** Runners that execute the FULL suite, and so must use the derived budget. */
const FULL_SUITE_RUNNERS = [
  "run-tests-main.ts",
  "run-tests-mcp-isolated.ts",
  "run-tests-main-sharded.ts",
];

/**
 * The pre-commit related-test gate. It keeps 15s DELIBERATELY: its partition
 * budget is 60s (RELATED_TESTS_PARTITION), so a 100s per-test timer inside it
 * would invert the outer > inner ordering the budget table depends on. Asserted
 * rather than merely commented, because "this one is different on purpose" is
 * exactly the kind of claim a later cleanup pass silently normalises away.
 */
const DELIBERATELY_UNCHANGED = "run-related-tests.ts";

function readScript(name: string): string {
  return readFileSync(join(SCRIPTS_DIR, name), { encoding: "utf-8" });
}

describe("mt#3704: the full-suite per-test timeout has one definition", () => {
  // Asserted as booleans rather than `expect(source).toContain(...)`: these
  // sources are 200+ lines of docstring, and a `toContain` failure prints the
  // ENTIRE file as "Received". The boolean keeps the failure to one line, with
  // the test name carrying which file and which property broke.
  for (const runner of FULL_SUITE_RUNNERS) {
    it(`${runner} derives the timeout from the constant`, () => {
      const source = readScript(runner);
      expect({
        runner,
        importsConstant: source.includes(CONSTANT_NAME),
        interpolatesIt: source.includes(`--timeout=\${${CONSTANT_NAME}}`),
      }).toEqual({ runner, importsConstant: true, interpolatesIt: true });
    });

    it(`${runner} carries no hardcoded ${OLD_LITERAL}`, () => {
      expect({ runner, hasOldLiteral: readScript(runner).includes(OLD_LITERAL) }).toEqual({
        runner,
        hasOldLiteral: false,
      });
    });
  }

  it(`${DELIBERATELY_UNCHANGED} keeps 15s, and says why`, () => {
    const source = readScript(DELIBERATELY_UNCHANGED);
    // The carve-out is only defensible if its reason travels with it, so the
    // justification is asserted alongside the value.
    expect({
      keepsOldLiteral: source.includes(OLD_LITERAL),
      citesTask: source.includes("mt#3704"),
      citesBudgetItOrdersAgainst: source.includes("RELATED_TESTS_PARTITION"),
    }).toEqual({ keepsOldLiteral: true, citesTask: true, citesBudgetItOrdersAgainst: true });
  });

  it("stays below the whole-run budget that actually catches hangs", () => {
    // The per-test timer is not the hang backstop — the wall-clock watchdog is
    // (it is the only one that fires on a synchronous block). If this ever
    // inverted, raising the per-test budget would start masking real hangs
    // instead of just tolerating slow ones.
    const { WATCHDOG_BUDGETS_MS } = require("./spawn-with-watchdog") as {
      WATCHDOG_BUDGETS_MS: { MAIN: number };
    };
    expect(FULL_SUITE_PER_TEST_TIMEOUT_MS).toBeLessThan(WATCHDOG_BUDGETS_MS.MAIN);
  });

  it("leaves margin over the slowest single test this repo has measured", () => {
    // 10.8s — mt#3875's session-auto-task-creation test, run alone. The old 15s
    // gave it 1.4x; the budget table's own convention for its siblings is ~9x.
    const SLOWEST_OBSERVED_SINGLE_TEST_MS = 10_800;
    expect(FULL_SUITE_PER_TEST_TIMEOUT_MS / SLOWEST_OBSERVED_SINGLE_TEST_MS).toBeGreaterThanOrEqual(
      9
    );
  });
});
