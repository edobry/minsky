#!/usr/bin/env bun
/**
 * Replay the gate-(h) enumeration-scope check against real transcripts (mt#4171).
 *
 * WHAT IT REPLAYS. For every `session_pr_create` call on disk, it rebuilds the
 * transcript PREFIX that preceded that call — which is exactly what a PreToolUse
 * guard sees — and runs the SHIPPED `run()` against it. Nothing is re-derived: the
 * prefix IS the guard's input and `run()` IS the guard, so a fire here is a fire
 * there.
 *
 * WHY IT EXISTS. mt#4171's spec names the change-type trigger as "the task's
 * central design question, not an implementation detail." The sibling mt#4168 set
 * the precedent for settling that kind of question by measurement: its own replay
 * found 16 fires over 70 claims with ONE true positive, which moved it from
 * injecting to record-only before it shipped. Argument is not measurement.
 *
 * This script also carries the SEAM measurement that moved this guard off the
 * READY seam ADR-042 assigned — `--seam-compare` re-runs the trigger against
 * every `tasks_status_set` → READY call so the two rates sit side by side.
 *
 * Usage:
 *   bun scripts/replay-enumeration-scope.ts --sweep <dir> [--limit N] [--seam-compare]
 *   bun scripts/replay-enumeration-scope.ts --file <transcript.jsonl>
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTranscript, findToolCallsWithResults } from "../.minsky/hooks/transcript";
import type { TranscriptLine, ToolCallWithResult } from "../.minsky/hooks/transcript";
import { sessionSweptDirectories } from "../.minsky/hooks/evidence-provenance-table";
import {
  run,
  editedPaths,
  isSerializedSurfacePath,
} from "../.minsky/hooks/enumeration-scope-check";
import type { DispatchContext } from "../.minsky/hooks/registry";
import type { ToolHookInput } from "../.minsky/hooks/types";
import { deriveBudgets } from "../.minsky/hooks/types";

/**
 * The dispatcher's host cap on this guard's matcher, READ from
 * `.claude/settings.json` rather than hardcoded. That timeout is DERIVED from the
 * sum of the matcher's guards, so it moves whenever a guard joins the seam — a
 * literal here would drift silently the first time that happened.
 */
const FALLBACK_HOST_CAP_SEC = 65;

function readHostCapSec(): number {
  try {
    const settings = JSON.parse(readFileSync(".claude/settings.json", "utf8")) as {
      hooks?: { PreToolUse?: Array<{ matcher?: string; hooks?: Array<{ timeout?: number }> }> };
    };
    const block = settings.hooks?.PreToolUse?.find(
      (b) => (b.matcher ?? "") === "mcp__minsky__session_pr_create"
    );
    // Extracted stepwise rather than `block?.hooks?.[block.hooks.length - 1]`
    // (PR #3141 R1 NON-BLOCKING). Optional chaining does short-circuit the whole
    // chain, so the original could not actually throw — but it READS as though
    // the index is evaluated unconditionally, and a reviewer had to work that out
    // to clear it. Cheaper to write the version nobody has to reason about.
    const hooks = block?.hooks;
    const last = hooks && hooks.length > 0 ? hooks[hooks.length - 1] : undefined;
    const timeout = last?.timeout;
    return typeof timeout === "number" && timeout > 0 ? timeout : FALLBACK_HOST_CAP_SEC;
  } catch {
    return FALLBACK_HOST_CAP_SEC;
  }
}

const HOST_CAP_SEC = readHostCapSec();

interface Fire {
  file: string;
  outcome: string;
  reason?: string;
  serializedSurfaces?: string[];
  swept?: string[];
}

function norm(name: string): string {
  return name
    .replace(/^mcp__.*?__/, "")
    .replace(/\./g, "_")
    .toLowerCase();
}

/** Run the SHIPPED guard against the prefix before each `session_pr_create`. */
function replayFile(file: string, lines: TranscriptLine[]): Fire[] {
  const out: Fire[] = [];
  for (const call of findToolCallsWithResults(lines)) {
    if (norm(call.toolName) !== "session_pr_create") continue;
    const prefix = lines.slice(0, call.index);
    // Built as the real types rather than cast through `unknown`: a replay whose
    // inputs are shaped by an assertion can drift from what the dispatcher
    // actually hands the guard, and this script's only value is being a faithful
    // stand-in for that.
    const input: ToolHookInput = {
      session_id: `replay:${file}`,
      cwd: process.cwd(),
      hook_event_name: "PreToolUse",
      tool_name: call.toolName,
      tool_input: call.input,
    };
    const ctx: DispatchContext = {
      event: "PreToolUse",
      hostCapSec: HOST_CAP_SEC,
      budgets: deriveBudgets(HOST_CAP_SEC),
      transcriptCandidates: [file],
      transcriptLines: prefix,
    };
    const result = run(input, ctx);
    const cal = result?.calibration as Record<string, unknown> | undefined;
    if (!cal) continue;
    out.push({
      file,
      outcome: String(cal["outcome"] ?? "?"),
      reason: cal["reason"] as string | undefined,
      serializedSurfaces: cal["serializedSurfaces"] as string[] | undefined,
      swept: cal["swept"] as string[] | undefined,
    });
  }
  return out;
}

