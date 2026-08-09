import { describe, test, expect } from "bun:test";
import {
  evaluateBunTestSummary,
  resolveChangedBase,
  changedFilesSince,
  touchesMcp,
  planRun,
  selectedNothing,
  MCP_PATH_PREFIX,
} from "../../scripts/run-tests-gated";

// mt#2716: these fixtures assert the FAIL-CLOSED behavior of the pre-push test
// gate. The summary-block shapes below match real `bun test` 1.2.21 output
// (pinned by mt#2665 against live macOS + GitHub Actions logs): a leading space
// before each count, and "Ran N tests across M file(s)" with singular "file"
// for a single-file run.

// Shared completion-summary "Ran …" line, reused across fixtures so the count
// stays consistent (and to satisfy custom/no-magic-string-duplication).
const ranLine = "Ran 512 tests across 87 files. [12.30s]";

// Shared fail-closed reason substring, reused across the "no summary at all"
// fixtures below (and to satisfy custom/no-magic-string-duplication).
const NO_SUMMARY_REASON = "no completion summary";

const cleanSummary = [" 512 pass", " 0 fail", " 1200 expect() calls", ranLine].join("\n");

const failingSummary = [" 510 pass", " 2 fail", " 1198 expect() calls", ranLine].join("\n");

const singleFileSummary = ["1 pass", "0 fail", "Ran 1 tests across 1 file. [0.10s]"].join("\n");

// mt#3014 finding: real bun 1.2.21 output singularizes "test" independently of
// "file" -- a run with exactly ONE test prints "Ran 1 test across 1 file."
// (verified empirically), NOT "Ran 1 tests across 1 file." as the fixture
// above (pre-existing, kept for regression coverage of the broader pattern)
// assumed. That mismatch meant the "singular file" test above was accidentally
// passing without ever exercising bun's real singular-test text -- a format-
// alignment gap (see .claude/rules/bun-test-patterns.md's "Format Alignment
// Pattern"). This fixture reproduces the REAL singular form.
const singleTestSingleFileSummary = ["1 pass", "0 fail", "Ran 1 test across 1 file. [0.10s]"].join(
  "\n"
);

// The exact failure this gate exists to catch: a run that exits 0 but never
// prints the completion summary (silent truncation).
const truncatedOutput = [
  "bun test v1.2.21",
  "src/foo.test.ts:",
  "(pass) foo > does a thing [0.5ms]",
].join("\n");

