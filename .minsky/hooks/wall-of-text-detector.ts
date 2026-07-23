#!/usr/bin/env bun
// UserPromptSubmit hook: measure the just-completed turn's FINAL assistant
// text block (the turn-end report) against the Tier-1 turn-report contract
// shape (communication-contract.mdc, mt#2713) and log a calibration record
// when it reads as a wall of text. Per mt#2870.
//
// **Why this exists.** The communication-altitude RFC's Phase 3 enforcement
// half has two sibling failure modes: UNDER-signaling (long silent tool-only
// stretches — the shipped silent-stretch-detector, mt#2824) and
// OVER-signaling (multi-screen turn-end reports that blow the contract's
// budget and lead with skill-internal audit vocabulary — this detector).
// Originating incident: the 2026-07-15 mt#2777 planning output that led with
// a four-part premise audit and a 14-row criterion table, prompting "This is
// too much information."
//
// **Calibration-first (mt#2263 detector ladder / ADR-024), graduated to LIVE
// by mt#3112.** v1 logged matches to JSONL and injected nothing while the FP
// rate was measured. mt#3112 (below) flips `INJECTION_ENABLED` to `true` —
// every matched fire still logs unconditionally, and `additionalContext` is
// now emitted too, EXCEPT when the depth-request override (also mt#3112)
// determines the principal recently asked for exactly this depth.
//
// **Measured signals (v1 — deterministic, no LLM):**
//   - word/line count of the turn's FINAL assistant text block (the report);
//   - skill-internal label patterns (gate/criterion letters, parenthesized
//     roman-numeral premise labels, `SC#N` refs) inside the report's OPENING
//     window — the contract allows them in a trailing audit block, so only
//     the lead is scanned;
//   - `minsky://` deeplink count vs named-artifact refs (`mt#N`, `PR #N`) —
//     the pointer-presence signal (detail should live behind pointers).
//
// **Thresholds.** The contract's Tier-1 budget is verbatim "hard budget:
// readable in under 30 seconds (~200 words)". A record is logged at 2x that
// budget (>= 400 words) — a clear violation, not a borderline expanded
// report (severity legitimately pierces the register; calibration data will
// show how often that happens) — OR on any lead-label hit.
//
// **mt#3028 — two measurement-integrity fixes (2026-07-21 calibration review,
// ask 8bf53c54, tune-both disposition).**
//
// (1) Cross-transcript contamination, not in-turn summing. The 3,117/3,557-
// word fires (session e1a0c941) matched NO rendered final message because
// `ctx.transcriptLines` (D6) is `transcriptCandidates.flatMap(parse)` —
// the PARENT transcript concatenated with EVERY sibling subagent transcript
// under the session's `subagents/` dir (`resolveTranscriptCandidates`'s
// unconditional "every sibling" fallback, mt#2637), with no per-line
// file-origin marker. Turn-boundary extraction over that flattened array
// can land inside a SUBAGENT's own transcript, misattributing ITS final
// report as this session's turn-end report. Empirically reproduced against
// the live e1a0c941 transcript + its `subagents/*.jsonl` siblings: the
// "final text" resolved to an "Adversarial Review — RFC:..." report that
// belongs to a dispatched review subagent, never rendered to the principal
// in the parent conversation. This is ALSO what produced session 820a6f06's
// identical 1,497-word record logged 6x — reparsing that session's PARENT
// transcript alone at each of the six firing timestamps yields six
// DIFFERENT small (27-337 word) reports, none matching 1,497 or each
// other — proving the duplication was an artifact of the same contaminated
// multi-file read, not a genuinely-unchanged report. Fix: `resolveTurnLines`
// below re-parses the PARENT candidate alone (registry.ts's own D6 doc
// comment sanctions exactly this: "a guard that needs per-candidate
// short-circuit scanning... can still walk `transcriptCandidates` itself and
// re-parse") whenever more than one candidate is present, instead of
// trusting the merged array.
//
// (2) Defense-in-depth dedupe. Even with (1) fixed, a session whose parent
// thread genuinely produces the identical measured report across back-to-back
// prompts (e.g. a task-notification firing with zero new parent-thread
// content) should still log at most once. `run()`/`main()` now hash the
// measured final text and skip logging when ANY record for this `session_id`
// within a bounded tail of the calibration log (`MAX_DEDUPE_READ_BYTES`)
// already carries the same hash — not just the single most-recent record, so
// an A -> B -> A sequence still dedupes the repeat A (PR #2165 R1 BLOCKING #1),
// while the bounded tail keeps the lookback window finite rather than
// "forever" (PR #2165 R1 BLOCKING #2).
//
// **mt#3112 — flip to live injection + depth-request override-awareness
// (2026-07-23, operator-confirmed disposition, ask 109807e1 / ask#5425).**
// The mt#2483 calibration-review sweep found 60 lifetime fires, all
// over-budget-shaped, including a confirmed operator-bounced true positive on
// 07-22 ("way too much for me to read") — the same failure drew operator
// correction 4x in 14 days, tripping mt#2838's escalation budget.
// `INJECTION_ENABLED` flips to `true` below, graduating this detector off the
// mt#2263 calibration-first ladder, paired with the override the review
// required as a CONDITION of the flip: suppress (but still LOG)
// `additionalContext` when the principal recently asked for depth
// in-conversation — "walk me through everything", "show me the detail",
// "give me the full breakdown" (see `DEPTH_REQUEST_PATTERNS`) — so a report
// that is long BECAUSE it was asked for does not train the operator to tune
// out the reminder. The lookback scans the last
// `DEPTH_REQUEST_LOOKBACK_TURNS` real user prompts up to and including the
// one that opened the measured turn (never the CURRENT prompt, which arrives
// AFTER the report and so cannot have caused it). Every matched fire still
// logs a calibration record — now carrying a `suppressedByDepthRequest` field
// — whether or not injection actually fires, so the override's own accuracy
// is itself reviewable in a future calibration pass.
//
// @see .minsky/hooks/silent-stretch-detector.ts — the under-signaling sibling this file mirrors structurally
// @see .minsky/rules/communication-contract.mdc — the Tier-1 contract shape being measured; its
//   rationale doc (docs/rules-rationale/communication-contract.md §Override) names the
//   altitude-register override vocabulary DEPTH_REQUEST_PATTERNS is calibrated from
// @see mt#2263 — detector ladder (calibration before injection)
// @see mt#2713 — the contract this measures against
// @see mt#2870 — this task (origin)
// @see mt#3003 — sibling task whose disposition narrowed/superseded scope for wall-of-text at planning;
//   on completion, mt#3003 hoisted this file's `resolveTurnLines` candidate-resolution logic and
//   dedupe-log primitives (`sessionHasLoggedHash`/`readCalibrationLogText`) into shared `transcript.ts`
//   helpers (`resolveParentTranscriptLines`/`sessionHasLoggedKey`/`readLogTailText`) that
//   silent-stretch-detector.ts now also consumes — this file's own exported functions/behavior are
//   unchanged, they just delegate internally now.
// @see mt#3028 — the two fixes above
// @see mt#3112 — this task (live-injection flip + depth-request override); mt#2838 — the
//   escalation budget this flip's disposition tripped; mt#2870 — RFC Phase-3 enforcement pair
// @see .minsky/hooks/registry.ts — ADR-028 GUARD_REGISTRY entry for this guard; D6 `DispatchContext` doc comment sanctions the per-candidate re-parse pattern used here

