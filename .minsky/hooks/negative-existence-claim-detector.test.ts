/* eslint-disable custom/no-real-fs-in-tests -- AT4 asserts the evaluation stream is
   actually WRITTEN, and AT5 asserts the rule and env-var registration exist in the
   repo; both are claims about real files, so mocking the filesystem would assert the
   mock. AT4 writes only into a per-test mkdtemp that afterEach removes. */
/**
 * Tests for the negative-existence-claim detector adapter (mt#3918).
 *
 * Carries the spec's AT1-AT5. The pure conjunct logic is covered separately in
 * `packages/domain/src/detectors/negative-existence-claim.test.ts`; these
 * exercise the wiring the adapter owns — artifact-prose extraction, the
 * search/result join, the injected DONE lookup, and the evaluation stream.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INJECTION_ENABLED,
  OVERRIDE_ENV_VAR,
  buildInjectionReminder,
  classifySearchScope,
  collectSearchObservations,
  evaluateTurn,
  renderWorstCase,
  run,
} from "./negative-existence-claim-detector";
import { evaluationLogPath, calibrationLogPath } from "./dispatcher";
import type { TranscriptLine } from "./transcript";
import type { ClaudeHookInput } from "./types";
import type { DispatchContext } from "./registry";

const DONE_TASK = "mt#2677";
/** mt#4748: the calibration/evaluation stream name this detector writes under. */
const STREAM_NAME = "negative-existence-claim";

/**
 * Instance 3's actual claim (mem#924, mt#3916): a grep for ONE spelling of a
 * shipped capability returned a single hit, and the agent wrote absence into a
 * durable artifact. `mt#2677` had shipped the mechanism complete.
 */
const INSTANCE_3_CLAIM =
  "Checked the MCP progress mechanism: zero production call sites, so no long-running tool has " +
  "ever emitted progress. mt#2677 claims to have shipped it but the plumbing is only half there.";

let tempDirs: string[] = [];

/** The resolved-project-dir env var the shared path helpers read (mt#4752). */
const PROJECT_DIR_ENV = "CLAUDE_PROJECT_DIR";
let priorProjectDir: string | undefined;

function makeTempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "mt3918-"));
  mkdirSync(join(dir, ".minsky"), { recursive: true });
  tempDirs.push(dir);
  // mt#4752: the cwd handed to the detector is its RAW input cwd, which the
  // shared resolver deliberately ranks BELOW `CLAUDE_PROJECT_DIR` — a raw cwd
  // is routinely a session workspace or a subdirectory, so letting it outrank
  // the resolved project dir is the bug mt#3745 removed. These tests want the
  // temp dir to be authoritative, so they say so rather than relying on the
  // ambient env being unset. Without this they assert against a log written
  // into the REAL repo.
  if (priorProjectDir === undefined) priorProjectDir = process.env[PROJECT_DIR_ENV];
  process.env[PROJECT_DIR_ENV] = dir;
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    // mt#4748: the evaluation/calibration logs now resolve under the shared
    // state dir, project-keyed by `dir` — outside `dir` itself, so the
    // `rmSync(dir, ...)` below no longer cleans them up.
    rmSync(evaluationLogPath(STREAM_NAME, { projectDir: dir }), { force: true });
    rmSync(calibrationLogPath(STREAM_NAME, { projectDir: dir }), { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
  if (priorProjectDir === undefined) delete process.env[PROJECT_DIR_ENV];
  else process.env[PROJECT_DIR_ENV] = priorProjectDir;
  priorProjectDir = undefined;
  delete process.env[OVERRIDE_ENV_VAR];
});

/** An assistant turn: a search call, its result, then a durable-artifact write. */
function makeTurn(options: {
  claim: string;
  searchTool?: string;
  searchCommand?: string;
  searchResult: string;
  artifactTool?: string;
  artifactKey?: string;
}): TranscriptLine[] {
  const {
    claim,
    searchTool = "Grep",
    searchCommand,
    searchResult,
    artifactTool = "mcp__minsky__tasks_create",
    artifactKey = "spec",
  } = options;

  return [
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_search",
            name: searchTool,
            input: searchCommand ? { command: searchCommand } : { pattern: "progress\\?\\." },
          },
        ],
      },
    } as unknown as TranscriptLine,
    {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_search", content: searchResult }],
      },
    } as unknown as TranscriptLine,
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_artifact",
            name: artifactTool,
            input: { [artifactKey]: claim },
          },
        ],
      },
    } as unknown as TranscriptLine,
  ];
}

