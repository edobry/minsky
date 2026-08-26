// Shared turn-extraction helpers for UserPromptSubmit detector hooks.
//
// Claude Code records `tool_result` blocks as USER-ROLE transcript lines. A
// naive "last assistant turn" that keys on every user-role line therefore
// SPLITS any turn that spans multiple tool round-trips at each tool_result,
// leaving only the trailing assistant segment after the final tool_result.
// That both false-positives (a completion claim in a later segment whose
// minting tool ran in an earlier segment looks tool-less — mt#2197) and
// under-detects (a trigger phrase in a non-final assistant segment is never
// scanned — substrate-bypass / retrospective scanners).
//
// The fix: bound the "just-completed turn" on REAL USER PROMPTS, not on every
// user-role line. A real prompt carries text content (a string, or a content
// array containing a `text` block); a tool_result line is a user-role content
// array of only `tool_result` blocks. Keying on real prompts makes the span
// from the prior real prompt through ALL interleaved assistant + tool_result
// lines — a full logical turn.
//
// This module is the single definition of the turn-boundary logic. Eleven
// detector hooks and their tests import from here — see ADR-031's
// classification table for the full caller list (the original comment here
// named three, which was accurate at mt#2255 and has not been true for a while).
//
// WHY THIS READS A FILE THE VENDOR WARNS MAY LAG. Claude Code's hooks
// reference says hooks needing the final assistant text of the current turn
// should use `last_assistant_message` on Stop rather than reading
// `transcript_path`, which "is written asynchronously and may lag the
// in-memory conversation". That guidance is FOLLOWED for what it covers and
// deviated from for what it does not: ten of the eleven callers need the
// turn's TOOL CALLS, which `last_assistant_message` does not carry at all, so
// the transcript is the only source that exists. Given it must be read, it is
// read at `UserPromptSubmit` — where the file has had the MOST time to flush —
// rather than at `Stop`, where it has had the least. Do not "fix" this by
// moving the transcript read to Stop; that makes the lag exposure worse, and
// the reasoning (plus the four options considered and the three rejected) is
// recorded so it does not have to be re-derived a seventh time.
//
// @see docs/architecture/adr-031-guidance-detector-lifecycle-event.md — the
//      event-architecture decision governing this module (task mt#3292)
// @see mt#2255 — this task
// @see .claude/hooks/types.ts — sibling cross-hook util home (readInput, readHostCap, deriveBudgets)