import { readInput, readHostCap, deriveBudgets, findRepoRoot } from "./types";
import type { ClaudeHookInput, HookOutput } from "./types";
import {
  parseTranscript,
  extractLastAssistantTurn,
  extractAssistantText,
  findRealPromptIndices,
  resolveParentTranscriptLines,
  resolveParentTranscriptLinesForPath,
  readLogTailText,
  sessionHasLoggedKey,
  DEFAULT_MAX_DEDUPE_READ_BYTES,
} from "./transcript";
import type { TranscriptLine } from "./transcript";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { DispatchContext, GuardOutcome } from "./registry";

// ---------------------------------------------------------------------------
// Calibration gate — LIVE since mt#3112
// ---------------------------------------------------------------------------

/**
 * LIVE since mt#3112 (2026-07-23) — flipped from calibration-only after the
 * mt#2483 review (ask 109807e1 / ask#5425) disposed the residual signal as a
 * confirmed operator-bounced true positive plus a 4x/14-day recurrence
 * (tripping the mt#2838 escalation budget). Paired, in the same flip, with
 * the depth-request override below: a matched fire still LOGS
 * unconditionally, but `additionalContext` is withheld when the principal
 * recently asked for depth (see `detectDepthRequest` / `DEPTH_REQUEST_PATTERNS`).
 */
