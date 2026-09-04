#!/usr/bin/env bun
/**
 * Replay the operator-deferral calibration log through the CURRENT matcher and
 * report, per record, whether it still fires (mt#3865 AT4).
 *
 * **What this can and cannot measure.** The records carry no input text — only
 * `phrase` and a `context` capped at `MATCH_CONTEXT_MAX_CHARS` (240). mt#3649
 * owns that gap. So the replay runs over CONTEXT strings, not original turns,
 * and three things follow that must not be papered over:
 *
 *   1. Records written before `captureSchema: 1` have NO context at all. They
 *      are reported as `unreplayable`, not as passes.
 *   2. A context truncated before the offered action cannot be rated by a
 *      human either; it is replayed, but its verdict is worth less.
 *   3. A context is a WINDOW, so a suppression cue that sat outside it in the
 *      original turn is absent here — this replay can therefore report a fire
 *      the live matcher would suppress, never the reverse.
 *
 * The denominator is printed explicitly for that reason. Exit code is 0 when
 * the replay completes; it is a MEASUREMENT, not a gate.
 *
 * The calibration log is a live, gitignored artifact — it exists in the main
 * workspace, not in a session clone — so the path is an argument:
 *
 *   bun scripts/replay-operator-deferral-calibration.ts [path-to-log]
 *
 * defaulting to this checkout's `.minsky/operator-deferral-calibration.jsonl`.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CAPABILITY_DEFERRAL_PATTERNS,
  PERMISSION_DEFERRAL_PATTERNS,
  detectCapabilityDeferral,
  detectPermissionDeferral,
  findReportableKill,
} from "../.minsky/hooks/operator-deferral-detector";
import { findKillVerb } from "../.minsky/hooks/block-bulk-process-kill";
import type { TranscriptLine } from "../.minsky/hooks/transcript";
import { calibrationLogPath } from "../.minsky/hooks/dispatcher";

/**
 * mt#4971: resolved through the WRITER's own function rather than the pre-mt#4748
 * repo path, which no longer exists — reading it produced a SKIP that looked like
 * "no records" rather than "wrong location". `fallbackCwd` (not `projectDir`) keeps
 * the resolver's `CLAUDE_PROJECT_DIR` tier ahead of this checkout.
 */
const LOG =
  process.argv[2] ??
  calibrationLogPath("operator-deferral", { fallbackCwd: resolve(import.meta.dir, "..") });

interface LoggedMatch {
  category?: string;
  phrase?: string;
  context?: string;
}
interface LoggedRecord {
  timestamp?: string;
  captureSchema?: number;
  matches?: LoggedMatch[];
}

const asTurn = (text: string): TranscriptLine[] => [
  {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  },
];

/**
 * The act-path surface, replayed differently from the prose ones (mt#4111).
 *
 * Its stored context is a COMMAND, not prose, so the prose detectors say nothing about it — and
 * before this arm existed the surface's records fell through to `phraseTruncated` regardless of
 * what they held, which is indistinguishable from being unreadable. The kill parse is what
 * judged them, so the kill parse is what replays them.
 */
const ACT_PATH = "act-path-workaround";

function firesNow(match: LoggedMatch, context: string): string[] {
  if (match.category === ACT_PATH) {
    return findReportableKill(context) === null ? [] : [ACT_PATH];
  }
  return [
    ...detectCapabilityDeferral(asTurn(context)),
    ...detectPermissionDeferral(asTurn(context)),
  ].map((m) => m.surface);
}

/**
 * Whether any trigger pattern matches the context AT ALL, ignoring every
 * suppression. This is the replay's "before" — and the reason it is needed is
 * that a stored context is a 240-char WINDOW around the match, which for
 * several records does not contain the matched phrase itself. Without this
 * split, a record silent because its phrase was truncated away is
 * indistinguishable from one this change deliberately suppressed, and the
 * delta would be overstated by exactly that many records.
 */
