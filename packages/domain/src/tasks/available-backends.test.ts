/* eslint-disable custom/no-real-fs-in-tests -- this suite reads the SHIPPED files on purpose:
   init.ts's switch, init/index.ts's option line, and README.md. The claim under test is about
   what those files actually contain, and a fixture would only assert what I put in it — which is
   precisely how the three surfaces drifted apart in the first place. Same rationale as
   scripts/lib/calibration-log-declarations.test.ts. */
/**
 * `--backend` help must enumerate exactly what the command accepts (mt#4673).
 *
 * The originating defect: `minsky init --help` advertised `github`, and
 * `minsky init --backend github` answered `Backend "github" is not supported.`
 * — the first flag a new user is required to pass, pointing at a value the
 * command rejects. Found on the first command of the mt#2929 dogfood onboarding.
 *
 * These assertions deliberately read the REAL surfaces rather than restating a
 * list. A test carrying its own copy of the valid set is a third place to drift,
 * and drift between copies is the whole defect — `getAvailableBackends()` was a
 * literal disagreeing with `init`'s validator while its docstring claimed it
 * "ensures backend lists in help text and errors are always up-to-date".
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAvailableBackends, getAvailableBackendsString } from "./taskConstants";
import { TaskBackend } from "../configuration/backend-types";

/**
 * The set `init` actually accepts, read out of its switch rather than restated.
 *
 * `init.ts` handles each accepted backend as a `case "<name>":` and throws from
 * `default`, so the case labels ARE the accepted set. Parsing them keeps this
 * test honest if a backend is added or removed there — the alternative, a
 * literal here, is the same mistake one layer over.
 */
function backendsAcceptedByInit(): string[] {
  const src = readFileSync(join(import.meta.dir, "..", "init.ts"), "utf-8");
  const switchIdx = src.indexOf("switch (backend)");
  expect(switchIdx, "init.ts no longer contains `switch (backend)`").toBeGreaterThan(-1);
  const body = src.slice(switchIdx, src.indexOf("is not supported", switchIdx));
  const cases = [...body.matchAll(/case\s+"([^"]+)":/g)].map((m) => m[1] as string).sort();
  // Parsing source is brittle by nature (PR #3704 R1), so make the failure mode
  // explicit rather than incidental: if the switch is ever rewritten into a shape
  // this regex cannot read, `cases` goes empty and every comparison below fails
  // LOUDLY instead of silently agreeing with an empty set. Asserted here so that
  // property is stated rather than inferred from how `toEqual` happens to behave.
  expect(
    cases.length,
    "parsed zero `case` labels from init.ts — the switch shape changed; update this parser"
  ).toBeGreaterThan(0);
  return cases;
}

describe("getAvailableBackends (mt#4673)", () => {
  test("advertises exactly what `init` accepts", () => {
    expect([...getAvailableBackends()].sort()).toEqual(backendsAcceptedByInit());
  });

  test("does NOT advertise `github`, which no --backend validator accepts", () => {
    // The precise regression. `TaskBackend.GITHUB` exists in the enum, which is
    // how it got into the help; `init` accepts `github-issues`, not `github`.
    expect(getAvailableBackends()).not.toContain(TaskBackend.GITHUB);
    expect(getAvailableBackendsString()).not.toMatch(/\bgithub\b(?!-issues)/);
  });

  test("names the pair `init`'s own non-interactive error already named", () => {
    // That error was correct all along — it interpolates the enum members — so
    // it is the surface the other two had drifted away from.
    expect([...getAvailableBackends()].sort()).toEqual(
      [TaskBackend.MINSKY, TaskBackend.GITHUB_ISSUES].sort()
    );
  });

  test("every advertised value is a real TaskBackend member", () => {
    const members = new Set<string>(Object.values(TaskBackend));
    for (const b of getAvailableBackends()) expect(members).toContain(b);
  });

  test("the formatted string is the list, comma-joined", () => {
    expect(getAvailableBackendsString()).toBe(getAvailableBackends().join(", "));
  });
});

describe("no hand-written copy of the advertised set survives (mt#4673)", () => {
  // The defect had TWO sources: the shared `getAvailableBackends()` and a
  // separate literal in `src/commands/init/index.ts`. Fixing only the first
  // leaves `init --help` — the surface the bug was reported on — still wrong,
  // so this asserts the literal is gone rather than that the function is right.
  const repoRoot = join(import.meta.dir, "..", "..", "..", "..");

  test("init's CLI option derives its description instead of restating it", () => {
    const src = readFileSync(join(repoRoot, "src", "commands", "init", "index.ts"), "utf-8");
    const backendOption = src.split("\n").find((l) => l.includes('cmd.option("--backend'));
    expect(backendOption, "init no longer declares a --backend option").toBeDefined();
    expect(backendOption).toContain("getAvailableBackendsString()");
    expect(backendOption).not.toContain("available: github, minsky");
  });

  test("the README uses the flag that exists", () => {
    // README:31/34 documented `--tasks-backend`, which commander rejects with
    // `error: unknown option`. The flag has never existed under that name.
    const readme = readFileSync(join(repoRoot, "README.md"), "utf-8");
    expect(readme).not.toContain("--tasks-backend");
  });
});
