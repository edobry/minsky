#!/usr/bin/env bun
// Stop-event, LOG-ONLY detector: the silent stop at a ripe decision (mt#3653).
//
// R5 of `family:stop-at-handoff` — the shape none of the shipped mechanisms
// cover: a turn whose substantive work is EVIDENCE-RECORDING into a
// decision-owning task (a `tasks_spec_patch` into a task that is not this
// conversation's own bound task and is still open), ending with no ask filed,
// no status transition, no dispatch, no skill invocation, and no
// recommendation in the closing message. The agent stopped where the agent
// was still the next actor — packaging the decision — and said nothing.
//
// WHY THE TWO SHIPPED SIBLINGS ARE BLIND TO THIS:
//   - `turn-end-untaken-action-scan` (mt#3179) keys on the SURFACE PHRASE in
//     `last_assistant_message`. The R5 incident ended on a factual bound with
//     no commitment phrase, so there was nothing to match.
//   - `turn-end-unwalked-task-scan` (mt#3536) keys on a `tasks_create` MINT.
//     The R5 incident minted nothing — the evidence went into an EXISTING
//     task's spec.
//   The trigger here is a third structural signal: an evidence-WRITE, which
//   neither sibling reads. They are siblings, not duplicates.
//
// ORIGINATING INCIDENT (2026-08-03, mt#3639 conversation): asked why no
// retrospective fired on a correction, the agent diagnosed two detector
// recall misses, patched the evidence into mt#3521 — a task whose spec
// literally opens a decision menu — and ended the turn. The principal had to
// demand "what do you plan to do about this?".
//
// LOG-ONLY (calibration-first, mt#2263 ladder): evidence-recording into open
// tasks is often legitimate (tracking-task updates, recurrence annotations),
// so the FP rate is measured before any injection. This guard NEVER returns
// `additionalContext`; it returns only a calibration record, and separately
// appends an EVALUATION record for every candidate turn (fired or not) per
// the mt#3583 pattern, so the eventual flip decision has a denominator.
//
// EVENT CHOICE — `Stop`, deviating from ADR-031's prompt-time default for
// tool-call reads, with recorded justification (mt#3653 spec §Planning Audit
// §Event registration): the detector's core case is a silent stop the
// principal walks away from — possibly the conversation's FINAL turn, which
// no `UserPromptSubmit` detector ever scans (ADR-031 retains that hole and
// names the Stop guards as its only coverage). The flush-lag cost is bounded
// by the log-only posture: a false record lands in calibration data, not on
// the operator. If calibration shows flush-lag-driven FPs, move the read to
// prompt time (or consume the mt#3490 anchor) with evidence in hand.
//
// @see .minsky/hooks/turn-end-unwalked-task-scan.ts — mint-keyed sibling (template)
// @see .minsky/hooks/turn-end-untaken-action-scan.ts — phrase-keyed sibling
// @see .minsky/hooks/turn-end-unescalated-incident-scan.ts — hybrid sibling
// @see mt#3653 — this guard; mem#846 — the handoff carrying the incident record

import type { DispatchContext, GuardOutcome } from "./registry";
import { logEvaluationRecord } from "./dispatcher";
import type { StopHookInput } from "./turn-end-retro-scan";
import { flagKey, readFlagged, writeFlagged } from "./turn-end-scan-store";
import type { TranscriptLine } from "./transcript";
import { extractFinalTurn, extractToolUseNames, findToolUseInputs } from "./transcript";

export const OVERRIDE_ENV_VAR = "MINSKY_SKIP_STOP_AT_DECISION";

/**
 * The evidence-write this guard triggers on. `memory_create` is ALSO an
 * evidence-class write (it neither discharges nor suppresses), but it cannot
 * TRIGGER: a memory has no target task, so there is nothing to key the
 * (turn, target-task) record on. Its count is recorded for the classifier.
 */
export const EVIDENCE_TOOL = "mcp__minsky__tasks_spec_patch";
export const EVIDENCE_COMPANION_TOOL = "mcp__minsky__memory_create";

