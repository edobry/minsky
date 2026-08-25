#!/usr/bin/env bun
// PreToolUse hook: block advancing a task to READY (`tasks_status_set`), binding a session to
// it (`session_start`), or one-call-dispatching an EXISTING task (`tasks_dispatch` with a
// `taskId`, mt#2657) when that task's spec was never surfaced in-session — the "task-hijack"
// bind/advance seam (mt#2515, Seam 1 of mt#2511).
//
// mt#2657 note: `tasks_dispatch` in existing-task mode performs the same advance (walks status
// to READY) and bind (starts a session) internally, IN-PROCESS — as a single harness tool call,
// it would otherwise be invisible to this hook (which is keyed on tool name from a PreToolUse
// event, one per top-level tool call). Guarding `tasks_dispatch` directly is how the one-call
// path composes this guard rather than bypassing it. New-task mode (`title`, no `taskId`) is not
// guarded — there is no pre-existing spec to have skipped reading.
//
// mt#4551 — the ask seam, and why it ADVISES where the three above DENY.
//
// The three tools above are ACTIONS ON a task. `asks_create` / `asks_edit` are
// a RECOMMENDATION ABOUT one: the payload names a task id and the principal
// reads it as a work candidate. The same premise fails there — the session
// never engaged the task's content — with a different remedy, so this leg
// emits `additionalContext` and does not block.
//
// It is advisory rather than deny because the failure modes are asymmetric. An
// unread reference costs a re-read; a denied `asks_create` can strand an
// escalation, including a `severity: "incident"` one, which is the only
// channel that reaches the principal's phone. A flip is operator-reserved per
// ADR-032.
//
// Originating incident (2026-08-25): ask#10163's first revision led with
// "Build the cheap-model triage pilot (mt#3473)", described as approved and
// never built. mt#3473's own spec had recorded, since 2026-08-01, that the
// pilot was measured and killed — 8 of 16 "trivial" pushes carried a real
// BLOCKING finding — and its last line reads "do not implement the
// Summary/Success Criteria above as written". The filing conversation
// (`cbafdfe3-…`) made 20 spec-surfacing reads across 14 distinct task ids;
// mt#3473 was not among them. A status field says where a task sits in the
// lifecycle. Only its body says whether it is still worth doing.
//
// Why the READ and not the verdict: reading the verdict back out of spec prose
// was measured at planning and rejected. A fixed phrase set (`do not
// implement`, `do not build`, `CLOSED as falsified`, …), fences and code spans
// elided, fires on 94 of 897 active tasks with roughly one true positive — it
// cannot separate a verdict on the whole task from a live directive inside one
// ("Out of scope … do not implement"), and 32 of the 94 sit on a line naming a
// DIFFERENT task. That is ADR-024's paraphrase axis, and mt#4168's "key on the
// TOOL CALL, never on a phrase set" is the correction this leg applies. The
// read is machine-recorded, so this leg has no matcher to tune. The residual —
// an agent that reads a falsified spec and recommends it anyway — is mt#4561.
//
// Originating incident: mt#2191 session 935e6a4c (2026-05-31). A Slidev-deck
// publishing session bound itself to the unrelated naming task mt#2191,
// advanced it TODO -> PLANNING -> READY, and shipped the deck under it — without
// EVER calling `tasks_spec_get mt#2191`. The spec was read once, after the
// merge, after DONE; the false DONE is irreversible.
//
// Detection: scan the FULL session transcript for a `tasks_spec_get` (or a
// `tasks_get` with `includeSpec: true`) tool_use whose taskId matches the task
// being advanced/bound. Scanning ALL lines (not a turn slice) sidesteps the
// role=user tool_result turn-boundary hazard (mt#2255 / memory a3e60471: a turn
// slice keyed on user-role lines silently drops earlier tool calls).
//
// Same-transcript authorship credit (mt#2814): a spec-surfacing READ is not
// the only way this session can have engaged a task's identity and content.
// Writing the spec is at least as strong a signal — `tasks_create` (with a
// spec body), `tasks_spec_patch`, and `tasks_spec_search_replace` all require
// the caller to name the target task id and supply content addressed to it.
// `specWasAuthored()` credits these the same as a read. Partial-edit decision
// (spec's open question, resolved here): ANY same-transcript spec_patch /
// search_replace call targeting the task counts, with NO minimum edit size or
// patch-count threshold — see specWasAuthored()'s docstring and
// docs/architecture/hooks/bind-advance-spec-read-guard.md for the rationale.
// Cross-session authorship does NOT count: the same
// resolveTranscriptCandidates() tree-scoping that already isolates the
// spec-READ check to this session's conversation tree isolates the
// spec-AUTHORED check the same way — a prior session's transcript file is
// never a candidate for the CURRENT session's scan.
//
// Subagent-aware resolution (mt#2637): for a background-Agent-dispatched
// subagent, the harness passes `transcript_path` pointing at the PARENT
// session's top-level transcript while the subagent's own tool calls are
// recorded under `<session-dir>/subagents/agent-<agentId>.jsonl` — so the scan
// walks resolveTranscriptCandidates() (given path + per-agent file + sibling
// agent files) instead of the single given file. A spec read (or same-
// transcript authorship) anywhere in the session's conversation tree counts;
// a tree with NO read/authorship still denies.
//
// Fail-open: any error — or a missing transcript — allows the call (exit 0).
// Override: MINSKY_SKIP_SPEC_READ_CHECK=1.
//
// @see mt#2511 — parent (task-hijack guard); mt#2514 — Seam 2 (merge-time)
// @see mt#2637 — subagent transcript_path false-positive fix
// @see mt#2814 — same-transcript spec-authorship credit (this change)
// @see mt#979 — subsumed (this hook adds the spec-read detection mt#979 deemed "too brittle")
// @see .claude/hooks/check-guessed-session-path.ts — PreToolUse deny-class template
// @see .claude/hooks/transcript.ts — parseTranscript / findToolUseInputs /
//      findCreatedResourceIds / resolveTranscriptCandidates

