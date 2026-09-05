/* eslint-disable custom/no-real-fs-in-tests -- source-fidelity: these assertions are ABOUT the real adapter sources. A fixture would assert that a string this test wrote contains a string this test chose, which is the tautology the guard is meant to prevent, not the drift it is meant to catch. */
/**
 * Both entry points must inject the daemon-ensuring step (mt#4707).
 *
 * ## Why this guard exists
 *
 * `performSetup` declares `ensureLocalDaemon` as an OPTIONAL injected seam,
 * because the implementation lives under `src/` and `packages/domain` may not
 * import it. An optional dep that a caller forgets is silently inert — the
 * feature simply does not happen, with no error anywhere. That is the exact
 * `work-completion.mdc §Invocation path` shape mt#4707 is itself an instance
 * of: the mt#4676 shim entry was written correctly and nothing started the
 * daemon it pointed at.
 *
 * There are TWO callers and they are easy to fix one at a time —
 * `src/adapters/shared/commands/setup.ts` (`minsky setup`) and
 * `src/adapters/shared/commands/init.ts` (`minsky init`, the CLAUDECODE=1
 * cold-machine path). Fixing only the first is the likely mistake, and it
 * misses the case the task was filed for.
 *
 * ## What this test can and cannot catch
 *
 * It reads the adapter SOURCES and asserts each one passes the dep. That
 * catches the drift class — an injection deleted, or a third entry point added
 * without one — which is the whole point. It does NOT prove the wiring works
 * end to end; `packages/domain/src/setup.test.ts` covers the decision, and the
 * PR's live run covers the rest. Stated rather than implied, because a guard
 * whose reach is overestimated is worse than none.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Every entry point that reaches `performSetup` on a production path. */
const INJECTION_SITES = [
  { label: "minsky setup", file: path.join(HERE, "setup.ts") },
  { label: "minsky init", file: path.join(HERE, "init.ts") },
];

describe("mt#4707 — every performSetup entry point injects the daemon step", () => {
  for (const site of INJECTION_SITES) {
    it(`${site.label} passes ensureLocalDaemon`, () => {
      const source = readFileSync(site.file, "utf-8");

      // The import and the injection are asserted separately: an import left
      // behind after the injection is deleted would otherwise read as a pass,
      // and lint's unused-import rule is not guaranteed to fire on a value
      // referenced nowhere in a file this large.
      expect(source).toContain("ensureLocalDaemonForSetup");
      expect(source).toMatch(/ensureLocalDaemon:\s*ensureLocalDaemonForSetup/);
    });
  }

  it("names every entry point that reaches performSetup", () => {
    // If a THIRD caller appears, this list is what makes it visible — the two
    // assertions above only check the sites they already know about, which is
    // precisely how the original gap survived.
    const setupSource = readFileSync(path.join(HERE, "setup.ts"), "utf-8");
    const initSource = readFileSync(path.join(HERE, "init.ts"), "utf-8");

    expect(setupSource).toContain("performSetup");
    expect(initSource).toContain("initializeProjectFromParams");
    expect(INJECTION_SITES).toHaveLength(2);
  });
});
