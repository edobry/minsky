#!/usr/bin/env bun
/**
 * mt#4531 — size the wall-of-text measured-window widening before shipping it.
 *
 * The detector measures `extractFinalAssistantText` — the LAST assistant line
 * of a turn carrying text. The principal reads the WHOLE turn. This replays
 * real transcripts under three candidate measurements and reports what each
 * would newly fire on, so the metric is CHOSEN by measurement rather than
 * asserted (mt#4531 SC3 / AT3).
 *
 * Candidates:
 *   current — words in the final assistant text line (shipped behaviour)
 *   sum     — words across every assistant text line in the turn (metric A)
 *   max     — words in the LARGEST single assistant text line (metric B)
 *
 * **Replay through TODAY's detector, not the recorded verdict (mem#1125).** The
 * calibration log spans months of matcher revisions, so its raw fire set mixes
 * retired matchers with live ones. Every number below is recomputed from the
 * transcript through the CURRENT `measureWallOfText` plus the CURRENT
 * suppression gates; the log is used only to enumerate which sessions to walk.
 *
 * **Faithful window.** The detector runs at `UserPromptSubmit`, so at fire time
 * the firing prompt is not yet in the transcript. Each turn is therefore
 * replayed against `lines.slice(0, closingPromptIndex)` — the closing prompt
 * EXCLUDED — which is what `resolveCompletedTurn` actually saw.
 *
 * Usage:
 *   bun scripts/replay-wall-of-text-window.ts [--sample N] [--json <path>]
 *                                             [--calibration-log <path>]
 *
 * `--calibration-log` matters more than it looks: the log is a gitignored
 * RUNTIME file, so a session workspace (a fresh clone) does not have one. With
 * a silent default this script reported `replayable=0` and a table of zeros —
 * a can't-fail probe (mem#704) wearing the costume of a clean measurement.
 * It now EXITS NON-ZERO when the log is missing or empty rather than replaying
 * nothing and printing a result.
 *
 * Exits 0 on a completed replay (this is a measurement, not a gate); non-zero
 * when it could not run — no transcript dir, no calibration log, or a log that
 * named no sessions.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { calibrationLogPath } from "../.minsky/hooks/dispatcher";
import {
  findRealPromptIndices,
  resolveCompletedTurn,
  extractAssistantText,
} from "../.minsky/hooks/transcript";
import type { TranscriptLine } from "../.minsky/hooks/transcript";
import { safeTruncate } from "../packages/shared/src/safe-truncate";
import { detectLengthComplaint } from "./lib/length-complaint";
import {
  collectTurnProse,
  measureWallOfText,
  extractFinalAssistantText,
  resolveDepthCheck,
  resolveQuestionAnswerCheck,
  WORD_COUNT_THRESHOLD,
  LEAD_WORD_BUDGET,
  SUPPRESSION_DEPTH_REQUEST,
  SUPPRESSION_QUESTION_ANSWER,
} from "../.minsky/hooks/wall-of-text-detector";

const REPO_ROOT = resolve(import.meta.dir, "..");

/**
 * mt#4971: resolved through the WRITER's own function rather than the pre-mt#4748
 * repo path, which no longer exists — reading it produced a SKIP that looked like
 * "no records" rather than "wrong location". `fallbackCwd` (not `projectDir`) keeps
 * the resolver's `CLAUDE_PROJECT_DIR` tier ahead of this checkout.
 */
const CALIBRATION_LOG = calibrationLogPath("wall-of-text", { fallbackCwd: REPO_ROOT });

/**
 * Where Claude Code writes a project's transcripts: `~/.claude/projects/<slug>`,
 * where the slug is the project's absolute path with `/` replaced by `-`.
 *
 * Derived from the REPO ROOT rather than from `process.cwd()`, and that
 * distinction is the whole point: this script is normally run from a SESSION
 * workspace (`~/.local/state/minsky/sessions/<id>`), which has a project dir of
 * its own containing none of the transcripts being replayed. The repo root is
 * taken from the calibration log's location, so the log and the transcripts are
 * guaranteed to describe the same project.
 *
 * `--transcript-dir` overrides it. The slug rule is a best-effort mirror of the
 * harness's own; if it ever diverges, the override is the escape hatch and the
 * failure is loud (the directory will not exist) rather than a silent zero.
 */
