#!/usr/bin/env bun
/**
 * Replay mt#4327's armed-watcher suppression over the recorded evaluation stream.
 *
 * The question: **of the turns this detector has already judged, how many armed
 * a wait that was running past the turn's end — and how many of those it FIRED
 * on.** The second number is the defect's measured size; it cannot be reasoned
 * about from the code, because whether a turn armed a watcher is a fact about
 * that turn's tool calls.
 *
 * ## Why the turns are recovered from transcripts
 *
 * `.minsky/stop-at-decision-evaluations.jsonl` records the VERDICT for every
 * evaluated turn (`fired`, `suppressionReasons`, `dischargeToolsSeen`) but not
 * the turn itself, and the armed-watcher predicate reads data no record carries:
 * the tool NAMES in the turn, `session_pr_checks`'s `wait` argument, and
 * `Bash`'s `run_in_background`. So the verdict alone cannot be re-derived — the
 * turn's tool calls have to come back from the local transcript store. Same
 * recovery shape as `replay-stop-at-decision-handoff.ts` (mt#4228) and
 * `replay-stop-at-decision-markers.ts` (mt#4085), this script's precedents.
 *
 * ## What "before" means here
 *
 * The RECORD's own `fired` field, written by the shipped detector at the time —
 * not a re-implementation of the old predicate, which would make the comparison
 * a test of that re-implementation (mt#4228's framing, kept).
 *
 * ## The fidelity check, and why the denominator shrinks
 *
 * A calibration log spans months of detector versions, so a record's verdict was
 * written by whatever code shipped that day (mem#1125). A record whose recovered
 * turn does not reproduce its own recorded suppression set is reported as
 * `unreproduced` and excluded, so a recovery bug or a retired matcher shows up as
 * a shrinking denominator rather than as a fake delta.
 *
 * `armed-watcher:*` is excluded from that comparison BY CONSTRUCTION: it is the
 * reason this task adds, so no historical record can carry it. `target-not-open`
 * is excluded because `run()` applies it after a status lookup the pure core
 * never performs.
 *
 * Usage:
 *   bun scripts/replay-stop-at-decision-armed-watcher.ts
 *   bun scripts/replay-stop-at-decision-armed-watcher.ts --transcripts <dir>
 *
 * Exits 0 on a completed measurement (and on a graceful SKIP when the corpus or
 * the transcript store is absent), non-zero only when the inputs are present but
 * unusable.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { detectDecisionStop } from "../.minsky/hooks/stop-at-decision-scan";
import type { TranscriptLine } from "../.minsky/hooks/transcript";

type JsonRecord = Record<string, unknown>;

const EVALUATION_LOG = join(process.cwd(), ".minsky", "stop-at-decision-evaluations.jsonl");

function transcriptDir(): string | null {
  const at = process.argv.indexOf("--transcripts");
  if (at >= 0 && process.argv[at + 1] !== undefined) return process.argv[at + 1] as string;
  const fromEnv = process.env["MINSKY_TRANSCRIPTS_DIR"];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const key = process.cwd().replace(/\//g, "-");
  const guess = join(homedir(), ".claude", "projects", key);
  return existsSync(guess) ? guess : null;
}

function asTranscriptLine(entry: JsonRecord): TranscriptLine {
  return {
    type: typeof entry["type"] === "string" ? (entry["type"] as string) : undefined,
    message: entry["message"] as TranscriptLine["message"],
    timestamp: typeof entry["timestamp"] === "string" ? (entry["timestamp"] as string) : undefined,
  } as TranscriptLine;
}

function readJsonl(path: string): JsonRecord[] {
  if (!existsSync(path)) return [];
  const out: JsonRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as JsonRecord);
    } catch {
      // A torn trailing line is normal for an append-only log written
      // concurrently; skipping it loses one record, not the run.
    }
  }
  return out;
}

/** Reasons the pure core does not compute, or that this task introduces. */
function excludedFromFidelity(reason: string): boolean {
  return reason === "target-not-open" || reason.startsWith("armed-watcher:");
}

const TRANSCRIPT_DIR = transcriptDir();
const cache = new Map<string, JsonRecord[] | null>();

