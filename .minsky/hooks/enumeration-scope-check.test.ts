import { describe, expect, test } from "bun:test";
import {
  run,
  editedPaths,
  callsSinceLastPr,
  isSerializedSurfacePath,
  OVERRIDE_ENV_VAR,
} from "./enumeration-scope-check";
import { sweptDirectories, sessionSweptDirectories } from "./evidence-provenance-table";
import type { ToolCallWithResult, TranscriptLine } from "./transcript";
import type { DispatchContext, GuardOutcome } from "./registry";
import type { ToolHookInput } from "./types";
import { deriveBudgets } from "./types";

/** Tool names used across fixtures — named so they cannot drift between cases. */
const PR_CREATE_TOOL = "mcp__minsky__session_pr_create";
const WRITE_TOOL = "mcp__minsky__session_write_file";
const HEALTH_CONTRACT = "contract/cockpit-health-shape.json";

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
    // A fixed path, not `process.cwd()`: this guard never reads the filesystem,
    // so the field is inert here and a real cwd would make the test
    // environment-dependent for nothing.
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
      path: "src/cockpit/principal-channel-poller.ts",
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
