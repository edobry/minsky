#!/usr/bin/env bun
// UserPromptSubmit hook: detect a NEGATIVE EXISTENCE CLAIM written into a
// durable artifact, justified by a search that returned <=1 hit, about a
// capability a task in DONE status claims to have delivered. Per mt#3918.
//
// CALIBRATION-FIRST: `INJECTION_ENABLED = false`. The hook writes an evaluation
// record for every case it EVALUATES — fired or not — and injects nothing until
// its own calibration review says otherwise (ADR-024's ladder).
//
// Detector contract:
//   FIRES when ALL THREE hold in the completed turn:
//     1. Durable-artifact prose (a PR body, spec patch, memory, ask, task)
//        carries a negative-existence claim — "X is never called", "nothing
//        implements Y", "zero call sites".
//     2. A same-turn search-class call returned ZERO OR ONE hits.
//     3. That prose cites an `mt#N` whose status is DONE.
//
//   DOES NOT FIRE when the search was wide, when no DONE task is cited, when no
//   task is cited at all, or when the prose asserts no absence.
//
// The matching itself lives in `packages/domain/src/detectors/negative-existence-claim.ts`
// per ADR-024's one-mechanism clause; this file is the adapter that feeds it the
// transcript and the task-status lookup. mt#3999 reads the same surface with a
// narrower third conjunct and consumes that module rather than copying it.
//
// @see packages/domain/src/detectors/negative-existence-claim.ts — the matcher
// @see .minsky/hooks/causal-premise-detector.ts — sibling calibration-first shape
// @see .minsky/hooks/constructed-identifier-batch-detector.ts — the bounded-lookup precedent

import { readInput, readHostCap, deriveBudgets, findRepoRoot } from "./types";
import type { ClaudeHookInput, HookOutput } from "./types";
import {
  resolveParentTranscriptLinesForPath,
  extractLastAssistantTurn,
  findToolCallsWithResults,
} from "./transcript";
import type { TranscriptLine } from "./transcript";
import {
  buildArtifactProseCorpus,
  elideBlocksAndQuotes,
} from "./code-mechanism-assertion-detector";
import { ensureHookDomainBootstrap } from "./domain-bootstrap";
import type { SqlCapablePersistenceProvider } from "../../packages/domain/src/persistence/types";
import {
  countSearchHits,
  type SearchScope,
  detectNegativeExistenceClaim,
  isSearchCall,
} from "../../packages/domain/src/detectors/negative-existence-claim";
import type {
  NegativeExistenceClaimResult,
  SearchObservation,
} from "../../packages/domain/src/detectors/negative-existence-claim";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DispatchContext, GuardOutcome } from "./registry";
// The SHARED search-argument grammar (mt#4362 SC2). `pathArgs` resolves
// `PATTERN [PATH...]` against `command-shape`'s `suppliesPattern` +
// `nonFlagOperands`, which is precisely the parse this needs and which mt#4328
// consolidated into one definition. Imported rather than re-derived on that
// module's own invitation — its re-export docblock names "any future consumer"
// as the reason the definition lives in one place.
import { pathArgs, tokenize } from "./nonexistent-search-path-detector";
// A scope path is unbounded text lifted out of a command string, and it now
// lands in ceiling-enforced advisory text — so it is bounded in UTF-16 UNITS,
// not code points (mt#4234/mt#4359: a cap in code points under a ceiling
// enforced in units is not a ceiling).
import { truncateToRenderedLength } from "./guard-feedback-format";

/**
 * Longest scope path rendered into the advisory.
 *
 * Long enough for the paths that actually occur (`packages/domain/src/detectors`
 * is 33), short enough that seven claims plus their searches cannot push
 * `renderWorstCase()` past the declared attention cost.
 */
const MAX_SCOPE_PATH_UNITS = 60;

/**
 * When false (calibration mode) the hook records and injects NOTHING. Flip only
 * after a `/calibration-review` pass over the evaluation stream — and that flip
 * is an enforcement-posture change, which is the operator's call (mt#3769).
 */
export const INJECTION_ENABLED = false;

export const OVERRIDE_ENV_VAR = "MINSKY_ACK_NEGATIVE_EXISTENCE_CLAIM";

