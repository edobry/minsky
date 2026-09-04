#!/usr/bin/env bun
/**
 * Recover the judged input behind `retrospective-trigger` calibration records
 * from the transcripts they were written against (mt#3821).
 *
 * ## Why this exists rather than a bigger capture
 *
 * mt#3931 could not be fixed because its pilot harness fed the confirm stage an
 * isolated SENTENCE while production feeds it the whole elided turn — so the
 * harness never reproduced the false positives it was built to remove, and a
 * negative control against it proved nothing (mem#704). The obvious remedy was
 * to store the whole turn in every record. That was rejected: the turn already
 * exists in the transcript, the record only has to be able to FIND it and to
 * PROVE that what was found is what was judged. So records carry
 * `judged_text_hash` (mt#3821) and this script does the finding.
 *
 * ## What a verdict means here
 *
 * - `recovered-verified` — a turn in the transcript elides to exactly the
 *   recorded hash. This is the only verdict that licenses using the text as a
 *   replay input.
 * - `recovered-corroborated` — no hash (the record predates `captureSchema`),
 *   but the returned turn CONTAINS the text the record itself quotes: its
 *   `transcript_excerpt`, or failing that its matched phrase. Weaker than a
 *   hash — a turn containing the phrase is not proof it is the turn that was
 *   judged — and far stronger than proximity in time.
 * - `recovered-unverified` — no hash and nothing to corroborate against, so the
 *   nearest candidate ending at or before the record's timestamp is returned. It
 *   is a CANDIDATE: plausible, unproven. Two measurements over the four mt#3931
 *   records bound it. Against WHOLE-TURN candidates it picked the wrong turn 3
 *   times out of 4, which is why prefixes exist (below). With prefixes it picks a
 *   candidate containing the record's own phrase 4 times out of 4 — better, and
 *   still not proof: containing the phrase is not being the judged text, and a
 *   record with nothing quoted (885 of the 959 in the live log) offers no way to
 *   check even that. Treat this verdict as a lead to check by hand, never as a
 *   replay input.
 * - `hash-mismatch` — a hash was present and no turn matched it. Reported
 *   loudly rather than silently downgraded to the nearest turn: a mismatch says
 *   the transcript was rotated, edited, or resolved differently, and quietly
 *   handing back the wrong text is exactly the failure the hash exists to catch.
 * - `unreplayable` — no transcript file for the session, or no assistant turn in
 *   it. NEVER counted as a pass. `scripts/replay-operator-deferral-calibration.ts`
 *   prints its denominator for the same reason.
 *
 * ## Usage
 *
 *   bun scripts/replay-retrospective-trigger-calibration.ts [options]
 *
 *     --log <path>       calibration log (default: this checkout's state-dir path,
 *                        `<state dir>/projects/<key>/retrospective-trigger-calibration.jsonl`)
 *     --session <id>     only records from this session id
 *     --timestamp <iso>  only the record with this exact timestamp (repeatable)
 *     --out <path>       write recovered texts as JSON (default: report only)
 *     --limit <n>        stop after n records
 *
 * The log and the transcripts are live local artifacts — gitignored, and absent
 * from a session clone — so paths are arguments and the transcript root is
 * resolved at runtime. Exit code is 0 whenever the replay COMPLETES; this is a
 * measurement, not a gate.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { elideQuotedAndCodeContexts } from "../.minsky/hooks/elision";
import { hashJudgedText } from "../.minsky/hooks/judged-input-capture";
import {
  extractAssistantText,
  findRealPromptIndices,
  parseTranscript,
  type TranscriptLine,
} from "../.minsky/hooks/transcript";
import { calibrationLogPath } from "../.minsky/hooks/dispatcher";

/**
 * The log this harness reads by default (mt#4971).
 *
 * mt#4748 moved calibration streams off the repo working tree into
 * `<state dir>/projects/<key>/`. This constant kept resolving the pre-migration
 * repo path, so a bare invocation printed `SKIP: calibration log not found` — and
 * `SKIP` reads as "nothing to do here", not as a defect. `/calibration-review`
 * Step 2 makes recovering the judged turn MANDATORY for this detector and names
 * this script as the tool, so the default being dead broke a mandated procedure
 * silently.
 *
 * Resolved through the WRITER's own function rather than a local copy of the key
 * derivation, so a reader and a writer cannot disagree about where the log is.
 * Importing the dispatcher costs ~14ms over what this script already imports:
 * `GUARD_REGISTRY`'s entries are lazy `() => import(...)` thunks, so no guard
 * module is evaluated (the precedent and the reasoning are recorded in
 * `scripts/lib/calibration-log-declarations.ts`'s header).
 *
 * Passed as `fallbackCwd`, NOT `projectDir`, so the resolver's own precedence
 * (`projectDir ?? CLAUDE_PROJECT_DIR ?? fallbackCwd ?? cwd`) still lets the harness's
 * project root win when one is set — which is the root the WRITER used. Measured:
 * `CLAUDE_PROJECT_DIR` is unset in an ordinary shell and in `session_exec`, and is
 * set for hook invocations, so this tier is inert for a manual run and correct for
 * an automated one. `projectDir` would have outranked it and silently pinned the
 * wrong checkout in the case where it matters.
 *
 * The fallback is THIS checkout, preserving the pre-migration semantics: run from a
 * session workspace with no harness root set, it resolves that workspace's project
 * key and finds nothing — `--log` remains the override for reading another
 * checkout's logs.
 */
