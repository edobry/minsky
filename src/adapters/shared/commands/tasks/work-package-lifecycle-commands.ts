/**
 * tasks.packages.sweep / tasks.release-conversation — work-package lifecycle
 * commands (mt#5132; ADR-046 decision 3 extended with the `completed` origin).
 *
 * `packages sweep` is the one-shot form of the `package-lifecycle` ops loop
 * (`src/commands/ops/package-lifecycle-tick.ts`): close every READY /
 * IN-PROGRESS package whose members are all terminal, release every claim
 * whose holder has gone stale. Dry-run by default — the first `--execute` on
 * production is a bulk shared-state mutation and runs under its task wrapper
 * (mt#5132 AT4, then mt#5139 for the loop).
 *
 * `release-conversation` is what the SessionEnd hook spawns
 * (`.minsky/hooks/release-work-package-claims-on-session-end.ts`): it releases
 * exactly the packages whose claim identity is `…:conv:<session_id>`, and skips
 * the `reason` values under which the conversation's identity survives the
 * event (`clear` — the process and its claim persist; `resume` — the
 * conversation continues in a later process).
 *
 * `packages refresh-transfers` (mt#5143) is the one-shot projection repair:
 * every transfer writer re-renders the spec's `## Transfers` section itself,
 * and this brings the packages written BEFORE that shipped (or whose
 * best-effort re-render failed) back in line with their logs. Dry-run by
 * default; the first production `--execute` runs under mt#5143.
 *
 * Tools registered:
 *   tasks_packages_sweep              — plan (default) or apply the lifecycle sweep.
 *   tasks_release-conversation        — release a conversation's claims on SessionEnd.
 *   tasks_packages_refresh-transfers  — plan (default) or apply the `## Transfers` re-render.
 */

import { z } from "zod";
import { defineCommand, CommandCategory } from "../../command-registry";
import type { SqlCapablePersistenceProvider } from "@minsky/domain/persistence/types";
import { ValidationError } from "@minsky/domain/errors/index";
import {
  CLAIM_STALE_MS,
  runWorkPackageLifecycleSweep,
} from "@minsky/domain/tasks/work-package-lifecycle-sweep";
import { releaseClaimsForConversation } from "@minsky/domain/tasks/work-package-lifecycle";
import { runTransfersRefresh } from "@minsky/domain/tasks/work-package-transfers-projection";

/**
 * SessionEnd `reason` values under which a conversation's claims are LEFT
 * ALONE. Values from the Claude Code hooks reference (read 2026-09-13):
 * `clear`, `resume`, `logout`, `prompt_input_exit`, `other`.
 */
export const SESSION_END_REASONS_KEEPING_CLAIMS = ["clear", "resume"] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function getDb(getPersistenceProvider: () => unknown) {
  const provider = getPersistenceProvider() as SqlCapablePersistenceProvider | undefined;
  if (!provider?.getDatabaseConnection) {
    throw new ValidationError(
      "Work-package lifecycle commands require the SQL persistence provider, which is not available."
    );
  }
  const db = await provider.getDatabaseConnection();
  if (!db) {
    throw new ValidationError(
      "Could not obtain a database connection for the work-package lifecycle command."
    );
  }
  return db;
}

// ---------------------------------------------------------------------------
// tasks.packages.sweep
// ---------------------------------------------------------------------------

const sweepParams = {
  execute: {
    schema: z.boolean().default(false),
    description:
      "Apply the plan. Default is a dry-run that prints the close / release / keep lists and " +
      "writes nothing. The first --execute against production is a bulk shared-state mutation: " +
      "compare the dry-run against the count recorded on mt#5132 before applying.",
    required: false,
    defaultValue: false,
  },
  staleHours: {
    schema: z.number().positive().optional(),
    description:
      `Claim staleness window in hours (default ${CLAIM_STALE_MS / 3_600_000}): a claim older than ` +
      "this whose holder has shown no presence inside it is released.",
    required: false,
  },
} as const;

export function createTasksPackagesSweepCommand(getPersistenceProvider: () => unknown) {
  return defineCommand({
    id: "tasks.packages.sweep",
    category: CommandCategory.TASKS,
    name: "sweep",
    description:
      "Work-package lifecycle sweep (mt#5132): close every READY / IN-PROGRESS package whose " +
      "members are all terminal (DONE, `completed` transfer naming the members), and release " +
      "every IN-PROGRESS claim older than the staleness window whose holder has shown no " +
      "presence inside it (READY, `release` transfer). Zero-member packages are reported, never " +
      "closed. Dry-run by default.",
    parameters: sweepParams,

    async execute(params) {
      const db = await getDb(getPersistenceProvider);
      const result = await runWorkPackageLifecycleSweep(db, {
        execute: params.execute === true,
        staleMs: params.staleHours === undefined ? undefined : params.staleHours * 3_600_000,
        via: "cli",
      });
      return {
        success: true,
        dryRun: result.dryRun,
        counts: {
          close: result.plan.close.length,
          release: result.plan.release.length,
          keep: result.plan.keep.length,
          zeroMembers: result.plan.zeroMembers.length,
          closed: result.applied.closed.length,
          released: result.applied.released.length,
          refused: result.applied.refused.length,
        },
        close: result.plan.close,
        release: result.plan.release,
        keep: result.plan.keep,
        zeroMembers: result.plan.zeroMembers,
        applied: result.applied,
      };
    },
  });
}

