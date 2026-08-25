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
import { dirname, join, resolve } from "node:path";
import {
  findRealPromptIndices,
  resolveCompletedTurn,
  extractAssistantText,
} from "../.minsky/hooks/transcript";
import type { TranscriptLine } from "../.minsky/hooks/transcript";
import { safeTruncate } from "../packages/shared/src/safe-truncate";
import {
  collectTurnProse,
  measureWallOfText,
  extractFinalAssistantText,
  resolveDepthCheck,
  resolveQuestionAnswerCheck,
  WORD_COUNT_THRESHOLD,
  LEAD_WORD_BUDGET,
} from "../.minsky/hooks/wall-of-text-detector";

const CALIBRATION_LOG = ".minsky/wall-of-text-calibration.jsonl";

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
    const perBlock = texts.map(countWords);
    const largestIdx = Math.max(0, perBlock.indexOf(maxWords));

    const depth = resolveDepthCheck(prefix);
    const question = resolveQuestionAnswerCheck(prefix);
    const suppressionReasons: string[] = [];
    if (depth.matched) suppressionReasons.push("depth-request-override");
    if (question.matched) suppressionReasons.push("question-answer-override");

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
      largestBlockLead: safeTruncate((texts[largestIdx] ?? "").replace(/\s+/g, " "), 220, "head"),
    });
  }

  return out;
}

function sessionIdsFromCalibrationLog(logPath: string): string[] {
  if (!existsSync(logPath)) {
    process.stderr.write(
      `FAIL: calibration log not found: ${logPath}\n` +
        `      It is a gitignored runtime file, so a session workspace does not carry one.\n` +
        `      Pass --calibration-log <path-to-main-checkout>/${CALIBRATION_LOG}\n`
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
  const logPath =
    logArg >= 0 ? resolve(args[logArg + 1] ?? "") : resolve(process.cwd(), CALIBRATION_LOG);

  // <root>/.minsky/wall-of-text-calibration.jsonl -> <root>
  const repoRoot = dirname(dirname(logPath));
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

  if (jsonPath) {
    writeFileSync(
      jsonPath,
      JSON.stringify({ threshold: WORD_COUNT_THRESHOLD, turns: all }, null, 2)
    );
    process.stdout.write(`\nwrote ${jsonPath}\n`);
  }
}

main();
