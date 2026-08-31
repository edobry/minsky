/**
 * tasks.claim / tasks.release — work-package claim commands (ADR-046, mt#2911).
 *
 * The claim path is the ONLY legal READY → IN-PROGRESS transition for kind
 * "work-package" (workflows.ts reserves it via restrictedTransitions). Claim is
 * a single conditional UPDATE writing status + claimed_by/claimed_at at once —
 * two concurrent claims resolve to one winner at the database. Release clears
 * the identity, returns the package to READY, and appends the transfer-log
 * entry (origin "release") that re-offers it.
 *
 * Tools registered:
 *   tasks_claim    — claim a READY work package for the calling conversation.
 *   tasks_release  — release a claimed work package back to the pool.
 */

import { z } from "zod";
import { defineCommand, CommandCategory } from "../../command-registry";
import type { SqlCapablePersistenceProvider } from "@minsky/domain/persistence/types";
import { claimWorkPackage, releaseWorkPackage } from "@minsky/domain/tasks/work-package-claim";
import { isQualifiedTaskId } from "@minsky/domain/tasks/task-id";
import { resolveCallerActorId } from "@minsky/domain/agent-identity/index";
import { ValidationError } from "@minsky/domain/errors/index";

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/**
 * The server-injected caller identity param, shared by both commands.
 * Same contract as tasks.claims.release (mt#4568): the MCP server overwrites
 * any hand-supplied value; the CLI path resolves from harness env instead.
 */
const callerActorIdParam = {
  schema: z.string(),
  description:
    "The caller's resolved agentId (ADR-006), recorded as the claim/release identity. " +
    "Server-injected from the resolved MCP identity (src/mcp/server.ts) — not supplied " +
    "by hand, and any hand-supplied value is overwritten there. Absent on the CLI path, " +
    "which resolves identity from the harness environment instead.",
  required: false,
  cliHidden: true,
  mcpHidden: true,
} as const;

function requireQualifiedTaskId(taskId: string): string {
  if (isQualifiedTaskId(taskId)) return taskId;
  throw new ValidationError(
    `Invalid task ID: '${taskId}'. Please provide a qualified task ID (mt#123, gh#456).`
  );
}

async function getDb(getPersistenceProvider: () => unknown) {
  const provider = getPersistenceProvider() as SqlCapablePersistenceProvider | undefined;
  if (!provider?.getDatabaseConnection) {
    throw new ValidationError(
      "Work-package claims require the SQL persistence provider, which is not available."
    );
  }
  const db = await provider.getDatabaseConnection();
  if (!db) {
    throw new ValidationError("Could not obtain a database connection for the claim.");
  }
  return db;
}

// The task.status_changed emission lives INSIDE the domain claim/release
// functions (PR #3503 R1) — every caller, including the cockpit routes, feeds
// the event ledger without re-implementing it here.

// ---------------------------------------------------------------------------
// tasks.claim
// ---------------------------------------------------------------------------

const tasksClaimParams = {
  taskId: {
    schema: z.string(),
    description: 'Work-package task id (e.g. "mt#2911")',
    required: true,
  },
  claimedBy: {
    schema: z.string().optional(),
    description:
      "Override the recorded claimant identity. Defaults to the resolved caller " +
      "(MCP identity or harness environment); pass only when claiming on behalf of " +
      "another actor deliberately.",
    required: false,
  },
  callerActorId: callerActorIdParam,
} as const;

export function createTasksClaimCommand(getPersistenceProvider: () => unknown) {
  return defineCommand({
    id: "tasks.claim",
    category: CommandCategory.TASKS,
    name: "claim",
    description:
      "Claim a READY work package: one conditional write sets IN-PROGRESS and records " +
      "claimed_by/claimed_at atomically, so concurrent claims get exactly one winner. " +
      "The only legal READY→IN-PROGRESS path for kind work-package.",
    parameters: tasksClaimParams,

    async execute(params) {
      const taskId = requireQualifiedTaskId(params.taskId);
      const claimedBy =
        params.claimedBy?.trim() || resolveCallerActorId(params.callerActorId) || null;
      if (!claimedBy) {
        // Outcome, not a throw: identity resolution depends on runtime state
        // (caller injection / harness env), not on the call's parameters, so it
        // is not validate()-shaped either (ADR-004) — report it like any other
        // refused claim.
        return {
          success: false,
          taskId,
          reason: "no-identity",
          message:
            "Could not resolve a claimant identity: no claimedBy given and no caller " +
            "identity available (CLAUDE_AGENT_ID / CLAUDE_CODE_SESSION_ID unset).",
        };
      }

      const db = await getDb(getPersistenceProvider);
      const outcome = await claimWorkPackage(db, { taskId, claimedBy });

      if (outcome.ok) {
        return {
          success: true,
          taskId,
          claimedBy: outcome.claimedBy,
          claimedAt: outcome.claimedAt.toISOString(),
          message: `Work package ${taskId} claimed by ${outcome.claimedBy}.`,
        };
      }
      return { success: false, ...outcome };
    },
  });
}

// ---------------------------------------------------------------------------
// tasks.release
// ---------------------------------------------------------------------------

const tasksReleaseParams = {
  taskId: {
    schema: z.string(),
    description: 'Work-package task id (e.g. "mt#2911")',
    required: true,
  },
  notes: {
    schema: z.string().optional(),
    description:
      "Transfer notes recorded on the release entry: what is done, what remains, " +
      "judgment the next claimant needs.",
    required: false,
  },
  callerActorId: callerActorIdParam,
} as const;

export function createTasksReleaseCommand(getPersistenceProvider: () => unknown) {
  return defineCommand({
    id: "tasks.release",
    category: CommandCategory.TASKS,
    name: "release",
    description:
      "Release a claimed work package back to READY, clearing claimed_by/claimed_at and " +
      "appending a transfer-log entry (origin release) that re-offers it. Any caller may " +
      "release — the releaser is recorded, so freeing a dead conversation's claim is " +
      "auditable rather than forbidden.",
    parameters: tasksReleaseParams,

    async execute(params) {
      const taskId = requireQualifiedTaskId(params.taskId);
      const byConversation = resolveCallerActorId(params.callerActorId);

      const db = await getDb(getPersistenceProvider);
      const outcome = await releaseWorkPackage(db, {
        taskId,
        byConversation,
        notes: params.notes,
      });

      if (outcome.ok) {
        return {
          success: true,
          taskId,
          previousHolder: outcome.previousHolder,
          transferSeq: outcome.transferSeq,
          message: `Work package ${taskId} released${
            outcome.previousHolder ? ` (was held by ${outcome.previousHolder})` : ""
          } — transfer #${outcome.transferSeq} recorded.`,
        };
      }
      return { success: false, ...outcome };
    },
  });
}