function transcriptDirFor(repoRoot: string): string {
  return join(homedir(), ".claude", "projects", repoRoot.replace(/\//g, "-"));
}

interface TurnMetrics {
  sessionId: string;
  /** 1-based index of the turn within the session's real-prompt sequence. */
  turnIndex: number;
  /** Words in the final assistant text line — the shipped measurement. */
  currentWords: number;
  /** Words across every assistant text line in the turn — metric A. */
  sumWords: number;
  /** Words in the largest single assistant text line — metric B. */
  maxWords: number;
  /** How many assistant lines carried text. */
  blockCount: number;
  /** tool_use blocks in the turn — the heartbeat-shape discriminator. */
  toolCalls: number;
  firesCurrent: boolean;
  firesSum: boolean;
  firesMax: boolean;
  /** True when either suppression gate would have withheld the injection. */
  suppressed: boolean;
  suppressionReasons: string[];
  /** First 220 chars of the largest block — for hand classification. */
  largestBlockLead: string;
  /**
   * What the principal typed AFTER reading this turn (mt#4540).
   *
   * This is the prompt at the turn's CLOSING boundary. The detector runs at
   * `UserPromptSubmit` and measures the turn before the prompt, so that same
   * prompt is the principal's reaction to the measured turn — which makes it
   * the only outcome signal available without asking them.
   */
  reactionText: string;
  /**
   * The reacting prompt's ISO timestamp, or `undefined` when the line carried
   * none. Used for ADR-032's provenance boundary; a turn with no readable
   * timestamp is EXCLUDED from a cutoff-filtered population rather than
   * assumed recent.
   */
  reactionAt: string | undefined;
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Per-LINE assistant text, using the module's own extractor. */
function assistantTextLines(turnLines: TranscriptLine[]): string[] {
  const out: string[] = [];
  for (const line of turnLines) {
    if (!line) continue;
    const text = extractAssistantText([line]);
    if (text.trim().length > 0) out.push(text);
  }
  return out;
}

function countToolUses(turnLines: TranscriptLine[]): number {
  let n = 0;
  for (const line of turnLines as Array<TranscriptLine & { message?: { content?: unknown } }>) {
    const content = line?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<{ type?: string }>) {
      if (block?.type === "tool_use") n++;
    }
  }
  return n;
}

function parseTranscript(path: string): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    if (!raw.trim()) continue;
    try {
      lines.push(JSON.parse(raw) as TranscriptLine);
    } catch {
      // A partially-flushed final line is normal for a live transcript.
    }
  }
  return lines;
}

/** A user-role line's text, string- and content-array shapes alike. */
function promptTextOf(line: TranscriptLine | undefined): string {
  const content = (line as { message?: { content?: unknown } } | undefined)?.message?.content;
  if (typeof content === "string") return content.replace(/\s+/g, " ");
  if (!Array.isArray(content)) return "";
  return (content as Array<{ type?: string; text?: string }>)
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join(" ")
    .replace(/\s+/g, " ");
}