/**
 * Wrap a turn in the real user prompts that BOUND it.
 *
 * `run()` re-derives the completed turn from the transcript rather than taking
 * one, so a fixture handed straight to it has no boundaries to slice on and
 * yields nothing. `evaluateTurn` takes the turn directly and needs no wrapper —
 * the difference is why the AT1-AT3 fixtures and the AT4 ones differ in shape.
 */
function asCompletedTurn(turn: TranscriptLine[]): TranscriptLine[] {
  return [
    { type: "user", message: { role: "user", content: "first turn" } } as unknown as TranscriptLine,
    ...turn,
    {
      type: "user",
      message: { role: "user", content: "second turn" },
    } as unknown as TranscriptLine,
  ];
}

function makeCtx(transcriptLines: TranscriptLine[]): DispatchContext {
  return {
    event: "UserPromptSubmit",
    hostCapSec: 15,
    budgets: { overallBudgetMs: 9000, fetchTimeoutMs: 4950, gitTimeoutMs: 1530 },
    transcriptCandidates: ["/mock/transcript.jsonl"],
    transcriptLines,
  } as DispatchContext;
}

function makeInput(cwd: string): ClaudeHookInput {
  return {
    session_id: "sess-mt3918",
    transcript_path: "/mock/transcript.jsonl",
    cwd,
    hook_event_name: "UserPromptSubmit",
  } as ClaudeHookInput;
}

const doneLookup = (ids: readonly string[]) =>
  Promise.resolve(new Set(ids.filter((id) => id === DONE_TASK)) as ReadonlySet<string>);
const noneDone = () => Promise.resolve(new Set() as ReadonlySet<string>);
const brokenLookup = () => Promise.resolve(null);

describe("AT1 — replay instance 3 (mt#3916 / mem#924)", () => {
  it("fires and names the DONE task whose diff to read", async () => {
    const turn = makeTurn({
      claim: INSTANCE_3_CLAIM,
      searchResult: "src/mcp/server.ts:214:  // progress?.() is the idiom",
    });

    const evaluated = await evaluateTurn(turn, doneLookup);
    if (evaluated === null) throw new Error("expected the turn to be evaluated");
    expect(evaluated.result.matched).toBe(true);
    expect(evaluated.result.doneTaskIds).toEqual([DONE_TASK]);

    const advisory = buildInjectionReminder(evaluated.result);
    expect(advisory).toContain(DONE_TASK);
    expect(advisory).toContain("CONSTRUCTS or INJECTS");
  });

  it("still fires when the claim is written into a PR body rather than a spec", async () => {
    const turn = makeTurn({
      claim: INSTANCE_3_CLAIM,
      searchResult: "one hit",
      artifactTool: "mcp__minsky__session_pr_create",
      artifactKey: "body",
    });
    const evaluated = await evaluateTurn(turn, doneLookup);
    expect(evaluated?.result.matched).toBe(true);
  });
});

describe("AT2 — many-hit counter-example", () => {
  it("does not fire when the supporting search returned many hits", async () => {
    const manyHits = Array.from({ length: 25 }, (_, i) => `src/file${i}.ts:1: onProgress`).join(
      "\n"
    );
    const turn = makeTurn({ claim: INSTANCE_3_CLAIM, searchResult: manyHits });

    const evaluated = await evaluateTurn(turn, doneLookup);
    expect(evaluated?.result.matched).toBe(false);
    expect(evaluated?.evaluation["thinSearchPresent"]).toBe(false);
    expect(evaluated?.evaluation["claimPresent"]).toBe(true);
  });
});