import {
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Transcript JSONL types (minimal subset the detectors use)
// ---------------------------------------------------------------------------

export interface TranscriptLine {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
  // tool_use lines may carry name/input at top level OR inside message.content
  name?: string;
  tool_name?: string;
  input?: Record<string, unknown>;
  /**
   * ISO-8601 wall-clock timestamp Claude Code stamps on every transcript
   * line (user/assistant/tool_result alike). Optional here because not
   * every caller-constructed synthetic TranscriptLine in tests sets it, but
   * real on-disk transcripts always carry it. Added for mt#2824 (silent-
   * stretch detector) — the first consumer that needs wall-clock gap
   * measurement rather than just line-order/content.
   */
  timestamp?: string;
  /**
   * Harness-synthetic-message marker (mt#2357). Claude Code stamps
   * `isMeta: true` on user-role lines it synthesizes itself — Skill-tool
   * invocation bodies ("Base directory for this skill: ..."), skill
   * re-invocation notices, and some local-command caveat lines. Verified
   * across recent live transcripts (2026-07-21): all 31 skill-body lines
   * sampled carry `isMeta: true`; typed and queued human prompts never do.
   * Excluded from {@link isRealUserPrompt} so a skill launch does not split
   * the logical turn.
   */
  isMeta?: boolean;
  /**
   * Auto-compaction-boundary marker (mt#4289). Claude Code stamps
   * `isCompactSummary: true` on the ~15KB model-written summary it appends as a
   * `user`-role line when it compacts a conversation.
   *
   * It is a SEPARATE marker from `isMeta`, not a special case of it: the
   * boundary record carries no `isMeta` at all (verified 2026-08-19 — its key
   * set is `cwd, entrypoint, gitBranch, isCompactSummary, isSidechain,
   * isVisibleInTranscriptOnly, message, parentUuid, promptId, sessionId,
   * session_id, slug, timestamp, type, userType, uuid, version`). And its
   * `message.content` is a plain STRING, so it takes {@link isRealUserPrompt}'s
   * string branch, which until mt#4289 excluded only interrupt-marker and
   * skill-body text — meaning every detector downstream read a compaction
   * boundary as an operator prompt, i.e. as a turn boundary the operator never
   * created.
   */
  isCompactSummary?: boolean;
  /** Line identity stamped by Claude Code; used for stable turn keying (mt#2357). */
  uuid?: string;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a JSONL transcript file. Returns one object per non-blank line,
 * skipping malformed lines. Never throws — returns [] on any read error.
 */
export function parseTranscript(transcriptPath: string): TranscriptLine[] {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return [];
  }

  const result: TranscriptLine[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      result.push(JSON.parse(trimmed) as TranscriptLine);
    } catch {
      // skip malformed line, continue
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Transcript-candidate resolution (subagent-aware, mt#2637)
// ---------------------------------------------------------------------------

/**
 * Resolve the ordered list of transcript files that may record the ACTIVE
 * agent's tool calls, from the hook-input `transcript_path` and (for subagent
 * calls) `agent_id`.
 *
 * Background-Agent-dispatched subagents receive a `transcript_path` pointing
 * at the PARENT session's top-level `<session-id>.jsonl`, while their own
 * tool_use lines are recorded at
 * `<dir>/<session-id>/subagents/agent-<agentId>.jsonl` (mt#2637 — confirmed
 * by natural experiment across the mt#2607 burndown waves). The upstream
 * hooks reference documents `agent_id` ("present only when the hook fires
 * inside a subagent call") but is silent on per-agent transcript_path
 * semantics, so hooks must resolve the candidates themselves.
 *
 * Candidates, in scan order:
 *   1. the given `transcript_path` — main-thread behavior, and also covers
 *      the orchestrator-pre-read pattern (the PARENT surfaced the content);
 *   2. when the given path is itself a per-agent file, the PARENT session's
 *      top-level transcript (tree semantics in the other direction);
 *   3. when `agentId` is provided, the precise per-agent file;
 *   4. every sibling `agent-*.jsonl` under the session's `subagents/` dir —
 *      a fallback that does not depend on the (undocumented) correspondence
 *      between the hook-input agent_id and the on-disk filename id. The
 *      session is treated as one conversation TREE: content surfaced by the
 *      parent or any dispatched agent counts for the whole tree.
 *
 * Nonexistent candidates are harmless — {@link parseTranscript} returns []
 * on any read error. Never throws.
 */
export function resolveTranscriptCandidates(transcriptPath: string, agentId?: string): string[] {
  const candidates: string[] = [transcriptPath];
  if (!transcriptPath.endsWith(".jsonl")) return candidates;

  const pushUnique = (p: string): void => {
    if (!candidates.includes(p)) candidates.push(p);
  };

  // Derive the session's subagents/ dir from either input shape:
  //   - top-level `<dir>/<session-id>.jsonl` (main thread; also what
  //     background subagents currently receive) -> `<dir>/<session-id>/subagents`
  //   - already a per-agent file `<dir>/<session-id>/subagents/agent-<id>.jsonl`
  //     -> its own directory; also add the parent `<dir>/<session-id>.jsonl`
  let subagentsDir: string;
  const base = basename(transcriptPath);
  if (base.startsWith("agent-") && basename(dirname(transcriptPath)) === "subagents") {
    subagentsDir = dirname(transcriptPath);
    pushUnique(`${dirname(subagentsDir)}.jsonl`); // parent session transcript
  } else {
    subagentsDir = join(transcriptPath.slice(0, -".jsonl".length), "subagents");
  }

  if (agentId) {
    pushUnique(join(subagentsDir, `agent-${agentId}.jsonl`));
  }

  try {
    for (const entry of readdirSync(subagentsDir)) {
      if (!entry.startsWith("agent-") || !entry.endsWith(".jsonl")) continue;
      pushUnique(join(subagentsDir, entry));
    }
  } catch {
    // no subagents dir — a session with no background dispatches
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Parent-scoped turn resolution (mt#3003 — shared anchoring fix)
// ---------------------------------------------------------------------------

/**
 * True iff `path` is a per-agent subagent transcript file — i.e. its
 * basename starts with `agent-` AND its containing directory is named
 * `subagents`. Mirrors the exact shape check `resolveTranscriptCandidates`
 * itself uses to recognize a per-agent path. A parent (session-level)
 * transcript never lives directly under a `subagents/` directory, so this
 * is the structural discriminator `resolveParentTranscriptLines` uses to
 * find the true parent candidate instead of assuming positional order
 * (PR #2175 R1 — `transcriptCandidates[0]` is NOT always the parent).
 * Accepts `undefined` defensively (a malformed/synthetic candidates entry —
 * the real `resolveTranscriptCandidates` never produces one) and treats it
 * as "not a subagent path" rather than throwing, so a bogus entry degrades
 * to the next fallback in `resolveParentTranscriptLines` instead of crashing.
 */
function isSubagentTranscriptPath(path: string | undefined): boolean {
  if (!path) return false;
  return basename(path).startsWith("agent-") && basename(dirname(path)) === "subagents";
}

/**
 * Resolve the transcript lines to measure THIS conversation's own
 * turn/silence signal against, scoped to the PARENT transcript alone
 * whenever more than one transcript candidate is in play.
 *
 * **Why this exists.** A guard's `ctx.transcriptLines` (registry.ts D6) is
 * `transcriptCandidates.flatMap(parseTranscript)` — the PARENT transcript
 * concatenated with EVERY sibling subagent transcript under the session's
 * `subagents/` dir ({@link resolveTranscriptCandidates}'s unconditional
 * "every sibling" fallback, mt#2637), with no per-line file-origin marker.
 * `findRealPromptIndices`/`extractLastAssistantTurn` operating over that
 * flattened array can therefore anchor on a prompt boundary that lives
 * inside a SUBAGENT's own (already-completed, no-longer-growing) transcript
 * file rather than the live, growing parent conversation. Because
 * `resolveTranscriptCandidates` always places subagent files AFTER the
 * parent file in candidate order, and `flatMap` preserves that order, a
 * subagent's own final real-prompt boundary is ALWAYS later in the flattened
 * array than every parent-transcript line — no matter how much the parent
 * conversation grows afterward. The last-two-real-prompt anchor
 * (`findRealPromptIndices`) therefore gets permanently stuck inside that
 * static subagent segment, and every subsequent hook firing re-measures the
 * exact same frozen turn.
 *
 * This is the actual root cause of the "stale turn re-measurement" bug
 * originally hypothesized (mt#3003 planning) as `findRealPromptIndices`
 * missing some NEW-PROMPT shape. Investigation against the three named
 * calibration sessions (3bf59029, 2c9ac5e6, 762cde32 — all of which have a
 * populated `subagents/` dir) found no missed real-prompt shape:
 * {@link isRealUserPrompt} correctly classified every plain-text human
 * prompt, slash-command echo, and tool_result line encountered. The
 * repeated-identical-record shape is fully explained by cross-transcript
 * contamination instead. wall-of-text-detector.ts independently diagnosed
 * and fixed this exact mechanism for its own consumption (mt#3028,
 * `resolveTurnLines`) before this task's investigation concluded; this
 * hoists that fix here as the SHARED primitive scope names
 * (`.minsky/hooks/transcript.ts (anchoring/dedup helpers)`) so
 * silent-stretch-detector.ts — which had the identical latent vulnerability,
 * never having been given its own copy of the mt#3028 fix — gets the same
 * guarantee instead of re-diagning/re-implementing it.
 *
 * Behavior: trusts `flatLines` as-is when there is at most one resolved
 * candidate (the common case — no subagents dispatched this conversation).
 * When `transcriptCandidates` names more than one file, re-parses the
 * PARENT candidate — never a per-agent `subagents/agent-*.jsonl` file — ALONE,
 * so a dispatched subagent's own content can never be measured as if it
 * were part of the live conversation's own turn.
 *
 * **Parent identification (PR #2175 R1 BLOCKING fix).** Does NOT assume
 * `transcriptCandidates[0]` is the parent. Per
 * {@link resolveTranscriptCandidates}'s own doc comment, when the GIVEN
 * `transcriptPath` is itself a per-agent file (the "tree semantics in the
 * other direction" branch — basename starts with `agent-` under a
 * `subagents/` dir), the candidate array places THAT per-agent file FIRST
 * and pushes the true parent session transcript LATER. Trusting
 * `candidates[0]` in that shape would scope this function to the SUBAGENT's
 * own transcript instead of the parent — silently reintroducing the exact
 * stale-turn-freeze bug this function exists to fix. Instead, the parent is
 * identified structurally: the first candidate whose path is NOT itself a
 * per-agent `subagents/agent-*.jsonl` file (a parent-transcript path never
 * lives directly under a `subagents/` directory). Falls back to
 * `transcriptCandidates[0]` only if every candidate looks agent-shaped (a
 * defensive case `resolveTranscriptCandidates` should never actually
 * produce, since it always includes the true parent as one entry whenever
 * `transcriptPath` ends in `.jsonl`).
 *
 * `parseTranscriptFn` is injectable (defaults to the real
 * {@link parseTranscript}) so callers/tests can exercise the multi-candidate
 * branch against an in-memory fixture instead of a real file
 * (`custom/no-real-fs-in-tests`).
 *
 * @see resolveTranscriptCandidates — mt#2637, produces the candidate order this relies on
 * @see mt#3028 — the wall-of-text-detector.ts fix this generalizes
 * @see mt#3003 — this task (hoists the fix to a shared helper + wires silent-stretch-detector.ts to it)
 */
export function resolveParentTranscriptLines(
  transcriptPath: string | undefined,
  transcriptCandidates: string[] | undefined,
  flatLines: TranscriptLine[],
  parseTranscriptFn: (path: string) => TranscriptLine[] = parseTranscript
): TranscriptLine[] {
  if (Array.isArray(transcriptCandidates) && transcriptCandidates.length > 1) {
    const parentPath =
      transcriptCandidates.find((c) => !isSubagentTranscriptPath(c)) ??
      (transcriptPath && !isSubagentTranscriptPath(transcriptPath) ? transcriptPath : undefined) ??
      transcriptCandidates[0];
    if (parentPath) return parseTranscriptFn(parentPath);
  }
  return flatLines;
}

/**
 * CLI-entrypoint convenience wrapper (PR #2175 R1 BLOCKING fix): resolves
 * the parent-scoped transcript lines for a STANDALONE (non-dispatcher) hook
 * invocation, given only the hook's own `transcriptPath` and optional
 * `agentId` — no `DispatchContext`/`transcriptCandidates` is available in
 * that mode, so a standalone `main()` previously called `parseTranscript`
 * on the raw path alone and got NONE of `resolveParentTranscriptLines`'s
 * contamination guarantee (the dispatcher `run()` path got it via `ctx`,
 * the CLI path silently didn't — divergent, and a stale-turn-freeze risk
 * whenever the CLI is invoked with a per-agent `transcriptPath`, or more
 * generally against a session with dispatched subagents).
 *
 * Reconstructs the SAME candidate set the dispatcher resolves
 * ({@link resolveTranscriptCandidates}), then applies
 * {@link resolveParentTranscriptLines}'s parent-only scoping on top — so a
 * standalone CLI invocation gets the identical guarantee as the dispatcher
 * path from a single call.
 *
 * Only flattens (parses) every candidate when there is at most one — the
 * common case, where `resolveParentTranscriptLines` trusts that flattened
 * result as-is. When more than one candidate is resolved,
 * `resolveParentTranscriptLines` always discards the flattened array in
 * favor of re-parsing the parent alone, so eagerly parsing every subagent
 * transcript first (only to throw the result away) would be pure wasted
 * I/O — this passes `[]` in that branch instead.
 */
export function resolveParentTranscriptLinesForPath(
  transcriptPath: string,
  agentId: string | undefined,
  parseTranscriptFn: (path: string) => TranscriptLine[] = parseTranscript
): TranscriptLine[] {
  const candidates = resolveTranscriptCandidates(transcriptPath, agentId);
  const flatLines = candidates.length > 1 ? [] : candidates.flatMap((p) => parseTranscriptFn(p));
  return resolveParentTranscriptLines(transcriptPath, candidates, flatLines, parseTranscriptFn);
}

// ---------------------------------------------------------------------------
// Per-session dedupe-log primitives (mt#3003 — shared dedup helpers)
// ---------------------------------------------------------------------------

/**
 * Default bound on how much of a calibration log a dedupe check reads,
 * regardless of how large the file grows over time — these logs have no
 * rotation, so an unbounded read would grow with them (originally sized in
 * wall-of-text-detector.ts, mt#3028 / PR #2165 R1 BLOCKING #2). 256 KiB is
 * generously many hundreds of JSONL records at these logs' typical line
 * size (~100-250 bytes) — comfortably more history than any realistic
 * same-session dedupe window needs.
 */
export const DEFAULT_MAX_DEDUPE_READ_BYTES = 262144;

/**
 * Real on-disk read of (at most) the last `maxBytes` of `logPath`. Bounded
 * per-invocation disk-I/O cost regardless of total log size; never throws —
 * returns undefined on any read error or a missing file. Hoisted from
 * wall-of-text-detector.ts's `readCalibrationLogText` (mt#3028) so any
 * calibration-log-backed dedupe check (silent-stretch-detector.ts included,
 * mt#3003) gets the identical bounded-read guarantee without
 * re-implementing the byte-offset seek.
 */
export function readLogTailText(
  logPath: string,
  maxBytes: number = DEFAULT_MAX_DEDUPE_READ_BYTES
): string | undefined {
  try {
    if (!existsSync(logPath)) return undefined;
    const size = statSync(logPath).size;
    if (size <= maxBytes) {
      return readFileSync(logPath, "utf-8");
    }
    const fd = openSync(logPath, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      readSync(fd, buf, 0, maxBytes, size - maxBytes);
      return buf.toString("utf-8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/**
 * True iff `sessionId` has a calibration record in `logText` (raw JSONL
 * contents, or a bounded TAIL of it — see {@link readLogTailText}) whose
 * `keyField` property equals `keyValue`. Scans EVERY record for this
 * session, not just the most recent one — an A -> B -> A sequence must
 * still dedupe the repeat A even though B is the most recent record for the
 * session (wall-of-text-detector.ts mt#3028 / PR #2165 R1 BLOCKING #1).
 * Generalized from that file's `sessionHasLoggedHash` (which always
 * compared a fixed `"textHash"` field) to an arbitrary `keyField` so a
 * detector can dedupe on whatever notion of "unchanged" fits its own
 * measurement — a content hash (wall-of-text) or a turn-boundary anchor
 * (silent-stretch-detector.ts, mt#3003 — see its `buildTurnAnchor`). Pure —
 * operates on a string, not a file path, so tests exercise it with an
 * in-memory fixture (`custom/no-real-fs-in-tests`).
 */
export function sessionHasLoggedKey(
  logText: string | undefined,
  sessionId: string | undefined,
  keyField: string,
  keyValue: string
): boolean {
  if (!logText || !sessionId) return false;
  for (const raw of logText.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (rec["session_id"] === sessionId && rec[keyField] === keyValue) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Real-user-prompt discriminator
// ---------------------------------------------------------------------------

function isUserRole(line: TranscriptLine): boolean {
  return line.type === "user" || line.message?.role === "user";
}

/**
 * Claude Code-synthesized markers recorded with `role: "user"` and a single
 * `{ type: "text" }` content block that are NOT actual human input — they
 * mark a harness-internal event (the user cancelled an in-flight tool call).
 * Excluded from {@link isRealUserPrompt} so they don't spuriously reset a
 * turn boundary at the exact instant of interruption.
 *
 * Discovered (mt#2824) while replaying the two originating silent-stretch
 * incident transcripts: in both, this exact marker landed ~20ms before the
 * operator's actual complaint message. Naively treating it as a real prompt
 * boundary collapsed the measured "turn" down to those 20ms — hiding the
 * real ~24/28-minute silent stretch that precedes it, which is exactly the
 * signal the silent-stretch detector needs to see. Confirmed exhaustive
 * (only two literal variants found) via a corpus scan across ~300 local
 * transcript files.
 */
const SYNTHETIC_INTERRUPT_MARKERS: ReadonlySet<string> = new Set([
  "[Request interrupted by user for tool use]",
  "[Request interrupted by user]",
]);

/**
 * Skill-tool invocation bodies are recorded as user-role TEXT lines whose
 * text opens with this prefix (mt#2357). They are harness plumbing — the
 * Skill tool returning the skill's instructions — not human input, so they
 * must not bound a logical turn. The primary discriminator is the
 * `isMeta: true` flag ({@link TranscriptLine.isMeta}); this prefix check is
 * the belt-and-suspenders fallback for any harness version or transcript
 * that does not stamp the flag. Originating incident: every `/skill`
 * invocation split the scanned turn at the skill launch, corrupting all
 * eight turn-boundary consumers (e.g. resetting the silent-stretch silence
 * clock mid-turn, and the mt#2467 substrate-bypass suppression FP).
 */
const SKILL_BODY_PREFIX = "Base directory for this skill:";

function isSkillBodyText(trimmedText: string): boolean {
  return trimmedText.startsWith(SKILL_BODY_PREFIX);
}

/**
 * True iff `trimmedText` is exactly one of {@link SYNTHETIC_INTERRUPT_MARKERS}.
 * Shared by BOTH content shapes `isRealUserPrompt` checks (string content and
 * array-of-text-blocks content) — PR #1963 R2 finding: the original fix only
 * covered the array-content-block shape (the shape actually observed in the
 * two originating transcripts) and asserted, without defensive justification,
 * that the string shape "needs no exclusion check" because the marker hadn't
 * been OBSERVED there. That the array shape's exact form was itself a
 * surprise (Claude Code's transcript format is not a schema this repo
 * controls or can assume is stable) means "not yet observed in one shape" is
 * not evidence the OTHER shape is safe — both shapes get the same check.
 */
function isSyntheticInterruptText(trimmedText: string): boolean {
  return SYNTHETIC_INTERRUPT_MARKERS.has(trimmedText);
}

function isRealTextBlock(block: unknown): boolean {
  if (!block || typeof block !== "object") return false;
  const b = block as Record<string, unknown>;
  if (b["type"] !== "text") return false;
  const text = typeof b["text"] === "string" ? b["text"].trim() : undefined;
  if (text !== undefined && isSyntheticInterruptText(text)) return false;
  if (text !== undefined && isSkillBodyText(text)) return false;
  return true;
}

/**
 * True iff `line` is a REAL user prompt (text from the human), as opposed to a
 * `tool_result` line that Claude Code also records with user role, or a
 * {@link SYNTHETIC_INTERRUPT_MARKERS} harness-internal marker.
 *
 * A real prompt carries text content:
 *   - `message.content` is a STRING that is not itself (once trimmed) a
 *     synthetic interrupt marker — even empty/whitespace otherwise still
 *     counts as real (a string-content user line is never a `tool_result`,
 *     which is always an array, so an ordinary string is a genuine human
 *     boundary — review NON-BLOCKING, mt#2255), OR
 *   - `message.content` is an array containing at least one `{ type: "text" }`
 *     block whose text is not a synthetic interrupt marker.
 *
 * A tool_result line is a user-role content array whose blocks are all
 * `tool_result` (no `text` block) — it returns false here. A
 * synthetic-interrupt-marker-only line is likewise excluded, in EITHER
 * content shape (PR #1963 R2 — both shapes must be covered, not just the
 * array-content-block shape actually observed in the wild).
 */
export function isRealUserPrompt(line: TranscriptLine): boolean {
  if (!isUserRole(line)) return false;
  // Harness-synthetic user-role lines (skill bodies, re-invocation notices)
  // are marked isMeta and are never human prompts (mt#2357).
  if (line.isMeta === true) return false;
  // The auto-compaction summary is harness-written too, and carries its OWN
  // marker rather than isMeta (mt#4289) — so it needs its own check here, not
  // a widening of the one above. See TranscriptLine.isCompactSummary.
  if (line.isCompactSummary === true) return false;
  const content = line.message?.content;
  if (typeof content === "string") {
    const trimmed = content.trim();
    return !isSyntheticInterruptText(trimmed) && !isSkillBodyText(trimmed);
  }
  if (Array.isArray(content)) {
    return content.some(isRealTextBlock);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Turn extraction
// ---------------------------------------------------------------------------

/**
 * Return the transcript-line index of every REAL user prompt, in order.
 *
 * Factored out of {@link extractLastAssistantTurn} (mt#2824) so callers that
 * need the boundary LINES themselves — not just the turn slice between them
 * — can locate them without re-implementing the real-prompt scan. The
 * silent-stretch detector is the first such consumer: it needs the previous
 * and current prompts' `timestamp` fields to measure wall-clock silence,
 * which `extractLastAssistantTurn`'s turn-slice return value (exclusive of
 * both boundary lines) does not expose.
 */
export function findRealPromptIndices(lines: TranscriptLine[]): number[] {
  const promptIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (isRealUserPrompt(line)) promptIndices.push(i);
  }
  return promptIndices;
}

/** The just-completed turn plus the boundary a caller should treat as its start. */
export interface CompletedTurn {
  /** Every line of the turn that just completed, in transcript order. */
  turnLines: TranscriptLine[];
  /**
   * Index of the real user prompt that OPENED `turnLines`, or undefined when
   * no turn could be resolved. Consumers that need the opening prompt's own
   * timestamp, or a lookback window over prompts at-or-before it, must read it
   * from here rather than recomputing `promptIndices[length - 2]` — that
   * expression is only correct in one of the two shapes below.
   */
  openingPromptIndex: number | undefined;
  /** Whether the prompt that fired this hook had already been written to the transcript. */
  firingPromptLanded: boolean;
}

/**
 * Resolve the just-completed turn from what the transcript ACTUALLY contains,
 * rather than from an assumed prompt count.
 *
 * At `UserPromptSubmit` the prompt that fired the hook is usually not in the
 * transcript yet, so the pre-mt#3280 rule — "the span between the last two
 * real prompts, the last one being the firing prompt" — returned the turn
 * BEFORE the one that just completed. Claude Code's hooks reference documents
 * the underlying property (`transcript_path`, common input fields): the
 * transcript "is written asynchronously and may lag the in-memory
 * conversation, so it may not yet include the current turn's most recent
 * messages when a hook fires."
 *
 * Because that lag is asynchronous, NEITHER shape can be assumed and a fixed
 * one-boundary correction would be wrong whenever the prompt does land in
 * time. The transcript answers the question itself:
 *
 * - Lines exist AFTER the last real prompt. Nothing can follow the firing
 *   prompt at `UserPromptSubmit` time, so that prompt has not landed; the last
 *   real prompt is the one that OPENED the completed turn, and the lines after
 *   it are the turn.
 * - Nothing follows the last real prompt. It is the newest line in the file —
 *   the firing prompt, which landed before the read. The completed turn is
 *   then the span between the last two real prompts, which is exactly what
 *   this function returned before mt#3280 and is correct in this shape.
 *
 * Under the first shape a conversation's FIRST turn now resolves too (one real
 * prompt is enough), where the two-prompt guard previously returned [].
 *
 * Returns empty `turnLines` when the transcript holds no real prompt at all,
 * and when the firing prompt landed but no earlier prompt exists to bound the
 * turn against.
 *
 * @see extractFinalTurn — the Stop-event sibling, which takes the same tail
 *   unconditionally because at Stop time no subsequent prompt exists yet.
 */
export function resolveCompletedTurn(lines: TranscriptLine[]): CompletedTurn {
  const promptIndices = findRealPromptIndices(lines);
  if (promptIndices.length === 0) {
    return { turnLines: [], openingPromptIndex: undefined, firingPromptLanded: false };
  }

  const lastPromptIdx = promptIndices[promptIndices.length - 1] as number;
  const tail = lines.slice(lastPromptIdx + 1);
  if (tail.length > 0) {
    return { turnLines: tail, openingPromptIndex: lastPromptIdx, firingPromptLanded: false };
  }

  if (promptIndices.length < 2) {
    return { turnLines: [], openingPromptIndex: undefined, firingPromptLanded: true };
  }
  const openingPromptIndex = promptIndices[promptIndices.length - 2] as number;
  return {
    turnLines: lines.slice(openingPromptIndex + 1, lastPromptIdx),
    openingPromptIndex,
    firingPromptLanded: true,
  };
}

/**
 * Stable identity of a real-prompt line, for anchor matching.
 *
 * MUST agree with `turnKeyFor` in `./turn-end-scan-store`, which is what the
 * `Stop`-side recorder uses to WRITE the key this function matches against.
 * The two are deliberately not a shared import — that would make this module,
 * the lowest layer, depend on a store — so `turn-anchor-store.test.ts` pins
 * their agreement instead. If you change one, that test fails.
 */
function anchorKeyOf(line: TranscriptLine | undefined): string | undefined {
  return line?.uuid ?? line?.timestamp;
}

/**
 * Resolve the just-completed turn from a RECORDED anchor rather than by
 * inferring the boundary from prompt positions (mt#3490, ADR-031).
 *
 * `resolveCompletedTurn` above answers "which span is the completed turn?" by
 * reading the shape of the file — a good inference, and still the fallback, but
 * an inference. Six of the seven fixes in this area were spent correcting it.
 * When the `Stop`-side recorder captured this conversation's turn key, the
 * boundary is not inferred at all: find that exact line and take the span from
 * it to the next real prompt.
 *
 * The key is the OPENING real prompt of the completed turn. At `Stop` time that
 * line was the transcript's LAST real prompt; by the next `UserPromptSubmit` it
 * is the SECOND-TO-LAST, because the firing prompt has landed after it — the
 * same physical line in both reads, which is exactly what makes it a usable
 * cross-event key.
 *
 * Returns `undefined` — never a wrong window — when the key names no real
 * prompt in `lines`. That happens legitimately (a compacted transcript, a
 * subagent-scoped read, an anchor from a prior conversation) and the caller
 * MUST fall back to {@link resolveCompletedTurn}. Returning `undefined` rather
 * than an empty turn is what keeps "no anchor" and "anchor names an empty turn"
 * distinguishable at the call site.
 *
 * @see .minsky/hooks/turn-anchor-store.ts — where the key comes from
 * @see docs/architecture/adr-031-guidance-detector-lifecycle-event.md
 */
export function resolveCompletedTurnFromAnchor(
  lines: TranscriptLine[],
  turnKey: string
): CompletedTurn | undefined {
  // "session-start" is `turnKeyFor`'s sentinel for "no opening prompt existed".
  // It names no line, so it can only ever produce a wrong match — refuse it
  // explicitly rather than relying on it failing to match by luck.
  if (!turnKey || turnKey === "session-start") return undefined;

  const promptIndices = findRealPromptIndices(lines);
  const anchorPos = promptIndices.findIndex((i) => anchorKeyOf(lines[i]) === turnKey);
  if (anchorPos < 0) return undefined;

  const anchorIdx = promptIndices[anchorPos] as number;
  const nextPromptIdx = promptIndices[anchorPos + 1];
  const end = nextPromptIdx ?? lines.length;

  return {
    turnLines: lines.slice(anchorIdx + 1, end),
    openingPromptIndex: anchorIdx,
    // A real prompt AFTER the anchor is the firing prompt having landed —
    // the same distinction `resolveCompletedTurn` reports, derived here from
    // the recorded boundary instead of from the tail's emptiness.
    firingPromptLanded: nextPromptIdx !== undefined,
  };
}

/**
 * Extract the just-completed logical turn.
 *
 * Thin accessor over {@link resolveCompletedTurn} — see that function for how
 * the turn's boundaries are resolved and why they cannot be derived from a
 * fixed prompt offset. Callers that also need the turn's opening boundary
 * should call `resolveCompletedTurn` directly so their boundary can never
 * disagree with the window scanned here.
 *
 * Because the bounds are real prompts (not every user-role line), interleaved
 * `tool_result` user-role lines fall INSIDE the returned span rather than
 * splitting it. The result therefore covers all assistant segments AND all
 * tool_result lines of the turn — a full multi-round turn.
 *
 * Returns [] when no turn can be resolved.
 */
export function extractLastAssistantTurn(
  lines: TranscriptLine[],
  recordedAnchor?: { turnKey: string }
): TranscriptLine[] {
  return resolveCompletedTurnWithAnchor(lines, recordedAnchor).turnLines;
}

/**
 * The window resolution every prompt-time consumer should use (mt#3490).
 *
 * Prefers the RECORDED boundary and falls back to inferring it — the single
 * place that precedence lives, so no caller has to remember the order. This is
 * the "swap the shared helper underneath them" shape ADR-031's migration-cost
 * paragraph describes: a caller opts in by passing `ctx.recordedAnchor`, and
 * passing `undefined` is exactly the pre-mt#3490 behaviour.
 *
 * Falls back — rather than trusting the anchor blindly — whenever the recorded
 * key names no real prompt in `lines`. That is a legitimate, expected state
 * (a compacted transcript, an anchor from before a `/clear`, a subagent-scoped
 * read), which is why {@link resolveCompletedTurnFromAnchor} reports it as
 * `undefined` instead of returning an empty window that a caller could mistake
 * for a genuinely empty turn.
 */
export function resolveCompletedTurnWithAnchor(
  lines: TranscriptLine[],
  recordedAnchor?: { turnKey: string }
): CompletedTurn {
  if (recordedAnchor) {
    const anchored = resolveCompletedTurnFromAnchor(lines, recordedAnchor.turnKey);
    if (anchored) return anchored;
  }
  return resolveCompletedTurn(lines);
}

/**
 * Extract the FINAL (just-completed) turn: every line AFTER the last real
 * user prompt through end-of-transcript. This is the Stop-event counterpart
 * of {@link extractLastAssistantTurn} (mt#2357): at Stop time no subsequent
 * prompt exists yet, so the completed turn is the transcript's tail — a
 * shape extractLastAssistantTurn (which needs two bounding prompts) returns
 * [] for. Also returns the bounding prompt line itself so callers can key
 * the turn stably (`uuid` / `timestamp`) across a later prompt-time re-scan
 * of the same turn.
 *
 * Returns { turnLines: [], openingPrompt: undefined } when the transcript
 * has no real user prompt at all.
 */
export function extractFinalTurn(lines: TranscriptLine[]): {
  turnLines: TranscriptLine[];
  openingPrompt: TranscriptLine | undefined;
} {
  const promptIndices = findRealPromptIndices(lines);
  if (promptIndices.length === 0) return { turnLines: [], openingPrompt: undefined };
  const lastIdx = promptIndices[promptIndices.length - 1] as number;
  return { turnLines: lines.slice(lastIdx + 1), openingPrompt: lines[lastIdx] };
}

// ---------------------------------------------------------------------------
// Content extraction
// ---------------------------------------------------------------------------

function textFromContent(content: unknown): string[] {
  const parts: string[] = [];
  if (typeof content === "string") {
    parts.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (b["type"] === "text" && typeof b["text"] === "string") {
          parts.push(b["text"] as string);
        }
      }
    }
  }
  return parts;
}

/**
 * Concatenate all assistant text from a turn's lines (string content and
 * `text` blocks in content arrays). Non-assistant lines are ignored.
 */
export function extractAssistantText(turnLines: TranscriptLine[]): string {
  const parts: string[] = [];
  for (const line of turnLines) {
    if (line.type === "assistant" || line.message?.role === "assistant") {
      parts.push(...textFromContent(line.message?.content));
    }
  }
  return parts.join("\n");
}

/**
 * Extract every `tool_use` tool name from a turn. Handles both shapes:
 *   - a top-level line with `type === "tool_use"` and `name`/`tool_name`
 *   - a line whose `message.content` array contains `{ type: "tool_use",
 *     name }` blocks (the assistant-line shape)
 *
 * Single pass — a name may appear more than once if duplicated in the
 * transcript; callers that need uniqueness wrap the result in a Set.
 */
export function extractToolUseNames(turnLines: TranscriptLine[]): string[] {
  const names: string[] = [];
  for (const line of turnLines) {
    if (line.type === "tool_use") {
      const n = line.name ?? line.tool_name;
      if (n) names.push(n);
    }
    if (line.message?.content && Array.isArray(line.message.content)) {
      for (const block of line.message.content as Array<Record<string, unknown>>) {
        if (block["type"] === "tool_use" && typeof block["name"] === "string") {
          names.push(block["name"] as string);
        }
      }
    }
  }
  return names;
}

/**
 * Extract the `input` object of every `tool_use` block whose name equals
 * `toolName`. Unlike {@link extractToolUseNames} (turn-scoped name list), this
 * is meant to run over the FULL `parseTranscript()` output to answer "did tool
 * X ever run this session, and with what args?" — so it deliberately does NOT
 * turn-bound, sidestepping the role=user tool_result turn-boundary hazard
 * (mt#2255 / memory a3e60471: tool_result lines are user-role, so a turn slice
 * built on user-role boundaries silently drops earlier tool calls).
 *
 * Handles both transcript shapes, mirroring {@link extractToolUseNames}:
 *   - a top-level line with `type === "tool_use"`, `name`/`tool_name`, `input`
 *   - an assistant line whose `message.content` array contains
 *     `{ type: "tool_use", name, input }` blocks
 *
 * A tool_use with no object `input` contributes `{}` so callers can still count
 * the call; callers read individual fields defensively.
 */
export function findToolUseInputs(
  lines: TranscriptLine[],
  toolName: string
): Array<Record<string, unknown>> {
  const inputs: Array<Record<string, unknown>> = [];
  const pushInput = (raw: unknown): void => {
    inputs.push(raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {});
  };
  for (const line of lines) {
    if (line.type === "tool_use") {
      const n = line.name ?? line.tool_name;
      if (n === toolName) pushInput(line.input);
    }
    const content = line.message?.content;
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block && block["type"] === "tool_use" && block["name"] === toolName) {
          pushInput(block["input"]);
        }
      }
    }
  }
  return inputs;
}

/**
 * Concatenate the text content of a `tool_result` block's `content` field.
 * `content` is either a plain string or an array of blocks. The common shape
 * observed in real Claude Code transcripts is `{ type: "text", text }`, but
 * (PR #1982 review) matching is deliberately not pinned to `type === "text"`
 * exactly — ANY block carrying a string `text` field is accepted, so a
 * differently-tagged text block (a future harness format change, or an
 * alternate MCP content-block variant) is not silently dropped. A block
 * whose text is nested one level deeper — e.g. an embedded-resource-style
 * `{ content: [...] }` wrapper — is recursed into once. Non-text, non-nested
 * blocks are ignored; a malformed or absent content contributes "".
 */
export function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (typeof b["text"] === "string") {
        parts.push(b["text"] as string);
        continue;
      }
      if (b["content"] !== undefined) {
        const nested = extractToolResultText(b["content"]);
        if (nested) parts.push(nested);
      }
    }
    return parts.join("");
  }
  return "";
}

/**
 * JSON-parse `text` into an object, or undefined if `text` is absent /
 * unparseable / not a JSON object (e.g. an error-path plain-text result).
 */
function parseResultJson(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extract every `tool_use` block for `toolName`, each paired with (a) its own
 * call input, (b) the id its JSON result reports under `idField`, and (c) the
 * full parsed result object — for tools that MINT a new resource id
 * server-side rather than taking one as input (e.g. `mcp__minsky__tasks_create`,
 * which never receives a `taskId`: the backend assigns one and returns it in
 * the result). Contrast {@link findToolUseInputs}, which only reads the
 * CALL's input and cannot see a server-assigned id or confirm the call
 * actually succeeded.
 *
 * Correlation: Claude Code stamps every `tool_use` block with an `id`
 * (`toolu_...`); the matching outcome is a LATER user-role line whose
 * `message.content` array contains a `{ type: "tool_result", tool_use_id,
 * content }` block carrying that same id. `content` is JSON-parsed (via
 * {@link extractToolResultText} + {@link parseResultJson}). A `tool_use` with
 * no correlated result in `lines`, or whose result isn't parseable JSON,
 * contributes `createdId: undefined` and `result: undefined` rather than
 * throwing; `createdId` is additionally `undefined` when the parsed result
 * lacks a non-empty string at `idField` (including the error-path case — a
 * thrown command's result has no `taskId`). Exposing the full `result` object
 * (not just the extracted id) lets a caller apply its own additional
 * server-side-confirmation checks — e.g. requiring `result.success === true`
 * — without this generic helper needing tool-specific knowledge of what
 * "confirmed" means for every possible `toolName`.
 *
 * Handles both transcript shapes for tool_use, mirroring
 * {@link findToolUseInputs}: a top-level `type === "tool_use"` line, or an
 * assistant line whose `message.content` array contains a `tool_use` block.
 */
export function findCreatedResourceIds(
  lines: TranscriptLine[],
  toolName: string,
  idField: string
): Array<{
  input: Record<string, unknown>;
  createdId: string | undefined;
  result: Record<string, unknown> | undefined;
  resultText: string | undefined;
}> {
  // Pass 1: tool_use_id -> concatenated result text, from every tool_result
  // block anywhere in the transcript (not scoped to toolName — a tool_result
  // only carries its correlating id, not the originating tool's name).
  const resultTextById = new Map<string, string>();
  for (const line of lines) {
    const content = line.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<Record<string, unknown>>) {
      if (!block || block["type"] !== "tool_result") continue;
      const useId = block["tool_use_id"];
      if (typeof useId !== "string") continue;
      const text = extractToolResultText(block["content"]);
      if (text) resultTextById.set(useId, (resultTextById.get(useId) ?? "") + text);
    }
  }

  // Pass 2: tool_use blocks for toolName, resolving each against pass 1's map.
  const results: Array<{
    input: Record<string, unknown>;
    createdId: string | undefined;
    result: Record<string, unknown> | undefined;
    resultText: string | undefined;
  }> = [];
  const pushResult = (id: unknown, rawInput: unknown): void => {
    const input =
      rawInput && typeof rawInput === "object" ? (rawInput as Record<string, unknown>) : {};
    const resultText = typeof id === "string" ? resultTextById.get(id) : undefined;
    const result = parseResultJson(resultText);
    const idValue = result?.[idField];
    const createdId = typeof idValue === "string" && idValue.length > 0 ? idValue : undefined;
    // `resultText` is surfaced alongside the parsed form (mt#3730) because not
    // every id-minting call answers in JSON: the Minsky CLI prints
    // `Task mt#NNNN created successfully` unless given `--json`, and
    // `parseResultJson` correctly returns undefined for that, leaving a caller
    // with no way to reach an id that is plainly present in the text. Callers
    // that only want structured results keep ignoring this field.
    results.push({ input, createdId, result, resultText });
  };
  for (const line of lines) {
    if (line.type === "tool_use") {
      const n = line.name ?? line.tool_name;
      if (n === toolName) pushResult((line as Record<string, unknown>)["id"], line.input);
    }
    const content = line.message?.content;
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block && block["type"] === "tool_use" && block["name"] === toolName) {
          pushResult(block["id"], block["input"]);
        }
      }
    }
  }
  return results;
}

/**
 * The canned opening Claude Code writes into a `tool_result` when a tool call is
 * REFUSED — by the interactive prompt or by auto-mode's permission classifier.
 *
 * Established empirically, not from vendor documentation, which does not specify
 * the shape (mt#3533). Measured over the 460 local transcripts of this project on
 * 2026-08-11: 73 denial results, every one of them carrying `is_error: true` and
 * one of exactly two continuations — `"STOP what you are doing and wait for the
 * user to tell you how to proceed."` or `"To tell you how to proceed, the user
 * said:"` plus a free-text tail. The prefix below is the part common to both.
 *
 * The apostrophe alternation is deliberate: the corpus carries the straight form,
 * and a harness that ever emits the typographic one would otherwise silently stop
 * matching.
 */
export const TOOL_DENIAL_MARKER = /The user doesn[’']t want to proceed with this tool use/;

/** Opens the free-text tail carrying the refusal's stated reason, when one was given. */
const DENIAL_REASON_MARKER = /To tell you how to proceed, the user said:\s*/;

/** A tool call that was refused before it ran, paired with what it would have run. */
export interface DeniedToolCall {
  /** Transcript-line index of the DENIAL — callers order against this. */
  index: number;
  /**
   * The `tool_use_id` this denial correlated to — the call's IDENTITY.
   *
   * Exposed (mt#4111) because a caller that must skip exactly the denied
   * invocation cannot key on {@link command}: two calls in one turn can carry
   * byte-identical command text, and a denial followed by a permitted retry is
   * the ordinary shape. Keying on the text drops the retry too, which inverts
   * the signal for any caller whose subject is what the turn actually DID.
   */
  useId: string;
  toolName: string | undefined;
  input: Record<string, unknown>;
  /** The `command` input, for the shell-running tools; undefined for every other tool. */
  command: string | undefined;
  /**
   * The refusal's stated reason — the tail after {@link DENIAL_REASON_MARKER} —
   * or "" when the denial gave none. Note that in the observed corpus this tail
   * is usually the canned message echoed back rather than a human-written
   * reason, so an empty-ish value is the norm and carries no information.
   */
  reason: string;
}

/**
 * Every tool call in `lines` that was DENIED, correlated back to its originating
 * `tool_use` block so the caller can see what was refused, not merely that
 * something was.
 *
 * The correlation is the same `tool_use_id` join {@link findCreatedResourceIds}
 * uses; it is required here because the denial result carries only the id, and
 * the command — the thing a caller actually needs — lives on the call.
 */
export function findDeniedToolCalls(lines: TranscriptLine[]): DeniedToolCall[] {
  const denials: Array<{ index: number; useId: string; text: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const content = lines[i]?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<Record<string, unknown>>) {
      if (!block || block["type"] !== "tool_result") continue;
      const useId = block["tool_use_id"];
      if (typeof useId !== "string") continue;
      // BOTH conjuncts, not just the marker. Every one of the 73 denials in the
      // measured corpus carries `is_error: true`, and requiring it closes an
      // obvious false-positive vector: a SUCCESSFUL result whose body merely
      // CONTAINS the rejection string — reading a transcript file, grepping a
      // calibration log, or any tool that echoes prior conversation back.
      if (block["is_error"] !== true) continue;
      const text = extractToolResultText(block["content"]);
      if (TOOL_DENIAL_MARKER.test(text)) denials.push({ index: i, useId, text });
    }
  }
  if (denials.length === 0) return [];

  const callsById = new Map<string, { name: string | undefined; input: Record<string, unknown> }>();
  const remember = (id: unknown, name: unknown, rawInput: unknown): void => {
    if (typeof id !== "string") return;
    callsById.set(id, {
      name: typeof name === "string" ? name : undefined,
      input: rawInput && typeof rawInput === "object" ? (rawInput as Record<string, unknown>) : {},
    });
  };
  for (const line of lines) {
    if (line.type === "tool_use") {
      remember(
        (line as Record<string, unknown>)["id"],
        line.name ?? line.tool_name,
        (line as Record<string, unknown>)["input"]
      );
    }
    const content = line.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block && block["type"] === "tool_use") {
        remember(block["id"], block["name"], block["input"]);
      }
    }
  }

  return denials.map(({ index, useId, text }) => {
    const call = callsById.get(useId);
    const input = call?.input ?? {};
    const command = typeof input["command"] === "string" ? (input["command"] as string) : undefined;
    const reasonMatch = DENIAL_REASON_MARKER.exec(text);
    const reason = reasonMatch ? text.slice(reasonMatch.index + reasonMatch[0].length).trim() : "";
    return { index, useId, toolName: call?.name, input, command, reason };
  });
}

/** A tool call paired with the transcript-line index that orders it. */
export interface IndexedToolUse {
  index: number;
  toolName: string;
  input: Record<string, unknown>;
}

/**
 * Every `tool_use` in `lines`, in transcript order, each with its line index.
 *
 * {@link findToolUseInputs} returns inputs without position and
 * {@link extractToolUseNames} returns names without inputs; neither can answer
 * "did THIS happen after THAT", which is what any ordering-sensitive suppression
 * rule turns on (mt#3533: was there a reshaped retry AFTER the denial, and did
 * the escalation come AFTER it).
 */
export function findIndexedToolUses(lines: TranscriptLine[]): IndexedToolUse[] {
  const calls: IndexedToolUse[] = [];
  const consider = (index: number, name: unknown, rawInput: unknown): void => {
    if (typeof name !== "string" || !name) return;
    calls.push({
      index,
      toolName: name,
      input: rawInput && typeof rawInput === "object" ? (rawInput as Record<string, unknown>) : {},
    });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (line.type === "tool_use") {
      consider(i, line.name ?? line.tool_name, (line as Record<string, unknown>)["input"]);
    }
    const content = line.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block && block["type"] === "tool_use") consider(i, block["name"], block["input"]);
    }
  }
  return calls;
}

/** A tool call paired with the body of the result it produced. */
export interface ToolCallWithResult {
  index: number;
  /**
   * The call's `tool_use_id`, or undefined when the block carried none — the
   * identity a caller joins against {@link DeniedToolCall.useId} (mt#4111).
   */
  useId: string | undefined;
  toolName: string;
  input: Record<string, unknown>;
  /** The result body, or "" when no correlated result appears in `lines`. */
  resultText: string;
  /** True when a correlated result was found — distinguishes "" from "never returned". */
  hasResult: boolean;
}

/**
 * Every `tool_use` in `lines`, joined to the body of its `tool_result`.
 *
 * The join is the same `tool_use_id` correlation {@link findCreatedResourceIds}
 * and {@link findDeniedToolCalls} each perform inline for their own purposes;
 * this is the general form, because a caller that needs to judge a call by WHAT
 * IT RETURNED — rather than by whether it errored, or by an id it minted —
 * previously had no helper and would have made this the third copy.
 *
 * `hasResult` is carried separately from `resultText` because an empty body and
 * a call with no result at all are different facts: a search that legitimately
 * found nothing returns "", while a call still in flight returns nothing. A
 * caller counting hits must not read the second as zero.
 */
export function findToolCallsWithResults(lines: TranscriptLine[]): ToolCallWithResult[] {
  const calls: Array<{
    index: number;
    useId: string | undefined;
    toolName: string;
    input: Record<string, unknown>;
  }> = [];
  const consider = (index: number, id: unknown, name: unknown, rawInput: unknown): void => {
    if (typeof name !== "string" || !name) return;
    calls.push({
      index,
      useId: typeof id === "string" ? id : undefined,
      toolName: name,
      input: rawInput && typeof rawInput === "object" ? (rawInput as Record<string, unknown>) : {},
    });
  };

  const resultsById = new Map<string, string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (line.type === "tool_use") {
      const raw = line as Record<string, unknown>;
      consider(i, raw["id"], line.name ?? line.tool_name, raw["input"]);
    }
    const content = line.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<Record<string, unknown>>) {
      if (!block) continue;
      if (block["type"] === "tool_use") {
        consider(i, block["id"], block["name"], block["input"]);
      }
      if (block["type"] === "tool_result" && typeof block["tool_use_id"] === "string") {
        resultsById.set(block["tool_use_id"] as string, extractToolResultText(block["content"]));
      }
    }
  }

  return calls.map(({ index, useId, toolName, input }) => {
    const hasResult = useId !== undefined && resultsById.has(useId);
    return {
      index,
      useId,
      toolName,
      input,
      resultText: hasResult ? (resultsById.get(useId as string) ?? "") : "",
      hasResult,
    };
  });
}