const DEFAULT_LOG = calibrationLogPath("retrospective-trigger", {
  fallbackCwd: resolve(import.meta.dir, ".."),
});

/** Claude Code's per-project transcript root. One directory per encoded cwd. */
const TRANSCRIPT_ROOT = join(homedir(), ".claude", "projects");

type Verdict =
  | "recovered-verified"
  | "recovered-corroborated"
  | "recovered-unverified"
  | "hash-mismatch"
  | "unreplayable";

interface CalibrationRecord {
  timestamp?: string;
  session_id?: string;
  judged_text_hash?: string;
  judged_text_length?: number;
  captureSchema?: number;
  transcript_excerpt?: string;
  matches?: { family?: string; phrase?: string }[];
  nominated_families?: string[];
  confirmed_families?: string[];
}

interface Recovery {
  timestamp: string;
  sessionId: string;
  verdict: Verdict;
  /** Why an `unreplayable` verdict was reached; absent otherwise. */
  reason?: string;
  /** The recovered elided turn text. Absent unless a turn was recovered. */
  judgedText?: string;
  recoveredHash?: string;
  recordedHash?: string;
  /** What a `recovered-corroborated` verdict was corroborated against. */
  corroboratedBy?: "transcript_excerpt" | "matched_phrase";
  /** Turns examined in the transcript — the denominator behind the verdict. */
  turnsExamined: number;
}

interface Args {
  log: string;
  session?: string;
  timestamps: string[];
  out?: string;
  limit?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { log: DEFAULT_LOG, timestamps: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--log" && value !== undefined) (args.log = resolve(value)), i++;
    else if (flag === "--session" && value !== undefined) (args.session = value), i++;
    else if (flag === "--timestamp" && value !== undefined) args.timestamps.push(value), i++;
    else if (flag === "--out" && value !== undefined) (args.out = resolve(value)), i++;
    else if (flag === "--limit" && value !== undefined) (args.limit = Number(value)), i++;
  }
  return args;
}

/**
 * Find a session's transcript. Claude Code names the file for the session id
 * under a per-project directory, so the project directory is unknown here and
 * every one is searched. Returns null rather than throwing when the file has
 * been rotated away — that is the `unreplayable` case, not an error.
 */
