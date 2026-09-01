/**
 * Tests for the test-file reachability invariant (mt#3935).
 *
 * The comparison and parsing logic is pure, so it is tested here against
 * synthetic inputs rather than by parsing the real workflows (mem#316 —
 * functional core, imperative shell). The real sweep runs as its own CI step
 * (`bun run check:test-reachability`); what this file guards is that the
 * derivation behaves correctly, including the failure direction — a check that
 * cannot fail is not verification (mem#704).
 *
 * Several cases below are regressions against bugs this check ACTUALLY had
 * during implementation, each of which made it report a clean repo while a real
 * hole was open. They are marked where they appear, because "green for the
 * wrong reason" is the specific failure this whole task exists to prevent.
 */
import { describe, expect, test } from "bun:test";
import {
  REACHABILITY_ALLOWLIST,
  compareReachability,
  extractPullRequestRunSteps,
  invokesTests,
  isAllowlisted,
  parseBunTestCommand,
  pathCovers,
  scopeReaches,
  validateAllowlist,
  type AllowlistEntry,
  type SuiteScope,
} from "../../scripts/test-reachability";

const scope = (roots: string[], excludePrefixes: string[] = []): SuiteScope => ({
  suite: "test",
  roots,
  excludePrefixes,
});

describe("parseBunTestCommand", () => {
  test("extracts positional paths and ignores flags", () => {
    const parsed = parseBunTestCommand("bun test --timeout=15000 ./src/cockpit/web");

    expect(parsed?.roots).toEqual(["./src/cockpit/web"]);
  });

  test("a value-taking flag consumes its value instead of it becoming a path", () => {
    // REGRESSION: without the VALUE_FLAGS set, `./tests/setup.ts` reads as a
    // positional root, so every suite that preloads it appears to cover the
    // whole tests/ tree — turning a real hole green.
    const parsed = parseBunTestCommand("bun test --preload ./tests/setup.ts ./src");

    expect(parsed?.roots).toEqual(["./src"]);
  });

  test("path-ignore-patterns is captured in both the inline and spaced forms", () => {
    const inline = parseBunTestCommand("bun test --path-ignore-patterns='services/**' ./src");
    const spaced = parseBunTestCommand("bun test --path-ignore-patterns 'services/**' ./src");

    expect(inline?.ignores).toEqual(["services/**"]);
    expect(spaced?.ignores).toEqual(["services/**"]);
    expect(inline?.roots).toEqual(["./src"]);
    expect(spaced?.roots).toEqual(["./src"]);
  });

  test("an env-var prefix does not hide the invocation", () => {
    const parsed = parseBunTestCommand("RUN_INTEGRATION_TESTS=1 bun test tests/integration/a.ts");

    expect(parsed?.roots).toEqual(["tests/integration/a.ts"]);
  });

  test("prose that merely CONTAINS 'bun test' is not an invocation", () => {
    // REGRESSION: ci.yml's own error string says "bun test did not print a
    // completion summary line (\"Ran N tests across M files\")". Parsed as a
    // command, its word `tests` became a positional root covering the entire
    // tests/ tree, and the check reported 1669/1669 reached with four real
    // holes open.
    const prose =
      'echo "::error::bun test did not print a completion summary line (\\"Ran N tests across M files\\")"';

    expect(parseBunTestCommand(prose)).toBeNull();
  });

  test("a command that is not bun test at all returns null", () => {
    expect(parseBunTestCommand("bun install --frozen-lockfile")).toBeNull();
    expect(parseBunTestCommand("bun run build")).toBeNull();
  });

  test("bun test after a shell operator IS in command position", () => {
    expect(parseBunTestCommand("cd services/reviewer && bun test ./src")?.roots).toEqual(["./src"]);
  });
});