export const INJECTION_ENABLED = true;

// ---------------------------------------------------------------------------
// Public API: exported constants
// ---------------------------------------------------------------------------

/**
 * Bespoke opt-out, checked directly inside `run()`/`main()` in addition to
 * the shared `MINSKY_HOOK_OVERRIDE` channel every GUARD_REGISTRY entry gets
 * for free via the dispatcher's `checkOverride()`.
 */
export const OVERRIDE_ENV_VAR = "MINSKY_SKIP_WALL_OF_TEXT";

const CALIBRATION_LOG = ".minsky/wall-of-text-calibration.jsonl";

// ---------------------------------------------------------------------------
// Thresholds (grounded in the contract — see header comment)
// ---------------------------------------------------------------------------

/** The Tier-1 contract's lead budget, verbatim from communication-contract.mdc. */
export const LEAD_WORD_BUDGET = 200;

/** A record is logged at this multiple of the budget — clear violation, not borderline. */
export const OVER_BUDGET_MULTIPLIER = 2;

/** Word count at which the over-budget trigger fires. */
export const WORD_COUNT_THRESHOLD = LEAD_WORD_BUDGET * OVER_BUDGET_MULTIPLIER;

/**
 * Size of the OPENING window (in words) scanned for skill-internal labels.
 * The contract requires the lead be label-free; a trailing audit block may
 * legitimately carry them, so the scan never extends past this window.
 */
export const LEAD_WINDOW_WORDS = 150;

/**
 * Skill-internal label patterns the contract bars from the lead
 * (communication-contract.mdc: "no skill-internal labels (gate letters (l),
 * premise-audit labels (iii), criterion-table IDs)"). Conservative by
 * design — calibration mode measures the FP rate before any graduation.
 */
