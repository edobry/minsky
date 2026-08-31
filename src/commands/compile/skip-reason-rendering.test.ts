/**
 * mt#3119 AT3: "Unit test fails if the emission is routed back through a mode-gated channel."
 *
 * This asserts the SHAPE of the two renderers rather than their runtime output, deliberately.
 * The alternative — driving the command and capturing logger output — requires patching the
 * `log` module import, which `testing-standards.mdc §Testable Design` names as design feedback
 * rather than a test technique, and the renderers are a `for` loop inside a command handler with
 * no seam to inject.
 *
 * What makes a source-shape check the right instrument HERE: the defect being guarded is
 * precisely a choice of channel identifier at a known site. `log.warn` and `log.cli` are
 * indistinguishable at runtime under the test harness (mt#2975 silences winston's Console, so a
 * captured-output test would pass on BOTH the fixed and the broken version — the same class of
 * can't-fail probe this whole task is about). The source text is the one place the difference is
 * actually observable.
 */
/* eslint-disable custom/no-real-fs-in-tests -- reading the REAL renderer sources is the whole
   check. An in-memory fixture would assert that a string this test itself wrote contains
   "log.cli", which is vacuous; only the committed files can drift back to a gated channel.
   Same rationale and same shape as tests/domain/plan-task-gate-letters.test.ts. */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RENDERERS = [
  join(import.meta.dir, "index.ts"),
  join(import.meta.dir, "../../adapters/shared/commands/compile/compile-commands.ts"),
];

/** The mode-gated sinks — any of these swallows output for a one-shot CLI command. */
const GATED_SINKS = ["log.warn", "log.debug", "log.info"];

describe("compile skip-reason rendering (mt#3119)", () => {
  for (const rendererPath of RENDERERS) {
    const name = rendererPath.split("/").slice(-3).join("/");

    test(`${name} renders skipReasons`, () => {
      const source = readFileSync(rendererPath, "utf8");
      expect(source).toContain("skipReasons");
    });

    test(`${name} renders skipReasons through an UNGATED channel, not a mode-gated one`, () => {
      const source = readFileSync(rendererPath, "utf8") as string;

      // Isolate the statement that consumes skipReasons: the loop body between the `for`
      // that names it and the closing of that block. Cheap and sufficient — the renderer is
      // a three-line loop, and widening the window would only weaken the assertion.
      const loopStart = source.indexOf("for (const reason of");
      expect(loopStart).toBeGreaterThan(-1);
      const loopBody = source.slice(loopStart, loopStart + 200);

      expect(loopBody).toContain("log.cli");
      for (const gated of GATED_SINKS) {
        expect(loopBody).not.toContain(gated);
      }
    });
  }
});
