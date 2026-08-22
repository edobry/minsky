import { describe, expect, test } from "bun:test";
import {
  run,
  editedPaths,
  callsSinceLastPr,
  isSerializedSurfacePath,
  messagePhrases,
  replacedLiterals,
  staleOccurrences,
  stripCommentLines,
  OVERRIDE_ENV_VAR,
} from "./enumeration-scope-check";
import { sweptDirectories, sessionSweptDirectories } from "./evidence-provenance-table";
import { suppliesPattern } from "./command-shape";
import type { ToolCallWithResult, TranscriptLine } from "./transcript";
import type { DispatchContext, GuardOutcome } from "./registry";
import type { ToolHookInput } from "./types";
import { deriveBudgets } from "./types";

/** Tool names used across fixtures — named so they cannot drift between cases. */
const PR_CREATE_TOOL = "mcp__minsky__session_pr_create";
const WRITE_TOOL = "mcp__minsky__session_write_file";
const HEALTH_CONTRACT = "contract/cockpit-health-shape.json";
/** Named so the fixtures below cannot drift from each other (custom/no-magic-string-duplication). */
const RETIRED_PHRASE = "The database is unreachable";
const SEARCH_REPLACE_TOOL = "mcp__minsky__session_search_replace";
const EXEC_TOOL = "mcp__minsky__session_exec";
const MISSING_DIRS = "missingDirectories";
/** The two renderers mt#4379 missed and PR #3220 had to close. */
const SIBLING_PROVIDER = "packages/domain/src/persistence/unconfigured-provider.ts";
const SIBLING_COCKPIT = "src/cockpit/db-providers.ts";
/** The file mt#4379 DID edit — excluded from stale hits because the session reached it. */
const EDITED_RENDERER = "packages/domain/src/tasks/multi-backend-service.ts";
/** An ordinary source file, used where the fixture just needs a non-contract edit. */
const ORDINARY_SOURCE = "src/cockpit/principal-channel-poller.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
//
// AT4: no fixture is a paraphrase. Every command string below is the verbatim
// structured tool-call state from a real session in
// `~/.claude/projects/-Users-edobry-Projects-minsky`, quoted as-is. mem#1020 —
// "prose gets paraphrased by default, because paraphrasing is what writing prose
// IS. A detector fixture is not prose."

function call(toolName: string, input: Record<string, unknown>): ToolCallWithResult {
  return { index: 0, useId: undefined, toolName, input, resultText: "", hasResult: true };
}

/**
 * VERBATIM from the mt#4252 session (`e88c639f-…`, line 127). This is the exact
 * call that made the first implementation credit `docs` as swept: a `grep` over
 * `src/` in one segment and a single-file `sed` of a `docs/` path in another.
 */
const MULTI_SEGMENT_GREP_AND_SED = call("Bash", {
  command:
    "rm -f src/cockpit/zz-mt4252-repro.test.ts\n" +
    "echo '--- backoff/deadline constants ---'\n" +
    'grep -rn "ERROR_BACKOFF_MS\\s*=\\|DB_STEP_DEADLINE_MS\\s*=" src/cockpit/principal-channel-poller.ts\n' +
    "sed -n '1,80p' docs/architecture/adr-035-failed-initializer-must-not-be-memoized-as-a-value.md",
});

/** VERBATIM shape from the same corpus: a real docs-ROOT sweep. */
const REAL_DOCS_SWEEP = call("Bash", {
  command: 'grep -rn "principalChannel" docs/ src/cockpit',
});

/**
 * VERBATIM from the mt#4252 session (`e88c639f-…`, line 127). The docs search
 * that session actually ran — and the reason an earlier revision suppressed the
 * guard on its own originating incident. It reads ONE SUBTREE under a glob that
 * structurally cannot reach `docs/principal-channel.md`, which sits at the
 * `docs/` root.
 */
const DOCS_SUBTREE_ONLY = call("Bash", {
  command:
    'grep -rln "principal-channel\\|principal channel" docs/architecture/adr-*.md 2>/dev/null',
});

const CONTRACT_EDIT = call(WRITE_TOOL, {
  sessionId: "d543c095-1f9f-42fc-9232-fdbfe9b5624f",
  path: HEALTH_CONTRACT,
  content: "{}",
});

const PR_CREATE = call(PR_CREATE_TOOL, { task: "mt#4232", title: "x" });

/**
 * Built as the real types rather than cast through `unknown` — the same
 * discipline `scripts/replay-claim-provenance.ts` records for itself: a harness
 * whose inputs are shaped by an assertion can drift from what the dispatcher
 * actually hands the guard.
 */