describe("evaluateBunTestSummary (mt#2716 fail-closed pre-push gate)", () => {
  test("passes a clean run: summary present, 0 fail, exit 0", () => {
    expect(evaluateBunTestSummary(cleanSummary, 0)).toEqual({ ok: true, reason: "" });
  });

  test('passes a single-file run (singular "1 file", no trailing s)', () => {
    expect(evaluateBunTestSummary(singleFileSummary, 0).ok).toBe(true);
  });

  test('passes a REAL single-test single-file run (singular "1 test", no trailing s, mt#3014)', () => {
    expect(evaluateBunTestSummary(singleTestSingleFileSummary, 0).ok).toBe(true);
  });

  test("FAILS a truncated run (no completion summary) even on exit 0 — the core mt#2716 fix", () => {
    const r = evaluateBunTestSummary(truncatedOutput, 0);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain(NO_SUMMARY_REASON);
  });

  test("FAILS when the summary reports failing tests", () => {
    const r = evaluateBunTestSummary(failingSummary, 1);
    expect(r.ok).toBe(false);
    // Exact emitted phrasing (`bun test reported N failing test(s)`), not a loose substring.
    expect(r.reason).toContain("2 failing test(s)");
  });

  test("FAILS closed when the summary is clean but the exit code is non-zero", () => {
    const r = evaluateBunTestSummary(cleanSummary, 1);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("exited 1 despite a clean summary");
  });

  test('FAILS closed when the Ran-line is present but the "<N> fail" line is absent', () => {
    const onlyRanLine = "Ran 512 tests across 87 files. [12.30s]";
    const r = evaluateBunTestSummary(onlyRanLine, 0);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('"<N> fail" line could not be found');
  });

  test("does not mistake a test NAME containing 'fail' for the summary line", () => {
    // A test title line must not satisfy the anchored /^ *\\d+ fail$/ pattern.
    const withDecoyName = [
      "(pass) handles the 0 fail edge case [1ms]",
      " 3 pass",
      " 0 fail",
      "Ran 3 tests across 1 file. [0.05s]",
    ].join("\n");
    expect(evaluateBunTestSummary(withDecoyName, 0).ok).toBe(true);
  });

  // mt#3075 / mt#3078: bun colorizes its summary lines whenever the child
  // process inherits a FORCE_COLOR-set env (e.g. a Claude Code agent
  // session's ambient shell) -- reproduced verbatim from a live `bun test`
  // 1.2.21 run under FORCE_COLOR=3. Before the stripAnsi() fix (found and
  // fixed independently on two branches), this exact output fail-closed
  // EVERY commit/push in such an environment: the escape codes around
  // " 0 fail" defeated the anchored /^ *\d+ fail$/ regex.
  const ansiCleanSummary = [
    "\x1b[0m\x1b[1mbun test \x1b[0m\x1b[2mv1.2.21 (7c45ed97)\x1b[0m",
    "",
    "\x1b[0m\x1b[32m 10 pass\x1b[0m",
    "\x1b[0m\x1b[2m 0 fail\x1b[0m",
    " 25 expect() calls",
    "Ran 10 tests across 1 file. \x1b[0m\x1b[2m[\x1b[1m140.00ms\x1b[0m\x1b[2m]\x1b[0m",
  ].join("\n");

  const ansiFailingSummary = [
    "\x1b[0m\x1b[1mbun test \x1b[0m\x1b[2mv1.2.21 (7c45ed97)\x1b[0m",
    "",
    "\x1b[0m\x1b[32m 8 pass\x1b[0m",
    "\x1b[0m\x1b[31m 2 fail\x1b[0m",
    " 25 expect() calls",
    "Ran 10 tests across 1 file. \x1b[0m\x1b[2m[\x1b[1m140.00ms\x1b[0m\x1b[2m]\x1b[0m",
  ].join("\n");

  test("passes a colorized (FORCE_COLOR) clean run — ANSI codes around '0 fail' are stripped", () => {
    expect(evaluateBunTestSummary(ansiCleanSummary, 0)).toEqual({ ok: true, reason: "" });
  });

  test("FAILS a colorized run reporting real failures (ANSI-wrapped '2 fail' line)", () => {
    const r = evaluateBunTestSummary(ansiFailingSummary, 1);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("2 failing test(s)");
  });

  // mt#3079: the colorized-clean/failing fixtures above both carry a
  // completion summary. This fixture covers the case the pair above doesn't:
  // colorized output with NO completion summary at all (the silent-
  // truncation case, mt#2716's core fix) must still fail closed once
  // ANSI-stripped, not accidentally pass because stripping happened to make
  // it look emptier.
  test("FAILS closed on colorized output with no completion summary at all (mt#3079)", () => {
    const colorized = "\x1b[0m\x1b[2msome unrelated output\x1b[0m";
    const r = evaluateBunTestSummary(colorized, 0);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain(NO_SUMMARY_REASON);
  });

  // PR #2207 R1 (non-blocking #2): the reviewer asked for explicit coverage that
  // stripAnsi's now-unconditional application to the full buffer doesn't mask a
  // genuine failure when the input is PLAIN (non-ANSI) structured content with no
  // completion summary -- a multi-line stack trace being the canonical shape. This
  // is a coverage addition only; per coordination with mt#3075's already-landed
  // implementation on main, the stripAnsi mechanism itself is unchanged here (see
  // this PR's reply on the review thread for the rationale against forking it).
  test("FAILS closed on a plain (non-ANSI) stack trace with no completion summary", () => {
    const stackTrace = [
      "error: Cannot access 'server' before initialization.",
      "      at <anonymous> (packages/domain/src/setup/github-app/manifest-flow-provisioner.ts:130:9)",
      "      at <anonymous> (packages/domain/src/setup/github-app/manifest-flow-provisioner.test.ts:187:62)",
    ].join("\n");
    const r = evaluateBunTestSummary(stackTrace, 1);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain(NO_SUMMARY_REASON);
  });
});

// ---------------------------------------------------------------------------
// mt#3562 — change-scoped selection
// ---------------------------------------------------------------------------

/**
 * Fake git that answers from a map keyed on the joined argv, and throws for
 * anything unlisted — matching production, where a non-zero git exit throws so
 * callers fall back to the full suite rather than reading empty output as
 * "nothing changed".
 */
const fakeGit =
  (responses: Record<string, string>) =>
  (args: string[]): string => {
    const joined = args.join(" ");
    const hit = Object.entries(responses).find(([prefix]) => joined.startsWith(prefix));
    if (!hit) throw new Error(`fake git: unexpected argv ${joined}`);
    return hit[1];
  };

describe("resolveChangedBase (mt#3562)", () => {
  test("returns the merge base with origin/main", () => {
    const git = fakeGit({ "merge-base HEAD origin/main": "abc123def\n" });
    expect(resolveChangedBase(git)).toBe("abc123def");
  });

  test("falls back to origin/master when origin/main is absent", () => {
    const git = fakeGit({ "merge-base HEAD origin/master": "beef42\n" });
    expect(resolveChangedBase(git)).toBe("beef42");
  });

  test("returns null when no upstream ref resolves — caller runs the full suite", () => {
    // Fail-closed: an unscoped run is slow but correct; a wrongly-scoped one is
    // fast and blind, which is the failure mode worth avoiding.
    expect(resolveChangedBase(fakeGit({}))).toBeNull();
  });

  test("treats empty git output as unresolved rather than as a valid base", () => {
    expect(resolveChangedBase(fakeGit({ "merge-base": "   \n" }))).toBeNull();
  });
});

