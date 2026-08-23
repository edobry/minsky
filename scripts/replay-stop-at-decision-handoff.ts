#!/usr/bin/env bun
/**
 * Replay mt#4228's suppression change over the recorded evaluation stream.
 *
 * The question this answers: **how many turns that the shipped detector
 * suppressed would the qualified predicates now let fire, and which of the two
 * changes is responsible for each?** That number is what decides whether the
 * change is a fix or a noise source, and it cannot be reasoned about from the
 * code — the corpus has to be run.
 *
 * ## Why the turns are recovered from transcripts
 *
 * `.minsky/stop-at-decision-evaluations.jsonl` records the VERDICT for every
 * evaluated turn (`fired`, `suppressionReasons`, `dischargeToolsSeen`) but not
 * the turn itself. Both of mt#4228's changes read data the record does not
 * carry: the `status` ARGUMENT of a `tasks_status_set` call, and the
 * `file_path` of a `Write`/`Edit`. So the verdict alone cannot be re-derived —
 * the turn's tool calls have to come back from the local transcript store.
 * Same recovery shape as `replay-stop-at-decision-markers.ts` (mt#4085), which
 * is this script's sibling and precedent.
 *
 * ## What "before" means here
 *
 * The RECORD's own `fired` field, written by the shipped detector at the time.
 * Not a simulation: re-implementing the old predicate to compare against would
 * make the comparison a test of that re-implementation. A record whose
 * recovered turn does not reproduce its own recorded suppression set is
 * reported as `unreproduced` and excluded from the arithmetic, so a recovery
 * bug shows up as a shrinking denominator rather than as a fake delta.
 *
 * Usage:
 *   bun scripts/replay-stop-at-decision-handoff.ts
 *   bun scripts/replay-stop-at-decision-handoff.ts --transcripts <dir>
 *
 * Exits 0 when it completes, including a clean SKIP when the transcript store
 * is absent (CI has neither). Non-zero only on an unreadable evaluation log.
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
  // Claude Code's per-project transcript store. The directory name is the
  // project path with separators replaced by dashes.
  const key = process.cwd().replace(/\//g, "-");
  const guess = join(homedir(), ".claude", "projects", key);
  return existsSync(guess) ? guess : null;
}

/**
 * A transcript entry, read structurally rather than cast.
 *
 * `TranscriptLine` is the hook's own shape and a JSONL entry is a superset of
 * it; narrowing by reading the two fields the detector actually consumes keeps
 * this honest about what is known, instead of asserting through `unknown`.
 */
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
      // A torn trailing line is normal for an append-only log being written
      // concurrently; skipping it loses one record, not the run.
    }
  }
  return out;
}

/**
 * Suppression reasons this task does not touch, and which the pure core does
 * not compute — so they are excluded from the fidelity comparison rather than
 * counted as a mismatch. `target-not-open` is applied by `run()` after a task
 * status lookup; the others are pure-core and DO participate.
 */
const UNCHANGED_BY_THIS_TASK: ReadonlySet<string> = new Set(["target-not-open"]);

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