export const SKILL_LABEL_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  // "gate (l)", "criterion (h)", "gate criterion (n)" — audit-battery refs.
  // PR #2036 R1: accepts the parenthesized form, an unclosed "gate (l", and
  // the bare "gate l" — the trailing (?![a-z0-9]) token boundary keeps a
  // bare letter from matching the first letter of an ordinary word
  // ("gate lock" does NOT match).
  {
    name: "gate-letter",
    re: /\b(?:gate|criterion|criteria)\s+(?:criterion\s+)?(?:\([a-n]\)|\(?[a-n](?![a-z0-9]))/i,
  },
  // "(i)" … "(x)" premise-audit-style parenthesized roman numerals. PR #2036
  // R1: extended past (iv) so longer label sequences still register. The
  // trailing boundary keeps "(i.e." and similar from matching.
  { name: "premise-label", re: /\((?:i{1,3}|iv|v|vi{1,3}|ix|x)\)(?:\s|$|[.,:;])/ },
  // "SC#3" success-criterion refs.
  { name: "sc-ref", re: /\bSC#\d+/ },
];

const DEEPLINK_RE = /minsky:\/\//g;
// "PR #12" and "PR#12" both count as named refs (PR #2036 R1 sweep).
const NAMED_REF_RE = /\bmt#\d+|\bPR\s*#\d+/g;

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

export interface WallOfTextMeasurement {
  /** true when either trigger fired. */
  matched: boolean;
  /** Which trigger(s) fired. */
  trigger: "over-budget" | "lead-labels" | "both" | "none";
  /** Word count of the final assistant text block. */
  wordCount: number;
  /** Line count of the final assistant text block. */
  lineCount: number;
  /** Names of SKILL_LABEL_PATTERNS that hit inside the lead window. */
  leadLabelHits: string[];
  /** Count of minsky:// deeplinks anywhere in the report. */
  deeplinkCount: number;
  /** Count of named-artifact refs (mt#N / PR #N) anywhere in the report. */
  namedRefCount: number;
}

/**
 * The turn-end report is the LAST assistant line in the turn that carries
 * non-empty text — the message the principal actually reads as the report.
 * Reuses `extractAssistantText` per-line (it already handles the
 * tool_result-is-user-role hazard and string-vs-content-array shapes).
 */
export function extractFinalAssistantText(turnLines: TranscriptLine[]): string {
  for (let i = turnLines.length - 1; i >= 0; i--) {
    const line = turnLines[i];
    if (!line) continue;
    const text = extractAssistantText([line]);
    if (text.trim().length > 0) return text;
  }
  return "";
}

/** Measure a turn-end report against the Tier-1 contract shape. */
export function measureWallOfText(finalText: string): WallOfTextMeasurement {
  const words = finalText.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const lineCount = finalText.split("\n").filter((l) => l.trim().length > 0).length;

  const lead = words.slice(0, LEAD_WINDOW_WORDS).join(" ");
  const leadLabelHits = SKILL_LABEL_PATTERNS.filter((p) => p.re.test(lead)).map((p) => p.name);

  const deeplinkCount = (finalText.match(DEEPLINK_RE) ?? []).length;
  const namedRefCount = (finalText.match(NAMED_REF_RE) ?? []).length;

  const overBudget = wordCount >= WORD_COUNT_THRESHOLD;
  const hasLeadLabels = leadLabelHits.length > 0;
  const matched = overBudget || hasLeadLabels;
  const trigger =
    overBudget && hasLeadLabels
      ? "both"
      : overBudget
        ? "over-budget"
        : hasLeadLabels
          ? "lead-labels"
          : "none";

  return { matched, trigger, wordCount, lineCount, leadLabelHits, deeplinkCount, namedRefCount };
}

// ---------------------------------------------------------------------------
// mt#3112 — depth-request override-awareness
// ---------------------------------------------------------------------------

/**
 * How many of the RECENT real user prompts (up to and including the one that
 * opened the measured turn) are scanned for an explicit depth request. Bounded
 * so a depth request many turns back does not stay "recent" forever — this is
 * a lookback over the immediate conversational stretch that plausibly caused
 * the just-measured over-budget report, not the whole session history.
 */
export const DEPTH_REQUEST_LOOKBACK_TURNS = 3;

/**
 * Phrasings the principal uses to explicitly ask for MORE depth/detail than
 * the Tier-1 default — calibrated from the altitude-register override
 * vocabulary in communication-contract.mdc's rationale doc
 * (`docs/rules-rationale/communication-contract.md §Override`: "walk me
 * through everything", "show me the detail") plus the mt#3112 spec's third
 * named example ("give me the full breakdown"). Deliberately does NOT include
 * "background this" — that phrase moves the OTHER direction (toward less
 * detail, the executive register), so it is not a reason to suppress a
 * too-long-report reminder.
 */
export const DEPTH_REQUEST_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  // "walk me through everything" / "walk me through it all" / "... the whole thing/story/process"
  {
    name: "walk-me-through",
    re: /\bwalk me through (?:everything|it all|the whole (?:thing|story|process))\b/i,
  },
  // "show me the detail(s)" / "show me all the detail(s)" / "show me the full/complete detail(s)"
  {
    name: "show-the-detail",
    re: /\bshow me (?:all )?(?:the )?(?:full |complete )?detail(?:s)?\b/i,
  },
  // "give me the full breakdown" / "give me a complete breakdown" / "want/need the full breakdown"
  {
    name: "full-breakdown",
    re: /\b(?:give me|want|need)\s+(?:the |a )?(?:full|complete)\s+breakdown\b/i,
  },
];

