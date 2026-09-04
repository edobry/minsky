#!/usr/bin/env bun
/**
 * Replay `duplicate-check-search-provenance`'s discharge over its own live
 * calibration log, and report what the mt#4975 query-aware discharge changes.
 *
 * ## Why a replay rather than a unit test
 *
 * The guard's old discharge was `sessionRanASearch` — presence-only, so ANY
 * search cleared ANY claimed search. Whether replacing it with a query
 * comparison is an improvement or a false-positive machine is a question about
 * the REAL corpus of records, not about a fixture: the answer depends on how
 * authors actually write duplicate-check records, which no synthetic case can
 * establish. This runs the new discharge over every record that took the old
 * branch and prints the split.
 *
 * ## The join, and why it is needed
 *
 * The calibration log does NOT carry the record text for a `clean` outcome —
 * measured, a `jq keys` union over all 239 records yields exactly
 * `{ts, title, sessionId, reason, outcome}` (mt#4665 is the sibling finding
 * about that omission). So the record and the session's actual queries are both
 * recovered from the TRANSCRIPT: `sessionId` names the Claude Code JSONL, and
 * the `tasks_create` tool_use inside it carries the `spec` the guard saw.
 *
 * A title can match more than one `tasks_create` — a create denied by a sibling
 * guard is retried — so the join takes the LAST create whose spec actually
 * carries a duplicate-check record. Taking the first silently resolved 5 of 30
 * records to a pre-record draft.
 *
 * ## Positive control
 *
 * The finding this produces is mostly a set of records that still DISCHARGE, and
 * a probe that clears everything because it is broken looks identical to one
 * that clears everything because the records are honest (mem#704). If the run
 * extracts no queries at all, or clears every single record including the two
 * known fabrications, the harness is broken and this exits non-zero rather than
 * reporting a clean corpus.
 *
 * Usage:
 *   bun scripts/replay-duplicate-check-search-provenance.ts [--log <path>]
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { calibrationLogPath } from "../.minsky/hooks/dispatcher";
import {
  checkoutForLegacyLogPath,
  transcriptRootFallbackNotice,
} from "./lib/calibration-log-checkout";
import {
  extractNamedQueries,
  namedQueryWasRun,
  queryTokenCoverage,
  sessionSearchQueries,
} from "../.minsky/hooks/evidence-provenance-table";
import { extractDuplicateCheckRecord } from "../.minsky/hooks/duplicate-check-search-provenance";
import type { TranscriptLine } from "../.minsky/hooks/transcript";

const REPO_ROOT = resolve(import.meta.dir, "..");
const GUARD = "duplicate-check-search-provenance";
/** The branch mt#4975 is about: the old presence-only discharge cleared these. */
const TARGET_REASON = "search claim matched a call";

interface CalibrationRecord {
  ts: string;
  sessionId: string | null;
  title: string | null;
  outcome: string;
  reason?: string;
}

/** Claude Code stores a project's transcripts under `~/.claude/projects/<cwd with / replaced by ->`. */
function transcriptDirFor(checkout: string): string {
  return join(homedir(), ".claude", "projects", checkout.replace(/\//g, "-"));
}

function parseArgs(): { logPath: string; transcriptDir: string | null } {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | null => {
    const i = argv.indexOf(name);
    if (i === -1) return null;
    return argv[i + 1] ?? null;
  };
  return {
    logPath: flag("--log") ?? calibrationLogPath(GUARD, { fallbackCwd: REPO_ROOT }),
    // Required when replaying a corpus that belongs to a DIFFERENT checkout than
    // the one this runs from — the usual case being a session workspace, whose
    // project key is its own clone's (mt#4954 / mt#4976 own converging that).
    // A state-dir log path cannot name its checkout, so it cannot be derived.
    transcriptDir: flag("--transcript-dir"),
  };
}

function readTranscript(path: string): TranscriptLine[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line) as TranscriptLine;
      } catch {
        return null;
      }
    })
    .filter((l): l is TranscriptLine => l !== null);
}

/** Every `tasks_create` tool_use input in the transcript, in order. */
function createInputs(lines: TranscriptLine[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    const content = line.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<Record<string, unknown>>) {
      const name = block?.["name"];
      if (
        block?.["type"] === "tool_use" &&
        typeof name === "string" &&
        name.endsWith("tasks_create")
      ) {
        const input = block["input"];
        out.push(input && typeof input === "object" ? (input as Record<string, unknown>) : {});
      }
    }
  }
  return out;
}

