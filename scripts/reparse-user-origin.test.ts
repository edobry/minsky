/**
 * Argument parsing for the mt#4877 re-parse driver.
 *
 * Narrow on purpose. The script's body is I/O against production — it was
 * verified by RUNNING it (dry-run, then `--execute` over 229 sessions, evidence
 * in mt#4877 `## Outcome`), which is stronger evidence than a mock could give.
 * What a live run does NOT pin is the flag that decides WHICH of those two
 * things happens, and that is the one part worth a test: a dry-run and a
 * production mutation differ by `--execute` alone.
 *
 * Importing this module is safe only because of the `import.meta.main` guard in
 * the script — without it, this file would open a prod connection at import.
 *
 * @see scripts/reparse-user-origin.ts
 */

import { describe, expect, test } from "bun:test";

import { parseArgs } from "./reparse-user-origin";

describe("parseArgs", () => {
  test("defaults to a dry run", () => {
    // The whole safety posture rests on this default (CLAUDE.md §Operational
    // Safety: Dry-Run First): an operator who forgets a flag must get a preview,
    // never a mutation.
    expect(parseArgs([]).execute).toBe(false);
  });

  test("--execute opts in", () => {
    expect(parseArgs(["--execute"]).execute).toBe(true);
  });

  test.each([["--execute-later"], ["--no-execute"], ["execute"], ["--dry-execute"]])(
    "%p does NOT opt in",
    (arg) => {
      // An exact-match check, not a substring one. A `.includes("--execute")`
      // implementation passes the test above and treats every one of these as
      // consent to mutate production.
      expect(parseArgs([arg]).execute).toBe(false);
    }
  );

  test("--after-id carries the resume cursor verbatim", () => {
    expect(parseArgs(["--after-id=agent-a0e1d070d1ae881bd"]).afterId).toBe(
      "agent-a0e1d070d1ae881bd"
    );
    expect(parseArgs([]).afterId).toBeUndefined();
  });

  test.each([["--after-id="], ["--after-id=   "]])(
    "%p throws rather than resuming from nowhere",
    (arg) => {
      // PR #3553 R1. An empty cursor is the quiet failure: the scan's
      // `agent_session_id > ''` matches every row, so a resume the operator asked
      // to be partial silently becomes a full run — AND the scope-match gate is
      // skipped, because it is skipped whenever --after-id is set. Two safety
      // properties lost at once, with output that looks entirely normal.
      expect(() => parseArgs([arg])).toThrow(/--after-id must name a session id/);
    }
  );

  test("page size defaults, and accepts an override", () => {
    expect(parseArgs([]).pageSize).toBe(150);
    expect(parseArgs(["--page-size=25"]).pageSize).toBe(25);
  });

  test.each([["--page-size=0"], ["--page-size=-5"], ["--page-size=abc"], ["--page-size="]])(
    "%p throws rather than silently falling back",
    (arg) => {
      // A non-positive or unparseable page size must not degrade to the default:
      // the scan loop keysets on the last row of each page, so a page size of 0
      // returns an empty page, breaks immediately, and reports ZERO affected
      // sessions — a clean-looking result that means nothing ran.
      expect(() => parseArgs([arg])).toThrow(/--page-size must be a positive number/);
    }
  );

  test("flags combine", () => {
    const args = parseArgs(["--execute", "--after-id=agent-x", "--page-size=10"]);
    expect(args).toEqual({ execute: true, afterId: "agent-x", pageSize: 10 });
  });
});