/** Text content of a single user-role transcript line (string or text-block-array content). */
function extractUserPromptText(line: TranscriptLine): string {
  const content = line.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content as Array<Record<string, unknown>>) {
      if (
        block &&
        typeof block === "object" &&
        block["type"] === "text" &&
        typeof block["text"] === "string"
      ) {
        parts.push(block["text"] as string);
      }
    }
    return parts.join("\n");
  }
  return "";
}

/**
 * Text of the last `lookback` REAL user prompts at or before `throughIndex`
 * (inclusive) — the lookback window for the depth-request override. Callers
 * pass the measured turn's OPENING prompt index as `throughIndex` so the
 * window never reaches into the CURRENT prompt (which arrives after the
 * report being measured and so cannot have caused it).
 */
export function recentUserPromptTexts(
  lines: TranscriptLine[],
  throughIndex: number,
  lookback: number = DEPTH_REQUEST_LOOKBACK_TURNS
): string[] {
  const promptIndices = findRealPromptIndices(lines).filter((i) => i <= throughIndex);
  const recent = promptIndices.slice(-lookback);
  return recent
    .map((i) => extractUserPromptText(lines[i] as TranscriptLine))
    .filter((t) => t.length > 0);
}

export interface DepthRequestResult {
  /** true iff any of `userTexts` matched a DEPTH_REQUEST_PATTERNS entry. */
  matched: boolean;
  /** Name of the first matching pattern, for calibration/debugging. */
  matchedPattern?: string;
}

/** Scan recent user-prompt texts for an explicit depth request. */
export function detectDepthRequest(userTexts: string[]): DepthRequestResult {
  for (const text of userTexts) {
    for (const p of DEPTH_REQUEST_PATTERNS) {
      if (p.re.test(text)) return { matched: true, matchedPattern: p.name };
    }
  }
  return { matched: false };
}

// ---------------------------------------------------------------------------
// mt#3028 fix (1) — scope turn extraction to the PARENT transcript alone
// ---------------------------------------------------------------------------

/**
 * Resolve the transcript lines to measure THIS session's turn-end report
 * against. `ctx.transcriptLines` (D6) is safe to use as-is when there is at
 * most one resolved candidate (the common case — no subagents dispatched
 * this session). When `ctx.transcriptCandidates` names MORE than one file,
 * `ctx.transcriptLines` is a flat concatenation of the parent transcript
 * with every sibling subagent transcript (see the header comment's mt#3028
 * fix (1)) — re-parse the parent candidate (`input.transcript_path`, always
 * `transcriptCandidates[0]` per `resolveTranscriptCandidates`) alone instead,
 * so a subagent's own final report can never be measured as if it were the
 * principal-facing turn-end report of the live conversation.
 *
 * `parseTranscriptFn` is injectable (defaults to the real `parseTranscript`)
 * so tests can exercise the multi-candidate branch with an in-memory fixture
 * instead of a real file (`custom/no-real-fs-in-tests`).
 */
export function resolveTurnLines(
  input: ClaudeHookInput,
  ctx: DispatchContext,
  parseTranscriptFn: (path: string) => TranscriptLine[] = parseTranscript
): TranscriptLine[] {
  // mt#3003: delegates to the shared transcript.ts primitive — this
  // function's own signature/behavior is unchanged (kept for callers/tests
  // that already reference it by this name), it just no longer duplicates
  // the candidate-resolution logic. See resolveParentTranscriptLines's own
  // doc comment for the full contamination-mechanism rationale.
  return resolveParentTranscriptLines(
    input.transcript_path,
    ctx.transcriptCandidates,
    ctx.transcriptLines,
    parseTranscriptFn
  );
}

// ---------------------------------------------------------------------------
// mt#3028 fix (2) — dedupe: an unchanged report logs at most once per session
// ---------------------------------------------------------------------------

/**
 * Stable content hash for dedupe keying — not a security digest. Truncated
 * to 16 hex chars (64 bits): dedupe only ever compares hashes WITHIN one
 * session's own recent history (see `MAX_DEDUPE_READ_BYTES` below, which
 * bounds that history to a few hundred records at most), so the collision
 * space is tiny relative to a 64-bit digest — an accidental collision here
 * would require two DIFFERENT reports for the same session, within the same
 * bounded window, sharing a hash purely by chance (PR #2165 R1 non-blocking).
 */
