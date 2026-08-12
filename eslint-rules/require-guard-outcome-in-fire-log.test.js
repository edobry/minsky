/**
 * @fileoverview Tests for custom/require-guard-outcome-in-fire-log (mt#3920).
 *
 * The rule flags a `.minsky/hooks` file that writes fire-log records without ever setting
 * `guardOutcome` — the ten-file gap this task closed, where each affected guard was
 * permanently unable to leave `dormant` and nothing caught it for two months.
 *
 * Two cases carry most of the weight. The factory-mediated caller (a merge gate reaching
 * the fire log through `makeRecordAndExit`, never naming the writer) is the one a rule
 * keyed on `recordFireLogEntry` alone would miss — the original gap, one level up. And
 * the positional-literal satisfaction (`recordAndExit("deny", undefined, "decided")`) is
 * how eleven of those callers actually mark their exits, with the field name appearing
 * nowhere in the file.
 */

// eslint-disable-next-line no-restricted-imports -- ESLint rule tests must use .js extension for direct rule loading
import rule, { COVERED_ROOTS_POSIX } from "./require-guard-outcome-in-fire-log.js";
import { RuleTester } from "eslint";
import * as tsParser from "@typescript-eslint/parser";
import { describe, expect, test } from "bun:test";
import config from "../eslint.config";

const hookFile = ".minsky/hooks/some-hook.ts";
const hookTestFile = ".minsky/hooks/some-hook.test.ts";
const fireLogFile = ".minsky/hooks/fire-log.ts";
const generatedFile = ".claude/hooks/some-hook.ts";
const outsideFile = "src/domain/tasks/unrelated.ts";

const MSG = "missingGuardOutcome";

const tester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

