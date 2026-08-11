/**
 * Declaration-shape coverage for the drift-gate refusal-set scan (mt#3924).
 *
 * The scan's whole failure mode is silent under-report: a declaration shape the
 * regex does not anticipate produces no error, just a missing id — and a missing
 * id agrees with a stale expected list instead of contradicting it. Two shapes
 * have already been missed in practice: `readonly id = "x"` (the original mt#3847
 * regex allowed no modifier before `id`, so it matched no class-based command at
 * all) and `public mutating = true` (PR #2848 R1, NON-BLOCKING 2).
 *
 * These cases feed the scanner sources it has never seen rather than the repo's,
 * so a shape that stops matching fails HERE, named, instead of quietly shrinking
 * the set the drift gate is pinned to.
 */
/* eslint-disable custom/no-real-fs-in-tests -- the unit under test IS a filesystem
   scan of command sources; its contract is "read these files and report ids". An
   injected fake filesystem would test the injection, not the parsing. Fixtures are
   written to a per-run temp directory and removed, so nothing touches the repo.
   Same rationale as `tool-effect-coverage.test.ts`'s repo-invariant tests. */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { scanMutatingFlaggedIds } from "./mutating-flag-scan";

const REGISTER_OPEN = "registry.registerCommand({";
const REGISTER_CLOSE = "});";
const FLAG_SET = "  mutating: true,";
const FLAG_CLEARED = "  mutating: false,";

/** An object-literal registration, the shape most commands use. */
function literalSource(id: string, flagLine: string): string {
  return [REGISTER_OPEN, `  id: "${id}",`, flagLine, REGISTER_CLOSE, ""].join("\n");
}

/** A command class, where the flag and the id carry field modifiers. */
function classSource(id: string, modifiers: string): string {
  return [
    "class C {",
    `  ${modifiers} id = "${id}";`,
    `  ${modifiers} mutating = true;`,
    "}",
    "",
  ].join("\n");
}

describe("scanMutatingFlaggedIds — declaration shapes", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mutating-flag-scan-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeSource(name: string, contents: string): void {
    writeFileSync(join(dir, name), contents, "utf8");
  }

  test("object-literal registration", () => {
    writeSource("literal.ts", literalSource("a.literal", FLAG_SET));
    expect(scanMutatingFlaggedIds(dir)).toEqual(["a.literal"]);
  });

  test("class field with readonly", () => {
    writeSource("readonly.ts", classSource("b.readonly", "readonly"));
    expect(scanMutatingFlaggedIds(dir)).toEqual(["b.readonly"]);
  });

  test("class field with an access modifier other than readonly", () => {
    // The R1 finding: allowing only `readonly` drops this silently.
    writeSource("public.ts", classSource("c.public", "public"));
    expect(scanMutatingFlaggedIds(dir)).toEqual(["c.public"]);
  });

  test("class field with stacked modifiers", () => {
    writeSource("stacked.ts", classSource("d.stacked", "public readonly"));
    expect(scanMutatingFlaggedIds(dir)).toEqual(["d.stacked"]);
  });

  test("a command WITHOUT the flag is not reported", () => {
    writeSource(
      "unflagged.ts",
      [
        "class C {",
        '  readonly id = "e.unflagged";',
        '  readonly name = "unflagged";',
        "}",
        "",
      ].join("\n")
    );
    expect(scanMutatingFlaggedIds(dir)).toEqual([]);
  });

  test("an explicitly cleared flag is not reported", () => {
    writeSource("explicit-false.ts", literalSource("f.false", FLAG_CLEARED));
    expect(scanMutatingFlaggedIds(dir)).toEqual([]);
  });

  test("test files are skipped and subdirectories are walked", () => {
    writeSource("ignored.test.ts", literalSource("g.in-a-test", FLAG_SET));
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "deep.ts"), literalSource("h.nested", FLAG_SET), "utf8");
    expect(scanMutatingFlaggedIds(dir)).toEqual(["h.nested"]);
  });

  test("results are deduplicated and sorted", () => {
    writeSource(
      "two.ts",
      `${literalSource("z.last", FLAG_SET)}${literalSource("a.first", FLAG_SET)}`
    );
    expect(scanMutatingFlaggedIds(dir)).toEqual(["a.first", "z.last"]);
  });
});
