#!/usr/bin/env bun
// UserPromptSubmit hook: detect a chat-only usability/delivery claim made
// after an in-session build/deploy-surface merge with NO rebuild/reinstall/
// deploy evidence in the session — the "merged != usable" seam the mt#2707
// RFC identified as uncovered by every REACTIVE detector (there is no tool
// call to gate on: the claim is prose, not a tool result). Per mt#2923
// (mt#2707-RFC Part 2 + Threats, Notion 3a0937f0-3cb4-81a6-8699-e419a5ce4da0).
//
// Fires when ALL hold:
//   (a) an in-session tool_use to `*session_pr_merge` occurred (heuristic —
//       see "Known v1 limitation" below) whose session ALSO edited a file
//       matching the deploy/build surface (`isDeploySurfaceFile` /
//       `isLocalAppDeploySurfaceFile`,
//       packages/domain/src/deployment/deploy-surface.ts — the SAME shared
//       surface detection mt#2545's pre-merge/skill-step slices use; this
//       task does NOT hand-roll a second surface detector, per the mt#2923
//       spec's mt#2545 coordination section);
//   (b) the prior assistant turn makes a usability/delivery claim ("you can
//       use it now", "ready to use", "it's live", "go ahead and test", ...);
//   (c) NO rebuild/reinstall/deploy evidence anywhere in the session (no
//       `install-local.sh`, `tauri build`, `deployment_wait-for-latest`, a
//       package-manager build script (`npm`/`pnpm`/`yarn`/`bun` `[run] build`,
//       including a `build:web`-style scoped script name), or an equivalent
//       tool call).
//
// On fire, injects the claim-confidence format reminder (per the LIVE
// `.minsky/rules/claim-confidence.mdc` — "[delivery state] — [evidential
// warrant + basis]") — NOT a block.
//
// CALIBRATION-FIRST (mt#2263 ladder): v1 ships with INJECTION_ENABLED=false —
// logs a calibration JSONL record and injects NOTHING — mirroring
// `code-mechanism-assertion-detector.ts` / `causal-premise-detector.ts` (the
// closest analogs named in this task's spec). Graduation contract:
// `CALIBRATION_LOG_REGISTRY`'s `build-claim-injection` entry
// (`src/domain/calibration/calibration-sweep.ts`) declares `reviewByDays: 30`
// so the never-reviewed-aging cadence leg (mt#2896) forces a disposition ask
// within 30 days even at low fire volume — mt#2896 shipped precisely so this
// detector's graduation contract is enforceable.
//
// MEASURED 2026-08-08 (mt#3755): condition (a) is the binding constraint, and
// it is near-unsatisfiable in practice. Replaying this detector over all 805
// transcripts since 2026-07-23 (3,048 evaluation points, via
// `bun scripts/replay-build-claim-injection.ts`) yields ZERO fires: 620
// sessions had no in-session `*session_pr_merge` at all, 176 merged but edited
// no deploy-surface file in-transcript, 8 had both but made no usability
// claim, and the single session that satisfied all three was correctly
// suppressed by real rebuild evidence. Two causes, both in (a): the surface
// set matches only deploy-CONFIG files, and Minsky merges in a main-agent
// conversation whose implementation edits live in a subagent's transcript.
// The claim patterns below are NOT what is failing. Fix tracked at mt#3819;
// this detector stays registered meanwhile because `INJECTION_ENABLED` is
// false (it costs ~nothing) and retiring it would re-open the mt#2707 chat
// seam that no other mechanism covers at the chat surface.
//
// Known v1 limitation (measured by calibration, addressed in a v2 if
// warranted): "merge succeeded" is approximated as "a `*session_pr_merge`
// tool_use call is present in the session." The transcript does not reliably
// expose a structured, tool_use_id-correlated merge-result payload this
// detector can confirm success from, and this is a non-blocking,
// calibration-first injection — so a false fire on a FAILED merge attempt is
// an acceptable v1 cost, reviewed via the calibration log (same posture as
// the sibling detectors' own "Known v1 limitation" notes).
//
// mt#2545 coordination (recorded in the mt#2923 spec's Planning notes):
// mt#2923 (this file) owns ONLY the UserPromptSubmit chat-seam injection.
// mt#2545 owns the pre-merge PR-body usability-claim block (Gap A) and the
// cockpit-tray-dev env-mutation skill-step (Gap B). All three reuse the SAME
// `deploy-surface.ts` surface detection — one detection source of truth,
// three distinct enforcement surfaces (chat / pre-merge PR body /
// verification skill). No duplication.
//
// @see mt#2923 — this task
// @see mt#2707 — the originating RFC (Notion 3a0937f0-3cb4-81a6-8699-e419a5ce4da0)
// @see mt#2545 — sibling task (pre-merge PR-body block + cockpit-tray-dev skill-step)
// @see .claude/hooks/code-mechanism-assertion-detector.ts — closest calibration-first analog
// @see .minsky/hooks/transcript.ts — shared turn-boundary + tool-use helpers
// @see packages/domain/src/deployment/deploy-surface.ts — shared surface detection
// @see .minsky/rules/claim-confidence.mdc — the injected reminder's format contract
// @see mt#2652 — ADR-028 Phase 2a: this file's exported `run()` is the
//      dispatcher-compatible entry point invoked in-process by
//      `./dispatch-userpromptsubmit.ts`; `main()` / the CLI entrypoint below
//      is unchanged.