function hookInput(): ToolHookInput {
  return {
    session_id: "test",
    // A fixed path, not `process.cwd()`. Row 1 never reads the filesystem; row 2
    // (mt#4399) does, and every test that reaches it injects both filesystem
    // steps via `outcomeWith`, so this stays inert and no test is
    // environment-dependent.
    cwd: "/repo",
    hook_event_name: "PreToolUse",
    tool_name: PR_CREATE_TOOL,
    tool_input: {},
  };
}

function dispatchContext(calls: ToolCallWithResult[]): DispatchContext {
  return {
    event: "PreToolUse",
    hostCapSec: 65,
    budgets: deriveBudgets(65),
    transcriptCandidates: [],
    transcriptLines: callsToLines(calls),
  };
}

function outcomeOf(calls: ToolCallWithResult[]): Record<string, unknown> {
  const result: GuardOutcome | null = run(hookInput(), dispatchContext(calls));
  return (result?.calibration ?? {}) as Record<string, unknown>;
}

/** Wrap fixture calls in the transcript-line shape `findToolCallsWithResults` parses. */
function callsToLines(calls: ToolCallWithResult[]): TranscriptLine[] {
  return calls.map((c) => ({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", name: c.toolName, input: c.input, id: "t" }],
    },
  }));
}

// ---------------------------------------------------------------------------
// The sweep recognizer
// ---------------------------------------------------------------------------