/**
 * Extract the text of the most-recent REAL user prompt (the current prompt
 * that fired the hook). Skips trailing `tool_result` user-role lines so it
 * never returns tool-result content as if it were the user's message.
 *
 * Returns "" when there is no real user prompt in the transcript.
 */
export function extractLastUserMessage(lines: TranscriptLine[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    if (isRealUserPrompt(line)) {
      return textFromContent(line.message?.content).join("\n");
    }
  }
  return "";
}

/** A full 36-char canonical UUID. */
const BINDING_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An ADR-029 numeric short id, e.g. `mem#1045`. */
const BINDING_SHORT_ID_RE = /^(?:ask|mem|ws)#\d+$/i;

/**
 * Pair an entity's own ids by FIELD NAME — `id` holding a UUID beside `shortId`
 * holding a short id (mt#4463).
 *
 * This exists because the value-shape rule below it cannot bind the canonical
 * record shape. A Minsky entity record carries `projectId` as well as `id`, so
 * it names two UUIDs and the uniqueness rule yields nothing. Measured over 654
 * transcripts, every `memory_create` / `memory_get` result whose `projectId`
 * held a UUID — 114 of them — bound NOTHING, against 929 of 930 that bound when
 * it was null. The population became universal on 2026-08-25, when `projectId`
 * went from near-never populated to always.
 *
 * **This does not weaken PR #3018 R1's guarantee, and the distinction is the
 * point.** That rule exists so a pairing cannot depend on key ORDER: with only
 * value shapes to go on, `{id, supersededBy}` has no non-arbitrary answer to
 * "which UUID is this record's own", so refusing was correct. Naming the fields
 * removes the question rather than answering it — `id` IS the record's own id
 * by construction, in any key order. The value-shape rule stays as the fallback
 * for shapes that invert the names, which is why `refs_status` (where `id`
 * holds the SHORT id and `uuid` holds the UUID) still resolves through it.
 *
 * Returns null unless BOTH fields are present and both match their expected
 * shape, so a record with an `id` that is not a UUID falls through untouched.
 *
 * **Cross-type consistency (PR #3378 R1).** A UUID carries no type, so nothing
 * in the VALUES can prove that `id` belongs to the entity `shortId` names. Two
 * layers bound that:
 *
 * 1. Here, when the object declares its own kind: a `kind` field holding a
 *    recognised entity kind must AGREE with the short id's prefix, or this
 *    returns null. `refs_status` rows carry `kind: "memory"`, so this is a real
 *    check on a real shape rather than a hypothetical one.
 * 2. In the CONSUMER, for every other shape: `partitionAuthorLinkedShortIds`
 *    suppresses only when a link of the short id's OWN type targets the
 *    resolved UUID (`targetsByType.get(parsed.kind)?.has(uuid)`). So a binding
 *    that paired `mem#5` with an ask's UUID cannot cause a suppression unless
 *    the message also links that UUID *as a memory*.
 *
 * A record that declares no kind and pairs mismatched ids is therefore still
 * bound here — that is unavoidable without type information, and layer 2 is
 * what makes it harmless. It is also not a regression: the value-shape rule
 * below binds that same object today.
 */