export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * Bounds how much of the calibration log the dedupe check reads, regardless
 * of how large the file grows over time (PR #2165 R1 BLOCKING #2 — the log
 * has no rotation, so an unbounded read would grow with it). Re-exported
 * from the shared `transcript.ts` default (mt#3003) under this file's
 * existing name, for callers/tests that reference it here.
 */
export const MAX_DEDUPE_READ_BYTES = DEFAULT_MAX_DEDUPE_READ_BYTES;

/**
 * True iff `sessionId` has a calibration record in `logText` (the raw JSONL
 * file contents, or a bounded TAIL of it — see `readCalibrationLogText`)
 * carrying exactly `hash` under the `textHash` field. Scans EVERY record for
 * this session, not just the most recent one (PR #2165 R1 BLOCKING #1 — a
 * prior version compared only against the last record, so an A -> B -> A
 * sequence re-logged the second A even though it was a repeat within the
 * same short window). Delegates to the shared `transcript.ts`
 * `sessionHasLoggedKey` (mt#3003), pinning the key field to `"textHash"` so
 * this file's existing callers/tests keep their two-arg-plus-hash call
 * shape.
 */
export function sessionHasLoggedHash(
  logText: string | undefined,
  sessionId: string | undefined,
  hash: string
): boolean {
  return sessionHasLoggedKey(logText, sessionId, "textHash", hash);
}

/**
 * Real on-disk read of (at most) the last `MAX_DEDUPE_READ_BYTES` of the
 * calibration log, resolved against the repo root (never throws). Bounded
 * per-invocation cost regardless of total log size (PR #2165 R1 BLOCKING #2).
 * Exported (rather than module-private) so the bounded-tail behavior itself
 * has direct test coverage against a real temp file, not just the pure
 * `sessionHasLoggedHash` string-parsing logic downstream of it. Delegates to
 * the shared `transcript.ts` `readLogTailText` (mt#3003) for the actual
 * bounded-read implementation.
 */
export function readCalibrationLogText(cwd: string): string | undefined {
  const logPath = resolve(findRepoRoot(cwd), CALIBRATION_LOG);
  return readLogTailText(logPath, MAX_DEDUPE_READ_BYTES);
}

// ---------------------------------------------------------------------------
// Calibration logging (standalone CLI path only — dispatcher path uses D4
// `logCalibrationRecord` via the registry's `calibrationLog` wiring)
// ---------------------------------------------------------------------------

function appendCalibrationRecord(cwd: string, record: Record<string, unknown>): void {
  try {
    // mt#2710: resolve the actual repo ROOT, not the raw shell cwd — `cwd` is
    // routinely a repo subdirectory, and a bare `resolve(cwd, ...)` would
    // scatter this calibration log into a stray subdirectory `.minsky/`.
    const logPath = resolve(findRepoRoot(cwd), CALIBRATION_LOG);
    const dir = dirname(logPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[wall-of-text-detector] Failed to write calibration log: ${msg}\n`);
  }
}

function buildCalibrationRecord(
  input: ClaudeHookInput,
  m: WallOfTextMeasurement,
  textHash: string,
  suppressedByDepthRequest: boolean
): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    session_id: input.session_id,
    wordCount: m.wordCount,
    lineCount: m.lineCount,
    trigger: m.trigger,
    leadLabelHits: m.leadLabelHits,
    deeplinkCount: m.deeplinkCount,
    namedRefCount: m.namedRefCount,
    // mt#3028: dedupe key (fix (2)) — any prior record for this session_id
    // (within the bounded lookback) carrying the same hash means an
    // unchanged report is being re-measured, not a genuinely new turn.
    textHash,
    // mt#3112: true when a recent user prompt matched DEPTH_REQUEST_PATTERNS
    // — additionalContext was withheld for this fire even though it matched,
    // so this field is what lets a future calibration pass measure the
    // override's OWN accuracy (recorded on every fire, live or suppressed).
    suppressedByDepthRequest,
  };
}

// ---------------------------------------------------------------------------
// Dispatcher-compatible pure function (ADR-028 D1/D2)
// ---------------------------------------------------------------------------

/** Injectable overrides for `run()` — tests substitute in-memory fakes for both real-IO seams (`custom/no-real-fs-in-tests`). */
export interface RunDeps {
  /** Defaults to the real `parseTranscript`. Used by `resolveTurnLines`'s multi-candidate branch. */
  parseTranscriptFn?: (path: string) => TranscriptLine[];
  /** Defaults to the real `readCalibrationLogText`. Used by the dedupe check. */
  readCalibrationLogTextFn?: (cwd: string) => string | undefined;
}

/**
 * Guard-dispatcher entry point. Uses `resolveTurnLines` (mt#3028 fix (1)) —
 * `ctx.transcriptLines` (D6) as-is when there is at most one transcript
 * candidate, otherwise a fresh parse of the parent candidate alone, so a
 * dispatched subagent's own final report is never measured as this
 * session's turn-end report. Before logging, checks the dedupe hash
 * (mt#3028 fix (2)) so an unchanged report already logged for this session
 * is not re-logged. The `calibration` field is always returned on a match
 * (forwarded to `logCalibrationRecord` per this guard's
 * `calibrationLog: "wall-of-text"` registration); `additionalContext` (LIVE
 * since mt#3112) is ALSO returned, UNLESS the depth-request override
 * (mt#3112 — `detectDepthRequest` over the recent real user prompts) found
 * the principal recently asked for exactly this depth, in which case the
 * fire still logs (with `suppressedByDepthRequest: true`) but injects
 * nothing.
 */
export function run(
  input: ClaudeHookInput,
  ctx: DispatchContext,
  deps: RunDeps = {}
): GuardOutcome | null {
  const overrideVal = process.env[OVERRIDE_ENV_VAR];
  const isOverride =
    overrideVal === "1" ||
    overrideVal?.toLowerCase() === "true" ||
    overrideVal?.toLowerCase() === "yes";
  if (isOverride) {
    return {
      auditLines: [
        `[wall-of-text-detector] OVERRIDE: ack=${overrideVal} session=${input.session_id ?? "unknown"} ts=${new Date().toISOString()}\n`,
      ],
    };
  }

  if (!input.transcript_path) return null;
  const parseTranscriptFn = deps.parseTranscriptFn ?? parseTranscript;
  const readCalibrationLogTextFn = deps.readCalibrationLogTextFn ?? readCalibrationLogText;

  const lines = resolveTurnLines(input, ctx, parseTranscriptFn);
  if (lines.length === 0) return null;

  let turnLines: TranscriptLine[];
  try {
    turnLines = extractLastAssistantTurn(lines);
  } catch {
    return null;
  }
  if (turnLines.length === 0) return null;

  let measurement: WallOfTextMeasurement;
  let finalText: string;
  try {
    finalText = extractFinalAssistantText(turnLines);
    if (finalText.length === 0) return null;
    measurement = measureWallOfText(finalText);
  } catch (err) {
    process.stderr.write(
      `[wall-of-text-detector] Measurement error: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return null;
  }

  if (!measurement.matched) return null;

  const textHash = hashText(finalText);
  if (sessionHasLoggedHash(readCalibrationLogTextFn(input.cwd), input.session_id, textHash)) {
    // mt#3028 fix (2): a record for this session already carries this exact
    // measured text (within the bounded lookback window) — an unchanged
    // report already logged; skip re-logging.
    return null;
  }

  // mt#3112: depth-request override-awareness. Look back over the recent
  // real user prompts up to and including the one that opened the measured
  // turn (never the CURRENT prompt — it arrives after the report and cannot
  // have caused it).
  const promptIndices = findRealPromptIndices(lines);
  const openingPromptIdx = promptIndices[promptIndices.length - 2] ?? 0;
  const depthCheck = detectDepthRequest(recentUserPromptTexts(lines, openingPromptIdx));

  const outcome: GuardOutcome = {
    calibration: buildCalibrationRecord(input, measurement, textHash, depthCheck.matched),
  };

  if (INJECTION_ENABLED && !depthCheck.matched) {
    outcome.additionalContext = buildInjectionReminder(measurement);
  }

  return outcome;
}

function buildInjectionReminder(m: WallOfTextMeasurement): string {
  return [
    "[wall-of-text-detector] Turn-end report shape violation detected (mt#2870).",
    "",
    `The prior turn's final report ran ${m.wordCount} words${
      m.leadLabelHits.length > 0
        ? ` and led with skill-internal labels (${m.leadLabelHits.join(", ")}).`
        : "."
    }`,
    "",
    "The Tier-1 turn-report contract (communication-contract.mdc): what happened /",
    "what you need to know / what's next, each 1-3 sentences, ~200 words total,",
    "plain-language lead, detail behind pointers.",
    "",
    `Override: ${OVERRIDE_ENV_VAR}=1.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Standalone CLI entrypoint
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const capInfo = readHostCap("wall-of-text-detector.ts", undefined, {
    events: ["UserPromptSubmit"],
  });
  if (capInfo.warning) {
    process.stderr.write(`[wall-of-text-detector] ${capInfo.warning}\n`);
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
      `[wall-of-text-detector] OVERRIDE: ack=${overrideVal} session=${input.session_id ?? "unknown"} ts=${ts}\n`
    );
    process.exit(0);
  }

  const transcriptPath = input.transcript_path;
  if (!transcriptPath) {
    process.exit(0);
  }

  if (Date.now() >= overallDeadline) {
    process.stderr.write(
      `[wall-of-text-detector] budget exhausted before transcript read — skipping\n`
    );
    process.exit(0);
  }

  // PR #2175 R1 (class-not-instance): mirrors run()'s (resolveTurnLines's)
  // cross-transcript-contamination guard — the standalone CLI path had the
  // identical pre-existing gap the reviewer flagged for silent-stretch's
  // main(); fixing it here too keeps both detectors' CLI/dispatcher paths
  // consistent instead of leaving one asymmetrically patched.
  const lines = resolveParentTranscriptLinesForPath(transcriptPath, input.agent_id);
  if (lines.length === 0) {
    process.exit(0);
  }

  let turnLines: TranscriptLine[];
  try {
    turnLines = extractLastAssistantTurn(lines);
  } catch {
    process.exit(0);
  }

  if (turnLines.length === 0) {
    process.exit(0);
  }

  let measurement: WallOfTextMeasurement;
  let finalText = "";
  try {
    finalText = extractFinalAssistantText(turnLines);
    if (finalText.length === 0) {
      process.exit(0);
    }
    measurement = measureWallOfText(finalText);
  } catch (err) {
    console.error(
      `[wall-of-text-detector] Measurement error: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(0);
  }

  if (!measurement.matched) {
    process.exit(0);
  }

  // mt#3112: depth-request override-awareness (see run()'s equivalent check).
  const promptIndices = findRealPromptIndices(lines);
  const openingPromptIdx = promptIndices[promptIndices.length - 2] ?? 0;
  const depthCheck = detectDepthRequest(recentUserPromptTexts(lines, openingPromptIdx));

  const textHash = hashText(finalText);
  if (Date.now() < overallDeadline) {
    // mt#3028 fix (2): skip re-logging an unchanged report already recorded
    // for this session (see the header comment + run()'s equivalent check).
    const alreadyLogged = sessionHasLoggedHash(
      readCalibrationLogText(input.cwd),
      input.session_id,
      textHash
    );
    if (!alreadyLogged) {
      appendCalibrationRecord(
        input.cwd,
        buildCalibrationRecord(input, measurement, textHash, depthCheck.matched)
      );
    }
  }

  if (!INJECTION_ENABLED || depthCheck.matched) {
    process.exit(0);
  }

  const reminder = buildInjectionReminder(measurement);
  const output: HookOutput = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: reminder,
    },
  };
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

// Entrypoint guard: only run main() when this file is invoked as a script —
// the dispatcher's dynamic `import("./wall-of-text-detector")` must NOT
// trigger it (mt#2835 convention; see auto-session-title.ts).
if (import.meta.main) {
  await main();
}