describe("sweptDirectories", () => {
  // LIVENESS FIRST (mem#1020): prove each fixture reaches the matcher in the
  // positive direction before any test asserts an absence on it. An inert
  // fixture passes a negative assertion vacuously AND survives its own negative
  // control, because "nothing matched" is stable whether or not the code under
  // test works.
  test("the docs-root fixture is LIVE — it credits docs", () => {
    // The liveness anchor for every negative assertion below: this fixture
    // provably reaches the matcher and returns a directory, so a later `[]` or
    // `not.toContain` is a real discrimination rather than an inert fixture
    // passing vacuously (mem#1020).
    expect(sweptDirectories(REAL_DOCS_SWEEP)).toContain("docs");
  });

  test("a docs SUBTREE glob does NOT credit docs — a subtree is not the directory", () => {
    // Same axis as the test above, opposite verdict, both fixtures verbatim.
    // This pair is the guard test mem#1002 prescribes: the next widening fails
    // HERE, naming the cause, instead of silently re-crediting the subtree and
    // suppressing the guard on mt#4252 again.
    expect(sweptDirectories(DOCS_SUBTREE_ONLY)).not.toContain("docs");
  });

  test("a single-file sed of a docs path does NOT credit docs, even sharing a command with a grep", () => {
    // The defect this encodes: asking "does ANY segment search?" and then
    // reading directory tokens from the WHOLE command pairs a verb from one
    // segment with a path from another. Measured on the mt#4252 session.
    expect(sweptDirectories(MULTI_SEGMENT_GREP_AND_SED)).not.toContain("docs");
  });

  test("a whole-tree ripgrep with no path operand credits every prescribable directory", () => {
    expect(sweptDirectories(call("Bash", { command: "rg principalChannel" }))).toContain("docs");
  });

  test("an explicit dot operand credits every prescribable directory", () => {
    expect(sweptDirectories(call("Bash", { command: 'grep -rn "foo" .' }))).toContain("docs");
  });

  test("a bare piped grep reading stdin credits nothing — it sweeps no tree", () => {
    // `grep` with no path operand reads STDIN. Treating it like `rg` is what
    // produced a measured 86.4% `contract/` sweep rate on the first run.
    expect(sweptDirectories(call("Bash", { command: "cat foo.txt | grep bar" }))).toEqual([]);
  });

  test("a non-search command naming a directory credits nothing", () => {
    expect(sweptDirectories(call("Bash", { command: "bun test src/cockpit" }))).toEqual([]);
  });

  // --- PR #3141 R1 regressions: each pins one BLOCKING finding ------------

  test("R1: `ls` is NOT a search — listing a directory does not credit it", () => {
    // `ls docs/` credited `docs` and would turn a real miss into a false clean,
    // contradicting this constant's own "commands that SEARCH" contract.
    expect(sweptDirectories(call("Bash", { command: "ls -la docs/" }))).toEqual([]);
  });

  test("R1: a bare directory operand with no trailing slash credits that directory", () => {
    // `rg foo src` is a path-SCOPED search. The slash heuristic read it as
    // pathless, took the tree-defaulting branch, and credited everything.
    expect(sweptDirectories(call("Bash", { command: "rg principalChannel src" }))).toEqual(["src"]);
  });

  test("R1: a path-scoped rg does NOT credit docs", () => {
    // The consequence that mattered: the over-credit above produced a false
    // `clean` on exactly the gap this guard exists to find.
    expect(sweptDirectories(call("Bash", { command: "rg principalChannel src" }))).not.toContain(
      "docs"
    );
  });

  test("R1: a bare `docs` inside a PATTERN does not credit docs", () => {
    // Resolving operand ROLE fixes this second over-credit for free: only
    // operands after the pattern are paths.
    expect(sweptDirectories(call("Bash", { command: 'rg "docs" src/' }))).not.toContain("docs");
  });

  test("R1: rg with no operand at all IS a whole-tree sweep", () => {
    // The behaviour the slash heuristic was reaching for, now decided by operand
    // count rather than by punctuation.
    expect(sweptDirectories(call("Bash", { command: "rg principalChannel" }))).toContain("docs");
  });

  test("R1: find takes its path FIRST, and is read that way", () => {
    expect(sweptDirectories(call("Bash", { command: "find docs -name '*.md'" }))).toEqual(["docs"]);
  });

  test("a structured search tool's path argument is read", () => {
    const c = call("mcp__minsky__session_grep_search", {
      sessionId: "s",
      query: "principalChannel",
      include_pattern: "docs/**",
    });
    expect(sweptDirectories(c)).toContain("docs");
  });

  // -------------------------------------------------------------------------
  // mt#4320 — a separated flag's VALUE is not an operand
  //
  // The pre-fix filter dropped tokens starting with `-` and kept everything
  // else, so a detached flag value survived into the path list. The error runs
  // in BOTH directions and each has its own case below: a value credited as a
  // directory (false `clean`), and a real path consumed as "the pattern" when
  // `-e`/`-f` had already supplied one (false `matched`).
  // -------------------------------------------------------------------------

  test("mt#4320 AT1: repeated -e values are not paths", () => {
    expect(sweptDirectories(call("Bash", { command: "grep -e foo -e bar src/" }))).toEqual(["src"]);
  });

  test("mt#4320 AT2: a -f value naming a prescribable directory is not credited", () => {
    expect(
      sweptDirectories(call("Bash", { command: "grep -f docs/patterns.txt src/" }))
    ).not.toContain("docs");
  });

  test("mt#4320 AT7: with the pattern supplied by -f, the positional is a PATH, not the pattern", () => {
    // The under-credit direction. Pre-fix this returned ["docs"] — crediting the
    // pattern FILE and losing the directory actually swept. A fix that only
    // skipped flag values would return [] here, which is also wrong; asserting
    // the value rather than `not.toContain("docs")` distinguishes the two.
    expect(sweptDirectories(call("Bash", { command: "grep src/ -f docs/patterns.txt" }))).toEqual([
      "src",
    ]);
  });

  test("mt#4320 AT6: a numeric flag value does not shift the pattern slot", () => {
    // `-A 3` keeps `3` as an operand pre-fix, so the pattern-first rule dropped
    // `3` and credited `docs/` — the actual PATTERN — as a swept directory.
    // -A/-B/-C are the most common value-taking grep flags in this corpus, which
    // makes this the likeliest variant to occur in real usage.
    const swept = sweptDirectories(call("Bash", { command: "grep -A 3 docs/ src/" }));
    expect(swept).toEqual(["src"]);
    expect(swept).not.toContain("docs");
  });

  test("mt#4320 AT3: a find predicate's value is not a path operand", () => {
    expect(sweptDirectories(call("Bash", { command: "find src -path docs -prune" }))).toEqual([
      "src",
    ]);
  });

  test("mt#4320 AT3b: -name's value likewise", () => {
    // Same defect as AT3, second spelling — measured pre-fix as ["src","docs"].
    //
    // Kept as its own case because the two spellings pass through DIFFERENT
    // branches once FIND_VALUE_TAKING_PREDICATES exists: `-name` ends in `e`,
    // which is in VALUE_TAKING_SHORT_OPTS, so an intermediate fix carrying only
    // the grep tables would satisfy this one and still fail AT3. Asserting both
    // is what makes the find-predicate set observable rather than incidental.
    expect(sweptDirectories(call("Bash", { command: "find src -name docs" }))).toEqual(["src"]);
  });

  test("mt#4320: whole-tree defaulting is unchanged by the flag tables", () => {
    // `find . …` sweeps the tree regardless of any predicate value, and
    // `sweepsWholeTree` short-circuits before operands are classified. Asserted
    // separately from AT3 so a fix that over-suppresses is caught rather than
    // read as success.
    expect(sweptDirectories(call("Bash", { command: "find . -path docs -prune" }))).toContain(
      "docs"
    );
  });

  test("mt#4320: joined long-option values still work", () => {
    expect(sweptDirectories(call("Bash", { command: "grep -rn 'x' --include=*.md src/" }))).toEqual(
      ["src"]
    );
  });

  test("mt#4320: a detached long-option value is skipped too", () => {
    expect(
      sweptDirectories(call("Bash", { command: "grep -rn 'x' --include docs/*.md src/" }))
    ).toEqual(["src"]);
  });

  test("mt#4320 SC3: an UNRECOGNIZED find predicate degrades toward not crediting", () => {
    // The criterion is that a spelling the tables miss cannot manufacture
    // coverage. Before the valueless-complement test, this was decided by the
    // predicate's LAST LETTER: `-newpath` (ends in `h`) leaked `docs`, while
    // `-unknownopt` (ends in `t`) happened not to. Both are asserted so the
    // property is structural rather than incidental.
    expect(sweptDirectories(call("Bash", { command: "find src -newpath docs" }))).toEqual(["src"]);
    expect(sweptDirectories(call("Bash", { command: "find src -unknownopt docs" }))).toEqual([
      "src",
    ]);
  });

  test("mt#4320 SC3: a valueless find predicate does NOT eat the token after it", () => {
    // The mirror error the complement test introduces, and its bound. `-prune`
    // takes no value, so a path following it survives.
    expect(sweptDirectories(call("Bash", { command: "find src -prune docs" }))).toEqual([
      "src",
      "docs",
    ]);
  });

  test("mt#4320: find-style grammar is NOT applied to grep, where -rni is a bundled run", () => {
    // `findStyle` must stay off for pattern-first commands: `-rni` matches the
    // same single-dash multi-letter shape as `-name`, and eating the next token
    // would drop the pattern and promote the path into its slot.
    expect(sweptDirectories(call("Bash", { command: "grep -rni foo src/" }))).toEqual(["src"]);
  });

  test("mt#4320 SC3: an unrecognized grep flag does not manufacture coverage", () => {
    expect(sweptDirectories(call("Bash", { command: "grep --newflag docs foo src/" }))).toEqual([
      "src",
    ]);
  });

  // -------------------------------------------------------------------------
  // PR #3161 R2 — a bundled run ending in -e/-f, after an unknown letter
  //
  // `suppliesPattern` bounded its whole scan by a grep-only letter set, so a
  // ripgrep flag the set never knew about (`-S`, `-u`) made it return false. The
  // consequence was not a small mis-credit: the pattern-first rule then dropped
  // the only path operand, leaving none, and a tree-defaulting searcher with no
  // path operand is a WHOLE-TREE sweep. `rg -Se foo src` credited all ten
  // prescribable directories — the false-`clean` direction, and the same shape as
  // the slash heuristic mt#4171 replaced.
  // -------------------------------------------------------------------------

  test("R2: a run ending in -e is pattern-supplying even after an unknown letter", () => {
    expect(sweptDirectories(call("Bash", { command: "rg -Se foo src" }))).toEqual(["src"]);
    expect(sweptDirectories(call("Bash", { command: "rg -uue foo src" }))).toEqual(["src"]);
  });

  test("R2: the attached form still guards against a stray word", () => {
    // `-notaflag` must not read as `-f`. The detached branch does not fire (it
    // ends in `g`), so this falls to the letter-bounded scan — which is now the
    // ONLY thing that set is responsible for.
    expect(suppliesPattern("-notaflag")).toBe(false);
    expect(suppliesPattern("-rnePATTERN")).toBe(true);
    expect(suppliesPattern("-Se")).toBe(true);
  });

  test("R2: a find-style token in a grep command is not treated as a predicate", () => {
    // Pre-fix the FIND_VALUE_TAKING_PREDICATES branch ran with findStyle off and
    // skipped the token after `-path`, emptying the operand list.
    expect(sweptDirectories(call("Bash", { command: "grep -path foo src/" }))).toEqual(["src"]);
  });
});