function replaySession(sessionId: string, lines: TranscriptLine[]): TurnMetrics[] {
  const promptIndices = findRealPromptIndices(lines);
  const out: TurnMetrics[] = [];

  // Start at 1: turn k is bounded by promptIndices[k-1] and promptIndices[k],
  // and the detector needs both bounds to resolve a completed turn.
  for (let k = 1; k < promptIndices.length; k++) {
    const closingIdx = promptIndices[k] as number;
    // The firing prompt is NOT yet in the transcript when the hook runs.
    const prefix = lines.slice(0, closingIdx);
    const { turnLines } = resolveCompletedTurn(prefix);
    if (turnLines.length === 0) continue;

    const texts = assistantTextLines(turnLines);
    if (texts.length === 0) continue;

    const finalText = extractFinalAssistantText(turnLines);
    const currentWords = measureWallOfText(finalText).wordCount;
    // Derive the block statistics from the SHIPPED function rather than
    // recomputing them here (PR #3310 R1, class-not-instance). The blocking
    // finding was that `largestBlockWords` and its two siblings were computed
    // on different paths and disagreed in the ADR-031 lag case; a replay that
    // re-derives them by hand is a second place for exactly that to happen, and
    // it would silently measure something other than what ships.
    const prose = collectTurnProse(turnLines, finalText);
    const sumWords = prose.totalWords;
    const maxWords = prose.largestBlockWords;
    // PR #3317 R1 (BLOCKING): `indexOf(maxWords)` searches the TRANSCRIPT blocks
    // only. In the ADR-031 lag case the largest block can be the recorded final
    // text, which is not among them — `indexOf` then returns -1 and a
    // `Math.max(0, …)` floor silently showed the FIRST block labelled as the
    // largest. Same lag case mt#4531's counting fix addressed; this display path
    // was the sibling site (class-not-instance).
    const perBlock = texts.map(countWords);
    const transcriptLargest = perBlock.length > 0 ? Math.max(...perBlock) : 0;
    const largestIsRecordedOnly = maxWords > transcriptLargest;
    const largestIdx = largestIsRecordedOnly ? -1 : perBlock.indexOf(maxWords);
    const largestSource = largestIsRecordedOnly ? finalText : (texts[largestIdx] ?? "");

    const depth = resolveDepthCheck(prefix);
    const question = resolveQuestionAnswerCheck(prefix);
    const suppressionReasons: string[] = [];
    if (depth.matched) suppressionReasons.push(SUPPRESSION_DEPTH_REQUEST);
    if (question.matched) suppressionReasons.push(SUPPRESSION_QUESTION_ANSWER);

    out.push({
      sessionId,
      turnIndex: k,
      currentWords,
      sumWords,
      maxWords,
      blockCount: texts.length,
      toolCalls: countToolUses(turnLines),
      firesCurrent: currentWords >= WORD_COUNT_THRESHOLD,
      firesSum: sumWords >= WORD_COUNT_THRESHOLD,
      firesMax: maxWords >= WORD_COUNT_THRESHOLD,
      suppressed: suppressionReasons.length > 0,
      suppressionReasons,
      largestBlockLead: safeTruncate(largestSource.replace(/\s+/g, " "), 220, "head"),
      reactionText: promptTextOf(lines[closingIdx]),
      reactionAt: (lines[closingIdx] as { timestamp?: string } | undefined)?.timestamp,
    });
  }

  return out;
}

function sessionIdsFromCalibrationLog(logPath: string): string[] {
  if (!existsSync(logPath)) {
    process.stderr.write(
      `FAIL: calibration log not found: ${logPath}\n` +
        `      Since mt#4748 it lives under the runtime state dir, keyed by checkout, so a\n` +
        `      session workspace resolves its OWN key and finds nothing.\n` +
        `      Pass --calibration-log <main-checkout's state-dir path> to read another checkout's.\n`
    );
    process.exit(2);
  }
  const ids = new Set<string>();
  for (const raw of readFileSync(logPath, "utf8").split("\n")) {
    if (!raw.trim()) continue;
    try {
      const rec = JSON.parse(raw) as { session_id?: string };
      if (rec.session_id) ids.add(rec.session_id);
    } catch {
      // Skip a malformed record rather than aborting the replay.
    }
  }
  if (ids.size === 0) {
    process.stderr.write(`FAIL: calibration log named no sessions: ${logPath}\n`);
    process.exit(2);
  }
  return [...ids];
}