import { readInput, readHostCap, deriveBudgets } from "./types";
import type { ClaudeHookInput, HookOutput } from "./types";
import {
  resolveParentTranscriptLinesForPath,
  extractLastAssistantTurn,
  extractAssistantText,
  extractToolUseNames,
  findToolUseInputs,
} from "./transcript";
import type { TranscriptLine } from "./transcript";
import { logCalibrationRecord } from "./dispatcher";
import type { DispatchContext, GuardOutcome } from "./registry";
import {
  isDeploySurfaceFile,
  isLocalAppDeploySurfaceFile,
} from "../../packages/domain/src/deployment/deploy-surface";
import {
  lookupMergeDeploySurface,
  readStore,
  type MergeDeploySurfaceStore,
} from "../../packages/domain/src/deployment/merge-deploy-surface-record";

// ---------------------------------------------------------------------------
// Calibration gate — v1 is log-only, no injection
// ---------------------------------------------------------------------------

/**
 * When false (v1/calibration mode), the hook logs matches to JSONL and
 * injects NO additionalContext. Flip to true only after reviewing the FP
 * rate from the calibration log (mt#2263 ladder) — the graduation contract
 * is declared via `reviewByDays: 30` on this detector's
 * `CALIBRATION_LOG_REGISTRY` entry.
 */
export const INJECTION_ENABLED = false;

// ---------------------------------------------------------------------------
// Public API: exported constants
// ---------------------------------------------------------------------------

/** Override env var: set to "1"/"true"/"yes" to suppress detection and emit audit. */
export const OVERRIDE_ENV_VAR = "MINSKY_ACK_BUILD_CLAIM_INJECTION";

const CALIBRATION_LOG_NAME = "build-claim-injection";

// ---------------------------------------------------------------------------
// Usability/delivery claim patterns (condition b)
// ---------------------------------------------------------------------------

/**
 * Canonical usability/delivery claim phrasing named by the mt#2923 spec —
 * the RFC's "merged != usable" seam. Deliberately narrow (a handful of
 * high-precision phrasings) rather than a broad "sounds positive" scan —
 * precision over recall, same design lever as the sibling detectors'
 * narrow-predicate-pattern approach.
 */
export const USABILITY_CLAIM_PATTERNS: RegExp[] = [
  /\byou\s+can\s+(?:now\s+)?use\s+it\b/i,
  /\byou\s+can\s+now\s+(?:use|try)\b/i,
  /\bready\s+(?:for\s+use|to\s+use)\b/i,
  /\bit'?s\s+live\b/i,
  /\bgo\s+ahead\s+and\s+test\b/i,
  /\b(?:is|are)\s+(?:now\s+)?updated\s+and\s+ready\b/i,
  /\bfeel\s+free\s+to\s+(?:use|try)\s+it\b/i,
  /\bavailable\s+(?:for\s+use\s+)?now\b/i,
];

