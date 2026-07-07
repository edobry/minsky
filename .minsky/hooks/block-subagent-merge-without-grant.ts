#!/usr/bin/env bun
// PreToolUse hook: deny `mcp__minsky__session_pr_merge` for subagents unless
// a valid, unexpired capability grant covers the task (ADR-028 D5).
//
// ## Why this exists
//
// Prior to this guard, `mcp__minsky__session_pr_merge` had NO subagent gate
// at all — only the raw `gh api PUT` bypass path was gated
// (`block-subagent-bypass-merge.ts`). Instruction-tier compliance ("do NOT
// merge the PR" in the dispatch prompt) was the only control, and it failed
// 2 of 6 times during the mt#2607 burndown (mt#2612 PR #1792, mt#2615
// PR #1795 — both merged by subagents despite explicit no-merge
// instructions; both outcomes happened to be sound, but the mechanism that
// would have prevented an UNsound one did not exist).
//
// ## Policy (ADR-028 D5)
//
// - **Default (no grant): deny.** A subagent (`agent_id` present) calling
//   `session_pr_merge` with no matching, unexpired capability grant is
//   denied. This makes the already-documented policy (`/implement-task` §9
//   "Subagent carve-out": subagents stop at PR creation; the main agent
//   drives convergence) a STRUCTURAL guarantee instead of an instruction
//   the subagent has to remember to honor.
// - **Escape valve: an explicit, TTL-bound capability grant**, issued via
//   `scripts/grant-subagent-merge.ts` (the orchestrator-side surface) BEFORE
//   the merge attempt. The grant is scoped to a task id, short-TTL, and
//   auditable — a fact set at dispatch/authorization time, not an
//   instruction the subagent has to comply with. See
//   `.minsky/hooks/merge-grant-store.ts` for the grant schema + matching
//   logic (shared between this guard and the issuance script).
// - **Main-thread merges are unaffected.** When `agent_id` is absent, this
//   guard is a no-op — the main agent's merge path is unchanged.
//
// ## Fail-open posture
//
// Fail-open is reserved for GENUINE ERRORS reading the grant store (file
// unreadable for reasons other than "doesn't exist yet", malformed JSON).
// A CONFIRMED state — the store file simply doesn't exist yet, or exists
// and parses cleanly but contains no matching grant — is NOT a fail-open
// case; it is the default-deny path doing its job. See
// `readGrantStore`'s doc comment in `merge-grant-store.ts` for the ENOENT
// vs. genuine-error distinction.
//
// ## Override
//
// Set `MINSKY_SKIP_MERGE_GRANT_CHECK=1` (or `true` / `yes`) in the
// environment before invoking the tool. The override is audit-logged to
// stdout (agent_id, resolved task id, ISO timestamp). Use only when this
// denial is a confirmed false positive (e.g. the grant-issuance mechanism
// itself is broken and the merge has been independently verified safe).
//
// @see mt#2651 — this guard's tracking task
// @see docs/architecture/adr-028-guard-hook-dispatcher-consolidation.md §D5
// @see .minsky/hooks/merge-grant-store.ts — grant schema + matching logic
// @see scripts/grant-subagent-merge.ts — orchestrator-side issuance surface
// @see .minsky/hooks/block-subagent-bypass-merge.ts — structural template
//      (the D5 doc explicitly calls this guard "structurally identical in
//      shape to block-subagent-bypass-merge.ts")
// @see .minsky/rules/hook-files.mdc "Subagent Merge Capability Guard"

import { readInput, writeOutput, execSync } from "./types";
import type { ToolHookInput } from "./types";
import { getMergeGrantStorePath, readGrantStore, findValidGrant } from "./merge-grant-store";
import type { MergeGrant } from "./merge-grant-store";

// ---------------------------------------------------------------------------
// Subagent context detection (identical shape to block-subagent-bypass-merge.ts)
// ---------------------------------------------------------------------------

export function isSubagentContext(input: ToolHookInput): boolean {
  return typeof input.agent_id === "string" && input.agent_id.length > 0;
}

// ---------------------------------------------------------------------------
// Task-id resolution
// ---------------------------------------------------------------------------

/**
 * Best-effort task id resolution for the current `session_pr_merge` call.
 *
 * Prefers `tool_input.task` (the string param `session_pr_merge` accepts
 * directly). Falls back to parsing the current git branch in `cwd` for the
 * `task/mt-<id>` naming convention — a self-contained, DB-free strategy
 * (deliberately NOT the DB-backed session lookup `record-subagent-
 * invocation.ts` uses, which would violate the hooks' self-containment
 * invariant this guard must preserve).
 *
 * Returns null when neither source yields a resolvable task id — the guard
 * treats an unresolvable task id as "no grant can match" (default-deny),
 * NOT as a read error (so it does not trigger the fail-open path).
 */
