/**
 * `session ps` (alias `session attached`) command (mt#2284).
 *
 * Lists sessions with a live runtime attachment, joining the STORED
 * (self-registered) attachment set with a local `lsof -d cwd` cross-check.
 * Reports stored-but-not-live and live-but-not-stored discrepancies
 * distinctly, per the task spec's acceptance tests.
 *
 * No `aliases` field exists on `CommandDefinition` (single-name commands
 * only), so the "alias" is implemented as a second, thin command
 * registration (`session.attached`) sharing the same execute logic.
 */
import { CommandCategory, type CommandDefinition } from "../../command-registry";
import { type LazySessionDeps, withErrorLogging } from "./types";
import type {
  PersistenceProvider,
  SqlCapablePersistenceProvider,
} from "@minsky/domain/persistence/types";
import { log } from "@minsky/shared/logger";
import { sessionPsCommandParams } from "./session-parameters";

const PS_DESCRIPTION =
  "List sessions with a live runtime attachment (self-registered), cross-checked " +
  "against a local `lsof -d cwd` scan. Reports stored-but-not-live and " +
  "live-but-not-stored discrepancies distinctly. Local-host only (v0).";

async function executeSessionPs(
  params: Record<string, unknown>,
  getDeps: LazySessionDeps,
  getPersistenceProvider?: () => PersistenceProvider | undefined
): Promise<{
  success: true;
  entries: unknown[];
  warning?: string;
  reaped?: { reapedCount: number; skippedRemoteHostCount: number };
}> {
  const { getSessionsDir } = await import("@minsky/shared/paths");
  const { buildSessionPsReport, reapStaleSessionAttachments } = await import(
    "@minsky/domain/session/index"
  );
  const { buildPresenceClaimRepository } = await import("@minsky/domain/presence/index");

  const provider = getPersistenceProvider?.();
  const sqlProvider = provider as SqlCapablePersistenceProvider | undefined;
  if (!sqlProvider?.getDatabaseConnection) {
    return {
      success: true,
      entries: [],
      warning: "No database connection available — cannot read stored attachments.",
    };
  }

  let repo: ReturnType<typeof buildPresenceClaimRepository> = null;
  try {
    const db = await sqlProvider.getDatabaseConnection();
    if (db) repo = buildPresenceClaimRepository(db);
  } catch (err) {
    log.debug("[session.ps] Failed to resolve presence-claim repository", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (!repo) {
    return {
      success: true,
      entries: [],
      warning: "Could not build presence-claim repository — cannot read stored attachments.",
    };
  }

  // mt#2284: manual invocation path for the stale-attachment reaper —
  // `minsky session ps --reap`. Runs BEFORE building the report so a just-reaped
  // dead pid doesn't show up as a stale entry in the same call.
  let reaped: { reapedCount: number; skippedRemoteHostCount: number } | undefined;
  if (params.reap === true) {
    const result = await reapStaleSessionAttachments(repo);
    reaped = {
      reapedCount: result.reapedCount,
      skippedRemoteHostCount: result.skippedRemoteHostCount,
    };
  }

  let report = await buildSessionPsReport(repo, getSessionsDir());

  const sessionIdFilter = params.sessionId as string | undefined;
  const taskFilter = params.task as string | undefined;

  if (sessionIdFilter) {
    report = report.filter((entry) => entry.sessionId === sessionIdFilter);
  } else if (taskFilter) {
    const deps = await getDeps();
    const storageTaskId = taskFilter.replace(/^mt#/i, "");
    const record = await deps.sessionProvider.getSessionByTaskId(storageTaskId);
    report = record ? report.filter((entry) => entry.sessionId === record.sessionId) : [];
  }

  return { success: true, entries: report, ...(reaped ? { reaped } : {}) };
}

export function createSessionPsCommand(
  getDeps: LazySessionDeps,
  getPersistenceProvider?: () => PersistenceProvider | undefined
): CommandDefinition {
  return {
    id: "session.ps",
    category: CommandCategory.SESSION,
    name: "ps",
    description: PS_DESCRIPTION,
    parameters: sessionPsCommandParams,
    execute: withErrorLogging("session.ps", (params: Record<string, unknown>) =>
      executeSessionPs(params, getDeps, getPersistenceProvider)
    ),
  };
}

export function createSessionAttachedCommand(
  getDeps: LazySessionDeps,
  getPersistenceProvider?: () => PersistenceProvider | undefined
): CommandDefinition {
  return {
    id: "session.attached",
    category: CommandCategory.SESSION,
    name: "attached",
    description: `${PS_DESCRIPTION} (alias of \`session ps\`)`,
    parameters: sessionPsCommandParams,
    execute: withErrorLogging("session.attached", (params: Record<string, unknown>) =>
      executeSessionPs(params, getDeps, getPersistenceProvider)
    ),
  };
}