const CALIBRATION_LOG = ".minsky/negative-existence-claim-calibration.jsonl";

/**
 * The EVALUATION stream, distinct from the calibration log above.
 *
 * The calibration log records fires. This records every case the detector
 * evaluated — fired or not — with each conjunct's outcome, so the MISS rate is
 * measurable rather than just the hit count (SC3). A fire-only log cannot
 * distinguish "the detector is precise" from "the detector is dead", which is
 * the failure mem#534 names and `coverage-receipt.ts` exists to catch.
 */
const EVALUATION_LOG = ".minsky/negative-existence-claim-evaluations.jsonl";

/** Longest excerpt kept per claim in a record. */
const MAX_EXCERPT_CHARS = 400;

/**
 * Which of `ids` name a task in DONE status. Returns `null` on ANY failure.
 *
 * `null` must not be read as "none are DONE" — the caller fires anyway. See
 * `detectNegativeExistenceClaim`'s doc for why conjunct 3 fails toward firing.
 *
 * ONE query over the distinct ids rather than a lookup per id, and called only
 * after conjuncts 1 and 2 already hold, so an ordinary artifact-writing turn
 * costs no round trip at all. Both choices follow `resolveExistingTaskIds` in
 * `constructed-identifier-batch-detector.ts` (mt#3991).
 */
export async function resolveDoneTaskIds(
  ids: readonly string[]
): Promise<ReadonlySet<string> | null> {
  const taskIds = [...new Set(ids.filter((id) => id.startsWith("mt#")))];
  if (taskIds.length === 0) return new Set();

  try {
    const bootstrap = await ensureHookDomainBootstrap();
    if (!bootstrap.ok) return null;

    const { resolvePersistenceProviderOrError } = await import(
      "../../packages/domain/src/persistence/factory"
    );
    const resolution = await resolvePersistenceProviderOrError();
    if (!resolution.ok) return null;

    const provider = resolution.provider;
    if (!provider.capabilities.sql || typeof provider.getDatabaseConnection !== "function") {
      return null;
    }
    const db = await (provider as SqlCapablePersistenceProvider).getDatabaseConnection();
    if (!db) return null;

    const { sql } = await import("drizzle-orm");
    const rows = await db.execute(
      sql`select id from tasks where id in ${taskIds} and status = 'DONE'`
    );
    const found = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? []);
    return new Set(
      found
        .map((r) => (r as { id?: unknown }).id)
        .filter((id): id is string => typeof id === "string")
    );
  } catch {
    // Deliberate: every failure shape collapses to "could not check", which the
    // caller renders as "fire anyway, and say the lookup was unavailable".
    // Rethrowing would take the whole UserPromptSubmit dispatch down over one
    // detector's refinement.
    return null;
  }
}

/**
 * Operands that name the repo root rather than a subtree.
 *
 * `*` is included because a bare glob expands within cwd — it narrows nothing.
 */
const REPO_ROOT_OPERANDS = new Set([".", "./", "*", "./*"]);

/**
 * Tools whose scope arrives as a structured `path` input, not a command string.
 *
 * The whole reason SC3 enumerates buckets: `command-shape`'s grammar parses a
 * COMMAND, and four of the covered tools never produce one. A shell-only
 * implementation would leave `Grep(path: ...)` — now at least as common a
 * subtree-scoped shape as a shell `grep` — permanently unclassified.
 */
const STRUCTURED_PATH_TOOLS: readonly string[] = [
  "Grep",
  "Glob",
  "mcp__minsky__repo_search",
  "mcp__minsky__git_search",
];

/**
 * Tools with no path PREFIX dimension at all.
 *
 * `tasks_search` and `transcripts_search-text` search a corpus, not a tree.
 * `session_grep_search` is the interesting one: it takes `include_pattern` /
 * `exclude_pattern`, which are glob FILTERS over the whole workspace rather
 * than a path prefix — a different narrowing axis this leg deliberately does
 * not model. Classified `unscopable` EXPLICITLY so it can never be mistaken for
 * repo-wide coverage (SC3).
 */