const BINDING_KIND_BY_PREFIX: Record<string, string> = {
  ask: "ask",
  mem: "memory",
  ws: "session",
};

/**
 * Three outcomes, and the third is why this is not a nullable pair.
 *
 * `"not-applicable"` falls through to the value-shape rule; `"mismatch"` REFUSES
 * the object outright. Collapsing the two would make the cross-type check inert:
 * a `{id, shortId, kind}` that disagrees names exactly one UUID and one short id,
 * so the value rule would bind the very pairing the check just rejected. Caught
 * by PR #3378 R1's requested test, which failed against the first version of
 * this guard for precisely that reason.
 */
type FieldNameBinding =
  | { outcome: "bound"; shortId: string; uuid: string }
  | { outcome: "mismatch" }
  | { outcome: "not-applicable" };

function bindEntityIdsByFieldName(node: Record<string, unknown>): FieldNameBinding {
  const id = node["id"];
  const shortId = node["shortId"];
  if (typeof id !== "string" || typeof shortId !== "string") return { outcome: "not-applicable" };
  if (!BINDING_UUID_RE.test(id) || !BINDING_SHORT_ID_RE.test(shortId)) {
    return { outcome: "not-applicable" };
  }

  // When the object names its own kind, it must agree with the short id's
  // prefix. An unrecognised `kind` (a memory record's `type: "project"` lives
  // in a different field, and other values are not entity kinds) is treated as
  // "no declaration" rather than a mismatch, so this cannot refuse a shape that
  // simply uses the word differently.
  const declaredKind = node["kind"];
  if (typeof declaredKind === "string") {
    const declared = declaredKind.toLowerCase();
    const known = Object.values(BINDING_KIND_BY_PREFIX).includes(declared);
    const expected = BINDING_KIND_BY_PREFIX[shortId.slice(0, shortId.indexOf("#")).toLowerCase()];
    if (known && declared !== expected) return { outcome: "mismatch" };
  }

  return { outcome: "bound", shortId: shortId.toLowerCase(), uuid: id.toLowerCase() };
}