function findTranscript(sessionId: string): string | null {
  if (!existsSync(TRANSCRIPT_ROOT)) return null;
  for (const project of readdirSync(TRANSCRIPT_ROOT)) {
    const candidate = join(TRANSCRIPT_ROOT, project, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Every assistant text the hook could have judged, elided the way every rung
 * matches on it.
 *
 * **Turn PREFIXES are candidates, not just whole turns**, and that is the
 * load-bearing part rather than thoroughness for its own sake. This scanner runs
 * at `UserPromptSubmit`, so the prompt that fires it is not yet in the file the
 * hook reads — it lands afterwards, and `transcript.ts:590-600` documents that
 * ordinary skew. A later reader therefore segments turns differently from the
 * hook: measured on session `719ef66c`, the turn the hook judged and the next
 * one appear here as ONE 3,927-character candidate ending four minutes past the
 * record. Whole-turn candidates alone made every one of mt#3931's four records
 * resolve to the wrong turn, and would make a hash written by the live scanner
 * fail to match its own transcript. Emitting the cumulative prefix at each
 * assistant line puts the exact judged text back in the candidate set.
 *
 * Deduplicated by text: a turn with one assistant message yields the same string
 * as its own prefix.
 */
function turnCandidates(lines: TranscriptLine[]): { text: string; endsAt?: string }[] {
  const promptIndices = findRealPromptIndices(lines);
  const candidates: { text: string; endsAt?: string }[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < promptIndices.length; i++) {
    const start = promptIndices[i];
    if (start === undefined) continue;
    const end = promptIndices[i + 1] ?? lines.length;
    const turnLines = lines.slice(start, end);
    let endsAt: string | undefined;
    for (let cut = 1; cut <= turnLines.length; cut++) {
      const line = turnLines[cut - 1];
      if (line?.timestamp !== undefined) endsAt = line.timestamp;
      // Only an assistant line can change the extracted text, so cutting
      // anywhere else just re-hashes a string already emitted.
      if (line?.type !== "assistant") continue;
      const assistantText = extractAssistantText(turnLines.slice(0, cut));
      if (!assistantText) continue;
      const text = elideQuotedAndCodeContexts(assistantText);
      if (seen.has(text)) continue;
      seen.add(text);
      candidates.push({ text, endsAt });
    }
  }
  return candidates;
}

/**
 * Injectable seam: how a session id becomes transcript lines. The default reads
 * the local transcript root; a test supplies its own lines rather than writing
 * into the operator's `~/.claude` (testing-standards `§Testable Design` — the
 * alternative was patching `node:fs`, which is the shape that discipline exists
 * to avoid).
 */
export interface RecoverDeps {
  resolveLines?: (sessionId: string) => TranscriptLine[] | null;
}

/**
 * Memoized per session: a log holds many records from one conversation, and
 * re-parsing a 2,000-line transcript once per record turns a whole-log replay
 * into minutes of work for no new information.
 */
const linesCache = new Map<string, TranscriptLine[] | null>();

function defaultResolveLines(sessionId: string): TranscriptLine[] | null {
  const cached = linesCache.get(sessionId);
  if (cached !== undefined) return cached;
  const transcriptPath = findTranscript(sessionId);
  const lines = transcriptPath === null ? null : parseTranscript(transcriptPath);
  linesCache.set(sessionId, lines);
  return lines;
}

function recover(record: CalibrationRecord, deps: RecoverDeps = {}): Recovery {
  const timestamp = record.timestamp ?? "";
  const sessionId = record.session_id ?? "";
  const base = { timestamp, sessionId, turnsExamined: 0 };

  if (!sessionId) {
    return { ...base, verdict: "unreplayable", reason: "record carries no session_id" };
  }
  const lines = (deps.resolveLines ?? defaultResolveLines)(sessionId);
  if (lines === null) {
    return { ...base, verdict: "unreplayable", reason: "no transcript file for session" };
  }
  const candidates = turnCandidates(lines);
  if (candidates.length === 0) {
    return { ...base, verdict: "unreplayable", reason: "transcript holds no assistant turn" };
  }

  const recordedHash = record.judged_text_hash;
  if (recordedHash !== undefined) {
    for (const candidate of candidates) {
      const hash = hashJudgedText(candidate.text);
      if (hash === recordedHash) {
        return {
          ...base,
          turnsExamined: candidates.length,
          verdict: "recovered-verified",
          judgedText: candidate.text,
          recoveredHash: hash,
          recordedHash,
        };
      }
    }
    return {
      ...base,
      turnsExamined: candidates.length,
      verdict: "hash-mismatch",
      recordedHash,
    };
  }

  // No hash: the pre-capture population. Before falling back to proximity in
  // time, try the record's own quoted text — a record that names a phrase names
  // its own falsifier, and whitespace is normalized on both sides because the
  // stored phrase carries the elision's same-length blanks while the recovered
  // text carries them in whatever run the turn produced.
  const normalize = (value: string): string => value.replace(/\s+/gu, " ").trim();
  const needles: { value: string; kind: "transcript_excerpt" | "matched_phrase" }[] = [];
  if (record.transcript_excerpt) {
    needles.push({ value: record.transcript_excerpt, kind: "transcript_excerpt" });
  }
  const firstPhrase = record.matches?.find((m) => m.phrase)?.phrase;
  if (firstPhrase) needles.push({ value: firstPhrase, kind: "matched_phrase" });

  for (const needle of needles) {
    const target = normalize(needle.value);
    if (!target) continue;
    // Latest match wins: a phrase repeated across turns is most likely the one
    // nearest the record, and every candidate here is at or before it.
    let hit: { text: string } | undefined;
    for (const candidate of candidates) {
      if (candidate.endsAt !== undefined && timestamp && candidate.endsAt > timestamp) continue;
      if (normalize(candidate.text).includes(target)) hit = candidate;
    }
    if (hit !== undefined) {
      return {
        ...base,
        turnsExamined: candidates.length,
        verdict: "recovered-corroborated",
        corroboratedBy: needle.kind,
        judgedText: hit.text,
        recoveredHash: hashJudgedText(hit.text),
      };
    }
  }

  let best: { text: string; endsAt?: string } | undefined;
  for (const candidate of candidates) {
    if (candidate.endsAt !== undefined && timestamp && candidate.endsAt > timestamp) continue;
    best = candidate;
  }
  if (best === undefined) {
    return {
      ...base,
      turnsExamined: candidates.length,
      verdict: "unreplayable",
      reason: "no turn ends at or before the record timestamp",
    };
  }
  return {
    ...base,
    turnsExamined: candidates.length,
    verdict: "recovered-unverified",
    judgedText: best.text,
    recoveredHash: hashJudgedText(best.text),
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.log)) {
    process.stderr.write(`SKIP: calibration log not found at ${args.log}\n`);
    process.exit(0);
  }

  const records: CalibrationRecord[] = [];
  for (const line of readFileSync(args.log, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let parsed: CalibrationRecord;
    try {
      parsed = JSON.parse(line) as CalibrationRecord;
    } catch {
      continue;
    }
    if (args.session !== undefined && parsed.session_id !== args.session) continue;
    if (args.timestamps.length > 0 && !args.timestamps.includes(parsed.timestamp ?? "")) continue;
    records.push(parsed);
    if (args.limit !== undefined && records.length >= args.limit) break;
  }

  const recoveries = records.map((record) => recover(record));
  const tally: Record<Verdict, number> = {
    "recovered-verified": 0,
    "recovered-corroborated": 0,
    "recovered-unverified": 0,
    "hash-mismatch": 0,
    unreplayable: 0,
  };
  for (const recovery of recoveries) tally[recovery.verdict]++;

  process.stdout.write(`log: ${args.log}\n`);
  process.stdout.write(`records considered: ${recoveries.length}\n`);
  for (const verdict of Object.keys(tally) as Verdict[]) {
    process.stdout.write(`  ${verdict}: ${tally[verdict]}\n`);
  }
  for (const recovery of recoveries) {
    const detail =
      recovery.reason !== undefined
        ? ` (${recovery.reason})`
        : recovery.judgedText !== undefined
          ? ` (${recovery.judgedText.length} chars, ${recovery.turnsExamined} turns examined)`
          : ` (${recovery.turnsExamined} turns examined, none matched ${recovery.recordedHash})`;
    process.stdout.write(
      `${recovery.timestamp} ${recovery.sessionId.slice(0, 8)} ${recovery.verdict}${detail}\n`
    );
  }

  if (args.out !== undefined) {
    writeFileSync(args.out, `${JSON.stringify(recoveries, null, 2)}\n`);
    process.stdout.write(`wrote ${recoveries.length} recoveries to ${args.out}\n`);
  }
}

if (import.meta.main) {
  main();
}

export { recover, turnCandidates, findTranscript, type Recovery, type Verdict };
