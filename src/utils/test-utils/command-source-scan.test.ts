/**
 * Declaration-shape coverage for the command-source scans (mt#3924, mt#3966).
 *
 * The failure mode both scans keep hitting is silent under-report: a declaration
 * shape the regex does not anticipate produces no error, just a missing id — and a
 * missing id AGREES with a stale expectation instead of contradicting it. Three
 * shapes have been missed in practice: `readonly id = "x"` (the original mt#3847
 * pattern allowed no modifier before `id`, so it matched no class-based command at
 * all — 23 of them), and `public mutating = true` (PR #2848 R1).
 *
 * These cases feed the scanners sources they have never seen rather than the repo's,
 * so a shape that stops matching fails HERE, named, instead of quietly shrinking an
 * answer some other test then agrees with.
 */
/* eslint-disable custom/no-real-fs-in-tests -- the units under test ARE filesystem
   scans of command sources; their contract is "read these files and report what is
   declared". An injected fake filesystem would test the injection, not the parsing.
   Fixtures are written to a per-run temp directory and removed, so nothing touches
   the repo. Same rationale as `tool-effect-coverage.test.ts`'s repo-invariant tests. */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { scanCommandIds, scanMutatingFlaggedIds } from "./command-source-scan";

const REGISTER_OPEN = "registry.registerCommand({";
const REGISTER_CLOSE = "});";
const FLAG_SET = "  mutating: true,";
const FLAG_CLEARED = "  mutating: false,";

/** An object-literal registration, the shape most commands use. */
function literalSource(id: string, flagLine: string): string {
  return [REGISTER_OPEN, `  id: "${id}",`, flagLine, REGISTER_CLOSE, ""].join("\n");
}

/** A command class, where the id and the flag carry field modifiers. */
function classSource(id: string, modifiers: string): string {
  return [
    "class C {",
    `  ${modifiers} id = "${id}";`,
    `  ${modifiers} mutating = true;`,
    "}",
    "",
  ].join("\n");
}

describe("command-source scans — declaration shapes", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "command-source-scan-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeSource(name: string, contents: string): void {
    writeFileSync(join(dir, name), contents, "utf8");
  }

  describe("scanMutatingFlaggedIds", () => {
    test("object-literal registration", () => {
      writeSource("literal.ts", literalSource("a.literal", FLAG_SET));
      expect(scanMutatingFlaggedIds(dir)).toEqual(["a.literal"]);
    });

    test("class field with readonly", () => {
      writeSource("readonly.ts", classSource("b.readonly", "readonly"));
      expect(scanMutatingFlaggedIds(dir)).toEqual(["b.readonly"]);
    });

    test("class field with an access modifier other than readonly", () => {
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
  });

  describe("scanCommandIds", () => {
    test("object-literal registration", () => {
      writeSource("literal.ts", literalSource("a.literal", FLAG_SET));
      expect(scanCommandIds(dir)).toEqual(["a.literal"]);
    });

    /**
     * The mt#3966 regression: `readonly id = "x"` was invisible to this scan, which
     * made the snapshot-freshness check unable to see 23 registered commands and
     * therefore unable to do the one job it exists for.
     */
    test("class field with readonly", () => {
      writeSource("readonly.ts", classSource("b.readonly", "readonly"));
      expect(scanCommandIds(dir)).toEqual(["b.readonly"]);
    });

    test("class field with an access modifier other than readonly", () => {
      writeSource("public.ts", classSource("c.public", "public"));
      expect(scanCommandIds(dir)).toEqual(["c.public"]);
    });

    test("class field with stacked modifiers", () => {
      writeSource("stacked.ts", classSource("d.stacked", "public readonly"));
      expect(scanCommandIds(dir)).toEqual(["d.stacked"]);
    });

    test("an id with no mutating flag is still reported", () => {
      // The two scans answer different questions; this one does not care about the flag.
      writeSource(
        "unflagged.ts",
        ["class C {", '  readonly id = "e.unflagged";', "}", ""].join("\n")
      );
      expect(scanCommandIds(dir)).toEqual(["e.unflagged"]);
    });
  });

  describe("traversal, shared by both scans", () => {
    test("test files are skipped and subdirectories are walked", () => {
      writeSource("ignored.test.ts", literalSource("g.in-a-test", FLAG_SET));
      mkdirSync(join(dir, "nested"));
      writeFileSync(join(dir, "nested", "deep.ts"), literalSource("h.nested", FLAG_SET), "utf8");

      expect(scanMutatingFlaggedIds(dir)).toEqual(["h.nested"]);
      expect(scanCommandIds(dir)).toEqual(["h.nested"]);
    });

    test("results are deduplicated and sorted", () => {
      writeSource(
        "two.ts",
        `${literalSource("z.last", FLAG_SET)}${literalSource("a.first", FLAG_SET)}`
      );

      expect(scanMutatingFlaggedIds(dir)).toEqual(["a.first", "z.last"]);
      expect(scanCommandIds(dir)).toEqual(["a.first", "z.last"]);
    });
  });
});