describe("pathCovers", () => {
  test("a directory prefix covers its descendants and itself", () => {
    expect(pathCovers("./src", "src/a/b.test.ts")).toBe(true);
    expect(pathCovers("src/", "src/a.test.ts")).toBe(true);
  });

  test("a sibling sharing a string prefix is NOT covered", () => {
    // The `/` boundary is what stops the substring collision `test:components`
    // needed a leading `./` to avoid (mt#3496).
    expect(pathCovers("src/cockpit/web", "src/cockpit/web-dist.test.ts")).toBe(false);
  });

  test("an exact file path covers only itself", () => {
    expect(pathCovers("tests/integration/a.test.ts", "tests/integration/a.test.ts")).toBe(true);
    expect(pathCovers("tests/integration/a.test.ts", "tests/integration/b.test.ts")).toBe(false);
  });

  test("a single-star glob matches within one segment, not across separators", () => {
    expect(
      pathCovers(
        "tests/integration/*.testcontainer.test.ts",
        "tests/integration/x.testcontainer.test.ts"
      )
    ).toBe(true);
    expect(
      pathCovers(
        "tests/integration/*.testcontainer.test.ts",
        "tests/integration/deep/x.testcontainer.test.ts"
      )
    ).toBe(false);
  });
});

describe("scopeReaches", () => {
  test("no positional roots means everything", () => {
    expect(scopeReaches(scope([]), "anywhere/x.test.ts")).toBe(true);
  });

  test("an exclude beats a matching root", () => {
    expect(scopeReaches(scope(["./src"], ["src/mcp"]), "src/mcp/a.test.ts")).toBe(false);
    expect(scopeReaches(scope(["./src"], ["src/mcp"]), "src/other/a.test.ts")).toBe(true);
  });

  test("a `dir/**` ignore pattern excludes the tree", () => {
    expect(scopeReaches(scope([], ["services/**"]), "services/reviewer/a.test.ts")).toBe(false);
  });
});

describe("compareReachability", () => {
  const main = scope(["./src"]);
  const COVERED = "src/a.test.ts";
  const ORPHAN = "orphan/b.test.ts";

  test("a file in no suite, with no allowlist entry, is a violation", () => {
    const result = compareReachability([COVERED, ORPHAN], [main], []);

    expect(result.unreached).toEqual([ORPHAN]);
    expect(result.allowlisted).toEqual([]);
  });

  test("an allowlisted file is reported separately, not as a violation", () => {
    const allowlist: AllowlistEntry[] = [{ prefix: "orphan/", reason: "tracked by mt#9999" }];

    const result = compareReachability([COVERED, ORPHAN], [main], allowlist);

    expect(result.unreached).toEqual([]);
    expect(result.allowlisted).toEqual([ORPHAN]);
  });

  test("full coverage yields no violations, and names the suite that runs each file", () => {
    const result = compareReachability([COVERED], [main], []);

    expect(result.unreached).toEqual([]);
    expect(result.reachedBy.get(COVERED)).toEqual(["test"]);
  });

  test("an allowlist prefix matching nothing is reported as stale", () => {
    const allowlist: AllowlistEntry[] = [
      { prefix: "gone/", reason: "the hole this named is closed" },
    ];

    const result = compareReachability([COVERED], [main], allowlist);

    expect(result.unusedAllowlistPrefixes).toEqual(["gone/"]);
  });

  test("bringing an unreached file into a suite removes the violation — the fix direction", () => {
    const files = [COVERED, "tests/b.test.ts"];

    const before = compareReachability(files, [main], []);
    const after = compareReachability(files, [main, scope(["./tests"])], []);

    expect(before.unreached).toEqual(["tests/b.test.ts"]);
    expect(after.unreached).toEqual([]);
  });
});

describe("validateAllowlist / isAllowlisted", () => {
  test("an entry with no reason is rejected — a hole must be a recorded decision", () => {
    const problems = validateAllowlist([{ prefix: "orphan/", reason: "" }]);

    expect(problems).toHaveLength(1);
    expect(problems[0]?.problem).toContain("reason");
  });

  test("a whitespace-only reason is rejected too", () => {
    expect(validateAllowlist([{ prefix: "orphan/", reason: "   " }])).toHaveLength(1);
  });

  test("matches a directory prefix and an exact path, but not an unrelated sibling", () => {
    const allowlist: AllowlistEntry[] = [
      { prefix: "tests/integration/", reason: "gated" },
      { prefix: "tests/verify-bug-fix.test.ts", reason: "root gap" },
    ];

    expect(isAllowlisted("tests/integration/deep/x.test.ts", allowlist)).toBe(true);
    expect(isAllowlisted("tests/verify-bug-fix.test.ts", allowlist)).toBe(true);
    expect(isAllowlisted("tests/domain/x.test.ts", allowlist)).toBe(false);
  });
});