describe("AT3 — no-DONE-task counter-example", () => {
  it("does not fire when the cited task is not DONE", async () => {
    const turn = makeTurn({ claim: INSTANCE_3_CLAIM, searchResult: "one hit" });
    const evaluated = await evaluateTurn(turn, noneDone);
    expect(evaluated?.result.matched).toBe(false);
    expect(evaluated?.evaluation["doneLookupRan"]).toBe(true);
    expect(evaluated?.evaluation["doneTaskCount"]).toBe(0);
  });

  it("does not fire when no task is cited at all, and skips the lookup entirely", async () => {
    let called = false;
    const spy = (ids: readonly string[]) => {
      called = true;
      return doneLookup(ids);
    };
    const turn = makeTurn({
      claim: "The progress mechanism has no callers in production.",
      searchResult: "one hit",
    });

    const evaluated = await evaluateTurn(turn, spy);
    expect(evaluated?.result.matched).toBe(false);
    expect(called).toBe(false);
    expect(evaluated?.evaluation["doneLookupRan"]).toBe(false);
  });

  it("FIRES when the lookup is unavailable, and says so in the record", async () => {
    const turn = makeTurn({ claim: INSTANCE_3_CLAIM, searchResult: "one hit" });
    const evaluated = await evaluateTurn(turn, brokenLookup);
    expect(evaluated?.result.matched).toBe(true);
    expect(evaluated?.evaluation["doneLookupUnavailable"]).toBe(true);
  });
});

describe("AT4 — evaluation stream records fired AND non-fired cases", () => {
  it("writes a record for both, with the distinguishing fields", async () => {
    const cwd = makeTempCwd();

    const firing = makeTurn({ claim: INSTANCE_3_CLAIM, searchResult: "one hit" });
    const outcome = await run(makeInput(cwd), makeCtx(asCompletedTurn(firing)), {
      lookupDoneTaskIds: doneLookup,
    });
    expect(outcome?.calibration).toBeDefined();

    const manyHits = Array.from({ length: 25 }, (_, i) => `src/f${i}.ts:1: x`).join("\n");
    const quiet = makeTurn({ claim: INSTANCE_3_CLAIM, searchResult: manyHits });
    const quietOutcome = await run(makeInput(cwd), makeCtx(asCompletedTurn(quiet)), {
      lookupDoneTaskIds: doneLookup,
    });
    expect(quietOutcome).toBeNull();

    // mt#4748: resolves under the state dir, project-keyed by `cwd`, not
    // under `cwd` itself — compute through the same helper the detector
    // routes through.
    const logPath = evaluationLogPath(STREAM_NAME, { projectDir: cwd });
    expect(existsSync(logPath)).toBe(true);
    const records = readFileSync(logPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(records).toHaveLength(2);
    expect(records[0]?.["fired"]).toBe(true);
    expect(records[1]?.["fired"]).toBe(false);
    // The miss RATE is what a fire-only log cannot give: the non-fired record
    // must carry WHICH conjunct failed, not merely that nothing happened.
    expect(records[1]?.["claimPresent"]).toBe(true);
    expect(records[1]?.["thinSearchPresent"]).toBe(false);
  });

  it("does NOT write the calibration log on the dispatcher path", async () => {
    // The dispatcher owns that write (`calibrationLog` on the registration).
    // Writing it here too would double-count every fire, making the rate
    // un-measurable. Pinned rather than left to a comment (PR #2905 R1).
    const cwd = makeTempCwd();
    const firing = makeTurn({ claim: INSTANCE_3_CLAIM, searchResult: "one hit" });
    const outcome = await run(makeInput(cwd), makeCtx(asCompletedTurn(firing)), {
      lookupDoneTaskIds: doneLookup,
    });

    expect(outcome?.calibration).toBeDefined();
    expect(existsSync(calibrationLogPath(STREAM_NAME, { projectDir: cwd }))).toBe(false);
    expect(existsSync(evaluationLogPath(STREAM_NAME, { projectDir: cwd }))).toBe(true);
  });

  it("evaluates nothing when the turn wrote no durable artifact", async () => {
    const cwd = makeTempCwd();
    const noArtifact: TranscriptLine[] = [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "It has no callers, per mt#2677." }],
        },
      } as unknown as TranscriptLine,
    ];

    const outcome = await run(makeInput(cwd), makeCtx(asCompletedTurn(noArtifact)), {
      lookupDoneTaskIds: doneLookup,
    });
    expect(outcome).toBeNull();
    // The population this detector measures is artifact-writing turns; a chat-only
    // turn is not a miss, so it must not enter the denominator.
    expect(existsSync(evaluationLogPath(STREAM_NAME, { projectDir: cwd }))).toBe(false);
  });
});