/**
 * Calls that DISCHARGE the ripe decision — any one present in the turn means
 * the stop was not silent. `tasks_create` counts: minting a follow-up task
 * routes the decision somewhere, and whether THAT id then gets walked is the
 * unwalked-task sibling's jurisdiction, not this guard's. `session_start`
 * counts for the same reason it is a WALK_FORWARD tool in the unwalked-task
 * sibling: starting a session IS taking the work forward (PR #2611 R1).
 * Belt-and-suspenders for the target task specifically — a same-turn
 * `session_start(task: <target>)` ALSO suppresses via the bound-task
 * derivation, because `collectBoundTaskIds` scans the full transcript
 * including the firing turn; this entry makes the intent legible and covers
 * the different-task case too.
 */
export const DISCHARGE_TOOLS: readonly string[] = [
  "mcp__minsky__asks_create",
  "mcp__minsky__tasks_status_set",
  "mcp__minsky__tasks_dispatch",
  "mcp__minsky__tasks_create",
  "mcp__minsky__session_start",
  "Skill",
];

/**
 * Tools that mark the turn as a WORKING turn — its substantive mutations were
 * not (only) evidence-writes, so the spec-patch was a drive-by beside real
 * work, not a stop at a decision. Matched by exact name or by the
 * `mcp__minsky__session_pr_` prefix.
 */
export const WORKING_TURN_TOOLS: readonly string[] = [
  "mcp__minsky__session_write_file",
  "mcp__minsky__session_edit_file",
  "mcp__minsky__session_search_replace",
  "mcp__minsky__session_commit",
  "mcp__minsky__git_commit",
  "mcp__minsky__git_push",
  "Write",
  "Edit",
  "NotebookEdit",
];
const WORKING_TURN_PREFIX = "mcp__minsky__session_pr_";

/**
 * First-cut recommendation markers (mt#3653 `## Scope`: measured, then tuned
 * via calibration review). Deliberately GENEROUS: a marker SUPPRESSES a fire,
 * so over-matching costs under-measurement, never operator noise. The
 * commitment shapes ("I'll", "I will") are the untaken-action sibling's
 * trigger — suppressing here keeps one turn from writing two families'
 * records for the same sentence.
 */