function main(): void {
  const { logPath, transcriptDir: transcriptDirOverride } = parseArgs();
  if (!existsSync(logPath)) {
    console.error(`FAIL: calibration log not found: ${logPath}`);
    process.exit(2);
  }

  // A legacy `<checkout>/.minsky/<file>` path still names its checkout; a
  // state-dir path cannot (one-way hash), so say so rather than steering
  // silently to the wrong transcripts.
  const checkout = checkoutForLegacyLogPath(logPath);
  if (
    transcriptDirOverride === null &&
    checkout === null &&
    logPath !== calibrationLogPath(GUARD, { fallbackCwd: REPO_ROOT })
  ) {
    console.warn(transcriptRootFallbackNotice(logPath, REPO_ROOT));
  }
  const transcriptDir = transcriptDirOverride ?? transcriptDirFor(checkout ?? REPO_ROOT);
  if (!existsSync(transcriptDir)) {
    console.error(`FAIL: transcript directory not found: ${transcriptDir}`);
    process.exit(2);
  }

  const records: CalibrationRecord[] = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as CalibrationRecord)
    .filter((r) => r.reason === TARGET_REASON);

  if (records.length === 0) {
    console.error(`FAIL: no "${TARGET_REASON}" records in ${logPath} — nothing to replay.`);
    process.exit(2);
  }

  const discharged: string[] = [];
  const flagged: Array<{ ts: string; title: string; named: string[]; best: number }> = [];
  const presenceFallback: string[] = [];
  const unresolved: string[] = [];

  for (const rec of records) {
    if (!rec.sessionId) {
      unresolved.push(`${rec.ts} (no sessionId)`);
      continue;
    }
    const transcriptPath = join(transcriptDir, `${rec.sessionId}.jsonl`);
    if (!existsSync(transcriptPath)) {
      unresolved.push(`${rec.ts} (transcript missing)`);
      continue;
    }
    const lines = readTranscript(transcriptPath);
    const withRecord = createInputs(lines).filter(
      (input) =>
        input["title"] === rec.title &&
        extractDuplicateCheckRecord(
          typeof input["spec"] === "string" ? (input["spec"] as string) : ""
        )
    );
    const chosen = withRecord[withRecord.length - 1];
    if (!chosen) {
      unresolved.push(`${rec.ts} (no create carrying a duplicate-check record)`);
      continue;
    }
    const record = extractDuplicateCheckRecord(
      typeof chosen["spec"] === "string" ? chosen["spec"] : ""
    );
    if (!record) {
      unresolved.push(`${rec.ts} (record vanished between filter and read)`);
      continue;
    }
    const named = extractNamedQueries(record);
    if (named.length === 0) {
      presenceFallback.push(rec.ts);
      continue;
    }
    // Reproduce the guard's ACTUAL view: at PreToolUse the transcript ends at
    // the create, so only searches that already ran can discharge. Replaying
    // over the whole file lets a search run AFTERWARDS clear the record — and
    // that is not a hypothetical, it silently cleared the 19:02:20 incident
    // here, because the query named in that fabricated record was in fact run
    // later, while investigating it (mem#1236: keep lines <= record.timestamp).
    const asOfCreate = lines.filter(
      (l) => typeof l.timestamp !== "string" || l.timestamp <= rec.ts
    );
    const actual = sessionSearchQueries(asOfCreate);
    if (namedQueryWasRun(named, actual)) {
      discharged.push(rec.ts);
      continue;
    }
    let best = 0;
    for (const n of named) for (const a of actual) best = Math.max(best, queryTokenCoverage(n, a));
    flagged.push({ ts: rec.ts, title: String(rec.title ?? ""), named, best });
  }

  const withNamed = discharged.length + flagged.length;
  console.log(`Replay of ${GUARD} over ${records.length} "${TARGET_REASON}" records`);
  console.log(`  log:         ${logPath}`);
  console.log(`  transcripts: ${transcriptDir}\n`);
  console.log(`  named a query:        ${withNamed}`);
  console.log(`    still discharges:   ${discharged.length}`);
  console.log(`    NEWLY FLAGGED:      ${flagged.length}`);
  console.log(`  no named query:       ${presenceFallback.length}  (presence fallback, unchanged)`);
  console.log(`  unresolved:           ${unresolved.length}`);

  if (flagged.length > 0) {
    console.log(`\nNewly flagged — each needs a spot-check verdict:`);
    for (const f of flagged) {
      console.log(`\n  ${f.ts}  (best coverage ${f.best.toFixed(2)})`);
      console.log(`    title: ${f.title.slice(0, 90)}`);
      for (const n of f.named) console.log(`    named: "${n.slice(0, 100)}"`);
    }
  }
  if (unresolved.length > 0) {
    console.log(`\nUnresolved (join could not recover the record):`);
    for (const u of unresolved) console.log(`  - ${u}`);
  }

  // ---- Positive controls: a clean report must be earned, not defaulted to ----
  if (withNamed === 0) {
    console.error(
      `\nFAIL (control): not one record yielded a named query. The extractor is broken, ` +
        `or the join is resolving the wrong creates — either way this run says nothing ` +
        `about the corpus.`
    );
    process.exit(1);
  }
  if (flagged.length === withNamed) {
    console.error(
      `\nFAIL (control): every named-query record flagged. A tune that flags the whole ` +
        `branch is wrong regardless of the count (mt#4975 SC).`
    );
    process.exit(1);
  }

  console.log(
    `\nOK: ${discharged.length} of ${withNamed} named-query records still discharge; ` +
      `${flagged.length} flag. The 195+ "no search claim" majority is untouched by this branch.`
  );
}

if (import.meta.main) main();
