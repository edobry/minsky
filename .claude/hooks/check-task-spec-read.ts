#!/usr/bin/env bun
// PreToolUse hook: block advancing a task to READY (`tasks_status_set`) or
// binding a session to it (`session_start`) when that task's spec was never
// surfaced in-session — the "task-hijack" bind/advance seam (mt#2515, Seam 1 of
// mt#2511).
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
// Fail-open: any error — or a missing transcript — allows the call (exit 0).
// Override: MINSKY_SKIP_SPEC_READ_CHECK=1.
//
// @see mt#2511 — parent (task-hijack guard); mt#2514 — Seam 2 (merge-time)
// @see mt#979 — subsumed (this hook adds the spec-read detection mt#979 deemed "too brittle")
// @see .claude/hooks/check-guessed-session-path.ts — PreToolUse deny-class template
// @see .claude/hooks/transcript.ts — parseTranscript / findToolUseInputs

import { readInput } from "./types";
import type { ToolHookInput, HookOutput } from "./types";
import { parseTranscript, findToolUseInputs, type TranscriptLine } from "./transcript";

// ---------------------------------------------------------------------------
// Public API / constants
// ---------------------------------------------------------------------------

/** Override env var: set to "1"/"true"/"yes" to allow advancing/binding an unread task. */
export const OVERRIDE_ENV_VAR = "MINSKY_SKIP_SPEC_READ_CHECK";

/** Tools whose result surfaces a task's spec body into the transcript. */
export const SPEC_GET_TOOL = "mcp__minsky__tasks_spec_get";
export const TASKS_GET_TOOL = "mcp__minsky__tasks_get";

/** Guarded tools. */
export const STATUS_SET_TOOL = "mcp__minsky__tasks_status_set";
export const SESSION_START_TOOL = "mcp__minsky__session_start";

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
    if (String(toolInput["status"] ?? "").toUpperCase() !== "READY") return "";
    return normalizeTaskId(toolInput["taskId"]);
  }
  if (toolName === SESSION_START_TOOL) {
    return normalizeTaskId(toolInput["task"] ?? toolInput["taskId"]);
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

/** Build the denial-reason message naming the action, the task, and the fix. */
export function buildDenialReason(toolName: string, rawTaskId: unknown): string {
  const id = typeof rawTaskId === "string" && rawTaskId.length > 0 ? rawTaskId : "<unknown>";
  const action =
    toolName === SESSION_START_TOOL ? `binding a session to ${id}` : `advancing ${id} to READY`;
  return [
    `You are ${action}, but this session has never read ${id}'s spec`,
    `(no tasks_spec_get / tasks_get includeSpec for it anywhere in the transcript). This is`,
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

if (import.meta.main) {
  try {
    const overrideVal = process.env[OVERRIDE_ENV_VAR];
    const isOverride =
      overrideVal === "1" ||
      overrideVal?.toLowerCase() === "true" ||
      overrideVal?.toLowerCase() === "yes";

    const input = await readInput<ToolHookInput>();

    if (isOverride) {
      process.stdout.write(
        `[check-task-spec-read] OVERRIDE: ack=${overrideVal} tool=${input.tool_name} session=${input.session_id ?? "unknown"} ts=${new Date().toISOString()}\n`
      );
      process.exit(0);
    }

    const toolName = input.tool_name;
    const toolInput = input.tool_input ?? {};
    const targetId = resolveTargetTaskId(toolName, toolInput);
    if (!targetId) process.exit(0); // not guarded / non-READY transition / no resolvable id

    const transcriptPath = input.transcript_path;
    if (!transcriptPath) process.exit(0); // can't verify without a transcript — fail-open

    const lines = parseTranscript(transcriptPath);
    if (specWasSurfaced(lines, targetId)) process.exit(0);

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
    process.exit(0);
  } catch (err) {
    process.stderr.write(
      `[check-task-spec-read] fail-open: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(0);
  }
}