function transcriptFor(sessionId: string): JsonRecord[] | null {
  if (TRANSCRIPT_DIR === null) return null;
  const cached = cache.get(sessionId);
  if (cached !== undefined) return cached;
  const file = join(TRANSCRIPT_DIR, `${sessionId}.jsonl`);
  const entries = existsSync(file) ? readJsonl(file) : null;
  cache.set(sessionId, entries);
  return entries;
}

/** The transcript lines in `[turnKey, recordedAt]` — the window the detector read. */
function recoverTurn(
  sessionId: string,
  turnKey: string,
  recordedAt: string
): TranscriptLine[] | null {
  const entries = transcriptFor(sessionId);
  if (entries === null) return null;
  const start = new Date(turnKey).getTime();
  const end = new Date(recordedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  const window: TranscriptLine[] = [];
  for (const entry of entries) {
    const stamp = entry["timestamp"];
    const ts = typeof stamp === "string" ? new Date(stamp).getTime() : NaN;
    if (Number.isNaN(ts) || ts < start || ts > end) continue;
    window.push(asTranscriptLine(entry));
  }
  return window.length > 0 ? window : null;
}

function lastAssistantText(lines: TranscriptLine[]): string {
  let last = "";
  for (const line of lines) {
    if (line.type !== "assistant") continue;
    const content = line.message?.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((b): b is { type: string; text: string } => (b as { type?: string })?.type === "text")
      .map((b) => b.text)
      .join("");
    if (text.trim() !== "") last = text;
  }
  return last;
}

// --- run ---------------------------------------------------------------------

const records = readJsonl(EVALUATION_LOG);
if (records.length === 0) {
  console.log(`SKIP: no evaluation records at ${EVALUATION_LOG}`);
  process.exit(0);
}
if (TRANSCRIPT_DIR === null) {
  console.log("SKIP: no local transcript store — pass --transcripts <dir> to point at one.");
  process.exit(0);
}

let unrecovered = 0;
let unreproduced = 0;
let compared = 0;
let firedBefore = 0;
let armedAny = 0;
/** The measured defect: records that FIRED and would now be suppressed. */
const nowSuppressed: Array<{ timestamp: string; evidence: string[] }> = [];

for (const record of records) {
  const sessionId = typeof record["session_id"] === "string" ? record["session_id"] : "";
  const turnKey = typeof record["turnKey"] === "string" ? record["turnKey"] : "";
  const recordedAt = typeof record["timestamp"] === "string" ? record["timestamp"] : "";
  if (sessionId === "" || turnKey === "" || turnKey === "tail" || recordedAt === "") {
    unrecovered += 1;
    continue;
  }

  const turn = recoverTurn(sessionId, turnKey, recordedAt);
  if (turn === null) {
    unrecovered += 1;
    continue;
  }

  const replayed = detectDecisionStop(turn, turn, lastAssistantText(turn));
  if (replayed === null) {
    unreproduced += 1;
    continue;
  }

  // Fidelity: the replay must agree with the record on every reason that
  // existed when the record was written.
  const recordedReasons = (
    Array.isArray(record["suppressionReasons"]) ? (record["suppressionReasons"] as string[]) : []
  )
    .filter((r) => !excludedFromFidelity(r))
    .sort();
  const replayedReasons = replayed.suppressionReasons
    .filter((r) => !excludedFromFidelity(r))
    .sort();
  if (recordedReasons.join("|") !== replayedReasons.join("|")) {
    unreproduced += 1;
    continue;
  }

  compared += 1;
  const armed = replayed.armedWatcherEvidence;
  if (armed.length > 0) armedAny += 1;
  if (record["fired"] === true) {
    firedBefore += 1;
    if (armed.length > 0) nowSuppressed.push({ timestamp: recordedAt, evidence: armed });
  }
}

console.log(`records:        ${records.length}`);
console.log(`unrecovered:    ${unrecovered} (no transcript, or no window)`);
console.log(`unreproduced:   ${unreproduced} (recovered turn disagrees with its own record)`);
console.log(`compared:       ${compared}`);
console.log(`fired before:   ${firedBefore}`);
console.log(`armed a wait:   ${armedAny} of ${compared} compared`);
console.log(`NOW SUPPRESSED: ${nowSuppressed.length} of ${firedBefore} fires`);
for (const hit of nowSuppressed) {
  console.log(`  - ${hit.timestamp}  ${hit.evidence.join(",")}`);
}
