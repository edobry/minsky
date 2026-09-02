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
import { anyStatusSetIsForwardMotion, STATUS_SET_TOOL } from "./handoff-status";
import { detectArmedWatcherEvidence } from "./armed-watcher";

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
 * The `session_pr_*` tools that only READ (mt#4228).
 *
 * {@link WORKING_TURN_PREFIX} matches the whole family on the assumption that
 * touching a PR is work. Half of the family does not touch anything: listing
 * PRs, reading one, polling its checks, or waiting for a review are exactly
 * what an agent does while INVESTIGATING — which is the evidence-gathering this
 * detector's trigger is about, so counting them as work suppresses the guard
 * on the turns it exists to see.
 *
 * This is what actually kept the R6 incident suppressed. Its `working-turn`
 * came from a single `session_pr_list` call — a read — and it survived both of
 * the qualifications mt#4228 was originally scoped to make. Found by running
 * the replay, not by reading the code.
 *
 * An EXCLUSION list rather than an inclusion list, so the failure direction
 * stays the same as the rest of this module: a `session_pr_*` tool nobody has
 * classified keeps counting as work, which costs a missed advisory rather than
 * a fabricated one.
 */
export const READ_ONLY_SESSION_PR_TOOLS: ReadonlySet<string> = new Set([
  "mcp__minsky__session_pr_list",
  "mcp__minsky__session_pr_get",
  "mcp__minsky__session_pr_checks",
  "mcp__minsky__session_pr_review_context",
  // The HYPHEN is correct and is not a typo (PR #3090 R1 flagged it as one).
  // This command's id is `session.pr.wait-for-review` — the leaf name itself
  // contains a hyphen, unlike its siblings — so the MCP tool name keeps it
  // after the `.`→`_` mapping. Verified against
  // `src/generated/completion-manifest.json` (`"commandId":
  // "session.pr.wait-for-review"`), and pinned by a test below so the next
  // reader does not "correct" it into a name that matches nothing.
  "mcp__minsky__session_pr_wait-for-review",
]);

/**
 * The harness-native write tools, whose `file_path` decides whether the write
 * was WORK (mt#4228).
 *
 * Every other entry in {@link WORKING_TURN_TOOLS} is unambiguous — a session
 * write, a commit, a push all target the repo by construction. `Write` / `Edit`
 * / `NotebookEdit` do not: the same tool writes a throwaway measurement script
 * to the harness scratchpad, and that is the OPPOSITE of the turn being a
 * working one. In the R6 incident the turn's only `Write` was a scratch script
 * used to MEASURE the problem being recorded — evidence-gathering, which is the
 * trigger condition, counted as a reason to suppress.
 */
const PATH_SCOPED_WRITE_TOOLS: readonly string[] = ["Write", "Edit", "NotebookEdit"];

/**
 * Path prefixes that are never repo work.
 *
 * Deliberately a prefix list over temp roots rather than "is it under the repo":
 * {@link detectDecisionStop} is a PURE function with no cwd, and threading one
 * in to answer a question that three literals answer would put IO into the
 * core for no gain. macOS resolves `/tmp` through `/private/tmp` and hands
 * per-process temp dirs out of `/var/folders`, so all three forms appear in
 * real `file_path` values; the harness scratchpad
 * (`/private/tmp/claude-<uid>/<project>/<session>/scratchpad`) sits under the
 * second.
 *
 * A repo that genuinely lived under `/tmp` would read as never-working here.
 * That is accepted: it is not a real configuration, and the failure direction
 * is a redundant advisory rather than a missed one.
 */
const SCRATCH_PATH_PREFIXES: readonly string[] = [
  "/tmp/",
  "/private/tmp/",
  "/private/var/folders/",
  "/var/folders/",
];

/** True when a `Write`/`Edit` targeted a scratch path rather than the repo. */
function isScratchWrite(input: Record<string, unknown>): boolean {
  const path = input["file_path"] ?? input["path"] ?? input["notebook_path"];
  if (typeof path !== "string") return false;
  return SCRATCH_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * First-cut recommendation markers (mt#3653 `## Scope`: measured, then tuned
 * via calibration review). Deliberately GENEROUS: a marker SUPPRESSES a fire,
 * so over-matching costs under-measurement, never operator noise. The
 * commitment shapes ("I'll", "I will") are the untaken-action sibling's
 * trigger — suppressing here keeps one turn from writing two families'
 * records for the same sentence.
 */
export const RECOMMENDATION_MARKERS_BASELINE: readonly RegExp[] = [
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

/**
 * The natural-prose decision handoff (mt#4085).
 *
 * Derived from the corpus, not invented: each pattern below is the minimal
 * generalization of a phrase that appears verbatim in a record the 2026-08-13
 * calibration pass classified FALSE (records 12-22 of
 * `.minsky/stop-at-decision-calibration.jsonl`). The three shapes the baseline
 * list above cannot spell:
 *
 *  - **Possessive-inversion** — "detector enforcement posture is yours to set"
 *    (2026-08-10T15:24:57Z), "Confirming whether that peer is done is yours to
 *    call" (2026-08-10T17:40:01Z). The baseline carries `decision … is yours`
 *    and `your call`, and misses every inflection that fronts the noun.
 *  - **Nominalized framing** — "The decision reduces to which strain you'd
 *    rather live with" (2026-08-11T20:29:00Z), "the choice it has to make:
 *    absorb the interlock page, or state a division of labor"
 *    (2026-08-12T00:20:22Z). The decision is NAMED as a noun rather than asked
 *    as a question, so `should (?:we|I)` cannot see it.
 *  - **Position-stating** — "my three positions — …" (2026-08-12T21:51:50Z).
 *
 * **Deliberately NOT widened to the other four records in that window**
 * (2026-08-09T03:54:06Z, 2026-08-10T10:05:00Z, 2026-08-10T10:23:39Z,
 * 2026-08-12T22:08:54Z). They carry no decision-handoff phrase of any shape —
 * they narrate the evidence-write itself ("Two corrections recorded", "I've
 * recorded that and withdrawn the gap"). A marker for THAT shape would match
 * nearly every turn this detector evaluates, since evidence-writing is its
 * trigger condition; that is the nullification mt#3861's criterion 3 rejected
 * two regex candidates for. Those four are a separate class and are recorded as
 * such in mt#4085's `## Implementation finding`, not silenced here.
 *
 * Split from the baseline as its own exported array so the replay harness
 * (`scripts/replay-stop-at-decision-markers.ts`) computes its before/after arms
 * from the SHIPPED list rather than a copy that can drift out of sync with it.
 */
export const RECOMMENDATION_MARKERS_MT4085: readonly RegExp[] = [
  /\byours to \w+/i,
  /\b(?:decision|choice|question|call)\s+(?:reduces|comes down|boils down)\s+to\b/i,
  /\b(?:choice|decision|call)\s+(?:it|they|we|you|I)\s+(?:has|have|needs?)\s+to\s+make\b/i,
  /\bmy\s+(?:\w+\s+)?positions?\b/i,
];

/** The list the detector actually matches against. */
export const RECOMMENDATION_MARKERS: readonly RegExp[] = [
  ...RECOMMENDATION_MARKERS_BASELINE,
  ...RECOMMENDATION_MARKERS_MT4085,
];

/**
 * The suppression reason a marker match records. Exported as the single source
 * of truth: the replay harness and the tests both key off this string, and a
 * rename that missed either would silently miscount rather than fail (PR #3037
 * R1, NON-BLOCKING).
 */
export const RECOMMENDATION_MARKER_REASON = "recommendation-marker";

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
  /**
   * Discharge tool names that actually DISCHARGED.
   *
   * Since mt#4228 this is narrower than "seen": a `tasks_status_set` whose only
   * transitions open hand-offs is present in the turn and absent here. The
   * calibration stream would otherwise lose that distinction entirely — a turn
   * with no status-set call and a turn with a PLANNING-only one would look
   * identical — so {@link DecisionStopDetection.statusSetSeenButNotDischarging}
   * carries it alongside (PR #3090 R1, non-blocking).
   */
  dischargeToolsSeen: string[];
  /**
   * A `tasks_status_set` ran this turn and did NOT discharge, because every
   * status it set opens a hand-off. Exactly the R6 signature, and the field a
   * later calibration pass needs to count how often this fires.
   */
  statusSetSeenButNotDischarging: boolean;
  specPatchCount: number;
  memoryCreateCount: number;
  boundTaskIds: string[];
  /**
   * Tool-call evidence that a wait is running past this turn's end (mt#4327).
   *
   * Written whether or not it suppressed, so a calibration pass can RATE the
   * decision instead of inferring it — an absent field and an empty one were
   * previously indistinguishable, and the field was absent on every record this
   * detector had ever written.
   */
  armedWatcherEvidence: string[];
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

  // `tasks_status_set` discharges only when it moved something FORWARD (mt#4228).
  // A transition INTO PLANNING or READY opens a hand-off rather than walking
  // one, so it is the canonical stop-at-handoff rather than evidence against
  // it. Every other entry in DISCHARGE_TOOLS stays unconditional.
  const statusSetInputs = findToolUseInputs(turnLines, STATUS_SET_TOOL);
  const statusSetDischarges =
    statusSetInputs.length > 0 && anyStatusSetIsForwardMotion(statusSetInputs);
  const dischargeToolsSeen = toolNames.filter(
    (n) => DISCHARGE_TOOLS.includes(n) && (n !== STATUS_SET_TOOL || statusSetDischarges)
  );

  // A `Write`/`Edit` to a scratch path is not repo work (mt#4228) — see
  // PATH_SCOPED_WRITE_TOOLS. Everything else in WORKING_TURN_TOOLS targets the
  // repo by construction and needs no path check.
  const workingTurn = toolNames.some((n) => {
    if (n.startsWith(WORKING_TURN_PREFIX)) return !READ_ONLY_SESSION_PR_TOOLS.has(n);
    if (!WORKING_TURN_TOOLS.includes(n)) return false;
    if (!PATH_SCOPED_WRITE_TOOLS.includes(n)) return true;
    const inputs = findToolUseInputs(turnLines, n);
    // Fail OPEN: the tool ran and its inputs are unreadable, so keep the
    // pre-mt#4228 reading rather than manufacturing a fire.
    if (inputs.length === 0) return true;
    return !inputs.every(isScratchWrite);
  });
  const hasMarker = RECOMMENDATION_MARKERS.some((re) => re.test(lastAssistantMessage));

  // A wait running past this turn's end means the turn is MID-FLIGHT, not
  // stopped: it has nothing to mint yet, so it is not at a decision (mt#4327).
  // Keyed on tool-call state via the shared predicate rather than on the closing
  // message's wording — see `./armed-watcher` for why that axis is the wrong one.
  const armedWatcherEvidence = detectArmedWatcherEvidence(turnLines);

  const suppressionReasons: string[] = [];
  if (armedWatcherEvidence.length > 0) {
    suppressionReasons.push(`armed-watcher:${armedWatcherEvidence.join(",")}`);
  }
  if (candidateTaskIds.length === 0) suppressionReasons.push("bound-task-target");
  if (dischargeToolsSeen.length > 0) {
    suppressionReasons.push(`discharged:${dischargeToolsSeen.join(",")}`);
  }
  if (workingTurn) suppressionReasons.push("working-turn");
  if (hasMarker) suppressionReasons.push(RECOMMENDATION_MARKER_REASON);

  return {
    candidateTaskIds,
    suppressionReasons,
    dischargeToolsSeen,
    statusSetSeenButNotDischarging: statusSetInputs.length > 0 && !statusSetDischarges,
    specPatchCount: specPatchInputs.length,
    memoryCreateCount: findToolUseInputs(turnLines, EVIDENCE_COMPANION_TOOL).length,
    boundTaskIds: [...bound],
    armedWatcherEvidence,
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
      statusSetSeenButNotDischarging: detection.statusSetSeenButNotDischarging,
      specPatchCount: detection.specPatchCount,
      memoryCreateCount: detection.memoryCreateCount,
      armedWatcherEvidence: detection.armedWatcherEvidence,
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
      armedWatcherEvidence: detection.armedWatcherEvidence,
      // Recorded so a false-positive classifier can read what the turn's
      // closing message actually said, without the guard keying on it.
      final_message_tail: (input.last_assistant_message ?? "").slice(-600),
      suppressionReasons: [],
    },
  };
}