/**
 * Harvest `<short id> -> <UUID>` bindings from the tool results in a transcript
 * (mt#4160).
 *
 * ## Why the transcript rather than the database
 *
 * A consumer that needs to resolve a short id the display map does not hold
 * (`short-id-map-cache.ts`) cannot simply query for it: that file's header
 * records the measurement — `domain-bootstrap.ts` caps a hook process's
 * Postgres connect at 2s against a measured cold connect of 4.3-5.5s, so "a DB
 * read from hook context does not resolve slowly — it resolves to null every
 * time." A resolver built that way would be inert in production while passing
 * every injected-dependency test.
 *
 * The transcript needs no connection and is already resolved into
 * `ctx.transcriptLines`. It is also the AUTHORITATIVE source for the population
 * that matters: an id the map missed is one minted since the last sweep, and
 * the call that minted it returned both halves of the binding in this very
 * transcript.
 *
 * ## Why the pairing is keyed on VALUE SHAPE, not field names
 *
 * The two field names are not stable across tools and are in fact inverted
 * between them: `memory_create` answers `{ id: <uuid>, shortId: "mem#1045" }`
 * while `refs_status` answers `{ id: "mem#996", uuid: <uuid> }`. Keying on
 * names would need a per-tool table that goes stale silently; keying on the
 * shapes — one value that is a UUID, one that is a short id, in the same object
 * — reads both, plus any future result object carrying the pair.
 *
 * ## Ambiguity fails OPEN, at two levels
 *
 * Within one object, two paths are tried in order (mt#4463):
 *
 * 1. **By field name** — `id` holding a UUID beside `shortId` holding a short
 *    id. This is the canonical Minsky entity shape, and naming the fields makes
 *    the pairing unambiguous no matter what else the record carries. See
 *    {@link bindEntityIdsByFieldName}; it is what lets a record with a populated
 *    `projectId` bind at all.
 * 2. **By value shape**, when path 1 does not apply — a binding is recorded only
 *    when the object names EXACTLY ONE entity, one distinct UUID and one
 *    distinct short id among its own string values. An object carrying a second
 *    UUID (a foreign key, a nested resource id) yields NOTHING rather than a
 *    guess, which is what keeps the pairing from depending on key order
 *    (PR #3018 R1). This path is what resolves INVERTED shapes such as
 *    `refs_status`, where `id` holds the short id and `uuid` holds the UUID.
 *
 * Across the transcript: if one short id is nonetheless seen bound to two
 * different UUIDs, the binding is DROPPED.
 *
 * Callers treat an absent binding as "unresolved", so in every ambiguous case
 * no suppression or rewrite happens for that id — the conservative direction.
 */