describe("AT5 — documentation and override registration", () => {
  it("is documented in the hook-observers source rule", () => {
    const rule = readFileSync(".minsky/rules/hook-observers.mdc", "utf-8");
    expect(rule).toContain(STREAM_NAME);
    expect(rule).toContain(OVERRIDE_ENV_VAR);
  });

  it("registers its override var in HOOK_ONLY_ENV_VARS", () => {
    const environment = readFileSync(
      "packages/domain/src/configuration/sources/environment.ts",
      "utf-8"
    );
    expect(environment).toContain(OVERRIDE_ENV_VAR);
  });
});

describe("adapter wiring", () => {
  it("ships calibration-first — no injection until the posture flips", () => {
    expect(INJECTION_ENABLED).toBe(false);
  });

  it("honors the override without evaluating", async () => {
    process.env[OVERRIDE_ENV_VAR] = "1";
    const cwd = makeTempCwd();
    const turn = makeTurn({ claim: INSTANCE_3_CLAIM, searchResult: "one hit" });
    const outcome = await run(makeInput(cwd), makeCtx(asCompletedTurn(turn)), {
      lookupDoneTaskIds: doneLookup,
    });
    expect(outcome?.auditLines?.[0]).toContain("OVERRIDE");
    expect(existsSync(evaluationLogPath(STREAM_NAME, { projectDir: cwd }))).toBe(false);
  });

  it("counts a shell search by its leading token and reads its result", () => {
    const turn = makeTurn({
      claim: INSTANCE_3_CLAIM,
      searchTool: "Bash",
      searchCommand: "grep -rn 'onProgress' src",
      searchResult: "src/a.ts:1: onProgress",
    });
    const observations = collectSearchObservations(turn);
    expect(observations).toHaveLength(1);
    expect(observations[0]?.hitCount).toBe(1);
  });

  it("treats a search still in flight as an unknown count, not zero", () => {
    const inFlight: TranscriptLine[] = [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_x", name: "Grep", input: { pattern: "x" } }],
        },
      } as unknown as TranscriptLine,
    ];
    expect(collectSearchObservations(inFlight)[0]?.hitCount).toBeNull();
  });

  it("does not read a claim the agent QUOTED in a fenced block as one it asserted", async () => {
    const quoted = [
      "Reviewing the prior spec, which said:",
      "",
      "```",
      "zero production call sites — mt#2677 never shipped it",
      "```",
      "",
      "That turned out to be wrong.",
    ].join("\n");
    const turn = makeTurn({ claim: quoted, searchResult: "one hit" });
    const evaluated = await evaluateTurn(turn, doneLookup);
    expect(evaluated?.result.matched).toBe(false);
  });

  it("renders a worst case within the declared attention cost", () => {
    const rendered = renderWorstCase();
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered).toContain("[negative-existence-claim-detector]");
  });
});

/**
 * Scope classification — the three buckets of mt#4362 SC3.
 *
 * The bucket split exists because `command-shape`'s grammar parses a COMMAND,
 * and four of the seven covered tools never produce one. A shell-only
 * implementation passes the R11 fixture and silently classifies nothing for
 * `Grep(path:)`, which is the commonest subtree-scoped shape in this repo.
 */