// ---------------------------------------------------------------------------
// Rebuild/reinstall/deploy evidence patterns (condition c)
// ---------------------------------------------------------------------------

/** Tool NAMES whose invocation counts as rebuild/deploy evidence. */
const REBUILD_TOOL_NAME_RE = /deployment_(?:wait-for-latest|status|logs)/i;

/**
 * Command-shaped TEXT (Bash / session_exec inputs) that counts as rebuild/deploy evidence.
 *
 * Package-manager build variants (mt#2923 R1 non-blocking #1): `(?:npm|pnpm|yarn|bun)\s+
 * (?:run\s+)?build` covers `npm run build`, `npm run build:web` (no trailing anchor, so a
 * `:web`-style script-name suffix still matches as a substring), `pnpm build`, `pnpm run build`,
 * `yarn build`, `yarn run build`, and `bun run build` in one alternative — kept as a single
 * maintainable group rather than one alternative per package manager.
 */
const REBUILD_COMMAND_RE =
  /(install-local\.sh|tauri\s+(?:build|dev)|cargo\s+build|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build|bun\s+run\s+dev|railway\s+up)/i;

/** Tool names whose Bash-shaped command input is scanned against {@link REBUILD_COMMAND_RE}. */
const COMMAND_TOOL_NAMES: readonly string[] = ["Bash", "mcp__minsky__session_exec"];

// ---------------------------------------------------------------------------
// Deploy-surface edit detection (condition a)
// ---------------------------------------------------------------------------

/**
 * File-edit-shaped tool names whose inputs are scanned for a deploy-surface
 * path. Deliberately broad (every session file-mutation tool) since the
 * exact field name carrying the path varies by tool (`file_path`, `path`,
 * `sourcePath`/`targetPath`, ...) — {@link collectStrings} below recurses
 * through the whole input object rather than guessing one field name per
 * tool.
 */
const FILE_EDIT_TOOL_NAMES: readonly string[] = [
  "Edit",
  "Write",
  "mcp__minsky__session_edit_file",
  "mcp__minsky__session_edit-file",
  "mcp__minsky__session_write_file",
  "mcp__minsky__session_search_replace",
  "mcp__minsky__session_create_directory",
  "mcp__minsky__session_delete_file",
  "mcp__minsky__session_move_file",
  "mcp__minsky__session_rename_file",
];

/** Tool NAME suffix identifying a session PR merge call. */
const MERGE_TOOL_NAME_RE = /session_pr_merge$/i;

/**
 * Recursively collect every string value reachable from `value` into `out`.
 * Local duplicate of the same small utility that appears in
 * `code-mechanism-assertion-detector.ts` — the sibling-detector duplication
 * practice: duplicate small helpers across detector files rather than
 * cross-import between sibling detectors (each detector stays a
 * self-contained, independently-readable module).
 *
 * This is about DETECTOR-TO-DETECTOR imports and survives mt#4373 untouched.
 * It used to be called "this repo's hooks tree convention", which collided with
 * the separate — and now retired — convention against importing
 * `packages/domain`. Two different rules; only the other one was retired.
 */
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) collectStrings(v, out);
  }
}

/**
 * Every deploy-surface (Railway) or local-app (cockpit-tray) surface path
 * touched by a file-edit tool call ANYWHERE in the session — the proxy for
 * "the merged PR touched a deploy/build surface" (the transcript does not
 * expose the merged PR's own file list directly).
 */