export function collectShortIdBindings(lines: TranscriptLine[]): Map<string, string> {
  const bindings = new Map<string, string>();
  const ambiguous = new Set<string>();

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!node || typeof node !== "object") return;

    // An object binds only when it names EXACTLY ONE entity: one distinct UUID
    // and one distinct short id among its own string values (PR #3018 R1).
    //
    // Taking the first of each instead would make the pairing depend on key
    // ORDER, which is arbitrary — a record carrying both `id` and a second uuid
    // field like `supersededBy` would bind to whichever the serializer emitted
    // first. Requiring uniqueness removes the ordering question rather than
    // answering it, and it is the direction that fails OPEN: a second uuid
    // yields NO binding, so the caller suppresses nothing.
    //
    // Distinctness (not raw count) is what the rule needs, because a legitimate
    // record can repeat one value across fields — `refs_status` emits the same
    // short id as both `ref` and `id` on every row.
    // mt#4463: try the FIELD-NAME pairing first. It answers the question the
    // value-shape rule below has to refuse — which UUID is this record's own —
    // so a canonical record carrying `projectId` beside `id` binds instead of
    // yielding nothing. Falls through to the value rule for inverted shapes.
    const byFieldName = bindEntityIdsByFieldName(node as Record<string, unknown>);

    // A declared-kind mismatch refuses the OBJECT, not just the field-name path
    // — falling through would let the value rule re-bind the rejected pairing.
    // Recursion continues, so a nested object can still contribute.
    if (byFieldName.outcome === "mismatch") {
      for (const value of Object.values(node as Record<string, unknown>)) visit(value);
      return;
    }

    let uuid: string | undefined;
    let shortId: string | undefined;
    if (byFieldName.outcome === "bound") {
      uuid = byFieldName.uuid;
      shortId = byFieldName.shortId;
    } else {
      const uuids = new Set<string>();
      const shortIds = new Set<string>();
      for (const value of Object.values(node as Record<string, unknown>)) {
        if (typeof value !== "string") continue;
        if (BINDING_UUID_RE.test(value)) uuids.add(value.toLowerCase());
        else if (BINDING_SHORT_ID_RE.test(value)) shortIds.add(value.toLowerCase());
      }
      uuid = uuids.size === 1 ? [...uuids][0] : undefined;
      shortId = shortIds.size === 1 ? [...shortIds][0] : undefined;
    }
    if (uuid !== undefined && shortId !== undefined) {
      const existing = bindings.get(shortId);
      if (existing !== undefined && existing !== uuid) {
        ambiguous.add(shortId);
      } else {
        bindings.set(shortId, uuid);
      }
    }

    for (const value of Object.values(node as Record<string, unknown>)) visit(value);
  };

  for (const line of lines) {
    const content = line.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<Record<string, unknown>>) {
      if (!block || block["type"] !== "tool_result") continue;
      const parsed = parseResultJson(extractToolResultText(block["content"]));
      if (parsed !== undefined) visit(parsed);
    }
  }

  for (const key of ambiguous) bindings.delete(key);
  return bindings;
}
