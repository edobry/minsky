#!/usr/bin/env bun
/**
 * Replay the current `code-mechanism-assertion` detector over its own recorded
 * calibration history (mt#3649).
 *
 * The problem this closes: a record used to carry the EXTRACTED claims but not
 * the text they were extracted from, so "does this change alter what the
 * existing surface detects?" could only be inferred. mt#3642 wrote exactly that
 * criterion, could not run it, and shipped the unchanged test suite as
 * substitute evidence — which proves the cases someone thought to write still
 * behave, not that real traffic is unperturbed.
 *
 * Usage:
 *   bun scripts/replay-code-mechanism-calibration.ts [--log <path>] [--json]
 *
 * Exit codes: 0 = replay ran (whatever it found), 1 = replay could not run.
 * A CHANGED record is a finding to read, not a failure — this reports, it does
 * not gate.
 *
 * ## What a verdict does and does not mean
 *
 * Three verdicts, and the two non-`same` ones exist so a missing input can
 * never be counted as agreement (mem#704: a probe returning the same answer
 * when its input is absent carries no information):
 *
 * - `unrecoverable` — the record predates the capture (`captureSchema` absent).
 *   NOT comparable. Never folded into same/changed.
 * - `partial` — the capture was truncated at the cap, so the replay saw a
 *   PREFIX of what the detector saw. A prefix can only lose claims, never gain
 *   them, so a `changed` verdict here is uninformative and is reported as
 *   `partial` instead.
 * - `same` / `changed` — a full-fidelity comparison of the CHAT-surface claim
 *   set.
 *
 * **Bound worth stating: this replays claim EXTRACTION, not BACKING.** The
 * detector takes a verification corpus built from the turn's tool calls, and
 * that corpus is not captured — only the judged text is. So `hadSameTurnRead`
 * and `backedClaimCount`, which are corpus-derived, are outside what this can
 * re-derive, and the comparison is scoped to `claims`. Capturing the corpus is
 * a strictly larger retention decision and is deliberately not taken here.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { detectCodeMechanismAssertion } from "../.minsky/hooks/code-mechanism-assertion-detector";
import { hasJudgedInputCapture } from "../.minsky/hooks/judged-input-capture";
import { calibrationLogPath } from "../.minsky/hooks/dispatcher";

/**
 * mt#4971: resolved through the WRITER's own function rather than the pre-mt#4748
 * repo path, which no longer exists — reading it produced a SKIP that looked like
 * "no records" rather than "wrong location". `fallbackCwd` (not `projectDir`) keeps
 * the resolver's `CLAUDE_PROJECT_DIR` tier ahead of this checkout.
 */
const DEFAULT_LOG = calibrationLogPath("code-mechanism-assertion", {
  fallbackCwd: resolve(import.meta.dir, ".."),
});

type Verdict = "same" | "changed" | "partial" | "unrecoverable";

interface RecordComparison {
  index: number;
  timestamp: unknown;
  verdict: Verdict;
  recordedClaims: string[];
  replayedClaims: string[];
}

/** Canonical, order-insensitive form of a claim set, for comparison. */
export function claimKeys(claims: unknown): string[] {
  if (!Array.isArray(claims)) return [];
  return claims
    .map((c) => {
      if (c === null || typeof c !== "object") return "";
      const rec = c as Record<string, unknown>;
      return `${String(rec["symbol"] ?? "")}|${String(rec["predicate"] ?? "")}`;
    })
    .filter((k) => k !== "")
    .sort();
}

/**
 * Compare one record against a fresh run of the current detector.
 *
 * Pure and exported so the acceptance tests can drive it directly rather than
 * reaching through the file-reading shell around it.
 */
export function compareRecord(record: Record<string, unknown>, index: number): RecordComparison {
  const recordedClaims = claimKeys(record["claims"]);
  const base: Omit<RecordComparison, "verdict" | "replayedClaims"> = {
    index,
    timestamp: record["timestamp"],
    recordedClaims,
  };

  if (!hasJudgedInputCapture(record)) {
    return { ...base, verdict: "unrecoverable", replayedClaims: [] };
  }

  const captured = record["judgedInput"];
  if (captured === null || typeof captured !== "object") {
    return { ...base, verdict: "unrecoverable", replayedClaims: [] };
  }
  const cap = captured as Record<string, unknown>;
  const excerpt = typeof cap["excerpt"] === "string" ? cap["excerpt"] : undefined;
  if (excerpt === undefined) {
    return { ...base, verdict: "unrecoverable", replayedClaims: [] };
  }

  // The corpus is not captured (see the module docblock): replay extraction
  // against an empty verification corpus and compare the claim set only.
  const replayed = claimKeys(detectCodeMechanismAssertion(excerpt, "", "").claims);

  if (cap["truncated"] === true) {
    return { ...base, verdict: "partial", replayedClaims: replayed };
  }

  const same =
    replayed.length === recordedClaims.length && replayed.every((k, i) => k === recordedClaims[i]);
  return { ...base, verdict: same ? "same" : "changed", replayedClaims: replayed };
}

export function parseLog(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object") {
        out.push(parsed as Record<string, unknown>);
      }
    } catch {
      // A partially-written trailing line is normal for an append-only log;
      // skipping it is correct and is counted in the summary as a skip.
    }
  }
  return out;
}

export interface ReplaySummary {
  total: number;
  same: number;
  changed: number;
  partial: number;
  unrecoverable: number;
}

export function summarize(comparisons: RecordComparison[]): ReplaySummary {
  return {
    total: comparisons.length,
    same: comparisons.filter((c) => c.verdict === "same").length,
    changed: comparisons.filter((c) => c.verdict === "changed").length,
    partial: comparisons.filter((c) => c.verdict === "partial").length,
    unrecoverable: comparisons.filter((c) => c.verdict === "unrecoverable").length,
  };
}

function main(): void {
  const argv = process.argv.slice(2);
  const logFlag = argv.indexOf("--log");
  const logPath = resolve(logFlag >= 0 ? (argv[logFlag + 1] ?? DEFAULT_LOG) : DEFAULT_LOG);
  const asJson = argv.includes("--json");

  let text: string;
  try {
    text = readFileSync(logPath, "utf-8");
  } catch (err) {
    process.stderr.write(
      `[replay] cannot read ${logPath}: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(1);
  }

  const comparisons = parseLog(text).map(compareRecord);
  const summary = summarize(comparisons);

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ log: logPath, summary, comparisons }, null, 2)}\n`);
    return;
  }

  process.stdout.write(`[replay] ${logPath}\n`);
  for (const c of comparisons) {
    if (c.verdict === "changed") {
      process.stdout.write(
        `  CHANGED  #${c.index} ${String(c.timestamp)}\n` +
          `    recorded: ${c.recordedClaims.join(", ") || "(none)"}\n` +
          `    replayed: ${c.replayedClaims.join(", ") || "(none)"}\n`
      );
    }
  }
  process.stdout.write(
    `[replay] total=${summary.total} same=${summary.same} changed=${summary.changed} ` +
      `partial=${summary.partial} unrecoverable=${summary.unrecoverable}\n`
  );
  if (summary.unrecoverable > 0) {
    process.stdout.write(
      `[replay] ${summary.unrecoverable} record(s) predate the capture and are NOT comparable — ` +
        `they are excluded from same/changed, not counted as agreement.\n`
    );
  }
}

if (import.meta.main) {
  main();
}