/** The transcript lines in `[turnKey, firedAt]` — the window the detector read. */
function recoverTurn(sessionId: string, turnKey: string, firedAt: string): TranscriptLine[] | null {
  const entries = transcriptFor(sessionId);
  if (entries === null) return null;
  const start = new Date(turnKey).getTime();
  const end = new Date(firedAt).getTime();
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

let withCandidate = 0;
let unrecovered = 0;
let unreproduced = 0;
/** Records that survived recovery + fidelity — the denominator both sides share. */
let compared = 0;
let firedBefore = 0;
let firedAfter = 0;
const newFires: { timestamp: string; task: string; wasSuppressedBy: string[] }[] = [];

for (const record of records) {
  const candidates = record["candidateTaskIds"];
  if (!Array.isArray(candidates) || candidates.length === 0) continue;
  withCandidate++;

  // Counted AFTER the recovery and fidelity checks below, not here: a record
  // that drops out of the comparison must drop out of BOTH sides of it, or the
  // totals move in a direction the change cannot produce. Loosening a
  // suppression can only ever ADD fires, so a falling `firedAfter` is a bug in
  // this script rather than a finding — which is exactly how the first run of
  // it read (24 -> 21) before the denominators were aligned.
  const before = record["fired"] === true;

  const sessionId = String(record["session_id"] ?? "");
  const turnKey = String(record["turnKey"] ?? "");
  const firedAt = String(record["timestamp"] ?? "");
  const lines = recoverTurn(sessionId, turnKey, firedAt);
  if (lines === null) {
    unrecovered++;
    continue;
  }

  const detection = detectDecisionStop(lines, lines, lastAssistantText(lines));
  if (detection === null) {
    // The recovered window does not even carry the spec-patch that triggered
    // the record — a recovery miss, not a behaviour change.
    unreproduced++;
    continue;
  }

  // FIDELITY CHECK. Everything the pure core still decides the same way must
  // still come out the same way; only the two qualified predicates may differ.
  // Without this the run cannot tell a behaviour change from a recovery bug,
  // and a wrong window produces a plausible-looking delta — the same failure
  // the sibling script records having shipped once.
  const recorded = ((record["suppressionReasons"] as string[] | undefined) ?? []).filter(
    (r) => !UNCHANGED_BY_THIS_TASK.has(r) && !r.startsWith("discharged:")
  );
  const recomputed = detection.suppressionReasons.filter((r) => !r.startsWith("discharged:"));
  const unchangedRecorded = recorded.filter((r) => r !== "working-turn");
  const unchangedRecomputed = recomputed.filter((r) => r !== "working-turn");
  if (unchangedRecorded.sort().join("|") !== unchangedRecomputed.sort().join("|")) {
    unreproduced++;
    continue;
  }

  // `target-not-open` is applied by `run()` AFTER the pure core, via a task
  // status lookup this script does not repeat — and this task changes nothing
  // about it. A record carrying it stays suppressed no matter what the core
  // says; treating the core's verdict as final here would manufacture "new
  // fires" out of a filter that never moved.
  const targetNotOpen = ((record["suppressionReasons"] as string[] | undefined) ?? []).includes(
    "target-not-open"
  );

  const after =
    !targetNotOpen &&
    detection.suppressionReasons.length === 0 &&
    detection.candidateTaskIds.length > 0;

  compared++;
  if (before) firedBefore++;
  if (after) firedAfter++;
  if (!before && after) {
    newFires.push({
      timestamp: firedAt,
      task: String(candidates[0]),
      wasSuppressedBy: (record["suppressionReasons"] as string[] | undefined) ?? [],
    });
  }
}

const attributable = (reason: string): number =>
  newFires.filter((f) => f.wasSuppressedBy.some((r) => r.startsWith(reason))).length;

console.log(
  JSON.stringify(
    {
      evaluationRecords: records.length,
      withCandidateTask: withCandidate,
      unrecovered,
      unreproduced,
      compared,
      firedBefore,
      firedAfter,
      newFires: newFires.length,
      attribution: {
        // A new fire can be attributable to BOTH changes — a turn suppressed by
        // the status-set discharge AND by a scratch write needed both lifted.
        // These overlap on purpose; they are not a partition.
        statusSetDischargeLifted: attributable("discharged:"),
        workingTurnLifted: attributable("working-turn"),
      },
      sample: newFires.slice(0, 10),
    },
    null,
    2
  )
);

console.log(
  `\nPASS: ${withCandidate} candidate-carrying records, ${compared} compared ` +
    `(${unrecovered} unrecovered, ${unreproduced} unreproduced); ` +
    `${firedBefore} fired before, ${firedAfter} after, ${newFires.length} newly firing.`
);
console.log(
  "Hand-classify the newly-firing turns before any posture change — this script " +
    "measures the delta, it does not judge it."
);