function main(): void {
  const args = process.argv.slice(2);
  const sampleArg = args.indexOf("--sample");
  const sampleSize = sampleArg >= 0 ? Number(args[sampleArg + 1] ?? 20) : 20;
  const jsonArg = args.indexOf("--json");
  const jsonPath = jsonArg >= 0 ? args[jsonArg + 1] : undefined;
  const logArg = args.indexOf("--calibration-log");
  const logPath = logArg >= 0 ? resolve(args[logArg + 1] ?? "") : CALIBRATION_LOG;

  // mt#4971: the repo root used to be DERIVED from the log path
  // (`<root>/.minsky/wall-of-text-calibration.jsonl` -> `<root>`). That derivation
  // died with mt#4748 — the log now lives at `<state dir>/projects/<key>/`, whose
  // grandparent is the state dir, not a checkout. Deriving it from this file's own
  // location is what the path used to encode; `--transcript-dir` stays the override
  // for reading another checkout's transcripts.
  const repoRoot = REPO_ROOT;
  const dirArg = args.indexOf("--transcript-dir");
  const dir = dirArg >= 0 ? resolve(args[dirArg + 1] ?? "") : transcriptDirFor(repoRoot);
  if (!existsSync(dir)) {
    process.stderr.write(
      `FAIL: transcript dir not found: ${dir}\n` +
        `      Derived from repo root ${repoRoot}. Pass --transcript-dir to override.\n`
    );
    process.exit(2);
  }

  const logged = new Set(sessionIdsFromCalibrationLog(logPath));
  const available = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.replace(/\.jsonl$/, ""));
  const targets = available.filter((id) => logged.has(id));

  process.stdout.write(
    `budget=${LEAD_WORD_BUDGET} threshold=${WORD_COUNT_THRESHOLD}\n` +
      `calibration-log sessions=${logged.size} transcripts-on-disk=${available.length} ` +
      `replayable=${targets.length}\n`
  );
  if (targets.length < logged.size) {
    process.stdout.write(
      `NOTE: ${logged.size - targets.length} logged sessions have no transcript on disk ` +
        `(rotated or another project) — they are absent from every count below.\n`
    );
  }

  const all: TurnMetrics[] = [];
  for (const id of targets) {
    const path = join(dir, `${id}.jsonl`);
    try {
      all.push(...replaySession(id, parseTranscript(path)));
    } catch (err) {
      process.stderr.write(`WARN: ${id}: ${(err as Error).message}\n`);
    }
  }

  const fired = (sel: (t: TurnMetrics) => boolean) => all.filter(sel);
  const unsuppressed = (t: TurnMetrics) => !t.suppressed;

  const cur = fired((t) => t.firesCurrent);
  const sum = fired((t) => t.firesSum);
  const max = fired((t) => t.firesMax);
  const newSum = fired((t) => t.firesSum && !t.firesCurrent);
  const newMax = fired((t) => t.firesMax && !t.firesCurrent);

  process.stdout.write(
    `\nturns replayed: ${all.length}\n` +
      `\n              fires  (unsuppressed)  newly-firing  (unsuppressed)\n` +
      `current       ${String(cur.length).padStart(5)}  ${String(cur.filter(unsuppressed).length).padStart(13)}  ${"—".padStart(12)}  ${"—".padStart(14)}\n` +
      `sum   (A)     ${String(sum.length).padStart(5)}  ${String(sum.filter(unsuppressed).length).padStart(13)}  ${String(newSum.length).padStart(12)}  ${String(newSum.filter(unsuppressed).length).padStart(14)}\n` +
      `max   (B)     ${String(max.length).padStart(5)}  ${String(max.filter(unsuppressed).length).padStart(13)}  ${String(newMax.length).padStart(12)}  ${String(newMax.filter(unsuppressed).length).padStart(14)}\n`
  );

  // The heartbeat-shape control (SC3): a long tool-heavy turn whose prose is
  // many short status lines is MANDATED by user-preferences.mdc §Progress
  // heartbeats and must not read as a wall. Metric A cannot distinguish it
  // from a wall; metric B can. Report the split explicitly rather than
  // letting it hide inside an aggregate.
  const HEARTBEAT_TOOLCALL_FLOOR = 20;
  const heartbeatShaped = (t: TurnMetrics) =>
    t.toolCalls >= HEARTBEAT_TOOLCALL_FLOOR && t.maxWords < WORD_COUNT_THRESHOLD;
  const hbNewSum = newSum.filter(heartbeatShaped);
  process.stdout.write(
    `\nheartbeat-shaped control (>=${HEARTBEAT_TOOLCALL_FLOOR} tool calls AND no single block >= threshold):\n` +
      `  newly-firing under A: ${hbNewSum.length} of ${newSum.length}\n` +
      `  newly-firing under B: ${newMax.filter(heartbeatShaped).length} (0 expected — B keys on a single block)\n`
  );

  const sample = [...newMax].sort((a, b) => b.maxWords - a.maxWords).slice(0, sampleSize);
  process.stdout.write(
    `\nnewly-firing under B, largest first (top ${sample.length}) — for hand classification:\n`
  );
  for (const t of sample) {
    process.stdout.write(
      `  ${t.sessionId.slice(0, 8)} turn#${t.turnIndex} max=${t.maxWords} sum=${t.sumWords} ` +
        `final=${t.currentWords} blocks=${t.blockCount} tools=${t.toolCalls}` +
        `${t.suppressed ? ` [suppressed: ${t.suppressionReasons.join(",")}]` : ""}\n` +
        `      ${t.largestBlockLead}\n`
    );
  }

  if (args.includes("--suppression-accuracy")) {
    reportSuppressionAccuracy(all, !args.includes("--no-provenance-cutoff"));
  }

  if (jsonPath) {
    writeFileSync(
      jsonPath,
      JSON.stringify({ threshold: WORD_COUNT_THRESHOLD, turns: all }, null, 2)
    );
    process.stdout.write(`\nwrote ${jsonPath}\n`);
  }
}