import { readInput } from "./types";
import type { ToolHookInput, HookOutput } from "./types";
import { BIND_ADVANCE_SEAM_STATUS } from "../../packages/domain/src/tasks/workflows";
import {
  parseTranscript,
  findToolUseInputs,
  findCreatedResourceIds,
  resolveTranscriptCandidates,
  type TranscriptLine,
} from "./transcript";
import { recordFireLogEntry } from "./fire-log";

/** This guard's fire-log identifier (mt#2889, evaluation-loop Phase 1 completion). */
const GUARD_NAME = "check-task-spec-read";

// ---------------------------------------------------------------------------
// Public API / constants
// ---------------------------------------------------------------------------

/** Override env var: set to "1"/"true"/"yes" to allow advancing/binding an unread task. */
export const OVERRIDE_ENV_VAR = "MINSKY_SKIP_SPEC_READ_CHECK";

/** Tools whose result surfaces a task's spec body into the transcript. */
export const SPEC_GET_TOOL = "mcp__minsky__tasks_spec_get";
export const TASKS_GET_TOOL = "mcp__minsky__tasks_get";

/**
 * Tools whose CALL is same-transcript spec AUTHORSHIP, credited as
 * read-equivalent (mt#2814). `tasks_create`'s target id is not in its own
 * input (the backend mints it) — its result is correlated via
 * {@link findCreatedResourceIds}; the spec-patch tools carry `taskId`
 * directly in their input, like the read-detection tools above.
 */
export const TASKS_CREATE_TOOL = "mcp__minsky__tasks_create";
export const SPEC_PATCH_TOOL = "mcp__minsky__tasks_spec_patch";
export const SPEC_SEARCH_REPLACE_TOOL = "mcp__minsky__tasks_spec_search_replace";

/**
 * A `tasks_edit` carrying a spec-writing operation — `specContent`, `spec`, or
 * `specFile` (the set `edit-commands.ts` treats as `hasSpecOperation`) — is the
 * full-spec-replacement authoring path (`tasks_spec_patch`'s fail-closed
 * message points callers here). Credited as read-equivalent (mt#2558), gated on
 * a non-empty spec-writing field so a status/kind/title/tags-only edit is NOT
 * counted.
 */
export const TASKS_EDIT_TOOL = "mcp__minsky__tasks_edit";

/** Guarded tools. */
export const STATUS_SET_TOOL = "mcp__minsky__tasks_status_set";
export const SESSION_START_TOOL = "mcp__minsky__session_start";
/** One-call dispatch (mt#2657) — guarded only in existing-task mode (a `taskId` is present). */
export const DISPATCH_TOOL = "mcp__minsky__tasks_dispatch";