function findDeploySurfaceEditPaths(lines: TranscriptLine[]): string[] {
  const found = new Set<string>();
  for (const toolName of FILE_EDIT_TOOL_NAMES) {
    for (const input of findToolUseInputs(lines, toolName)) {
      const strings: string[] = [];
      collectStrings(input, strings);
      for (const s of strings) {
        if (isDeploySurfaceFile(s) || isLocalAppDeploySurfaceFile(s)) {
          found.add(s);
        }
      }
    }
  }
  return [...found];
}

/** True iff a `*session_pr_merge` tool_use call appears anywhere in `lines`. */
function hadSessionPrMerge(lines: TranscriptLine[]): boolean {
  return extractToolUseNames(lines).some((n) => MERGE_TOOL_NAME_RE.test(n));
}

/**
 * The id-bearing fields of `session_pr_merge`'s input. ONLY these are candidate
 * record keys.
 *
 * PR #2734 R1: an earlier version collected EVERY string reachable from the
 * input, which is over-permissive — `repo`, or free-text like `bypassReason`,
 * could coincide with another merge's key and mis-associate a verdict onto an
 * unrelated PR. A false match here is worse than a miss: a miss falls back to
 * the old proxy, while a false match asserts a deploy surface (or its absence)
 * from someone else's merge.
 */
const MERGE_RECORD_KEY_FIELDS: readonly string[] = ["task", "taskId", "sessionId", "session"];

/**
 * Candidate keys for {@link lookupMergeDeploySurface}, read from the id fields of
 * every in-session `*session_pr_merge` tool_use input. The merge may be invoked
 * by `task` or by `sessionId`, so all id fields are offered rather than guessing
 * which one the caller used.
 */
function mergeRecordCandidateKeys(lines: TranscriptLine[]): string[] {
  const keys: string[] = [];
  for (const toolName of extractToolUseNames(lines)) {
    if (!MERGE_TOOL_NAME_RE.test(toolName)) continue;
    for (const input of findToolUseInputs(lines, toolName)) {
      if (!input || typeof input !== "object") continue;
      const record = input as Record<string, unknown>;
      for (const field of MERGE_RECORD_KEY_FIELDS) {
        const value = record[field];
        if (typeof value === "string" && value.length > 0) keys.push(value);
      }
    }
  }
  return keys;
}

/**
 * The deploy/build-surface paths for the merge this session performed (mt#3819).
 *
 * Reads the verdict `require-deploy-verification-before-merge` recorded at merge
 * time from the PR's ACTUAL changed-file list. Replaces the previous proxy —
 * scanning this transcript's own file-edit tool calls — which measured 0 fires
 * across 805 sessions because Minsky merges in a main-agent conversation while
 * the implementation edits live in a dispatched subagent's transcript
 * (mt#3755).
 *
 * Returns null for UNKNOWN (no record for this merge), which the caller must not
 * treat as "no deploy surface" — a missing record means the producer did not run
 * (an older merge, or a merge that bypassed the gate), not that the PR was clean.
 */
function findMergeDeploySurfaceFiles(
  lines: TranscriptLine[],
  readRecordStore: () => MergeDeploySurfaceStore
): string[] | null {
  const record = lookupMergeDeploySurface(mergeRecordCandidateKeys(lines), readRecordStore());
  if (!record) return null;
  return record.deploySurfaceFiles;
}

/**
 * True iff rebuild/reinstall/deploy evidence appears anywhere in `lines` —
 * either a matching TOOL NAME (`deployment_wait-for-latest`/`status`/`logs`)
 * or a matching COMMAND string in a Bash/session_exec tool_use input.
 */