export function resolveTaskIdFromInput(input: ToolHookInput): string | null {
  const fromToolInput = input.tool_input?.["task"];
  if (typeof fromToolInput === "string" && fromToolInput.trim().length > 0) {
    return fromToolInput.trim();
  }

  const cwd = input.cwd;
  if (!cwd) return null;

  try {
    const result = execSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 3000 });
    if (result.exitCode !== 0) return null;

    const match = result.stdout.match(/^task\/mt[-#](\d+)$/);
    return match ? `mt#${match[1]}` : null;
  } catch {
    // A nonexistent cwd, or any other spawn-level failure, resolves to "no
    // task id" — treated as default-deny territory, not a store read error.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Override env var
// ---------------------------------------------------------------------------

export const MERGE_GRANT_OVERRIDE_ENV = "MINSKY_SKIP_MERGE_GRANT_CHECK";

function isOverrideActive(): boolean {
  const val = process.env[MERGE_GRANT_OVERRIDE_ENV]?.toLowerCase();
  return val === "1" || val === "true" || val === "yes";
}

// ---------------------------------------------------------------------------
// Denial message
// ---------------------------------------------------------------------------

export function buildDenialMessage(taskId: string | null): string {
  const taskRef = taskId ?? "this task (could not be resolved)";
  return (
    `Subagent merge denied (ADR-028 D5): no valid capability grant for ${taskRef}. ` +
    "Subagents stop at PR creation and report the PR URL + reviewer-bot status to the " +
    'parent (per /implement-task §9 "Subagent carve-out"); the main agent (or an ' +
    "orchestrating parent) drives the PR to convergence and merges. If this dispatch was " +
    "explicitly authorized to merge, the orchestrator must issue a capability grant BEFORE " +
    "this call: `bun scripts/grant-subagent-merge.ts --task <id> --ttl-minutes <n>` " +
    '(see .minsky/rules/hook-files.mdc §"Subagent Merge Capability Guard"). ' +
    `Override: set ${MERGE_GRANT_OVERRIDE_ENV}=1 in the environment if this denial is a ` +
    "confirmed false positive (audit-logged)."
  );
}

// ---------------------------------------------------------------------------
// Core decision logic (pure, given already-read grants — for testability)
// ---------------------------------------------------------------------------

export type MergeGrantDecision =
  | { decision: "allow"; reason: string }
  | { decision: "deny"; reason: string };

/**
 * Pure decision function given the resolved task id, agent id, the grants
 * already read from the store, and the current time. Exported so tests can
 * exercise the deny/allow/expired matrix without touching the filesystem.
 */
export function decideMergeGrant(
  taskId: string | null,
  agentId: string,
  grants: MergeGrant[],
  nowMs: number
): MergeGrantDecision {
  const match = findValidGrant(grants, { taskId, agentId }, nowMs);
  if (match) {
    return {
      decision: "allow",
      reason:
        `valid grant found for task=${taskId ?? "?"} agent_id=${agentId} ` +
        `issuedAt=${match.issuedAt} ttlMs=${match.ttlMs}`,
    };
  }
  return { decision: "deny", reason: buildDenialMessage(taskId) };
}

// ---------------------------------------------------------------------------
// Hook entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const input = await readInput<ToolHookInput>();

  if (input.tool_name !== "mcp__minsky__session_pr_merge") {
    process.exit(0);
  }

  if (!isSubagentContext(input)) {
    // Main-thread merges are unaffected by this guard.
    process.exit(0);
  }

  const agentId = input.agent_id as string;

  if (isOverrideActive()) {
    console.error(
      `[block-subagent-merge-without-grant] ${MERGE_GRANT_OVERRIDE_ENV} override active — ` +
        `allowing subagent merge. agent_id=${agentId} timestamp=${new Date().toISOString()}`
    );
    process.exit(0);
  }

  const taskId = resolveTaskIdFromInput(input);

  const storeResult = readGrantStore(getMergeGrantStorePath());
  if (storeResult.status === "error") {
    // Fail-open ONLY on genuine grant-store read errors (corrupt file,
    // permission denied, etc.) — a broken store must not silently deny
    // every subagent merge. Deny is reserved for the CONFIRMED
    // no-valid-grant case (empty/absent store, or a store that parses
    // cleanly but has no matching entry).
    console.error(
      `[block-subagent-merge-without-grant] warn: grant store read error (${storeResult.message}) ` +
        "— failing open (allowing this call)."
    );
    process.exit(0);
  }

  const decision = decideMergeGrant(taskId, agentId, storeResult.grants, Date.now());

  if (decision.decision === "allow") {
    console.error(`[block-subagent-merge-without-grant] ${decision.reason} — allowing.`);
    process.exit(0);
  }

  writeOutput({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: decision.reason,
    },
  });
  process.exit(0);
}