// ---------------------------------------------------------------------------
// The PR window
// ---------------------------------------------------------------------------

describe("callsSinceLastPr", () => {
  test("is the whole list when no PR was created yet", () => {
    expect(callsSinceLastPr([CONTRACT_EDIT]).length).toBe(1);
  });

  test("excludes edits belonging to a previous PR in the same conversation", () => {
    // The measured false positive: session `c1b904ea` created SEVEN PRs, and a
    // contract edit from an earlier task flagged mt#4232's PR.
    expect(editedPaths([CONTRACT_EDIT, PR_CREATE])).toEqual([]);
  });

  test("R1: a session_move_file of a contract counts as an edit", () => {
    const move = call("mcp__minsky__session_move_file", {
      sessionId: "s",
      sourcePath: HEALTH_CONTRACT,
      targetPath: "contract/renamed-health-shape.json",
    });
    expect(editedPaths([move])).toContain(HEALTH_CONTRACT);
  });

  test("R1: a session_rename_file of a contract counts as an edit", () => {
    const rename = call("mcp__minsky__session_rename_file", {
      sessionId: "s",
      path: HEALTH_CONTRACT,
      newName: "cockpit-health-shape-v2.json",
    });
    expect(editedPaths([rename])).toContain(HEALTH_CONTRACT);
  });

  test("includes edits made after the previous PR", () => {
    expect(editedPaths([PR_CREATE, CONTRACT_EDIT])).toEqual([HEALTH_CONTRACT]);
  });
});