function hasRebuildEvidence(lines: TranscriptLine[]): boolean {
  if (extractToolUseNames(lines).some((n) => REBUILD_TOOL_NAME_RE.test(n))) return true;

  for (const toolName of COMMAND_TOOL_NAMES) {
    for (const input of findToolUseInputs(lines, toolName)) {
      const strings: string[] = [];
      collectStrings(input, strings);
      if (strings.some((s) => REBUILD_COMMAND_RE.test(s))) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Markdown elision (fenced blocks + inline code + blockquotes)
// ---------------------------------------------------------------------------

/**
 * Elide fenced code blocks, inline code spans, and blockquotes (pasted output
 * / a quote / a citation, not a fresh claim) with same-length whitespace,
 * preserving positions.
 *
 * Unlike `code-mechanism-assertion-detector.ts`'s same-named helper — which
 * deliberately KEEPS inline code because a backticked symbol IS the claim it
 * detects — this detector's usability/delivery phrases are natural language,
 * not code symbols: a phrase quoted inline (citing a prior message, a log
 * line, a string literal) or inside a blockquote is not a fresh claim.
 * Mirrors `causal-premise-detector.ts`'s `elideMarkdownContexts`, which elides
 * inline code for the same reason (mt#2923 R1 non-blocking #2 — guards the
 * overfire boundary on a quoted/backticked usability claim).
 */
export function elideBlocksAndQuotes(text: string): string {
  let result = text;
  // Fenced code blocks (``` or ~~~ fences, 3+ markers)
  result = result.replace(/^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]{0,3}\1[ \t]*$/gm, (m) =>
    " ".repeat(m.length)
  );
  // Inline code spans (variable backtick run length)
  result = result.replace(/(`+)([^`]|(?!`)[^`]*?)\1(?!`)/g, (m) => " ".repeat(m.length));
  // Blockquote lines (up to 3 leading spaces + one or more > markers)
  result = result.replace(/^[ \t]{0,3}>+.*$/gm, (m) => " ".repeat(m.length));
  return result;
}

/** Return the first matched usability/delivery claim phrase in `assistantText`, or undefined. */
function detectUsabilityClaim(assistantText: string): string | undefined {
  const prose = elideBlocksAndQuotes(assistantText);
  for (const pattern of USABILITY_CLAIM_PATTERNS) {
    const m = pattern.exec(prose);
    if (m) return m[0];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Detection result type
// ---------------------------------------------------------------------------

export interface BuildClaimInjectionResult {
  /** True iff all three conditions (a)/(b)/(c) hold. */
  matched: boolean;
  /** The matched usability/delivery claim phrase, when one was found. */
  matchedPhrase?: string;
  /** Deploy/build-surface paths edited anywhere in the session (condition a's evidence). */
  deploySurfaceFiles: string[];
  /** Whether an in-session `*session_pr_merge` tool_use call was found. */
  hadMerge: boolean;
  /** Whether rebuild/reinstall/deploy evidence was found anywhere in the session. */
  hadRebuildEvidence: boolean;
}

// ---------------------------------------------------------------------------
// Core detector (pure, exported for testing)
// ---------------------------------------------------------------------------

/**
 * Detect a chat-only usability/delivery claim after a build/deploy-surface
 * merge with no rebuild evidence.
 *
 * @param assistantText - concatenated assistant text from the PRIOR
 *   (just-completed) turn — condition (b)'s source.
 * @param sessionLines - the FULL session transcript (not turn-scoped) —
 *   conditions (a) and (c) look across the whole session, since the merge
 *   and any rebuild/reinstall evidence may have happened several turns
 *   before the usability claim.
 */
export function detectBuildClaimInjection(
  assistantText: string,
  sessionLines: TranscriptLine[],
  readRecordStore: () => MergeDeploySurfaceStore = readStore
): BuildClaimInjectionResult {
  const empty: BuildClaimInjectionResult = {
    matched: false,
    deploySurfaceFiles: [],
    hadMerge: false,
    hadRebuildEvidence: false,
  };
  if (!assistantText) return empty;

  // mt#3819: prefer the merge-time record (the PR's ACTUAL changed files) and
  // fall back to the in-transcript edit proxy only when no record exists — a
  // merge that predates the producer, or one that bypassed the gate. Falling
  // back rather than treating UNKNOWN as "no surface" keeps old sessions
  // behaving exactly as before instead of silently losing coverage.
  const recordedSurfaceFiles = findMergeDeploySurfaceFiles(sessionLines, readRecordStore);
  const deploySurfaceFiles = recordedSurfaceFiles ?? findDeploySurfaceEditPaths(sessionLines);
  const hadMerge = hadSessionPrMerge(sessionLines);
  if (!hadMerge || deploySurfaceFiles.length === 0) {
    return { ...empty, deploySurfaceFiles, hadMerge };
  }

  const matchedPhrase = detectUsabilityClaim(assistantText);
  if (!matchedPhrase) {
    return { ...empty, deploySurfaceFiles, hadMerge };
  }

  const hadRebuildEvidence = hasRebuildEvidence(sessionLines);
  if (hadRebuildEvidence) {
    return { matched: false, matchedPhrase, deploySurfaceFiles, hadMerge, hadRebuildEvidence };
  }

  return { matched: true, matchedPhrase, deploySurfaceFiles, hadMerge, hadRebuildEvidence };
}

// ---------------------------------------------------------------------------
// Calibration logging
// ---------------------------------------------------------------------------

function appendCalibrationRecord(cwd: string, record: Record<string, unknown>): void {
  // mt#4752: the shared helper derives the path from the stream NAME, so the
  // filename cannot drift from the convention the .gitignore globs encode.
  // `cwd` is the guard's raw input cwd — a FALLBACK, never an authoritative
  // root (see `calibrationLogPath`'s docblock for why the two ranks differ).
  logCalibrationRecord(CALIBRATION_LOG_NAME, record, { fallbackCwd: cwd });
}

// ---------------------------------------------------------------------------
// Injection text (gated by INJECTION_ENABLED)
// ---------------------------------------------------------------------------

// Exported (mt#4002) — see `renderProbe` in the registry. Calibration-first
// guards emit no `additionalContext`, so the shape test had nothing to measure.
export function buildInjectionReminder(result: BuildClaimInjectionResult): string {
  const files =
    result.deploySurfaceFiles
      .slice(0, 6)
      .map((f) => `  - ${f}`)
      .join("\n") || "  (no specific paths recorded)";
  return [
    "[build-claim-injection-detector] Usability claim after a build/deploy-surface",
    "merge with no rebuild evidence (mt#2923).",
    "",
    `The prior turn claimed usability/delivery ("${result.matchedPhrase}") after an`,
    "in-session merge touched a deploy/build surface, with no rebuild/reinstall/",
    "deploy evidence anywhere in this session (no install-local.sh, tauri build,",
    "deployment_wait-for-latest, or equivalent):",
    files,
    "",
    "Required: use the claim-confidence format — [delivery state] — [evidential",
    "warrant + basis] (see claim-confidence.mdc). Name the crossing step",
    "(rebuild/reinstall/deploy) still needed before the change is usable, rather",
    "than asserting it is ready now.",
    // Override advertisement removed (mt#4002) — banned from advisory text by
    // `guard-feedback-authoring.mdc`; the operator reads overrides in
    // `CLAUDE.md §Hook Files`, the agent should not be handed the exit.
  ].join("\n");
}

/**
 * Worst-case render for the registry's `renderProbe` (mt#4002).
 *
 * Bounded on the axis that grows: the file list is `.slice(0, 6)`, so six is the
 * ceiling however many deploy-surface files a session touched. `matchedPhrase`
 * is interpolated unbounded in principle, but it comes from this module's own
 * fixed claim-phrase corpus, so it is posed at the longest member's order of
 * magnitude rather than at an arbitrary length.
 */
export function renderWorstCase(): string {
  return buildInjectionReminder({
    matched: true,
    matchedPhrase: "x".repeat(60),
    deploySurfaceFiles: Array.from(
      { length: 6 },
      (_, i) => `services/${"s".repeat(40)}/file-${i}.ts`
    ),
    hadMerge: true,
    hadRebuildEvidence: false,
  });
}

// ---------------------------------------------------------------------------
// Dispatcher-compatible pure function (ADR-028 D1/D2 — mt#2652 Phase 2a)
// ---------------------------------------------------------------------------

/**
 * Guard-dispatcher entry point. Reuses `ctx.transcriptLines` (D6) instead of
 * re-parsing the transcript itself. Only calibration logging happens while
 * `INJECTION_ENABLED` is false — `additionalContext` is never set until the
 * flag flips post-graduation.
 */
export function run(input: ClaudeHookInput, ctx: DispatchContext): GuardOutcome | null {
  const overrideVal = process.env[OVERRIDE_ENV_VAR];
  const isOverride =
    overrideVal === "1" ||
    overrideVal?.toLowerCase() === "true" ||
    overrideVal?.toLowerCase() === "yes";

  if (isOverride) {
    return {
      auditLines: [
        `[build-claim-injection-detector] OVERRIDE: ack=${overrideVal} session=${input.session_id ?? "unknown"} ts=${new Date().toISOString()}\n`,
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

  let result: BuildClaimInjectionResult;
  try {
    const assistantText = extractAssistantText(turnLines);
    result = detectBuildClaimInjection(assistantText, lines);
  } catch (err) {
    process.stderr.write(
      `[build-claim-injection-detector] detection error: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return null;
  }

  if (!result.matched) return null;

  const outcome: GuardOutcome = {
    calibration: {
      timestamp: new Date().toISOString(),
      session_id: input.session_id,
      matchedPhrases: result.matchedPhrase ? [result.matchedPhrase] : [],
      deploySurfaceFiles: result.deploySurfaceFiles,
    },
  };

  if (INJECTION_ENABLED) {
    outcome.additionalContext = buildInjectionReminder(result);
  }

  return outcome;
}

// ---------------------------------------------------------------------------
// Standalone CLI entrypoint
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const capInfo = readHostCap("build-claim-injection-detector.ts", undefined, {
    events: ["UserPromptSubmit"],
  });
  if (capInfo.warning) {
    process.stderr.write(`[build-claim-injection-detector] ${capInfo.warning}\n`);
  }
  const budgets = deriveBudgets(capInfo.hostCapSec);
  const overallDeadline = Date.now() + budgets.overallBudgetMs;

  const overrideVal = process.env[OVERRIDE_ENV_VAR];
  const isOverride =
    overrideVal === "1" ||
    overrideVal?.toLowerCase() === "true" ||
    overrideVal?.toLowerCase() === "yes";

  let input: ClaudeHookInput;
  try {
    input = await readInput<ClaudeHookInput>();
  } catch {
    process.exit(0);
  }

  if (isOverride) {
    const ts = new Date().toISOString();
    process.stdout.write(
      `[build-claim-injection-detector] OVERRIDE: ack=${overrideVal} session=${input.session_id ?? "unknown"} ts=${ts}\n`
    );
    process.exit(0);
  }

  const transcriptPath = input.transcript_path;
  if (!transcriptPath) process.exit(0);

  if (Date.now() >= overallDeadline) {
    process.stderr.write(`[build-claim-injection-detector] budget exhausted — skipping\n`);
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

  let result: BuildClaimInjectionResult;
  try {
    const assistantText = extractAssistantText(turnLines);
    result = detectBuildClaimInjection(assistantText, lines);
  } catch (err) {
    console.error(
      `[build-claim-injection-detector] detection error: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(0);
  }

  if (!result.matched) process.exit(0);

  if (Date.now() < overallDeadline) {
    appendCalibrationRecord(input.cwd, {
      timestamp: new Date().toISOString(),
      session_id: input.session_id,
      matchedPhrases: result.matchedPhrase ? [result.matchedPhrase] : [],
      deploySurfaceFiles: result.deploySurfaceFiles,
    });
  }

  if (!INJECTION_ENABLED) process.exit(0);

  const output: HookOutput = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: buildInjectionReminder(result),
    },
  };
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

// Entrypoint guard: only run main() when this file is invoked as a script —
// the dispatcher's dynamic `import("./build-claim-injection-detector")` must
// NOT trigger it (mt#2835 — see auto-session-title.ts's header comment for
// the incident this convention prevents).
if (import.meta.main) {
  await main();
}