tester.run("require-guard-outcome-in-fire-log", rule, {
  valid: [
    // The direct form: a writer call with the field named in the record literal.
    {
      filename: hookFile,
      code: `
        import { recordFireLogEntry } from "./fire-log";
        recordFireLogEntry({
          guardName: "some-guard",
          event: "PreToolUse",
          decision: "allow",
          guardOutcome: "decided",
        });
      `,
    },
    // The field named as a PARAMETER, with the record spreading it conditionally — the
    // shape most converted hooks took, where each exit point decides its own outcome.
    {
      filename: hookFile,
      code: `
        import { recordFireLogEntry } from "./fire-log";
        function recordAndExit(decision, outcome) {
          recordFireLogEntry({
            guardName: "some-guard",
            event: "PreToolUse",
            decision,
            ...(outcome !== undefined ? { guardOutcome: outcome } : {}),
          });
        }
        recordAndExit("allow");
      `,
    },
    // Factory-mediated, satisfied POSITIONALLY: a merge gate marks its exits through
    // `recordAndExit`'s third argument and never names the field. This is the case that
    // makes the literal-value branch load-bearing rather than a convenience.
    {
      filename: hookFile,
      code: `
        import { makeRecordAndExit } from "./merge-gate-fire-log";
        const recordAndExit = makeRecordAndExit("some-gate", Date.now(), input);
        if (!applies) recordAndExit("allow");
        recordAndExit("deny", undefined, "decided");
      `,
    },
    // `crashed` alone satisfies it too — a guard may legitimately have no `decided` exit
    // yet (the safe intermediate state this task's own branch passed through).
    {
      filename: hookFile,
      code: `
        import { makeRecordAndExit } from "./merge-gate-fire-log";
        const recordAndExit = makeRecordAndExit("some-gate", Date.now(), input);
        recordAndExit("allow", undefined, "crashed");
      `,
    },
    // R1: an ALIASED import is a trigger, and this one marks its exit, so it passes for
    // the right reason. Its invalid twin below is the case the alias mapping exists for.
    {
      filename: hookFile,
      code: `
        import { recordFireLogEntry as writeFire } from "./fire-log";
        writeFire({
          guardName: "g",
          event: "PreToolUse",
          decision: "allow",
          guardOutcome: "decided",
        });
      `,
    },
    // R1: a namespace import reaching the writer through a member call.
    {
      filename: hookFile,
      code: `
        import * as fireLog from "./fire-log";
        fireLog.recordFireLogEntry({
          guardName: "g",
          event: "PreToolUse",
          decision: "allow",
          guardOutcome: "crashed",
        });
      `,
    },
    // A hook that writes nothing to the fire log is not subject to the invariant.
    {
      filename: hookFile,
      code: `
        import { writeOutput } from "./types";
        writeOutput({ hookSpecificOutput: { hookEventName: "PreToolUse" } });
      `,
    },
    // A test file legitimately names the writer while asserting on hand-built records.
    {
      filename: hookTestFile,
      code: `
        import { recordFireLogEntry } from "./fire-log";
        test("writes a record", () => {
          recordFireLogEntry({ guardName: "g", event: "PreToolUse", decision: "allow" });
        });
      `,
    },
    // `fire-log.ts` DEFINES the field and cannot be required to consume it. Written
    // without any mention of the field or its values, so the exemption is what passes it
    // — not incidental satisfaction.
    {
      filename: fireLogFile,
      code: `
        export function recordFireLogEntry(input) {
          return input;
        }
      `,
    },
    // The generated tree is out of scope: fixing a generated file is not a fix.
    {
      filename: generatedFile,
      code: `
        import { recordFireLogEntry } from "./fire-log";
        recordFireLogEntry({ guardName: "g", event: "PreToolUse", decision: "allow" });
      `,
    },
    // Outside the hooks tree entirely.
    {
      filename: outsideFile,
      code: `
        import { recordFireLogEntry } from "./fire-log";
        recordFireLogEntry({ guardName: "g", event: "PreToolUse", decision: "allow" });
      `,
    },
  ],

  invalid: [
    // The gap itself: the exact shape all ten standalone writers had before this task.
    {
      filename: hookFile,
      code: `
        import { recordFireLogEntry } from "./fire-log";
        recordFireLogEntry({
          guardName: "some-guard",
          event: "PreToolUse",
          decision: "allow",
          durationMs: 12,
        });
      `,
      errors: [{ messageId: MSG }],
    },
    // Factory-mediated with no marker anywhere — a new merge gate wired through
    // `makeRecordAndExit`, whose every exit would silently default to UNSET.
    {
      filename: hookFile,
      code: `
        import { makeRecordAndExit } from "./merge-gate-fire-log";
        const recordAndExit = makeRecordAndExit("some-gate", Date.now(), input);
        if (!applies) recordAndExit("allow");
        recordAndExit("deny");
      `,
      errors: [{ messageId: MSG }],
    },
    // ONE report per file even with several writer calls: the invariant is a file-level
    // property, and flagging every call site would bury it.
    {
      filename: hookFile,
      code: `
        import { recordFireLogEntry } from "./fire-log";
        recordFireLogEntry({ guardName: "g", event: "PreToolUse", decision: "allow" });
        recordFireLogEntry({ guardName: "g", event: "PreToolUse", decision: "deny" });
        recordFireLogEntry({ guardName: "g", event: "PreToolUse", decision: "warn" });
      `,
      errors: [{ messageId: MSG }],
    },
    // A near-miss that must NOT satisfy the rule: `decided`/`crashed` as identifiers or
    // in unrelated prose-ish strings is not the marker. Only the field name or the exact
    // string values count.
    {
      filename: hookFile,
      code: `
        import { recordFireLogEntry } from "./fire-log";
        const alreadyDecided = true;
        recordFireLogEntry({
          guardName: "g",
          event: "PreToolUse",
          decision: alreadyDecided ? "allow" : "deny",
        });
      `,
      errors: [{ messageId: MSG }],
    },
    // R1: the ALIASED writer with no marker — the hole the alias mapping closes. Before
    // it, this file wrote fire-log records under a local name and the rule never fired.
    {
      filename: hookFile,
      code: `
        import { recordFireLogEntry as writeFire } from "./fire-log";
        writeFire({ guardName: "g", event: "PreToolUse", decision: "allow" });
      `,
      errors: [{ messageId: MSG }],
    },
    // R1: the literal spoof. A stray `"decided"` in a non-argument, non-property position
    // must NOT satisfy the rule — before the scoping, this passed with every exit
    // unmarked, which is a false negative in the one direction that matters.
    {
      filename: hookFile,
      code: `
        import { recordFireLogEntry } from "./fire-log";
        const note = "decided";
        recordFireLogEntry({ guardName: note, event: "PreToolUse", decision: "allow" });
      `,
      errors: [{ messageId: MSG }],
    },
  ],
});

describe("coverage stays in sync between the rule and eslint.config.js (R1)", () => {
  // The mt#3178 failure mode, mechanized rather than left to the header comment. Coverage
  // is declared twice — the `files` glob in the flat config and `COVERED_ROOTS_POSIX` in
  // the rule — and a root present in only one is silently unenforced. The sibling rule
  // `require-hook-domain-bootstrap` hit exactly that: widening the config glob alone
  // reported 0 violations across 144 files because the rule's own path guard rejected
  // every path. A comment did not prevent it there; this assertion does here.
  const block = config.find((entry) => entry?.rules?.["custom/require-guard-outcome-in-fire-log"]);

  test("the rule is registered in the flat config", () => {
    expect(block).toBeDefined();
    expect(block.rules["custom/require-guard-outcome-in-fire-log"]).toBe("error");
  });

  test("every config glob root is declared in COVERED_ROOTS_POSIX, and vice versa", () => {
    // `.minsky/hooks/**/*.ts` -> `.minsky/hooks`
    const globRoots = block.files.map((glob) => glob.replace(/\/\*\*.*$/, ""));
    expect([...globRoots].sort()).toEqual([...COVERED_ROOTS_POSIX].sort());
  });
});