// ---------------------------------------------------------------------------
// The trigger
// ---------------------------------------------------------------------------

describe("isSerializedSurfacePath", () => {
  test("a golden contract fixture is a serialized surface", () => {
    expect(isSerializedSurfacePath(HEALTH_CONTRACT)).toBe(true);
  });

  test("an absolute session path to the same fixture is too", () => {
    expect(
      isSerializedSurfacePath(
        "/Users/edobry/.local/state/minsky/sessions/47b26406/contract/cockpit-health-shape.json"
      )
    ).toBe(true);
  });

  test("a generated manifest is", () => {
    expect(isSerializedSurfacePath("src/generated/interceptor-catalog.json")).toBe(true);
  });

  test("the contract directory's README is NOT — it is prose about the contract", () => {
    expect(isSerializedSurfacePath("contract/README.md")).toBe(false);
  });

  test("a route handler is NOT — the path cannot tell a shape change from a behavior change", () => {
    // mt#3398 in the measured set was a 500→503 status fix on a route handler,
    // which prescribes no docs sweep at all.
    expect(isSerializedSurfacePath("src/cockpit/routes/entity-threads.ts")).toBe(false);
  });

  test("an ordinary source file is NOT", () => {
    expect(isSerializedSurfacePath("src/cockpit/principal-channel-poller.ts")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

describe("run", () => {
  test("AT1/AT2 — a contract edit whose sweep never reached docs is MATCHED", () => {
    // This is the mt#4252 shape, reproduced from that session's own calls: the
    // contract fixture edited, and the only docs-adjacent call a single-file sed
    // sharing a command with an unrelated grep.
    const out = outcomeOf([MULTI_SEGMENT_GREP_AND_SED, CONTRACT_EDIT]);
    expect(out["outcome"]).toBe("matched");
    expect(out["missingDirectories"]).toEqual(["docs"]);
  });

  test("AT1 — the SAME edit with a real docs sweep is clean", () => {
    const out = outcomeOf([REAL_DOCS_SWEEP, CONTRACT_EDIT]);
    expect(out["outcome"]).toBe("clean");
  });

  test("a docs EDIT discharges it too — reaching the consumer beats sweeping for it", () => {
    const docsEdit = call(WRITE_TOOL, {
      sessionId: "s",
      path: "docs/principal-channel.md",
      content: "x",
    });
    expect(outcomeOf([CONTRACT_EDIT, docsEdit])["outcome"]).toBe("clean");
  });

  test("AT3 — a declined change type produces NO finding, and says so distinctly", () => {
    const ordinaryEdit = call(WRITE_TOOL, {
      sessionId: "s",
      path: ORDINARY_SOURCE,
      content: "x",
    });
    const out = outcomeOf([ordinaryEdit]);
    // `declined` must not be spelled `clean`: conflating them would report "we
    // checked and found nothing" for a case never checked at all.
    expect(out["outcome"]).toBe("declined");
    expect(out["outcome"]).not.toBe("clean");
  });

  test("no transcript is skipped, never clean", () => {
    const cal = (run(hookInput(), dispatchContext([]))?.calibration ?? {}) as Record<
      string,
      unknown
    >;
    expect(cal["outcome"]).toBe("skipped");
  });

  test("the override short-circuits to an audit line and never a finding", () => {
    process.env[OVERRIDE_ENV_VAR] = "1";
    try {
      const result = run(hookInput(), dispatchContext([CONTRACT_EDIT]));
      expect(result?.auditLines?.[0]).toContain("OVERRIDE");
      expect(result?.calibration).toBeUndefined();
    } finally {
      delete process.env[OVERRIDE_ENV_VAR];
    }
  });

  test("this guard never denies", () => {
    const out = run(hookInput(), dispatchContext([MULTI_SEGMENT_GREP_AND_SED, CONTRACT_EDIT]));
    expect(out?.deny).toBeUndefined();
  });
});

describe("sessionSweptDirectories", () => {
  test("unions across calls", () => {
    const s = sessionSweptDirectories([MULTI_SEGMENT_GREP_AND_SED, REAL_DOCS_SWEEP]);
    expect(s.has("src")).toBe(true);
    expect(s.has("docs")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Row 2 — message constant (mt#4399)
// ---------------------------------------------------------------------------
//
// AT4 again: both fixtures below are the VERBATIM structured tool-call state
// from the mt#4379 session (`72513016-…`) — the session whose docs-only sweep
// this row exists to catch. Extracted from the transcript rather than retyped,
// because the finding here turned on a detail a paraphrase would have smoothed
// away: see the comment-line test immediately below.

const MESSAGE_EDIT = call("mcp__minsky__session_search_replace", {
  sessionId: "s",
  path: "packages/domain/src/tasks/multi-backend-service.ts",
  search:
    '    if (unavailability.configured) {\n      return (\n        `the \'${unavailability.backend ?? "postgres"}\' persistence backend is configured but ` +\n        `failed to initialize at boot (${unavailability.reason}), so no task backend is ` +\n        "registered. The database is unreachable — this is NOT an empty database, and an empty " +\n        "result here would be indistinguishable from a real one. Check the boot logs and " +\n        "restart once the database is reachable; `minsky persistence check` reports the same " +\n        "failure."\n      );\n    }',
  replace:
    '    if (unavailability.configured) {\n      // The retry clause is what keeps this HONEST (mt#4379). The previous\n      // wording asserted "The database is unreachable" and "`minsky persistence\n      // check` reports the same failure" in the PRESENT tense — both describe\n      // the moment of boot, and both were false by the time anyone read them.\n      // In the originating incident persistence had long since recovered and\n      // `persistence check` returned "All checks passed" seconds before this\n      // error rendered, so two separate agents spent their first diagnostic\n      // minutes on a healthy database. A boot-time observation must carry its\n      // timestamp, not masquerade as current state.\n      const retryClause = this.lastRetryAt\n        ? `Last re-registration attempt ${this.lastRetryAt.toISOString()} also failed` +\n          `${this.lastRetryError ? ` (${this.lastRetryError})` : ""}.`\n        : "This registration has NOT been re-attempted since boot, so the underlying " +\n          "dependency may well have recovered in the meantime.";\n      return (\n        `the \'${unavailability.backend ?? "postgres"}\' persistence backend was configured but ` +\n        `failed to initialize AT BOOT (${unavailability.reason}), so no task backend was ` +\n        `registered. ${retryClause} This is a backend-REGISTRATION failure, which is not the ` +\n        "same as an empty database and not necessarily a current outage — an empty result here " +\n        "would be indistinguishable from a real one, which is why this fails instead. Note " +\n        "`minsky persistence check` may well PASS while this fails: it probes the live " +\n        "connection, whereas this reports what happened when the backend was registered."\n      );\n    }',
});

/**
 * The sweep PR #3219 actually ran. Docs-only by construction: it names `docs/`,
 * `.minsky/` and one README file, and reaches no code directory at all.
 */
const DOCS_ONLY_SWEEP = call("mcp__minsky__session_exec", {
  sessionId: "s",
  command:
    'echo "=== every doc/prose reference to the old message wording ==="\ngrep -rn \'database is unreachable\\|reports the same failure\\|failed to initialize at boot\\|NOT an empty database\' docs/ .minsky/ README.md 2>/dev/null\necho "=== end ==="',
});

/** `run` with the filesystem steps stubbed, so an outcome is a function of the transcript. */
function outcomeWith(
  calls: ToolCallWithResult[],
  stale: (literal: string) => string[],
  isRepo = true
): Record<string, unknown> {
  const result = run(hookInput(), dispatchContext(calls), {
    staleOccurrences: (literal: string) => stale(literal),
    searchableRepo: (() => isRepo) as never,
  });
  return (result?.calibration ?? {}) as Record<string, unknown>;
}

describe("replacedLiterals (mt#4399)", () => {
  test("flags the removed message chunks even though the replacement quotes the old wording in a COMMENT", () => {
    // mt#4379 replaced the message and explained itself in a comment that quotes
    // the retired wording, so the raw replacement text still contains it:
    expect(MESSAGE_EDIT.input["replace"]).toContain(RETIRED_PHRASE);

    // The chunks themselves are still correctly seen as removed. Recorded
    // precisely because an earlier version of THIS test claimed to be the
    // negative control for `stripCommentLines` and was not: it asserted
    // `.some(l => l.includes(...))`, which the long chunk satisfies whether or
    // not comments are stripped, so it passed with the rule disabled. The rule
    // earns its place on the SEARCH side (a phrase quoted in a comment is prose
    // about the code, not a rendered message); the honest control for the
    // row's real behaviour is the against-the-tree probe recorded in the PR.
    const literals = replacedLiterals([MESSAGE_EDIT]).map((r) => r.literal);
    expect(literals.some((l) => l.includes(RETIRED_PHRASE))).toBe(true);
    expect(literals.some((l) => l.includes("reports the same"))).toBe(true);
  });

  test("every flagged literal carries the file it was removed from", () => {
    for (const r of replacedLiterals([MESSAGE_EDIT])) {
      expect(r.path).toBe(EDITED_RENDERER);
    }
  });

  test("an edit that only reflows a message flags nothing", () => {
    const reflow = call(SEARCH_REPLACE_TOOL, {
      sessionId: "s",
      path: "packages/domain/src/x.ts",
      search: 'const m = "the database was configured but failed at boot";',
      replace: 'const m =\n  "the database was configured but failed at boot";',
    });
    expect(replacedLiterals([reflow])).toEqual([]);
  });

  test("short strings are not messages — identifiers and keys are ignored", () => {
    const tweak = call(SEARCH_REPLACE_TOOL, {
      sessionId: "s",
      path: "packages/domain/src/x.ts",
      search: 'backend: "postgres",',
      replace: 'backend: "sqlite",',
    });
    expect(replacedLiterals([tweak])).toEqual([]);
  });
});

describe("stripCommentLines (mt#4399)", () => {
  test("drops whole-line comments and keeps code", () => {
    const stripped = stripCommentLines(
      ['// wording asserted "gone"', 'const a = "kept";'].join("\n")
    );
    expect(stripped).not.toContain("gone");
    expect(stripped).toContain("kept");
  });

  test("keeps a mid-line // so a URL inside a string survives", () => {
    // Stripping from a mid-line `//` would corrupt any string carrying a URL,
    // and the case this rule is for is a comment on its own line.
    expect(stripCommentLines('const u = "https://example.com/x";')).toContain(
      "https://example.com/x"
    );
  });
});

describe("run — the message-constant row (mt#4399)", () => {
  test("SC2 — the PR #3219 shape FIRES: docs-only sweep, message still rendered under packages/", () => {
    const out = outcomeWith([MESSAGE_EDIT, DOCS_ONLY_SWEEP], () => [
      SIBLING_PROVIDER,
      SIBLING_COCKPIT,
    ]);
    expect(out["outcome"]).toBe("matched");
    expect(out["row"]).toBe("message-constant");
    expect(out[MISSING_DIRS]).toEqual(expect.arrayContaining(["packages", "src"]));
  });

  test("the same edit with a sweep that DID reach the renderers is clean", () => {
    const codeSweep = call(EXEC_TOOL, {
      sessionId: "s",
      command: 'grep -rn "database is unreachable" packages/ src/',
    });
    const out = outcomeWith([MESSAGE_EDIT, codeSweep], () => [SIBLING_PROVIDER, SIBLING_COCKPIT]);
    expect(out["outcome"]).toBe("clean");
  });

  test("no surviving occurrence anywhere is clean, not matched", () => {
    const out = outcomeWith([MESSAGE_EDIT, DOCS_ONLY_SWEEP], () => []);
    expect(out["outcome"]).toBe("clean");
  });

  test("a cwd that is not a work tree is SKIPPED, never clean", () => {
    // A broken probe must not render as a pass — the same rule the
    // no-transcript path follows. This is the shape mem#704 names.
    const out = outcomeWith([MESSAGE_EDIT, DOCS_ONLY_SWEEP], () => [], false);
    expect(out["outcome"]).toBe("skipped");
    expect(out["outcome"]).not.toBe("clean");
  });

  test("a session that replaced no message literal still DECLINES", () => {
    const ordinaryEdit = call(WRITE_TOOL, {
      sessionId: "s",
      path: ORDINARY_SOURCE,
      content: "x",
    });
    const out = outcomeWith([ordinaryEdit], () => ["src/anything.ts"]);
    expect(out["outcome"]).toBe("declined");
  });

  test("row 1 still wins when a serialized contract was edited", () => {
    // Ordering is not arbitrary: a contract edit is decided by the row built for
    // it, whose prescribed set comes from gate (h)'s table rather than a search.
    const out = outcomeWith([MESSAGE_EDIT, CONTRACT_EDIT, MULTI_SEGMENT_GREP_AND_SED], () => [
      SIBLING_PROVIDER,
    ]);
    expect(out["outcome"]).toBe("matched");
    expect(out["row"]).toBeUndefined();
    expect(out[MISSING_DIRS]).toEqual(["docs"]);
  });
});

describe("staleOccurrences (mt#4399)", () => {
  function fakeGrep(stdout: string, exitCode = 0) {
    return (() => ({ exitCode, stdout: new TextEncoder().encode(stdout) })) as never;
  }

  test("drops a line that ASSERTS the literal is gone", () => {
    // Observed on the real tree: after mt#4379/mt#4383 retired the wording,
    // every surviving test-file occurrence was the regression test forbidding
    // it. Firing there fires at the author who retired it most carefully.
    const out = staleOccurrences(
      RETIRED_PHRASE,
      "/repo",
      [],
      fakeGrep(
        "packages/domain/src/persistence/describe-unavailability.test.ts:31:" +
          `    expect(described).not.toContain("${RETIRED_PHRASE}");\n` +
          "packages/domain/src/persistence/unconfigured-provider.ts:203:" +
          '      "The database is unreachable — this is a degraded provider, not a missing "\n'
      )
    );
    expect(out).toEqual([SIBLING_PROVIDER]);
  });

  test("excludes files the session itself edited", () => {
    const out = staleOccurrences(
      RETIRED_PHRASE,
      "/repo",
      [EDITED_RENDERER],
      fakeGrep(`${EDITED_RENDERER}:88:  "${RETIRED_PHRASE}"\n`)
    );
    expect(out).toEqual([]);
  });

  test("a search that did not RUN yields no hits rather than a false clean", () => {
    // exit 1 is git grep's honest "no match"; anything else is the probe failing.
    expect(staleOccurrences("x".repeat(30), "/repo", [], fakeGrep("", 1))).toEqual([]);
    expect(staleOccurrences("x".repeat(30), "/repo", [], fakeGrep("", 128))).toEqual([]);
  });

  test("content containing colons is not truncated when the line is parsed", () => {
    const out = staleOccurrences(
      "Note: the database is unreachable",
      "/repo",
      [],
      fakeGrep('src/a.ts:12:  const m = "Note: the database is unreachable";\n')
    );
    expect(out).toEqual(["src/a.ts"]);
  });
});

describe("messagePhrases (mt#4399)", () => {
  test("yields the clause that actually relates the three renderers", () => {
    // NOT a guess. Run against the real tree at `fbc352c97^` — the revision as
    // it stood when mt#4379 swept — `git grep -F RETIRED_PHRASE`
    // returns `packages/domain/src/persistence/unconfigured-provider.ts` and
    // `src/cockpit/db-providers.ts`, the two renderers PR #3220 had to fix.
    //
    // This is pinned because two earlier search units did NOT produce it and
    // each failed against that same tree: whole quoted chunks returned zero hits
    // for all five literals (the renderers break their chunks at different
    // points), and a 6-word window stepping by 3 produced "backend is
    // registered. The database is" — which found one renderer and missed the
    // other. A regression to either would be invisible without this.
    const literals = replacedLiterals([MESSAGE_EDIT]).map((r) => r.literal);
    expect(messagePhrases(literals)).toContain(RETIRED_PHRASE);
  });

  test("rejoins chunks, so a clause split across two string literals survives", () => {
    // The whole reason literals are joined before splitting: `+` concatenation
    // is what the chunks are FOR, and a sibling renderer wraps at a different
    // column.
    expect(messagePhrases(["restart once the database is ", "reachable now"])).toContain(
      "restart once the database is reachable now"
    );
  });

  test("drops a clause carrying an interpolation — it can never match as a fixed string", () => {
    const phrases = messagePhrases(["the ${backend} persistence backend is configured but"]);
    expect(phrases).toEqual([]);
  });

  test("drops fragments below the length floor", () => {
    expect(messagePhrases(["too short. also brief."])).toEqual([]);
  });

  test("splits on an em-dash clause boundary, not only on sentence punctuation", () => {
    const phrases = messagePhrases([
      "The database is unreachable — this is a degraded provider, not a missing configuration",
    ]);
    expect(phrases).toContain(RETIRED_PHRASE);
  });
});