// ---------------------------------------------------------------------------
// tasks.release-conversation
// ---------------------------------------------------------------------------

const releaseConversationParams = {
  conversationId: {
    schema: z.string(),
    description: "The ending conversation's id — the SessionEnd payload's `session_id` (a uuid).",
    required: true,
  },
  reason: {
    schema: z.string().optional(),
    description:
      "The SessionEnd payload's `reason`. `clear` and `resume` release nothing: the conversation's " +
      "identity outlives the event. Any other value (logout, prompt_input_exit, other, or none) " +
      "releases.",
    required: false,
  },
} as const;

export function createTasksReleaseConversationCommand(getPersistenceProvider: () => unknown) {
  return defineCommand({
    id: "tasks.release-conversation",
    category: CommandCategory.TASKS,
    name: "release-conversation",
    description:
      "Release every IN-PROGRESS work package claimed by a conversation that has ended — the " +
      "SessionEnd hook's write (mt#5132). Matches claims whose identity is exactly " +
      "`<kind>:conv:<conversationId>`; a `proc:`-scoped or free-text claim is never matched " +
      "(that identity is shared or unattributable) and is left to the lifecycle sweep's " +
      "staleness backstop. Skips reasons `clear` and `resume`.",
    parameters: releaseConversationParams,

    // ADR-004: input validation lives in validate(), not execute(). A non-uuid
    // id is refused here rather than becoming a LIKE pattern downstream.
    async validate(params) {
      const conversationId = params.conversationId.trim();
      if (!UUID_RE.test(conversationId)) {
        throw new ValidationError(
          `conversationId must be a uuid (the SessionEnd payload's session_id); got "${conversationId}".`
        );
      }
    },

    async execute(params) {
      const conversationId = params.conversationId.trim();
      const reason = params.reason?.trim() || "unspecified";
      if ((SESSION_END_REASONS_KEEPING_CLAIMS as readonly string[]).includes(reason)) {
        return {
          success: true,
          conversationId,
          reason,
          skipped: true,
          matched: [],
          released: [],
          refused: [],
          message: `SessionEnd reason "${reason}" keeps the conversation's claims; nothing released.`,
        };
      }
      const db = await getDb(getPersistenceProvider);
      const result = await releaseClaimsForConversation(db, {
        conversationId,
        notes:
          `Released on SessionEnd (reason: ${reason}) by the release-work-package-claims hook ` +
          `(mt#5132) for conversation ${conversationId}.`,
      });
      return {
        success: true,
        conversationId,
        reason,
        skipped: false,
        matched: result.matched,
        released: result.released,
        refused: result.refused,
        message:
          result.matched.length === 0
            ? `No IN-PROGRESS work package is claimed by conversation ${conversationId}.`
            : `Released ${result.released.length} of ${result.matched.length} package(s) claimed by ${conversationId}.`,
      };
    },
  });
}

// ---------------------------------------------------------------------------
// tasks.packages.refresh-transfers
// ---------------------------------------------------------------------------

const refreshTransfersParams = {
  execute: {
    schema: z.boolean().default(false),
    description:
      "Rewrite the `## Transfers` section of every package whose rendering is missing, behind " +
      "or ahead of its transfer log. Default is a dry-run that lists them and writes nothing. " +
      "The first --execute against production is a bulk spec mutation: compare the dry-run's " +
      "count against the population recorded on mt#5143 before applying.",
    required: false,
    defaultValue: false,
  },
} as const;

export function createTasksPackagesRefreshTransfersCommand(getPersistenceProvider: () => unknown) {
  return defineCommand({
    id: "tasks.packages.refresh-transfers",
    category: CommandCategory.TASKS,
    name: "refresh-transfers",
    description:
      "One-shot repair of the `## Transfers` projection (mt#5143): for every work package with a " +
      "transfer log, re-render the spec section from the log when it is missing, behind or ahead. " +
      "Every transfer writer re-renders on its own; this covers packages written before that " +
      "shipped and any best-effort re-render that failed. Terminal packages included. Dry-run by " +
      "default.",
    parameters: refreshTransfersParams,

    async execute(params) {
      const db = await getDb(getPersistenceProvider);
      const result = await runTransfersRefresh(db, { execute: params.execute === true });
      const byState = { missing: 0, behind: 0, ahead: 0 };
      for (const entry of result.plan.refresh) byState[entry.state as keyof typeof byState] += 1;
      return {
        success: true,
        dryRun: result.dryRun,
        counts: {
          refresh: result.plan.refresh.length,
          ...byState,
          inSync: result.plan.inSync.length,
          refreshed: result.applied.refreshed.length,
          failed: result.applied.failed.length,
        },
        refresh: result.plan.refresh,
        applied: result.applied,
      };
    },
  });
}