/** The same trigger at the READY seam, for the seam comparison. */
function readySeamTriggerCount(lines: TranscriptLine[]): { ready: number; triggered: number } {
  let ready = 0;
  let triggered = 0;
  for (const call of findToolCallsWithResults(lines)) {
    if (norm(call.toolName) !== "tasks_status_set") continue;
    const status = call.input["status"];
    if (typeof status !== "string" || status.toUpperCase() !== "READY") continue;
    ready++;
    // The evidence a READY-seam trigger would have: the spec body surfaced so
    // far. Recovered generously — ANY spec-read result in the prefix.
    const prefix = lines.slice(0, call.index);
    let specText = "";
    for (const c of findToolCallsWithResults(prefix)) {
      if (["tasks_spec_get", "tasks_get"].includes(norm(c.toolName))) specText += c.resultText;
    }
    // The SAME predicate the shipped guard uses, applied to the path tokens the
    // spec names — so the two seams are compared on one definition rather than
    // on two differently-shaped regexes.
    const specPaths = [...specText.matchAll(/\b[\w@][\w\-./]*\/[\w\-.]+\.\w+\b/g)].map((m) => m[0]);
    if (specPaths.some(isSerializedSurfacePath)) triggered++;
  }
  return { ready, triggered };
}

function pct(n: number, d: number): string {
  if (d === 0) return "n/a";
  return `${((n / d) * 100).toFixed(1)}%`;
}

function main(): void {
  const args = process.argv.slice(2);
  const sweepIdx = args.indexOf("--sweep");
  const fileIdx = args.indexOf("--file");
  const limitIdx = args.indexOf("--limit");
  const seamCompare = args.includes("--seam-compare");
  const limit = limitIdx >= 0 ? Number.parseInt(args[limitIdx + 1] ?? "0", 10) : 0;

  let files: string[] = [];
  if (fileIdx >= 0) {
    const f = args[fileIdx + 1];
    if (!f) {
      console.error("--file needs a path");
      process.exit(2);
    }
    files = [f];
  } else if (sweepIdx >= 0) {
    const dir = args[sweepIdx + 1];
    if (!dir) {
      console.error("--sweep needs a directory");
      process.exit(2);
    }
    files = readdirSync(dir)
      .filter((n) => n.endsWith(".jsonl"))
      .map((n) => join(dir, n));
    if (limit > 0) files = files.slice(0, limit);
  } else {
    console.error("need --sweep <dir> or --file <path>");
    process.exit(2);
  }

  const fires: Fire[] = [];
  let readyTotal = 0;
  let readyTriggered = 0;
  for (const file of files) {
    const lines = parseTranscript(file);
    if (lines.length === 0) continue;
    fires.push(...replayFile(file, lines));
    if (seamCompare) {
      const r = readySeamTriggerCount(lines);
      readyTotal += r.ready;
      readyTriggered += r.triggered;
    }
  }

  const byOutcome = new Map<string, number>();
  for (const f of fires) byOutcome.set(f.outcome, (byOutcome.get(f.outcome) ?? 0) + 1);

  console.log(`Transcripts scanned:   ${files.length}`);
  console.log(`PR-create calls seen:  ${fires.length}`);
  console.log(`\n--- Outcomes ---`);
  for (const [outcome, n] of [...byOutcome].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${outcome.padEnd(10)} ${String(n).padStart(5)}  ${pct(n, fires.length)}`);
  }

  const decided = fires.filter((f) => f.outcome === "matched" || f.outcome === "clean");
  const matched = fires.filter((f) => f.outcome === "matched");
  console.log(
    `\nDecided (trigger fired): ${decided.length} (${pct(decided.length, fires.length)} of calls)`
  );
  console.log(
    `Flagged:                 ${matched.length} (${pct(matched.length, decided.length)} of decided)`
  );

  // DEDUPED BY SESSION. A session that retries `session_pr_create` — after a
  // conflict, or across review rounds — replays the same state, and counting
  // each one inflates the rate without adding a case to classify. The first
  // full-corpus run reported 44 fires of which 18 were one session repeated.
  const seen = new Set<string>();
  const uniqueMatched = matched.filter((f) => {
    const key = `${f.file}|${(f.serializedSurfaces ?? []).join(",")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  console.log(
    `Distinct flagged situations: ${uniqueMatched.length} (from ${matched.length} raw fires)`
  );

  console.log(`\n--- Every flagged case (hand-classify these; a rate is not a verdict) ---`);
  for (const f of uniqueMatched) {
    console.log(
      `  ${f.file.split("/").pop()}\n     surfaces=${JSON.stringify(f.serializedSurfaces)}\n     swept=${JSON.stringify(f.swept)}`
    );
  }
  if (uniqueMatched.length === 0) console.log("  (none)");

  if (seamCompare) {
    console.log(`\n=== SEAM COMPARISON (why this guard is not at the READY seam) ===`);
    console.log(`READY transitions:            ${readyTotal}`);
    console.log(
      `  ...where the spec named a serialized surface: ${readyTriggered} (${pct(readyTriggered, readyTotal)})`
    );
    console.log(`PR-create calls:              ${fires.length}`);
    console.log(
      `  ...where an EDIT touched one:               ${decided.length} (${pct(decided.length, fires.length)})`
    );
  }
}

main();

// Re-exported for the unit tests, which assert the recognizers directly rather
// than only through `run()`.
export { editedPaths, isSerializedSurfacePath, sessionSweptDirectories };
export type { ToolCallWithResult };