/**
 * ADR-032 D1's provenance boundary: calibration records written before this
 * date are discarded from any tuning basis, because mt#3280 found
 * `extractLastAssistantTurn` could hand a `UserPromptSubmit` detector the
 * PREVIOUS turn — so a pre-fix record's measured value may belong to text the
 * guard never fired on.
 */
export const PROVENANCE_CUTOFF_ISO = "2026-07-29T00:00:00Z";

/** ADR-032 D1's cold-start floor: fewer labeled observations decides nothing. */
export const COLD_START_FLOOR = 5;

/** The disjoint populations a suppression-accuracy report compares. */
export interface SuppressionPartition {
  /** `[label, turns]`, DISJOINT by construction. */
  populations: Array<[string, TurnMetrics[]]>;
  /** In-window turns that did not fire under metric B. */
  control: TurnMetrics[];
  /** In-window turns excluded for having no readable reacting prompt. */
  droppedNoReaction: number;
}

/**
 * Split the corpus into the populations a suppression-accuracy rate compares.
 *
 * Extracted as a pure function rather than left inline (PR #3317 R1): both of
 * that round's population defects were arithmetic on set membership, invisible
 * in a report that prints only totals, and one of them moved the headline rate
 * by half. A void function that writes to stdout cannot be asserted against;
 * this can. (`/implement-task` §6 testable-design checkpoint.)
 *
 * Two invariants the tests pin, because both were violated in the first cut:
 *
 * - **The suppressed populations are DISJOINT.** A turn both gates suppressed
 *   used to count in the depth population and be excluded from the
 *   question-answer one, so the two were not comparable — on exactly the axis
 *   the finding rested on. It now has its own row.
 * - **A turn with no readable reacting prompt is EXCLUDED, not counted as
 *   "no complaint."** It can never be a candidate, so leaving it in the
 *   denominator biases every rate downward, and unevenly, since harness-opened
 *   turns are not spread evenly across the populations.
 */
export function partitionBySuppression(
  all: TurnMetrics[],
  inWindow: (t: TurnMetrics) => boolean
): SuppressionPartition {
  const hasReaction = (t: TurnMetrics): boolean => t.reactionText.trim().length > 0;
  const windowed = all.filter(inWindow);
  const scored = windowed.filter(hasReaction);
  const droppedNoReaction = windowed.length - scored.length;

  const firing = scored.filter((t) => t.firesMax);
  const depth = (t: TurnMetrics) => t.suppressionReasons.includes(SUPPRESSION_DEPTH_REQUEST);
  const qa = (t: TurnMetrics) => t.suppressionReasons.includes(SUPPRESSION_QUESTION_ANSWER);

  return {
    populations: [
      ["suppressed: depth-request only", firing.filter((t) => depth(t) && !qa(t))],
      ["suppressed: question-answer only", firing.filter((t) => qa(t) && !depth(t))],
      ["suppressed: BOTH gates", firing.filter((t) => depth(t) && qa(t))],
      ["DELIVERED (reminder injected)", firing.filter((t) => !t.suppressed)],
    ],
    control: scored.filter((t) => !t.firesMax),
    droppedNoReaction,
  };
}