const UNSCOPABLE_SEARCH_TOOLS: readonly string[] = [
  "mcp__minsky__tasks_search",
  "mcp__minsky__transcripts_search-text",
  "mcp__minsky__session_grep_search",
];

/** Reduce a search's path operands to a scope classification. */
function classifyPaths(paths: readonly string[]): { scope: SearchScope; scopePath?: string } {
  const named = paths.map((p) => p.trim()).filter((p) => p.length > 0);

  // SC4 — a search naming NO path defaults to cwd, and the hook runs with the
  // repo root as cwd, so this is REPO scope. Recorded as a decision rather than
  // left to fall through. Its failure mode, stated: an agent that had cd'd into
  // a subdirectory would have a genuinely subtree-scoped search classified
  // `repo` and go unflagged. That direction is a MISS, not a false fire, which
  // is the right way to be wrong for a calibration-first widening.
  if (named.length === 0) return { scope: "repo" };

  // ANY root operand makes the whole search repo-wide — the operands union.
  if (named.some((p) => REPO_ROOT_OPERANDS.has(p))) return { scope: "repo" };

  // Multiple subtrees are still subtrees (AT7). `src/ packages/` reaches
  // neither `.minsky/` nor `scripts/` nor `docs/`, so a repo-wide claim resting
  // on it outruns its evidence exactly as a single-operand search would.
  return { scope: "subtree", scopePath: named[0] as string };
}

/**
 * Which territory a search covered — the three buckets of SC3.
 *
 * Shell first, because a `Bash`/`session_exec` search carries its paths in the
 * command string and that is the only bucket needing the grammar.
 */
export function classifySearchScope(
  toolName: string,
  input: Record<string, unknown>,
  command: string | undefined
): { scope: SearchScope; scopePath?: string } {
  if (typeof command === "string" && command.trim().length > 0) {
    const tokens = tokenize(command);
    const leader = tokens[0] ?? "";
    const binary = leader.split("/").pop() ?? leader;
    return classifyPaths(pathArgs(binary, tokens));
  }

  if (STRUCTURED_PATH_TOOLS.includes(toolName)) {
    const raw = input["path"];
    return classifyPaths(typeof raw === "string" ? [raw] : []);
  }

  if (UNSCOPABLE_SEARCH_TOOLS.includes(toolName)) return { scope: "unscopable" };

  // An UNRECOGNIZED tool lands here. It resolves to the same value as the
  // enumerated bucket above and the branches are kept apart anyway: "we know
  // this tool has no path dimension" and "we have never seen this tool" are
  // different facts that happen to warrant the same default today. Collapsing
  // them would make a newly-added search tool indistinguishable from a
  // deliberately-classified one the next time someone reads this.
  //
  // Either way `unscopable` never satisfies the scope leg, so a new search tool
  // fails QUIET — a miss, not a false fire — until someone classifies it.
  return { scope: "unscopable" };
}

/** Search-class calls in `turnLines`, each with the hit count and scope its result carried. */
export function collectSearchObservations(turnLines: TranscriptLine[]): SearchObservation[] {
  const observations: SearchObservation[] = [];
  for (const call of findToolCallsWithResults(turnLines)) {
    const command =
      typeof call.input["command"] === "string" ? (call.input["command"] as string) : undefined;
    if (!isSearchCall(call.toolName, command)) continue;
    const { scope, scopePath } = classifySearchScope(call.toolName, call.input, command);
    observations.push({
      toolName: call.toolName,
      // A call with no correlated result has an UNKNOWN count, not zero — a
      // search still in flight must not read as "found nothing".
      hitCount: call.hasResult ? countSearchHits(call.resultText) : null,
      scope,
      ...(scopePath === undefined ? {} : { scopePath }),
    });
  }
  return observations;
}