/**
 * Advisory-only surfaces (mt#4551): an ask RECOMMENDS a task rather than acting
 * on one, so an unread reference here warns and never denies. See the header
 * for why the asymmetry runs this way.
 */
export const ASKS_CREATE_TOOL = "mcp__minsky__asks_create";
export const ASKS_EDIT_TOOL = "mcp__minsky__asks_edit";

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Normalise a task id for comparison: lowercase, then strip every
 * non-alphanumeric character. `mt#2515` / `MT#2515` / `mt-2515` / `mt_2515` /
 * `mt2515` all collapse to `mt2515` (so a branch-style `mt-2515` compares equal
 * to a tool-arg `mt#2515`). Returns "" for a non-string / empty id.
 */
export function normalizeTaskId(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * The normalised target task id this tool call would advance/bind, or "" if the
 * tool isn't guarded or carries no resolvable id. For `tasks_status_set` the
 * guard fires ONLY on the READY transition (the bind/advance seam) — other
 * transitions return "" and pass.
 */
export function resolveTargetTaskId(toolName: string, toolInput: Record<string, unknown>): string {
  if (toolName === STATUS_SET_TOOL) {
    // mt#3010: the seam status is now the registry's single-authority
    // BIND_ADVANCE_SEAM_STATUS constant, not a hardcoded "READY" literal.
    if (String(toolInput["status"] ?? "").toUpperCase() !== BIND_ADVANCE_SEAM_STATUS) return "";
    return normalizeTaskId(toolInput["taskId"]);
  }
  if (toolName === SESSION_START_TOOL) {
    return normalizeTaskId(toolInput["task"] ?? toolInput["taskId"]);
  }
  if (toolName === DISPATCH_TOOL) {
    // Existing-task mode only (`taskId` present). New-task mode (`title`, no `taskId`) creates
    // a fresh task with no prior spec to have skipped — not guarded.
    return normalizeTaskId(toolInput["taskId"]);
  }
  return "";
}

/**
 * True iff the transcript contains a spec-surfacing tool_use for `targetId`
 * (already normalised): a `tasks_spec_get` for the task, OR a `tasks_get` with
 * `includeSpec: true` for the task.
 */
export function specWasSurfaced(lines: TranscriptLine[], targetId: string): boolean {
  if (!targetId) return false;
  for (const input of findToolUseInputs(lines, SPEC_GET_TOOL)) {
    if (normalizeTaskId(input["taskId"]) === targetId) return true;
  }
  for (const input of findToolUseInputs(lines, TASKS_GET_TOOL)) {
    if (input["includeSpec"] === true && normalizeTaskId(input["taskId"]) === targetId) {
      return true;
    }
  }
  return false;
}

/**
 * True iff a `tasks_edit` input carries a non-empty spec-writing operation
 * (`specContent` / `spec` / `specFile`) — the same set `edit-commands.ts`'s
 * `hasSpecOperation` recognizes. A status/kind/title/tags-only edit carries
 * none of these and is not spec authorship (mt#2558).
 */
function editHasSpecContent(input: Record<string, unknown>): boolean {
  return [input["specContent"], input["spec"], input["specFile"]].some(
    (v) => typeof v === "string" && v.trim() !== ""
  );
}

/**
 * True iff `targetId` was AUTHORED in this transcript — a same-transcript
 * spec-WRITING action credited as read-equivalent (mt#2814): a
 * {@link TASKS_CREATE_TOOL} call that supplied a non-empty `spec` body AND
 * whose CORRELATED RESULT both explicitly confirms success and reports the
 * created task's id as `targetId`, OR a {@link SPEC_PATCH_TOOL} /
 * {@link SPEC_SEARCH_REPLACE_TOOL} call whose `taskId` input matches
 * `targetId`.
 *
 * Server-side confirmation (PR #1982 review): the `tasks_create` credit does
 * NOT rely on the call's local `spec` input alone as proof a spec was
 * persisted — that input is merely what the CALLER asked for, not
 * confirmation the domain layer accepted it. The gate also requires
 * `result.success === true` in the correlated tool_result JSON. This is the
 * strongest server-side signal actually available: the success response
 * (`createSuccessResponse({ taskId, task, ... })`) does not echo the spec
 * content back, so exact-content confirmation isn't obtainable from the
 * transcript — but the domain command (`TasksCreateCommand.execute`) only
 * ever reaches its success path AFTER `createTaskFromTitleAndSpec` persists
 * the spec; any failure (including the empty-spec `ValidationError`) throws
 * before a taskId is minted, so a result reporting BOTH `success === true`
 * AND a matching `taskId` is not obtainable except via a real, accepted
 * creation.
 *
 * Partial-edit decision (mt#2814, spec's open question — see
 * docs/architecture/hooks/bind-advance-spec-read-guard.md for the full
 * rationale): ANY same-transcript spec_patch/search_replace call targeting
 * the task counts, with no minimum edit size and no patch-count threshold.
 * This guard's purpose is task-hijack prevention (the session never engaged
 * the CORRECT task's identity at all, per the mt#2191 originating incident) —
 * not read-completeness enforcement, which is `/plan-task`'s concern. A
 * patch/search-replace call requires the caller to name the target task id
 * and supply content addressed to it; that is itself unambiguous identity
 * engagement regardless of the edit's size, so a trivial one-line fix counts
 * exactly like a full-spec create.
 */
export function specWasAuthored(lines: TranscriptLine[], targetId: string): boolean {
  if (!targetId) return false;

  for (const input of findToolUseInputs(lines, SPEC_PATCH_TOOL)) {
    if (normalizeTaskId(input["taskId"]) === targetId) return true;
  }
  for (const input of findToolUseInputs(lines, SPEC_SEARCH_REPLACE_TOOL)) {
    if (normalizeTaskId(input["taskId"]) === targetId) return true;
  }

  // A same-transcript tasks_edit that rewrites the spec (specContent / spec /
  // specFile) is authorship too — the full-replacement path spec_patch points
  // to (mt#2558). Gated on a spec-writing field so a metadata-only edit
  // (status/kind/title/tags) does not count.
  for (const input of findToolUseInputs(lines, TASKS_EDIT_TOOL)) {
    if (normalizeTaskId(input["taskId"]) === targetId && editHasSpecContent(input)) return true;
  }

  for (const { input, createdId, result } of findCreatedResourceIds(
    lines,
    TASKS_CREATE_TOOL,
    "taskId"
  )) {
    const spec = input["spec"];
    if (typeof spec !== "string" || spec.trim() === "") continue;
    if (createdId === undefined || normalizeTaskId(createdId) !== targetId) continue;
    if (result?.["success"] !== true) continue;
    return true;
  }

  return false;
}

/**
 * True iff ANY transcript in the session's conversation tree — the given
 * transcript_path, the dispatching agent's own per-agent file, or a sibling
 * subagent file (see {@link resolveTranscriptCandidates}) — contains a
 * spec-surfacing tool_use (a READ, {@link specWasSurfaced}) OR a same-
 * transcript spec-authorship action (a WRITE, {@link specWasAuthored},
 * mt#2814) for `targetId`. Candidates are scanned in order and short-circuit
 * on the first hit, so the extra files are only read on the would-deny path
 * (mt#2637). Because candidates are scoped to THIS session's conversation
 * tree, authorship recorded in a DIFFERENT session's transcript is never a
 * candidate here — cross-session authorship does not satisfy the check.
 */
export function specWasSurfacedInAnyTranscript(
  transcriptPath: string,
  agentId: string | undefined,
  targetId: string
): boolean {
  for (const candidate of resolveTranscriptCandidates(transcriptPath, agentId)) {
    const lines = parseTranscript(candidate);
    if (specWasSurfaced(lines, targetId) || specWasAuthored(lines, targetId)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The ask seam (mt#4551) — advisory only
// ---------------------------------------------------------------------------

/**
 * Task references in an ask payload. Matches the two id namespaces the task
 * backends mint (`mt#` / `md#`), the same shape
 * `loop-preflight-pr-merge-check.ts` reads.
 *
 * Deliberately NOT fence- or code-span-aware, unlike the guidance detectors: a
 * backticked `mt#3473` in an ask is a real reference to a real task, not a
 * quotation of one. There is no paraphrase axis here to elide around — an id
 * either appears or it does not.
 */
const TASK_REF_RE = /\b(?:mt|md)#\d+\b/gi;

/**
 * Ceiling on distinct references extracted from one ask.
 *
 * Bounds the transcript work, which is what makes this leg cheap: the scan
 * below parses each candidate transcript ONCE and tests every pending id
 * against it, so the cost is O(transcripts), not O(transcripts x ids). The cap
 * is a backstop against a pathological payload rather than a tuning knob — the
 * largest real ask in the corpus carries six.
 */
export const MAX_ASK_TASK_REFS = 20;

/**
 * Every distinct task id an ask payload names, in first-seen order, in the raw
 * spelling it was written with (so the advisory quotes the operator's own text
 * back).
 *
 * Reads exactly three places, per this task's Success Criterion 1: the
 * `question`, each option's `label` and `description`, and each `contextRefs`
 * entry's `ref`. `parentTaskId` is deliberately NOT read — it names the task an
 * ask was filed FROM, which the filing session has almost always just been
 * working, so including it would fire on the ordinary case rather than the
 * recommending one.
 *
 * A `contextRefs` entry may be a bare string or an object; both are handled,
 * and an entry's `kind` is not consulted — an id that matches the pattern is a
 * task reference whatever the entry claims to be.
 */
export function extractAskTaskIds(toolInput: Record<string, unknown>): string[] {
  /** normalised id -> the raw spelling first seen for it. */
  const seen = new Map<string, string>();

  const harvest = (value: unknown): void => {
    if (typeof value !== "string") return;
    for (const match of value.matchAll(TASK_REF_RE)) {
      const raw = match[0];
      const normalized = normalizeTaskId(raw);
      if (!normalized || seen.has(normalized)) continue;
      if (seen.size >= MAX_ASK_TASK_REFS) return;
      seen.set(normalized, raw);
    }
  };

  harvest(toolInput["question"]);

  const options = toolInput["options"];
  if (Array.isArray(options)) {
    for (const option of options) {
      if (option === null || typeof option !== "object") continue;
      const record = option as Record<string, unknown>;
      harvest(record["label"]);
      harvest(record["description"]);
    }
  }

  const contextRefs = toolInput["contextRefs"];
  if (Array.isArray(contextRefs)) {
    for (const entry of contextRefs) {
      if (typeof entry === "string") {
        harvest(entry);
        continue;
      }
      if (entry === null || typeof entry !== "object") continue;
      harvest((entry as Record<string, unknown>)["ref"]);
    }
  }

  return [...seen.values()];
}

/**
 * The subset of `rawIds` whose specs were neither READ nor AUTHORED anywhere in
 * the session's conversation tree — returned in the raw spelling the ask used.
 *
 * Structured as one pass over the transcripts rather than one call to
 * {@link specWasSurfacedInAnyTranscript} per id: that helper re-parses every
 * candidate file for each id it is asked about, which for a six-reference ask
 * would be six full parses of the same transcript. Here each candidate is
 * parsed once and every still-pending id is tested against it, and the loop
 * stops early once nothing is pending.
 */
export function unreadAskTaskIds(
  transcriptPath: string,
  agentId: string | undefined,
  rawIds: readonly string[]
): string[] {
  /** normalised id -> raw spelling, drained as each id is credited. */
  const pending = new Map<string, string>();
  for (const raw of rawIds) {
    const normalized = normalizeTaskId(raw);
    if (normalized) pending.set(normalized, raw);
  }
  if (pending.size === 0) return [];

  for (const candidate of resolveTranscriptCandidates(transcriptPath, agentId)) {
    if (pending.size === 0) break;
    const lines = parseTranscript(candidate);
    for (const normalized of [...pending.keys()]) {
      if (specWasSurfaced(lines, normalized) || specWasAuthored(lines, normalized)) {
        pending.delete(normalized);
      }
    }
  }

  return [...pending.values()];
}

/**
 * Build the advisory for an ask naming task ids this session never opened.
 *
 * Emitted as `additionalContext` with NO `permissionDecision`, so the call
 * proceeds — see the header for why this leg does not deny.
 */
export function buildAskAdvisoryReason(toolName: string, unreadIds: readonly string[]): string {
  const action =
    toolName === ASKS_EDIT_TOOL ? "editing an ask that names" : "filing an ask that names";
  const one = unreadIds.length === 1;
  return [
    `[check-task-spec-read] ADVISORY — you are ${action} ${unreadIds.join(", ")}, but this`,
    `session has never read or authored ${one ? "that task's spec" : "those tasks' specs"}.`,
    "",
    `An ask is a RECOMMENDATION the principal acts on. A task's STATUS says where it sits in the`,
    `lifecycle; only its BODY says whether it is still worth doing — a spec can carry a measured`,
    `falsification while the status still reads as available (mt#3473 / ask#10163, where a killed`,
    `pilot led a principal-facing ask as its top option).`,
    "",
    `Call mcp__minsky__tasks_spec_get on ${one ? "it" : "each"} before the principal acts on this ask.`,
    `If the body contradicts the recommendation, revise the ask rather than filing it as written.`,
    "",
    `Advisory only — this call is NOT blocked. Override: ${OVERRIDE_ENV_VAR}=1.`,
  ].join("\n");
}

/** Build the denial-reason message naming the action, the task, and the fix. */
export function buildDenialReason(toolName: string, rawTaskId: unknown): string {
  const id = typeof rawTaskId === "string" && rawTaskId.length > 0 ? rawTaskId : "<unknown>";
  const action =
    toolName === SESSION_START_TOOL
      ? `binding a session to ${id}`
      : toolName === DISPATCH_TOOL
        ? `one-call-dispatching ${id}`
        : `advancing ${id} to READY`;
  return [
    `You are ${action}, but this session has never read or authored ${id}'s spec`,
    `(no tasks_spec_get / tasks_get includeSpec, and no same-transcript tasks_create-with-spec /`,
    `tasks_spec_patch / tasks_spec_search_replace / tasks_edit-with-specContent/spec/specFile, for it`,
    `anywhere in the session's conversation`,
    `tree — parent and dispatched-agent transcripts). This is`,
    `the "task-hijack" bind/advance seam (mt#2511 / mt#2191): advancing or binding a task you`,
    `never engaged risks shipping unrelated work under its number and auto-completing it.`,
    "",
    `Before retrying, call mcp__minsky__tasks_spec_get taskId:"${id}" and confirm:`,
    "  - the spec is read in full",
    "  - any file:line references in it are verified against the current codebase",
    "  - the implementation approach is sketched and ambiguities resolved",
    "  - scope concerns / blockers are noted in the spec or flagged to the user",
    "",
    `Then re-attempt. Override (only if reading the spec is genuinely unnecessary):`,
    `set ${OVERRIDE_ENV_VAR}=1.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Entry point (fail-open: any error allows the call)
// ---------------------------------------------------------------------------

/**
 * Entrypoint body, wrapped in an `async function` (mt#2889 PR #2012 CI fix,
 * mt#2900) rather than left as a bare top-level `if (import.meta.main) {
 * ... }` block — matching the established convention every OTHER guard with
 * multi-step narrowing uses. A bare top-level block is not a function body,
 * so `return` is invalid there; CI's `tsconfig.hooks.json` typecheck (tsgo,
 * a native-preview compiler) also does not narrow `transcriptPath` from its
 * nullable type after a bare (non-`return`ed) call to a locally-defined
 * `never`-returning closure the way it does after an explicit `return` —
 * wrapping in a real function makes `return recordAndExit(...)` both valid
 * AND the correctly-narrowing form.
 */
async function main(): Promise<void> {
  const startMs = Date.now();
  let sessionId: string | undefined;
  let toolNameForLog: string | undefined;
  // mt#2889 (evaluation-loop Phase 1 completion): fire-log every evaluation,
  // exactly once per invocation regardless of which early-return fires
  // (not-guarded / non-READY / no-transcript / spec-surfaced / denied).
  /**
   * mt#3920 — `outcome` is clean-run evidence for guard-health's recovery join, and only
   * the two exits downstream of the transcript scan may claim it. The override exit, the
   * unresolvable-target-id exit and the absent-`transcript_path` exit are all left UNSET:
   * none of them ran the scan, and none of them broke — the harness simply did not hand
   * this guard something to check. The catch is `crashed`: the only way to reach it is
   * `readInput()` itself throwing, which is a genuine failed evaluation that fails open.
   */
  const recordAndExit = (decision: "allow" | "deny", outcome?: "decided" | "crashed"): never => {
    recordFireLogEntry({
      guardName: GUARD_NAME,
      event: "PreToolUse",
      decision,
      ...(outcome !== undefined ? { guardOutcome: outcome } : {}),
      durationMs: Date.now() - startMs,
      toolName: toolNameForLog,
      sessionId,
    });
    process.exit(0);
  };

  try {
    const overrideVal = process.env[OVERRIDE_ENV_VAR];
    const isOverride =
      overrideVal === "1" ||
      overrideVal?.toLowerCase() === "true" ||
      overrideVal?.toLowerCase() === "yes";

    const input = await readInput<ToolHookInput>();
    sessionId = input.session_id;
    toolNameForLog = input.tool_name;

    if (isOverride) {
      process.stdout.write(
        `[check-task-spec-read] OVERRIDE: ack=${overrideVal} tool=${input.tool_name} session=${input.session_id ?? "unknown"} ts=${new Date().toISOString()}\n`
      );
      return recordAndExit("allow");
    }

    const toolName = input.tool_name;
    const toolInput = input.tool_input ?? {};

    // The ask seam (mt#4551). Returns from inside this block on every path —
    // an ask is never a bind/advance action, so it must not fall through to
    // the deny logic below.
    if (toolName === ASKS_CREATE_TOOL || toolName === ASKS_EDIT_TOOL) {
      const askIds = extractAskTaskIds(toolInput);
      // An ask naming no task does no transcript work at all.
      if (askIds.length === 0) return recordAndExit("allow");

      const askTranscriptPath = input.transcript_path;
      // Same fail-open as the deny path: nothing to scan, nothing to claim.
      if (!askTranscriptPath) return recordAndExit("allow");

      const unread = unreadAskTaskIds(askTranscriptPath, input.agent_id, askIds);
      if (unread.length === 0) return recordAndExit("allow", "decided");

      // `additionalContext` with NO `permissionDecision` — the advisory shape
      // (`check-branch-fresh.ts` emits its warnings the same way). Written with
      // `process.stdout.write` rather than `writeOutput` to match this file's
      // own existing output call; the two differ only in `emitHookFiredOnDeny`,
      // which is a no-op for a non-deny payload.
      const advisory: HookOutput = {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: buildAskAdvisoryReason(toolName, unread),
        },
      };
      process.stdout.write(`${JSON.stringify(advisory)}\n`);
      return recordAndExit("allow", "decided");
    }

    const targetId = resolveTargetTaskId(toolName, toolInput);
    // not guarded / non-READY transition / no resolvable id
    if (!targetId) return recordAndExit("allow");

    const transcriptPath = input.transcript_path;
    // can't verify without a transcript — fail-open. `return` (not a bare
    // call) narrows `transcriptPath` from `string | undefined` to `string`
    // for `specWasSurfacedInAnyTranscript` below — CI's tsconfig.hooks.json
    // typecheck (tsgo, mt#2900) doesn't perform this narrowing off a bare
    // (non-`return`ed) never-returning expression statement.
    if (!transcriptPath) return recordAndExit("allow");

    if (specWasSurfacedInAnyTranscript(transcriptPath, input.agent_id, targetId)) {
      return recordAndExit("allow", "decided");
    }

    const rawTaskId =
      toolName === SESSION_START_TOOL
        ? (toolInput["task"] ?? toolInput["taskId"])
        : toolInput["taskId"];
    const output: HookOutput = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: buildDenialReason(toolName, rawTaskId),
      },
    };
    process.stdout.write(`${JSON.stringify(output)}\n`);
    return recordAndExit("deny", "decided");
  } catch (err) {
    process.stderr.write(
      `[check-task-spec-read] fail-open: ${err instanceof Error ? err.message : String(err)}\n`
    );
    // mt#2889 PR #2012 R1 NON-BLOCKING #6: this catch's fire-log record can
    // carry toolName/sessionId ONLY when `readInput()` (line ~302) already
    // succeeded before a LATER step threw — but no such later step exists in
    // this guard's body: sessionId/toolNameForLog are assigned on the very
    // next two lines after a successful readInput() call, with no
    // throwable operation in between. So the only way this catch block
    // fires is `readInput()` itself throwing (malformed stdin / JSON parse
    // failure) — there is no partial `input` object to extract context
    // from in that case; the error message on stderr above is the only
    // available diagnostic. Skipping the "populate what exists" advice
    // here deliberately, since there is genuinely nothing to populate.
    // mt#3920: `crashed` — a failed evaluation that fails open, the case the marker
    // exists to keep out of guard-health's recovery join.
    return recordAndExit("allow", "crashed");
  }
}

if (import.meta.main) {
  await main();
}