describe("invokesTests", () => {
  test("recognizes the three runner shapes this repo actually uses", () => {
    expect(invokesTests('spawn(["bun",\n      "test",\n      "--preload"])')).toBe(true);
    expect(invokesTests("const args = toBunTestArgs(files);")).toBe(true);
    expect(invokesTests('spawnWithWatchdog(["bun", "scripts/run-tests-main.ts"])')).toBe(true);
  });

  test("IMPORTING from a run-tests module is not running tests", () => {
    // REGRESSION, and the sharpest one: reading `ROOTS` to reason about which
    // files a suite would run is precisely what a coverage check does — so the
    // import-based signal classified THIS script as an unregistered runner and
    // aborted its own sweep with exit 2. A spawn is what distinguishes them.
    expect(invokesTests('import { ROOTS } from "./run-tests-main";')).toBe(false);
  });

  test("a spawn described in a COMMENT is not a spawn", () => {
    // REGRESSION: this script's own docblock explains the gated runner by
    // quoting `["bun", script]`. Matched against raw source, that prose made
    // the check classify ITSELF as a runner and abort with exit 2 as soon as it
    // was wired into CI — the same prose-is-not-a-command mistake as the ci.yml
    // error string, one layer up.
    const commented = '/* the gated runner spawns ["bun", script] */\nexport const X = 1;';

    expect(invokesTests(commented)).toBe(false);
    expect(invokesTests('// spawns ["bun", "test"]\nconst y = 2;')).toBe(false);
  });

  test("a script that spawns something other than bun is not a runner", () => {
    // Otherwise every `bun scripts/*.ts` step in CI — budget checks, catalog
    // builders, this check itself — would abort the sweep as an unregistered
    // runner, and the invariant would never run at all.
    expect(invokesTests('Bun.spawnSync(["git", "ls-files", "*.test.ts"]);')).toBe(false);
  });
});

describe("extractPullRequestRunSteps", () => {
  const prWorkflow = (steps: string) =>
    `on:\n  pull_request:\n    branches: [main]\njobs:\n${steps}`;

  test("captures a block-scalar step body, not the block indicator", () => {
    // REGRESSION: `run: |` matched the inline-command pattern and was captured
    // as a command whose body was the literal `|`, so every multi-line step was
    // silently dropped — which is where most suite invocations live.
    const steps = extractPullRequestRunSteps(
      prWorkflow("  build:\n    steps:\n      - run: |\n          bun run test:reviewer\n")
    );

    expect(steps.join("\n")).toContain("bun run test:reviewer");
    expect(steps).not.toContain("|");
  });

  test("captures an inline step body", () => {
    const steps = extractPullRequestRunSteps(
      prWorkflow("  build:\n    steps:\n      - run: bun run test:hooks\n")
    );

    expect(steps).toEqual(["bun run test:hooks"]);
  });

  test("a workflow with no pull_request trigger contributes nothing", () => {
    // clock-shifted-tests.yml is schedule-only: it gates no PR, so counting it
    // would credit coverage no merge is actually protected by.
    const scheduled =
      "on:\n  schedule:\n    - cron: '37 7 * * *'\njobs:\n  x:\n    steps:\n      - run: bun test ./src\n";

    expect(extractPullRequestRunSteps(scheduled)).toEqual([]);
  });
});

describe("the shipped allowlist", () => {
  test("is valid — every entry records why the hole exists", () => {
    expect(validateAllowlist(REACHABILITY_ALLOWLIST)).toEqual([]);
  });

  test("every entry names an owning task", () => {
    // This is mt#3935's SC5 rendered as an assertion: a reported hole is
    // acceptable only when something owns closing it. An entry without a
    // tracking task is an untracked gap wearing a decision's clothes.
    for (const entry of REACHABILITY_ALLOWLIST) {
      expect(entry.tracking).toMatch(/^mt#\d+$/);
    }
  });
});