/**
 * Do the suppression gates withhold the reminder on the turns the principal
 * then complains about? (mt#4540 SC1)
 *
 * The gates' premise is that a report long BECAUSE depth was requested is not a
 * violation. This measures that against the only outcome signal available: what
 * the principal typed next. A rate ABOVE the delivered-reminder population is
 * evidence the gates are selecting for the wrong turns.
 *
 * **Reports CANDIDATES, never a verdict.** `detectLengthComplaint` is a loose
 * screen (see its module doc — a first cut over-reported by 2x), so every
 * candidate is printed with its context for hand classification and the summary
 * says so. A caller quoting these numbers as classified rates without reading
 * the contexts is misusing the output.
 */
export function reportSuppressionAccuracy(all: TurnMetrics[], applyCutoff: boolean): void {
  const cutoffMs = Date.parse(PROVENANCE_CUTOFF_ISO);
  const inWindow = (t: TurnMetrics): boolean => {
    if (!applyCutoff) return true;
    if (t.reactionAt === undefined) return false;
    const ms = Date.parse(t.reactionAt);
    return !Number.isNaN(ms) && ms >= cutoffMs;
  };

  const { populations, control, droppedNoReaction } = partitionBySuppression(all, inWindow);

  process.stdout.write(
    `\n=== suppression accuracy (mt#4540) ===\n` +
      `provenance cutoff: ${applyCutoff ? `>= ${PROVENANCE_CUTOFF_ISO} (ADR-032 D1)` : "DISABLED — includes pre-mt#3280 records whose measured turn may be wrong"}\n` +
      `\nlength-complaint CANDIDATES in the principal's reacting prompt.\n` +
      `These are NOT classified results — read each context below before quoting a rate.\n\n`
  );

  if (droppedNoReaction > 0) {
    process.stdout.write(
      `  NOTE: ${droppedNoReaction} in-window turn(s) had no readable reacting prompt and are\n` +
        `        excluded from every denominator below — not counted as "no complaint".\n\n`
    );
  }

  let suppressedCandidates = 0;
  for (const [label, set] of populations) {
    const hits = set.filter((t) => detectLengthComplaint(t.reactionText).isCandidate);
    if (label.startsWith("suppressed")) suppressedCandidates += hits.length;
    const pct = set.length > 0 ? ((hits.length / set.length) * 100).toFixed(1) : "n/a";
    process.stdout.write(
      `  ${label.padEnd(32)} ${String(hits.length).padStart(3)} / ${String(set.length).padStart(4)}  (${pct}%)\n`
    );
  }
  const controlHits = control.filter((t) => detectLengthComplaint(t.reactionText).isCandidate);
  const controlPct =
    control.length > 0 ? ((controlHits.length / control.length) * 100).toFixed(1) : "n/a";
  process.stdout.write(
    `  ${"control: does not fire".padEnd(32)} ${String(controlHits.length).padStart(3)} / ${String(control.length).padStart(4)}  (${controlPct}%)\n`
  );

  process.stdout.write(
    `\npooled suppressed candidates: ${suppressedCandidates}` +
      ` (ADR-032 cold-start floor: ${COLD_START_FLOOR})\n` +
      `  ${suppressedCandidates >= COLD_START_FLOOR ? "at or over the floor — a direction may be read, a magnitude may not" : "UNDER the floor — this population decides nothing on its own"}\n`
  );

  process.stdout.write(`\n--- candidates, for hand classification ---\n`);
  for (const [label, set] of populations) {
    for (const t of set) {
      const c = detectLengthComplaint(t.reactionText);
      if (!c.isCandidate) continue;
      process.stdout.write(
        `  [${label}] ${t.sessionId.slice(0, 8)} turn#${t.turnIndex} max=${t.maxWords} sum=${t.sumWords} patterns=${c.patterns.join(",")}\n` +
          `      ${c.context}\n`
      );
    }
  }
}

if (import.meta.main) main();
