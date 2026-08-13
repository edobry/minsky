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
// ATTRIBUTION IS PER-EVALUATION, NOT PER-SESSION (PR #2725 R1 finding 1).
// The detector runs once per user-prompt boundary, and each run sees only the
// transcript prefix that existed then. An earlier draft accumulated the raw
// conditions across evaluations (`hadMerge ||= …`, `max(surfaceFiles)`) and
// then derived the blocking condition from those session-wide aggregates.
// That misattributes whenever the conditions hold at DIFFERENT times: a
// session that merged late and claimed usability early satisfies every
// aggregate while no single evaluation ever satisfied them together, and the
// old code's final `else` then blamed `rebuild-evidence` — a condition that
// may be false. `stageFor` below reads ONE evaluation's coherent view, and the
// session is attributed to the furthest stage any single evaluation reached.
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

/**
 * How far one evaluation got through the detector's short-circuit chain.
 * Ordered so a HIGHER number is closer to firing, which makes "the furthest
 * any evaluation reached" a plain `Math.max`.
 */
export const STAGE = {
  /** (a) first half: no in-session `*session_pr_merge` tool_use yet. */
  NO_MERGE: 0,
  /** (a) second half: merged, but no deploy/build-surface file edited. */
  NO_DEPLOY_SURFACE: 1,
  /** (b): merge + surface edit present, but no usability claim in the turn. */
  NO_USABILITY_CLAIM: 2,
  /** (c): all three met, but rebuild/deploy evidence suppressed the fire. */
  SUPPRESSED_BY_REBUILD_EVIDENCE: 3,
  /** The detector fired. */
  FIRED: 4,
} as const;

export type Stage = (typeof STAGE)[keyof typeof STAGE];

/** Label for the condition that blocked a session, keyed by its furthest stage. */
export const STAGE_LABEL = {
  [STAGE.NO_MERGE]: "merge",
  [STAGE.NO_DEPLOY_SURFACE]: "deploy-surface",
  [STAGE.NO_USABILITY_CLAIM]: "usability-claim",
  [STAGE.SUPPRESSED_BY_REBUILD_EVIDENCE]: "rebuild-evidence",
} as const;

export type BlockedBy = (typeof STAGE_LABEL)[keyof typeof STAGE_LABEL];

/**
 * The slice of a detector result the attribution needs. Declared structurally
 * rather than importing `BuildClaimInjectionResult` so the pure core carries no
 * dependency on the hooks tree — `BuildClaimInjectionResult` satisfies it.
 */
export interface StageInput {
  matched: boolean;
  hadMerge: boolean;
  deploySurfaceFiles: string[];
  matchedPhrase?: string;
  hadRebuildEvidence: boolean;
}

/**
 * Classify ONE evaluation's result. Reads only that evaluation's own view, in
 * the detector's own short-circuit order, so the returned stage is always a
 * coherent statement about a single moment in the session.
 */
export function stageFor(result: StageInput): Stage {
  if (result.matched) return STAGE.FIRED;
  if (!result.hadMerge) return STAGE.NO_MERGE;
  if (result.deploySurfaceFiles.length === 0) return STAGE.NO_DEPLOY_SURFACE;
  if (!result.matchedPhrase) return STAGE.NO_USABILITY_CLAIM;
  return STAGE.SUPPRESSED_BY_REBUILD_EVIDENCE;
}

/**
 * Reduce one session's per-evaluation stages to its outcome. Pure, so the
 * aggregation the R1 finding was about is testable without a transcript.
 *
 * The session is attributed to the FURTHEST stage any single evaluation
 * reached. Attributing from separately-accumulated conditions instead is the
 * defect this replaces: stages `[NO_MERGE, NO_USABILITY_CLAIM]` means one
 * evaluation saw a claim before any merge and a later one saw the merge
 * without a claim — never both together — which is a `usability-claim` block,
 * NOT the `rebuild-evidence` block that OR-ing the raw conditions produced.
 */
export function attributeSession(stages: Stage[]): {
  furthestStage: Stage;
  wouldFire: boolean;
  blockedBy: BlockedBy | null;
} {
  const furthestStage = stages.reduce<Stage>((a, b) => (b > a ? b : a), STAGE.NO_MERGE);
  const wouldFire = furthestStage === STAGE.FIRED;
  return {
    furthestStage,
    wouldFire,
    blockedBy: wouldFire ? null : STAGE_LABEL[furthestStage as Exclude<Stage, 4>],
  };
}

/** Per-session replay outcome — one row per transcript. */
export interface SessionReplay {
  path: string;
  /** Number of real user-prompt boundaries the detector would have evaluated at. */
  evaluations: number;
  /** The furthest stage ANY single evaluation reached. */
  furthestStage: Stage;
  /** Distinct usability claims seen in any evaluated turn (reporting only). */
  usabilityClaims: string[];
  /** Whether the detector would have fired at ANY evaluation point. */
  wouldFire: boolean;
  /** The condition that blocked a fire, for sessions that did not fire. */
  blockedBy: BlockedBy | null;
}

export function replaySession(path: string): SessionReplay | null {
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
  const stages: Stage[] = [];
  let evaluations = 0;

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

    evaluations++;
    const result = detectBuildClaimInjection(extractAssistantText(turnLines), visible);

    stages.push(stageFor(result));

    if (result.matchedPhrase && !usabilityClaims.includes(result.matchedPhrase)) {
      usabilityClaims.push(result.matchedPhrase);
    }
  }

  return { path, evaluations, usabilityClaims, ...attributeSession(stages) };
}

function summarize(results: SessionReplay[]) {
  return {
    sessions: results.length,
    evaluations: results.reduce((n, r) => n + r.evaluations, 0),
    wouldFire: results.filter((r) => r.wouldFire).length,
    blockedByCounts: results.reduce<Record<string, number>>((acc, r) => {
      if (r.blockedBy) acc[r.blockedBy] = (acc[r.blockedBy] ?? 0) + 1;
      return acc;
    }, {}),
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
    process.stdout.write(`${JSON.stringify({ ...summarize(results), results }, null, 2)}\n`);
    return;
  }

  process.stdout.write(`Replayed ${results.length} session(s)\n\n`);
  for (const r of results) {
    const name = r.path.split("/").pop() ?? r.path;
    process.stdout.write(`${name}\n`);
    process.stdout.write(`  evaluations:   ${r.evaluations}\n`);
    process.stdout.write(
      `  claims seen:   ${r.usabilityClaims.length > 0 ? r.usabilityClaims.join(" | ") : "none"}\n`
    );
    process.stdout.write(
      `  => would fire: ${r.wouldFire}${r.blockedBy ? ` (blocked by: ${r.blockedBy})` : ""}\n\n`
    );
  }

  const s = summarize(results);
  process.stdout.write(`Would fire: ${s.wouldFire}/${s.sessions}\n`);
  process.stdout.write(`Blocked by: ${JSON.stringify(s.blockedByCounts)}\n`);
}

if (import.meta.main) {
  main();
}
