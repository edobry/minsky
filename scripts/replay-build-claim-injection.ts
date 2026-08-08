#!/usr/bin/env bun
// Replay `build-claim-injection-detector` over real historical transcripts and
// report WHICH of its three conditions failed, per session (mt#3755).
//
// Why this exists. The detector has logged 2,341 evaluations and written zero
// calibration records, and its guard canary PASSES — so the invocation path is
// alive and the silence is a property of the CONDITIONS, not the wiring. A
// canary answers "can it fire at all?"; it cannot answer "why doesn't it fire
// on real work?", because the canary supplies a synthetic transcript built to
// satisfy every condition at once.
//
// `detectBuildClaimInjection` returns a per-condition breakdown
// (`hadMerge` / `deploySurfaceFiles` / `matchedPhrase` / `hadRebuildEvidence`)
// rather than a bare boolean, so replaying it over real sessions localizes the
// suppressor to a specific condition instead of leaving "it didn't match" as
// the whole finding.
//
// Usage:
//   bun scripts/replay-build-claim-injection.ts <transcript.jsonl> [...]
//   bun scripts/replay-build-claim-injection.ts --json <transcript.jsonl> [...]
//
// Exits 0 with a `SKIP:` line when no readable transcript is supplied, so an
// unattended run is safe (same posture as the other local verify scripts —
// see scripts/README.md §Running the browser-driving scripts).
//
// @see mt#3755 — the disposition this measurement feeds
// @see .minsky/hooks/build-claim-injection-detector.ts — the detector replayed
// @see docs/architecture/adr-024-detection-mechanism-ladder-for-guidance-hooks.md

import { existsSync } from "node:fs";
import {
  parseTranscript,
  findRealPromptIndices,
  extractLastAssistantTurn,
  extractAssistantText,
} from "../.minsky/hooks/transcript";
import { detectBuildClaimInjection } from "../.minsky/hooks/build-claim-injection-detector";

/** Per-session replay outcome — one row per transcript. */
interface SessionReplay {
  path: string;
  /** Number of real user-prompt boundaries the detector would have evaluated at. */
  evaluations: number;
  /** Condition (a), first half: an in-session `*session_pr_merge` tool_use. */
  hadMerge: boolean;
  /** Condition (a), second half: deploy/build-surface files edited in-session. */
  deploySurfaceFileCount: number;
  /** Condition (b): a usability/delivery claim in some completed assistant turn. */
  usabilityClaims: string[];
  /** Condition (c): rebuild/reinstall/deploy evidence anywhere in the session. */
  hadRebuildEvidence: boolean;
  /** Whether the detector would have fired at ANY evaluation point. */
  wouldFire: boolean;
  /** The condition that blocked a fire, for sessions that did not fire. */
  blockedBy: "merge" | "deploy-surface" | "usability-claim" | "rebuild-evidence" | null;
}

function replaySession(path: string): SessionReplay | null {
  if (!existsSync(path)) return null;

  let lines;
  try {
    lines = parseTranscript(path);
  } catch {
    return null;
  }
  if (lines.length === 0) return null;

  const promptIndices = findRealPromptIndices(lines);
  const usabilityClaims: string[] = [];
  let wouldFire = false;
  // Conditions (a) and (c) are session-scoped, so the last evaluation's view of
  // them is the fullest one; seed from the whole transcript and let the loop
  // confirm. Condition (b) is turn-scoped and must be accumulated per turn.
  let hadMerge = false;
  let deploySurfaceFileCount = 0;
  let hadRebuildEvidence = false;

  for (const idx of promptIndices) {
    // The detector sees only what existed when the prompt was submitted.
    const visible = lines.slice(0, idx);
    if (visible.length === 0) continue;

    let turnLines;
    try {
      turnLines = extractLastAssistantTurn(visible);
    } catch {
      continue;
    }
    if (turnLines.length === 0) continue;

    const result = detectBuildClaimInjection(extractAssistantText(turnLines), visible);

    hadMerge = hadMerge || result.hadMerge;
    deploySurfaceFileCount = Math.max(deploySurfaceFileCount, result.deploySurfaceFiles.length);
    hadRebuildEvidence = hadRebuildEvidence || result.hadRebuildEvidence;
    if (result.matchedPhrase && !usabilityClaims.includes(result.matchedPhrase)) {
      usabilityClaims.push(result.matchedPhrase);
    }
    if (result.matched) wouldFire = true;
  }

  // Report the FIRST condition in the detector's own short-circuit order that
  // failed — that is the one actually suppressing the fire, and reporting a
  // later one would misattribute the cause.
  let blockedBy: SessionReplay["blockedBy"] = null;
  if (!wouldFire) {
    if (!hadMerge) blockedBy = "merge";
    else if (deploySurfaceFileCount === 0) blockedBy = "deploy-surface";
    else if (usabilityClaims.length === 0) blockedBy = "usability-claim";
    else blockedBy = "rebuild-evidence";
  }

  return {
    path,
    evaluations: promptIndices.length,
    hadMerge,
    deploySurfaceFileCount,
    usabilityClaims,
    hadRebuildEvidence,
    wouldFire,
    blockedBy,
  };
}

function main(): void {
  const jsonMode = process.argv.includes("--json");
  const paths = process.argv.slice(2).filter((a) => a !== "--json");

  if (paths.length === 0) {
    process.stdout.write("SKIP: no transcript paths supplied\n");
    return;
  }

  const results: SessionReplay[] = [];
  for (const p of paths) {
    const r = replaySession(p);
    if (r) results.push(r);
  }

  if (results.length === 0) {
    process.stdout.write("SKIP: no readable transcripts among the supplied paths\n");
    return;
  }

  if (jsonMode) {
    const fired = results.filter((r) => r.wouldFire).length;
    process.stdout.write(
      `${JSON.stringify(
        {
          sessions: results.length,
          evaluations: results.reduce((n, r) => n + r.evaluations, 0),
          wouldFire: fired,
          blockedByCounts: results.reduce<Record<string, number>>((acc, r) => {
            if (r.blockedBy) acc[r.blockedBy] = (acc[r.blockedBy] ?? 0) + 1;
            return acc;
          }, {}),
          results,
        },
        null,
        2
      )}\n`
    );
    return;
  }

  process.stdout.write(`Replayed ${results.length} session(s)\n\n`);
  for (const r of results) {
    const name = r.path.split("/").pop() ?? r.path;
    process.stdout.write(`${name}\n`);
    process.stdout.write(`  evaluations:      ${r.evaluations}\n`);
    process.stdout.write(`  (a) merge:        ${r.hadMerge}\n`);
    process.stdout.write(`  (a) surface files:${r.deploySurfaceFileCount}\n`);
    process.stdout.write(
      `  (b) claims:       ${r.usabilityClaims.length > 0 ? r.usabilityClaims.join(" | ") : "none"}\n`
    );
    process.stdout.write(`  (c) rebuild evid: ${r.hadRebuildEvidence}\n`);
    process.stdout.write(
      `  => would fire:    ${r.wouldFire}${r.blockedBy ? ` (blocked by: ${r.blockedBy})` : ""}\n\n`
    );
  }

  const fired = results.filter((r) => r.wouldFire).length;
  const counts = results.reduce<Record<string, number>>((acc, r) => {
    if (r.blockedBy) acc[r.blockedBy] = (acc[r.blockedBy] ?? 0) + 1;
    return acc;
  }, {});
  process.stdout.write(`Would fire: ${fired}/${results.length}\n`);
  process.stdout.write(`Blocked by: ${JSON.stringify(counts)}\n`);
}

main();