function appendJsonl(cwd: string, relativePath: string, record: Record<string, unknown>): void {
  try {
    const logPath = resolve(findRepoRoot(cwd), relativePath);
    const dir = dirname(logPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[negative-existence-claim-detector] Failed to write ${relativePath}: ${msg}\n`
    );
  }
}

/**
 * The advisory. Four parts per `guard-feedback-authoring.mdc`: header, quoted
 * evidence, imperative directive, legitimate-halt branch.
 *
 * The directive names the specific falsifier — read the DONE task's diff —
 * rather than "verify your claim", because the whole value here is that the
 * falsifier is deterministic and already identified.
 */
export function buildInjectionReminder(result: NegativeExistenceClaimResult): string {
  const claimLines = result.claims.map((c) => `  - "${c.phrase}"`).join("\n");
  const tasks = result.doneTaskIds.join(", ");
  const hitCounts = result.thinSearches
    // Scope is rendered beside the count so a calibration reviewer can tell
    // WHICH leg admitted the search. Without it a subtree search returning 8
    // hits reads as "8 hit(s)" — i.e. as evidence AGAINST the fire it caused.
    .map(
      (s) =>
        `${s.toolName} -> ${s.hitCount ?? "?"} hit(s)${
          s.scope === "subtree"
            ? `, scoped to ${truncateToRenderedLength(s.scopePath ?? "a subtree", MAX_SCOPE_PATH_UNITS)}`
            : ""
        }`
    )
    .join("; ");

  return [
    "[negative-existence-claim-detector] You asserted absence from a thin search, about work a DONE task shipped.",
    "",
    "Claimed:",
    claimLines,
    `Supporting search: ${hitCounts}`,
    `Shipped by: ${tasks}`,
    "",
    `Read what ${tasks} actually shipped before this lands — git log/diff on its merge.`,
    "A search returning one hit is equally consistent with the wrong pattern; grep the thing that",
    "CONSTRUCTS or INJECTS the capability, not only its own name.",
    "",
    "If you already read that diff, or the claim is bounded to the one spelling you searched and",
    "says so, keep it and note which in one line.",
  ].join("\n");
}

/**
 * Worst-case render for the registry's `renderProbe` (mt#4002).
 *
 * Saturated on EVERY axis at once: the claim list at a representative count with
 * each phrase at its 120-char cap, and several DONE task ids and thin searches.
 *
 * **The claim and task axes are NOT capped** — one line per matched pattern, one
 * id per cited DONE task — so this is a saturated SAMPLE, not a proved ceiling.
 * `guard-feedback-shape.test.ts` classifies that `render-probe-sample`. The claim
 * axis is bounded in practice by `NEGATIVE_EXISTENCE_PATTERNS.length` (7), which
 * is what this poses; the task axis is not bounded at all and owes an
 * `…and N more` cap before this guard's injection is enabled.
 */
export function renderWorstCase(): string {
  const phrase = "x".repeat(120);
  return buildInjectionReminder({
    matched: true,
    claims: Array.from({ length: 7 }, () => ({ phrase, excerpt: "" })),
    citedTaskIds: [],
    doneTaskIds: ["mt#2677", "mt#3642", "mt#3918", "mt#2544"],
    thinSearches: [
      // Re-posed for the scope leg (mt#4362): the worst case now includes a
      // SUBTREE search rendering a path at the cap, because that is the widest
      // this advisory can get. Leaving the old count-only pair here would pose
      // a ceiling the real render can exceed.
      {
        toolName: "Bash",
        hitCount: 99,
        scope: "subtree",
        scopePath: "x".repeat(MAX_SCOPE_PATH_UNITS),
      },
      { toolName: "mcp__minsky__session_grep_search", hitCount: 1 },
      { toolName: "mcp__minsky__tasks_search", hitCount: 0 },
    ],
    doneLookupUnavailable: false,
  });
}

function isOverridden(): string | undefined {
  const value = process.env[OVERRIDE_ENV_VAR];
  if (value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes") {
    return value;
  }
  return undefined;
}

/**
 * Evaluate the completed turn. Returns the result plus the evaluation record
 * that must be written whether or not it fired.
 *
 * Exported so tests can exercise the whole conjunct pipeline against transcript
 * lines without patching a collaborator: the DONE lookup is INJECTED rather than
 * reached for, per `testing-standards.mdc §Testable Design`.
 */
export async function evaluateTurn(
  turnLines: TranscriptLine[],
  lookupDoneTaskIds: (ids: readonly string[]) => Promise<ReadonlySet<string> | null>
): Promise<{ result: NegativeExistenceClaimResult; evaluation: Record<string, unknown> } | null> {
  const rawProse = buildArtifactProseCorpus(turnLines);
  if (!rawProse.trim()) return null;

  // Elide first so a claim the agent QUOTED — from a review comment, a prior
  // spec, a pasted grep result — is not read as one it asserted. Inline code is
  // deliberately KEPT (the sibling detector's reasoning): "`onProgress` has no
  // callers" is exactly the claim this exists to catch.
  const prose = elideBlocksAndQuotes(rawProse);
  const searches = collectSearchObservations(turnLines);

  // Conjuncts 1 and 2 are pure. Run them first so the DB lookup covers only
  // turns that already produced a candidate (mt#3991's ordering).
  const provisional = detectNegativeExistenceClaim({
    artifactProse: prose,
    searches,
    doneTaskIds: new Set(),
  });
  const conjunct1 = provisional.claims.length > 0;
  const conjunct2 = provisional.thinSearches.length > 0;

  let result = provisional;
  let lookupRan = false;
  if (conjunct1 && conjunct2 && provisional.citedTaskIds.length > 0) {
    lookupRan = true;
    const doneTaskIds = await lookupDoneTaskIds(provisional.citedTaskIds);
    result = detectNegativeExistenceClaim({ artifactProse: prose, searches, doneTaskIds });
  }

  const evaluation: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    fired: result.matched,
    claimPresent: conjunct1,
    thinSearchPresent: conjunct2,
    citedTaskCount: result.citedTaskIds.length,
    doneTaskCount: result.doneTaskIds.length,
    doneLookupRan: lookupRan,
    doneLookupUnavailable: lookupRan && result.doneLookupUnavailable,
    searchCount: searches.length,
    proseChars: prose.length,
  };

  return { result, evaluation };
}

/**
 * Injectable deps for {@link run} — tests substitute the DONE-status lookup.
 *
 * The lookup is the only IO in the detection path, and it is threaded rather
 * than reached for so a test can observe the whole pipeline (corpus extraction,
 * conjuncts, evaluation record, log writes) without a database or a module
 * patch (`testing-standards.mdc §Testable Design`).
 */
export interface NegativeExistenceClaimDeps {
  lookupDoneTaskIds?: (ids: readonly string[]) => Promise<ReadonlySet<string> | null>;
}

/** Dispatcher entry point (ADR-028 D1/D2). */
export async function run(
  input: ClaudeHookInput,
  ctx: DispatchContext,
  deps: NegativeExistenceClaimDeps = {}
): Promise<GuardOutcome | null> {
  const override = isOverridden();
  if (override) {
    return {
      auditLines: [
        `[negative-existence-claim-detector] OVERRIDE: ack=${override} session=${input.session_id ?? "unknown"} ts=${new Date().toISOString()}\n`,
      ],
    };
  }

  if (!input.transcript_path) return null;
  const lines = ctx.transcriptLines;
  if (lines.length === 0) return null;

  let turnLines: TranscriptLine[];
  try {
    turnLines = extractLastAssistantTurn(lines, ctx.recordedAnchor);
  } catch {
    return null;
  }
  if (turnLines.length === 0) return null;

  let evaluated: Awaited<ReturnType<typeof evaluateTurn>>;
  try {
    evaluated = await evaluateTurn(turnLines, deps.lookupDoneTaskIds ?? resolveDoneTaskIds);
  } catch (err) {
    process.stderr.write(
      `[negative-existence-claim-detector] Detection error: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return null;
  }
  if (!evaluated) return null;

  const cwd = input.cwd ?? process.cwd();
  appendJsonl(cwd, EVALUATION_LOG, {
    ...evaluated.evaluation,
    session_id: input.session_id,
  });

  if (!evaluated.result.matched) return null;

  // The calibration record is RETURNED, not written here: the dispatcher owns
  // that write for a dispatched guard (`calibrationLog` on the registration).
  // Writing it from both places would double-count every fire, which is the
  // shape that makes a rate un-measurable. The EVALUATION stream above is
  // different — the dispatcher knows nothing about it, so this path owns it.
  // Pinned by a test rather than left to this comment: see
  // "does NOT write the calibration log on the dispatcher path".
  //
  // Same division for `guardOutcome` (mt#3892/mt#3920): this guard writes NO
  // fire-log record, so it stamps no `guardOutcome`. The dispatcher writes the
  // record and stamps its own, exactly as it does for `causal-premise-detector`
  // and every other dispatched observer — none of which names the field either.
  // `custom/require-guard-outcome-in-fire-log` is correspondingly scoped to
  // files that reach the writer (`recordFireLogEntry`, `makeRecordAndExit`, and
  // the merge-gate factory surface); this file reaches none of them, and the
  // returned `GuardOutcome` type has no such field to set.

  const outcome: GuardOutcome = {
    calibration: {
      timestamp: new Date().toISOString(),
      session_id: input.session_id,
      claims: evaluated.result.claims.map((c) => ({
        phrase: c.phrase,
        excerpt: c.excerpt.slice(0, MAX_EXCERPT_CHARS),
      })),
      doneTaskIds: evaluated.result.doneTaskIds,
      thinSearches: evaluated.result.thinSearches,
      doneLookupUnavailable: evaluated.result.doneLookupUnavailable,
    },
  };

  if (INJECTION_ENABLED) {
    outcome.additionalContext = buildInjectionReminder(evaluated.result);
  }

  return outcome;
}

export async function main(): Promise<void> {
  const capInfo = readHostCap("negative-existence-claim-detector.ts", undefined, {
    events: ["UserPromptSubmit"],
  });
  if (capInfo.warning) {
    process.stderr.write(`[negative-existence-claim-detector] ${capInfo.warning}\n`);
  }
  const budgets = deriveBudgets(capInfo.hostCapSec);
  const overallDeadline = Date.now() + budgets.overallBudgetMs;

  const override = isOverridden();

  let input: ClaudeHookInput;
  try {
    input = await readInput<ClaudeHookInput>();
  } catch {
    process.exit(0);
  }

  if (override) {
    process.stderr.write(
      `[negative-existence-claim-detector] OVERRIDE: ack=${override} session=${input.session_id ?? "unknown"} ts=${new Date().toISOString()}\n`
    );
    process.exit(0);
  }

  const transcriptPath = input.transcript_path;
  if (!transcriptPath) process.exit(0);
  if (Date.now() >= overallDeadline) {
    process.stderr.write(
      "[negative-existence-claim-detector] budget exhausted before transcript read — skipping\n"
    );
    process.exit(0);
  }

  const lines = resolveParentTranscriptLinesForPath(transcriptPath, input.agent_id);
  if (lines.length === 0) process.exit(0);

  let turnLines: TranscriptLine[];
  try {
    turnLines = extractLastAssistantTurn(lines);
  } catch {
    process.exit(0);
  }
  if (turnLines.length === 0) process.exit(0);

  let evaluated: Awaited<ReturnType<typeof evaluateTurn>>;
  try {
    evaluated = await evaluateTurn(turnLines, resolveDoneTaskIds);
  } catch (err) {
    process.stderr.write(
      `[negative-existence-claim-detector] Detection error: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(0);
  }
  if (!evaluated) process.exit(0);

  if (Date.now() < overallDeadline) {
    appendJsonl(input.cwd ?? process.cwd(), EVALUATION_LOG, {
      ...evaluated.evaluation,
      session_id: input.session_id,
    });

    if (evaluated.result.matched) {
      appendJsonl(input.cwd ?? process.cwd(), CALIBRATION_LOG, {
        timestamp: new Date().toISOString(),
        session_id: input.session_id,
        claims: evaluated.result.claims.map((c) => ({
          phrase: c.phrase,
          excerpt: c.excerpt.slice(0, MAX_EXCERPT_CHARS),
        })),
        doneTaskIds: evaluated.result.doneTaskIds,
        thinSearches: evaluated.result.thinSearches,
        doneLookupUnavailable: evaluated.result.doneLookupUnavailable,
      });
    }
  }

  if (!INJECTION_ENABLED || !evaluated.result.matched) process.exit(0);

  const output: HookOutput = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: buildInjectionReminder(evaluated.result),
    },
  };
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

if (import.meta.main) {
  main();
}