describe("classifySearchScope (mt#4362)", () => {
  describe("shell bucket — parsed by the shared grammar", () => {
    it("AT1 — a single subtree operand is subtree scope", () => {
      const got = classifySearchScope("Bash", {}, 'grep -rn "truncateToCodePoints" .minsky/hooks/');
      expect(got.scope).toBe("subtree");
      expect(got.scopePath).toBe(".minsky/hooks/");
    });

    it("AT7 — MULTIPLE subtree operands are still subtree scope", () => {
      // mem#1124's real search. `src/` and `packages/` reach neither `.minsky/`
      // nor `scripts/` nor `docs/`, so two operands do not make it repo-wide.
      const got = classifySearchScope("Bash", {}, "grep -rn ServiceWindowReaper src/ packages/");
      expect(got.scope).toBe("subtree");
    });

    it("SC4 — no path operand defaults to cwd, classified as repo scope", () => {
      expect(classifySearchScope("Bash", {}, "grep -rn truncateToCodePoints").scope).toBe("repo");
    });

    it("an explicit root operand is repo scope", () => {
      expect(classifySearchScope("Bash", {}, "grep -rn foo .").scope).toBe("repo");
    });

    it("a root operand among subtrees makes the whole search repo scope", () => {
      expect(classifySearchScope("Bash", {}, "grep -rn foo src/ .").scope).toBe("repo");
    });

    it("consumes the shared grammar's flag handling rather than a naive filter", () => {
      // `-e` supplies the pattern, so EVERY positional is a path — the exact
      // case mt#4328 consolidated. A parser that assumed "first positional is
      // the pattern" would drop `src/` and misreport this as repo scope.
      const got = classifySearchScope("Bash", {}, "grep -rn -e somePattern src/");
      expect(got.scope).toBe("subtree");
      expect(got.scopePath).toBe("src/");
    });
  });

  describe("structured-path bucket — no command string exists", () => {
    it("AT6 — Grep with a path input is subtree scope", () => {
      const got = classifySearchScope("Grep", { path: ".minsky/hooks" }, undefined);
      expect(got.scope).toBe("subtree");
      expect(got.scopePath).toBe(".minsky/hooks");
    });

    it("Grep with NO path input is repo scope", () => {
      expect(classifySearchScope("Grep", {}, undefined).scope).toBe("repo");
    });

    it("covers the MCP searchers that take a path", () => {
      expect(
        classifySearchScope("mcp__minsky__repo_search", { path: "src/" }, undefined).scope
      ).toBe("subtree");
      expect(
        classifySearchScope("mcp__minsky__git_search", { path: "docs/" }, undefined).scope
      ).toBe("subtree");
    });
  });

  describe("unscopable bucket — classified explicitly, never as repo-wide", () => {
    it("a corpus search has no path dimension", () => {
      expect(classifySearchScope("mcp__minsky__tasks_search", {}, undefined).scope).toBe(
        "unscopable"
      );
      expect(classifySearchScope("mcp__minsky__transcripts_search-text", {}, undefined).scope).toBe(
        "unscopable"
      );
    });

    it("session_grep_search narrows by glob FILTER, not path prefix", () => {
      const got = classifySearchScope(
        "mcp__minsky__session_grep_search",
        { include_pattern: "*.ts" },
        undefined
      );
      expect(got.scope).toBe("unscopable");
    });

    it("an unrecognized search tool fails quiet rather than reading as repo-wide", () => {
      expect(classifySearchScope("SomeFutureSearchTool", { path: "src/" }, undefined).scope).toBe(
        "unscopable"
      );
    });
  });

  describe("SC7 — the rendered scope path is bounded", () => {
    const withScopePath = (scopePath: string) =>
      buildInjectionReminder({
        matched: true,
        claims: [{ phrase: "has no callers", excerpt: "the helper has no callers" }],
        citedTaskIds: [DONE_TASK],
        doneTaskIds: [DONE_TASK],
        thinSearches: [{ toolName: "Bash", hitCount: 40, scope: "subtree", scopePath }],
        doneLookupUnavailable: false,
      });

    it("truncates a pathological path instead of interpolating it whole", () => {
      const rendered = withScopePath("y".repeat(5000));
      expect(rendered).toContain("scoped to");
      // The advisory feeds a ceiling enforced in UTF-16 units, so the bound has
      // to hold in units — the mt#4234/mt#4359 unit mismatch.
      expect(rendered.length).toBeLessThan(2000);
      expect(rendered).not.toContain("y".repeat(200));
    });

    it("leaves a real-world path intact", () => {
      expect(withScopePath("packages/domain/src/detectors")).toContain(
        "scoped to packages/domain/src/detectors"
      );
    });

    it("the worst case POSES the scope leg, so the canary is not understated", () => {
      const worst = renderWorstCase();
      expect(worst).toContain("scoped to");
    });
  });
});
