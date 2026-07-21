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
//       `install-local.sh`, `tauri build`, `deployment_wait-for-latest`, or
//       an equivalent tool call).
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

import { readInput, readHostCap, deriveBudgets, findRepoRoot } from "./types";
import type { ClaudeHookInput, HookOutput } from "./types";
import {
  parseTranscript,
  extractLastAssistantTurn,
  extractAssistantText,
  extractToolUseNames,
  findToolUseInputs,
} from "./transcript";
import type { TranscriptLine } from "./transcript";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DispatchContext, GuardOutcome } from "./registry";
import {
  isDeploySurfaceFile,
  isLocalAppDeploySurfaceFile,
} from "../../packages/domain/src/deployment/deploy-surface";

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

const CALIBRATION_LOG = ".minsky/build-claim-injection-calibration.jsonl";

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

/** Command-shaped TEXT (Bash / session_exec inputs) that counts as rebuild/deploy evidence. */
const REBUILD_COMMAND_RE =
  /(install-local\.sh|tauri\s+(?:build|dev)|cargo\s+build|npm\s+run\s+build|bun\s+run\s+(?:build|dev)|railway\s+up)/i;

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
 * `code-mechanism-assertion-detector.ts` — this repo's hooks tree convention
 * is to duplicate small helpers across detector files rather than
 * cross-import between sibling detectors (each detector stays a
 * self-contained, independently-readable module).
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
// Markdown elision (fenced blocks + blockquotes; keep inline code)
// ---------------------------------------------------------------------------

/**
 * Elide fenced code blocks and blockquotes (pasted output / a quote, not a
 * fresh claim) with same-length whitespace, preserving positions. Local
 * duplicate of the same small helper in `code-mechanism-assertion-detector.ts`
 * — see {@link collectStrings}'s doc comment for the duplication rationale.
 */
export function elideBlocksAndQuotes(text: string): string {
  let result = text;
  result = result.replace(/^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]{0,3}\1[ \t]*$/gm, (m) =>
    " ".repeat(m.length)
  );
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
  sessionLines: TranscriptLine[]
): BuildClaimInjectionResult {
  const empty: BuildClaimInjectionResult = {
    matched: false,
    deploySurfaceFiles: [],
    hadMerge: false,
    hadRebuildEvidence: false,
  };
  if (!assistantText) return empty;

  const deploySurfaceFiles = findDeploySurfaceEditPaths(sessionLines);
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
  try {
    // mt#2710: resolve the actual repo ROOT, not the raw shell cwd — `cwd` is
    // routinely a repo subdirectory, and a bare `resolve(cwd, ...)` would
    // scatter this calibration log into a stray subdirectory `.minsky/`.
    const logPath = resolve(findRepoRoot(cwd), CALIBRATION_LOG);
    const dir = dirname(logPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[build-claim-injection-detector] calibration log write failed: ${msg}\n`);
  }
}

// ---------------------------------------------------------------------------
// Injection text (gated by INJECTION_ENABLED)
// ---------------------------------------------------------------------------

function buildInjectionReminder(result: BuildClaimInjectionResult): string {
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
    "",
    `Override: ${OVERRIDE_ENV_VAR}=1.`,
  ].join("\n");
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
    turnLines = extractLastAssistantTurn(lines);
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

  const lines = parseTranscript(transcriptPath);
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