export const RECOMMENDATION_MARKERS: readonly RegExp[] = [
  /\brecommend/i,
  /\bnext (?:step|move|session)/i,
  /\bI (?:suggest|propose|plan|intend)\b/i,
  /\bI['’]ll\b/i,
  /\bI will\b/i,
  /\boptions?\s*(?::|\bare\b)/i,
  /\bshould (?:we|I)\b/i,
  /\byour call\b/i,
  /\bup to you\b/i,
  /\bdecision (?:needed|required|is yours)\b/i,
];

/** Task statuses in which a decision is still "ripe" — the spec's {TODO, PLANNING}. */
export const OPEN_STATUSES: readonly string[] = ["TODO", "PLANNING"];

/**
 * Per-run cap on status-read subprocess calls, and each call's timeout. A
 * `minsky` CLI status read measured 1.64s wall-clock in the live probe
 * environment (bundle boot + DB round-trip), so the per-call timeout carries
 * ~0.9s headroom over that; the guard's registry budget is 8000ms so two
 * reads at worst-case timeout still leave the transcript scan its share.
 * Targets past the cap, and reads that time out, fail OPEN (status
 * "unknown", target kept) — log-only, so the cost of over-recording is a
 * classifiable calibration row, not operator noise.
 */
export const MAX_STATUS_READS = 2;
const STATUS_READ_TIMEOUT_MS = 2500;

const TASK_ID_SHAPE = /^[a-z]+#\d+$/i;

/**
 * Evaluation stream (mt#3583 pattern) — a SEPARATE file from the calibration
 * log, because `coverage-receipt.ts` treats a calibration record's existence
 * as fire-evidence and `scripts/check-coverage-receipts.ts` globs
 * `.minsky/*-calibration.jsonl`. Every CANDIDATE turn (>=1 spec-patch in the
 * final turn) writes one record here, fired or not — the denominator a
 * fire-only corpus cannot provide. Non-candidate turns write nothing: a turn
 * with no evidence-write carries no signal for this detector's FP/FN axes,
 * and per-turn unconditional writes would flood the stream.
 *
 * mt#3745: the logical stream NAME, not a path — `logEvaluationRecord` derives
 * `.minsky/<name>-evaluations.jsonl` from it, the same name/path split the
 * registry's `calibrationLog` uses.
 */
const EVALUATION_LOG_NAME = "stop-at-decision";

/**
 * Append one evaluation record. Fail-open, never throws (a measurement stream
 * must never break the guard it measures).
 *
 * mt#3745: this detector already had the correct root precedence
 * (`CLAUDE_PROJECT_DIR` before cwd) — it was the only one of the three that
 * did, and its zero stray files are what identified the other two as broken.
 * That precedence now lives in the shared helper instead of here, so the next
 * stream inherits it rather than re-deriving it.
 */
export function appendEvaluationRecord(cwd: string, record: Record<string, unknown>): void {
  logEvaluationRecord(EVALUATION_LOG_NAME, record, { fallbackCwd: cwd });
}

/**
 * Read a task's current status via the `minsky` CLI. Fails OPEN to
 * `undefined` (recorded as status "unknown", target kept): the spec's
 * fail-direction follows the READY-chain-walk precedent — a status read the
 * guard cannot complete must not silently drop a candidate, because log-only
 * over-recording is classifiable and silent under-recording is not.
 */
function readTaskStatusViaCli(taskId: string): string | undefined {
  try {
    const result = Bun.spawnSync(["minsky", "tasks", "status", "get", taskId, "--json"], {
      timeout: STATUS_READ_TIMEOUT_MS,
      env: {
        // Fail-fast Postgres connect (mt#2982) — same injection as
        // post-session-start.ts's spawn, so a hanging DB fails the read well
        // inside this call's own timeout instead of eating the guard budget.
        MINSKY_PERSISTENCE_POSTGRES_CONNECT_TIMEOUT: "2",
        ...process.env,
        PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env["PATH"] ?? ""}`,
      },
      stdout: "pipe",
      stderr: "ignore",
    });
    if (result.exitCode !== 0) return undefined;
    const parsed = JSON.parse(result.stdout.toString().trim()) as { status?: unknown };
    return typeof parsed.status === "string" ? parsed.status : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Collect every task id this conversation is BOUND to: any `task`/`taskId`
 * argument carried by a `mcp__minsky__session_*` tool call anywhere in the
 * transcript. A conversation that started/committed/PR'd a session for
 * mt#X is doing mt#X's work — evidence written into mt#X's own spec is
 * progress recording, not a stop at someone else's decision.
 *
 * Runs over the FULL transcript (not the final turn) deliberately: binding
 * is a conversation-lifetime property, and `findToolUseInputs`-style
 * full-scan sidesteps the role=user tool_result turn-boundary hazard
 * (mem a3e60471).
 */
export function collectBoundTaskIds(lines: TranscriptLine[]): Set<string> {
  const bound = new Set<string>();
  const readInput = (name: string | undefined, input: unknown): void => {
    if (!name || !name.startsWith("mcp__minsky__session_")) return;
    if (!input || typeof input !== "object") return;
    const rec = input as Record<string, unknown>;
    for (const key of ["task", "taskId"]) {
      const value = rec[key];
      if (typeof value === "string" && TASK_ID_SHAPE.test(value)) bound.add(value);
    }
  };
  for (const line of lines) {
    if (line.type === "tool_use") {
      readInput(line.name ?? line.tool_name, line.input);
    }
    const content = line.message?.content;
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block && block["type"] === "tool_use" && typeof block["name"] === "string") {
          readInput(block["name"] as string, block["input"]);
        }
      }
    }
  }
  return bound;
}

/** What the pure core concluded about one candidate turn. */
export interface DecisionStopDetection {
  /** Spec-patch target task ids that are NOT conversation-bound (pre-status-filter). */
  candidateTaskIds: string[];
  /** Every suppression that applies — empty means the structural signature fired. */
  suppressionReasons: string[];
  /** Discharge tool names actually seen (for the evaluation stream). */
  dischargeToolsSeen: string[];
  specPatchCount: number;
  memoryCreateCount: number;
  boundTaskIds: string[];
}

/**
 * Pure detector core — exported for tests and the replay/parity script. No
 * IO: the status filter (a subprocess read) stays in `run()`'s shell around
 * this, injected via `RunDeps` so tests never spawn a process.
 */
export function detectDecisionStop(
  turnLines: TranscriptLine[],
  fullLines: TranscriptLine[],
  lastAssistantMessage: string
): DecisionStopDetection | null {
  const specPatchInputs = findToolUseInputs(turnLines, EVIDENCE_TOOL);
  if (specPatchInputs.length === 0) return null;

  const targets = new Set<string>();
  for (const input of specPatchInputs) {
    const value = input["taskId"];
    if (typeof value === "string" && TASK_ID_SHAPE.test(value)) targets.add(value);
  }
  if (targets.size === 0) return null;

  const bound = collectBoundTaskIds(fullLines);
  const candidateTaskIds = [...targets].filter((id) => !bound.has(id));

  const toolNames = extractToolUseNames(turnLines);
  const dischargeToolsSeen = toolNames.filter((n) => DISCHARGE_TOOLS.includes(n));
  const workingTurn = toolNames.some(
    (n) => WORKING_TURN_TOOLS.includes(n) || n.startsWith(WORKING_TURN_PREFIX)
  );
  const hasMarker = RECOMMENDATION_MARKERS.some((re) => re.test(lastAssistantMessage));

  const suppressionReasons: string[] = [];
  if (candidateTaskIds.length === 0) suppressionReasons.push("bound-task-target");
  if (dischargeToolsSeen.length > 0) {
    suppressionReasons.push(`discharged:${dischargeToolsSeen.join(",")}`);
  }
  if (workingTurn) suppressionReasons.push("working-turn");
  if (hasMarker) suppressionReasons.push("recommendation-marker");

  return {
    candidateTaskIds,
    suppressionReasons,
    dischargeToolsSeen,
    specPatchCount: specPatchInputs.length,
    memoryCreateCount: findToolUseInputs(turnLines, EVIDENCE_COMPANION_TOOL).length,
    boundTaskIds: [...bound],
  };
}

/** Injectable seams for `run()` — tests substitute fakes for every real-IO edge (`custom/no-real-fs-in-tests`). */
export interface RunDeps {
  /** Defaults to the `minsky tasks status get` CLI read. */
  readTaskStatusFn?: (taskId: string) => string | undefined;
  /** Defaults to the real evaluation-log append. */
  appendEvaluationRecordFn?: (cwd: string, record: Record<string, unknown>) => void;
  /** Dedup-store directory override (same seam as the sibling scans). */
  storeDir?: string;
}

/**
 * Guard-dispatcher entry point (GuardModule contract). Returns a calibration
 * record when the R5 signature fires; NEVER returns `additionalContext`
 * (log-only until a calibration review passes it).
 */
export function run(
  input: StopHookInput,
  ctx: DispatchContext,
  deps: RunDeps = {}
): GuardOutcome | null {
  const overrideVal = process.env[OVERRIDE_ENV_VAR];
  const isOverride =
    overrideVal === "1" ||
    overrideVal?.toLowerCase() === "true" ||
    overrideVal?.toLowerCase() === "yes";
  if (isOverride) {
    return {
      auditLines: [
        `[stop-at-decision-scan] OVERRIDE: skip=${overrideVal} session=${input.session_id ?? "unknown"} ts=${new Date().toISOString()}\n`,
      ],
    };
  }

  const lines = ctx.transcriptLines ?? [];
  const { turnLines, openingPrompt } = extractFinalTurn(lines);
  if (turnLines.length === 0) return null;

  const detection = detectDecisionStop(turnLines, lines, input.last_assistant_message ?? "");
  if (detection === null) return null;

  const sessionId = input.session_id ?? "unknown";
  const turnKey = openingPrompt?.timestamp ?? "tail";
  const flagged = readFlagged(sessionId, deps.storeDir);

  // One evaluation record per candidate turn: the turn-level flag dedups
  // Stop-continuation re-entries (another Stop guard's advisory beat re-fires
  // every Stop guard, including this one).
  const evalFlag = flagKey(turnKey, "stop-at-decision-eval", "");
  const alreadyEvaluated = flagged.has(evalFlag);

  // Status filter — only worth the subprocess cost when nothing else
  // suppressed. Fail-open: unknown/unchecked keeps the target.
  const readStatus = deps.readTaskStatusFn ?? readTaskStatusViaCli;
  const targetStatuses: Record<string, string> = {};
  const openTargets: string[] = [];
  if (detection.suppressionReasons.length === 0) {
    let reads = 0;
    for (const taskId of detection.candidateTaskIds) {
      let status: string | undefined;
      if (reads < MAX_STATUS_READS) {
        reads += 1;
        status = readStatus(taskId);
      }
      targetStatuses[taskId] = status ?? "unknown";
      if (status === undefined || OPEN_STATUSES.includes(status)) {
        openTargets.push(taskId);
      }
    }
    if (openTargets.length === 0) {
      detection.suppressionReasons.push("target-not-open");
    }
  }

  // Per-(turn, target-task) dedup (mt#3653 SC3): the record identity is the
  // turn plus the task, so a LATER turn silently stopping at the SAME task
  // records again — each is a distinct incident — while a Stop re-entry for
  // this turn stays quiet.
  const fresh = openTargets.filter(
    (id) => !flagged.has(flagKey(`${turnKey}:${id}`, "stop-at-decision", ""))
  );
  const fired = detection.suppressionReasons.length === 0 && fresh.length > 0;

  if (!alreadyEvaluated) {
    flagged.add(evalFlag);
    const appendEvaluation = deps.appendEvaluationRecordFn ?? appendEvaluationRecord;
    appendEvaluation(input.cwd ?? process.cwd(), {
      timestamp: new Date().toISOString(),
      session_id: sessionId,
      source: "live",
      turnKey,
      fired,
      candidateTaskIds: detection.candidateTaskIds,
      boundTaskIds: detection.boundTaskIds,
      suppressionReasons: detection.suppressionReasons,
      dischargeToolsSeen: detection.dischargeToolsSeen,
      specPatchCount: detection.specPatchCount,
      memoryCreateCount: detection.memoryCreateCount,
      targetStatuses,
    });
  }

  if (!fired) {
    writeFlagged(sessionId, flagged, deps.storeDir);
    return null;
  }

  for (const id of fresh) {
    flagged.add(flagKey(`${turnKey}:${id}`, "stop-at-decision", ""));
  }
  writeFlagged(sessionId, flagged, deps.storeDir);

  return {
    calibration: {
      source: "live",
      channel: "stop",
      timestamp: new Date().toISOString(),
      session_id: sessionId,
      stop_hook_active: input.stop_hook_active === true,
      targets: fresh.map((taskId) => ({ taskId, status: targetStatuses[taskId] ?? "unknown" })),
      boundTaskIds: detection.boundTaskIds,
      specPatchCount: detection.specPatchCount,
      memoryCreateCount: detection.memoryCreateCount,
      // Recorded so a false-positive classifier can read what the turn's
      // closing message actually said, without the guard keying on it.
      final_message_tail: (input.last_assistant_message ?? "").slice(-600),
      suppressionReasons: [],
    },
  };
}