describe("changedFilesSince (mt#3562)", () => {
  test("unions the ref diff with untracked files", () => {
    // bun's --changed=<ref> does the same union (verified 2026-08-08), so the
    // src/mcp routing decision is made over the same set bun selects from.
    const git = fakeGit({
      "diff --name-only": "src/a.ts\nsrc/b.ts\n",
      "ls-files --others": "scratch/new.ts\n",
    });
    expect(changedFilesSince("base", git)).toEqual(["src/a.ts", "src/b.ts", "scratch/new.ts"]);
  });

  test("returns null when git fails — caller runs everything", () => {
    expect(changedFilesSince("base", fakeGit({}))).toBeNull();
  });

  test("drops blank lines rather than emitting empty paths", () => {
    const git = fakeGit({
      "diff --name-only": "src/a.ts\n\n\n",
      "ls-files --others": "\n",
    });
    expect(changedFilesSince("base", git)).toEqual(["src/a.ts"]);
  });
});

describe("touchesMcp (mt#3562)", () => {
  test("fires on a src/mcp file", () => {
    expect(touchesMcp(["docs/x.md", `${MCP_PATH_PREFIX}server.ts`])).toBe(true);
  });

  test("does not fire on src/adapters/mcp, which is a different directory", () => {
    // The isolated runner's domain is src/mcp/ specifically; src/adapters/mcp
    // is part of the main suite and must not route work to it.
    expect(touchesMcp(["src/adapters/mcp/task-edit-tools.ts"])).toBe(false);
  });

  test("does not fire on an empty diff", () => {
    expect(touchesMcp([])).toBe(false);
  });
});

describe("planRun — every uncertainty resolves to the full suite (PR #2729 R1)", () => {
  test("scopes when the base resolves and the changed-file list reads", () => {
    const plan = planRun({ forceFull: false, base: "abc123def", changedFiles: ["src/a.ts"] });
    expect(plan.base).toBe("abc123def");
    expect(plan.runMcp).toBe(false);
  });

  test("runs the isolated runner when the diff reaches src/mcp", () => {
    const plan = planRun({
      forceFull: false,
      base: "abc123def",
      changedFiles: [`${MCP_PATH_PREFIX}server.ts`],
    });
    expect(plan.base).toBe("abc123def");
    expect(plan.runMcp).toBe(true);
  });

  test("an unreadable changed-file list runs the FULL suite, not a scoped one", () => {
    // The R1 finding: previously this forced the isolated runner to run
    // (correct) while leaving the MAIN suite scoped (incorrect), so the
    // documented fail-closed guarantee held for one half of the gate only.
    const plan = planRun({ forceFull: false, base: "abc123def", changedFiles: null });
    expect(plan.base).toBeNull();
    expect(plan.runMcp).toBe(true);
    expect(plan.reason).toContain("FULL suite");
  });

  test("an unresolvable merge base runs the FULL suite", () => {
    const plan = planRun({ forceFull: false, base: null, changedFiles: null });
    expect(plan.base).toBeNull();
    expect(plan.runMcp).toBe(true);
  });

  test("MINSKY_PREPUSH_FULL_SUITE wins over a resolvable base", () => {
    const plan = planRun({ forceFull: true, base: "abc123def", changedFiles: ["docs/x.md"] });
    expect(plan.base).toBeNull();
    expect(plan.runMcp).toBe(true);
  });

  test("every full-suite branch also runs the isolated runner — no half-scoped state", () => {
    // The invariant the R1 finding violated, asserted directly: base === null
    // and runMcp === false must be unreachable.
    const fullSuiteBranches = [
      planRun({ forceFull: true, base: "abc", changedFiles: ["docs/x.md"] }),
      planRun({ forceFull: false, base: null, changedFiles: null }),
      planRun({ forceFull: false, base: "abc", changedFiles: null }),
    ];
    for (const plan of fullSuiteBranches) {
      expect(plan.base).toBeNull();
      expect(plan.runMcp).toBe(true);
    }
  });
});

describe("selectedNothing (mt#3562)", () => {
  test("recognizes bun's legitimate zero-selection line", () => {
    expect(selectedNothing("--changed: 107 changed files, but no test files are affected")).toBe(
      true
    );
  });

  test("recognizes it through ANSI colouring", () => {
    expect(
      selectedNothing("[2m--changed: 12 changed files, but no test files are affected[0m")
    ).toBe(true);
  });

  test("does NOT fire on a run that selected files", () => {
    expect(selectedNothing("--changed: 179 changed files, running 161/887 test files")).toBe(false);
  });

  test("does NOT fire on a truncated run, which emits no --changed summary at all", () => {
    // The distinction that matters: zero-selected passes loudly, truncated
    // fail-closes via evaluateBunTestSummary. This helper only controls wording.
    expect(selectedNothing("bun test v1.3.14 (0d9b296a)\n")).toBe(false);
  });
});