function phrasePresent(match: LoggedMatch, context: string): boolean {
  // For the act path the equivalent question is whether the KILL is visible in the stored
  // window at all. Pre-mt#4111 records stored the head of the command, so a kill in the tail of
  // a compound command is absent from its own record — the same "silent for a reason this change
  // did not cause" case the prose arm measures, on a different axis.
  if (match.category === ACT_PATH) return findKillVerb(context) !== null;
  return [...CAPABILITY_DEFERRAL_PATTERNS, ...PERMISSION_DEFERRAL_PATTERNS].some((p) =>
    p.test(context)
  );
}

function main(): void {
  // mt#4971: SKIP rather than throwing ENOENT. The default now resolves a
  // project-KEYED state-dir path, so a run from a checkout that has produced no
  // fires (a session workspace, or a fresh clone) legitimately finds no file —
  // and an unhandled stack trace reads as a broken script rather than an empty
  // corpus. Every sibling replay harness already skips this way.
  if (!existsSync(LOG)) {
    console.log(`SKIP: calibration log not found at ${LOG}`);
    console.log("(Pass a path as the first argument to read another checkout's log.)");
    process.exit(0);
  }

  const lines = readFileSync(LOG, "utf8").split("\n").filter(Boolean);

  let total = 0;
  let unreplayable = 0;
  let actPathSeen = 0;
  const phraseTruncated: Array<{ ts: string; phrase: string; context: string }> = [];
  const stillFires: Array<{ ts: string; phrase: string; context: string }> = [];
  const nowQuiet: Array<{ ts: string; phrase: string; context: string }> = [];

  for (const line of lines) {
    let record: LoggedRecord;
    try {
      record = JSON.parse(line) as LoggedRecord;
    } catch {
      console.error(`SKIP: unparseable line`);
      continue;
    }
    for (const match of record.matches ?? []) {
      total += 1;
      if (match.category === ACT_PATH) actPathSeen += 1;
      const context = match.context?.trim();
      const ts = record.timestamp ?? "(no timestamp)";
      const phrase = match.phrase ?? "(no phrase)";
      if (!context) {
        unreplayable += 1;
        continue;
      }
      const entry = { ts, phrase, context };
      if (!phrasePresent(match, context)) phraseTruncated.push(entry);
      else if (firesNow(match, context).length > 0) stillFires.push(entry);
      else nowQuiet.push(entry);
    }
  }

  const rateable = stillFires.length + nowQuiet.length;
  console.log(`records with a match:            ${total}`);
  if (actPathSeen > 0) {
    // Naming each arm's BEFORE explicitly (PR #3051 R1). The two arms answer the
    // same before/after question against different matchers, and a reader who
    // assumes one applies to both will misread the delta.
    console.log(`  act-path arm (${actPathSeen} record(s)):`);
    console.log(`    before = any kill verb visible  (the pre-mt#4111 trigger)`);
    console.log(`    after  = findReportableKill     (non-denied + multi-target)`);
    console.log(`    NOT replayable: both TURN-STATE legs — the denial, and the absence of`);
    console.log(`    a capability search. A record carries neither, so a call the guard`);
    console.log(`    REFUSED (or one the turn searched before making) still reads as firing`);
    console.log(`    here. Both sides of this arm are therefore upper bounds on the real`);
    console.log(`    trigger, and the unit tests cover what the replay cannot.`);
  }
  console.log(`  no context at all:             ${unreplayable}   <- pre-captureSchema; mt#3649`);
  console.log(`  phrase truncated out of window: ${phraseTruncated.length}   <- silent for a`);
  console.log(`                                       reason this change did not cause`);
  console.log(`  RATEABLE (before = fires):     ${rateable}`);
  console.log(`    after: still fires:          ${stillFires.length}`);
  console.log(`    after: suppressed:           ${nowQuiet.length}`);

  console.log(`\n--- suppressed by this change (${nowQuiet.length}) ---`);
  for (const e of nowQuiet) console.log(`${e.ts}  [${e.phrase}]\n    ${e.context}\n`);

  console.log(`--- phrase truncated out of the stored window (${phraseTruncated.length}) ---`);
  for (const e of phraseTruncated) console.log(`${e.ts}  [${e.phrase}]`);

  console.log(`\n--- still fires (${stillFires.length}) ---`);
  for (const e of stillFires) console.log(`${e.ts}  [${e.phrase}]\n    ${e.context}\n`);
}

main();
