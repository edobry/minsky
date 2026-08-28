#!/usr/bin/env bun
/**
 * SC6 replay for mt#4697's tool-call-state match arm.
 *
 * ## Why this reads transcripts and not the calibration log
 *
 * SC6 asks for a calibration-log replay. That is structurally impossible for THIS arm, and the
 * reason is worth stating rather than working around: `.minsky/untaken-action-calibration.jsonl`
 * records `final_message_tail`, `matches`, `deferralOverlap`, `suppressionReasons` and the
 * per-suppression evidence arrays — verified with `jq -r 'keys[]'` over all 386 records. It records
 * NO tool calls. The arm's entire input is the turn's tool calls, so replaying it against that log
 * would measure nothing at all while returning a clean-looking zero (mem#704: a probe that cannot
 * come out the other way is not evidence).
 *
 * Transcripts DO carry the tool calls, so this replays there.
 *
 * ## What this measures, and what it cannot
 *
 * MEASURABLE: the arm's fire RATE over real turns, and every fire's `(task, status)` so a human can
 * classify true vs false positives. That is the precision half.
 *
 * NOT MEASURABLE, here or from the calibration log: the false-NEGATIVE rate. The log is fire-only —
 * 0 of its records carry an empty `matches` array — so it contains no record of a turn the guard
 * stayed silent on, and neither corpus knows which silent turns SHOULD have fired. Recall is
 * established by the named fixtures in the test file, not by a rate.
 *
 * ## Output discipline
 *
 * Prints COUNTS and `mt#NNNN (STATUS)` phrases only. No message text, no prompt text, no tool
 * arguments — the corpus it reads is the operator's own transcripts, and this script's stdout is
 * itself destined for a PR body (`claim-confidence.mdc`: enumerate the egress channels before
 * writing an "emits only aggregates" claim; stdout is the only one here — no network, no files).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  detectStrandedTaskState,
  detectUntakenAction,
} from "../.minsky/hooks/turn-end-untaken-action-scan";
import type { TranscriptLine } from "../.claude/hooks/transcript";

/**
 * Claude Code stores a project's transcripts under `~/.claude/projects/<cwd with / replaced by ->`.
 * Derived rather than hardcoded (PR #3420 R1) so this runs for any developer and in CI.
 *
 * Takes an explicit directory as argv[2], which is what you want from a SESSION workspace: cwd is
 * then the session clone, whose own project dir holds only that session's transcripts rather than
 * the corpus you mean to replay against. The script prints the directory it used and exits
 * non-zero if it is absent, so a wrong path is a loud failure and not a confident zero.
 */
function resolveProjectDir(): string {
  const explicit = process.argv[2];
  if (explicit) return explicit;
  return join(homedir(), ".claude", "projects", process.cwd().replace(/\//g, "-"));
}

const PROJECT_DIR = resolveProjectDir();
if (!existsSync(PROJECT_DIR)) {
  console.error(`No transcript directory at ${PROJECT_DIR}`);
  console.error(`Pass one explicitly: bun scripts/replay-untaken-action-arm.ts <dir>`);
  process.exit(1);
}
console.log(`transcript dir      : ${PROJECT_DIR}`);

/** A real prompt, as opposed to the user-role line Claude Code records for a tool_result. */
function isRealPrompt(line: TranscriptLine): boolean {
  const msg = (line as { message?: { role?: string; content?: unknown } }).message;
  if (!msg || msg.role !== "user") return false;
  if (typeof msg.content === "string") return true;
  if (!Array.isArray(msg.content)) return false;
  return msg.content.every((b) => (b as { type?: string })?.type === "text");
}

function assistantTextOf(lines: TranscriptLine[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const msg = (lines[i] as { message?: { role?: string; content?: unknown } }).message;
    if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    const text = msg.content
      .filter((b) => (b as { type?: string })?.type === "text")
      .map((b) => (b as { text?: string }).text ?? "")
      .join(" ");
    if (text.trim()) return text;
  }
  return "";
}

let files = 0;
let turns = 0;
let fires = 0;
let phraseFires = 0;
const byStatus = new Map<string, number>();
const samples: string[] = [];

for (const name of readdirSync(PROJECT_DIR)) {
  if (!name.endsWith(".jsonl")) continue;
  files++;
  let lines: TranscriptLine[];
  try {
    lines = readFileSync(join(PROJECT_DIR, name), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as TranscriptLine);
  } catch {
    continue; // a partially-written transcript is not a measurement failure
  }

  // Split into turns at each real prompt; a turn is [prompt, ...everything up to the next prompt].
  let current: TranscriptLine[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    turns++;
    const finalMessage = assistantTextOf(current);
    if (finalMessage) {
      // The existing phrase side, over the SAME turns — without this the arm's rate is a number
      // with nothing to compare it to, and "8.9% sounds high" is a threshold invented on the spot
      // rather than a measurement (decision-defaults.mdc §Thresholds).
      if (detectUntakenAction(finalMessage).length > 0) phraseFires++;
      const matches = detectStrandedTaskState(finalMessage, current);
      if (matches.length > 0) {
        fires++;
        for (const m of matches) {
          const status = m.matchedPhrase.replace(/^.*\(/, "").replace(/\)$/, "");
          byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
          if (samples.length < 40) samples.push(m.matchedPhrase);
        }
      }
    }
    current = [];
  };
  for (const line of lines) {
    if (isRealPrompt(line)) flush();
    current.push(line);
  }
  flush();
}

const rate = turns > 0 ? ((fires / turns) * 100).toFixed(2) : "n/a";
console.log(`transcripts scanned : ${files}`);
console.log(`turns replayed      : ${turns}`);
const phraseRate = turns > 0 ? ((phraseFires / turns) * 100).toFixed(2) : "n/a";
console.log(`turns the arm fires : ${fires}  (${rate}% of turns)`);
console.log(
  `  vs phrase side    : ${phraseFires}  (${phraseRate}% of turns) — the shipped baseline`
);
console.log(`by status           : ${JSON.stringify(Object.fromEntries(byStatus))}`);
console.log(`sample phrases (<=40, for manual TP/FP classification):`);
for (const s of samples) console.log(`  ${s}`);
console.log(
  `\nfalse-NEGATIVE rate: NOT MEASURABLE from either corpus — see this file's header for why.`
);
