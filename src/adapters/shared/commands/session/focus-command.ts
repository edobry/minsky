/**
 * `session focus <id>` (alias `session goto`) command (mt#2285).
 *
 * Resolves a session's LIVE runtime attachment(s) (mt#2284, via
 * `listLiveSessionAttachments`) and raises the terminal running its agent to
 * the foreground using the per-emulator focus-adapter registry
 * (`packages/domain/src/session/focus`). This file owns session resolution,
 * "nothing attached" / multi-attachment-selector messaging, and result
 * shaping; the actual OS-level focus action is delegated to
 * `focusAttachment`, which never runs from this process during tests --
 * `getFocusExecutor` lets tests inject a mock, mirroring how `session ps`
 * injects an `LsofRunner` (mt#2284 precedent).
 */
import { CommandCategory, type CommandDefinition } from "../../command-registry";
import { type LazySessionDeps, withErrorLogging } from "./types";
import type {
  PersistenceProvider,
  SqlCapablePersistenceProvider,
} from "@minsky/domain/persistence/types";
import type { CommandExecutor, SessionAttachment } from "@minsky/domain/session/index";
import { log } from "@minsky/shared/logger";
import { sessionFocusCommandParams } from "./session-parameters";

const FOCUS_DESCRIPTION =
  "Raise the terminal where a session's agent is running to the foreground, using the " +
  "live attachment recorded by `session ps` (mt#2284). Supports tmux, iTerm2, " +
  "Terminal.app, WezTerm, and kitty, with a window-raise degraded fallback for other " +
  "emulators. Never silently no-ops: every outcome (focused, degraded, permission " +
  "denied, no attachment) is reported with an actionable message.";

export interface SessionFocusResult {
  success: boolean;
  sessionId?: string;
  message: string;
  outcomeKind?: string;
  adapter?: string;
  attachments?: SessionAttachment[];
}

async function resolveSessionId(
  params: Record<string, unknown>,
  getDeps: LazySessionDeps
): Promise<string | undefined> {
  const sessionIdParam = params.sessionId as string | undefined;
  if (sessionIdParam) return sessionIdParam;

  const taskParam = params.task as string | undefined;
  if (!taskParam) return undefined;

  const deps = await getDeps();
  const storageTaskId = taskParam.replace(/^mt#/i, "");
  const record = await deps.sessionProvider.getSessionByTaskId(storageTaskId);
  return record?.sessionId;
}

function describeAttachment(attachment: SessionAttachment): string {
  const bits = [`id ${attachment.id}`];
  if (typeof attachment.pid === "number") bits.push(`pid ${attachment.pid}`);
  if (attachment.host) bits.push(`host ${attachment.host}`);
  if (attachment.entrypoint) bits.push(`entrypoint ${attachment.entrypoint}`);
  return bits.join(", ");
}

async function executeSessionFocus(
  params: Record<string, unknown>,
  getDeps: LazySessionDeps,
  getPersistenceProvider?: () => PersistenceProvider | undefined,
  getFocusExecutor?: () => CommandExecutor | undefined
): Promise<SessionFocusResult> {
  const { listLiveSessionAttachments, focusAttachment } = await import(
    "@minsky/domain/session/index"
  );
  const { buildPresenceClaimRepository } = await import("@minsky/domain/presence/index");

  const sessionId = await resolveSessionId(params, getDeps);
  if (!sessionId) {
    return {
      success: false,
      message: "Could not resolve a session id -- pass --session-id or --task.",
    };
  }

  const provider = getPersistenceProvider?.();
  const sqlProvider = provider as SqlCapablePersistenceProvider | undefined;
  if (!sqlProvider?.getDatabaseConnection) {
    return {
      success: false,
      sessionId,
      message: "No database connection available -- cannot resolve stored attachments.",
    };
  }

  let repo: Awaited<ReturnType<typeof buildPresenceClaimRepository>> = null;
  try {
    const db = await sqlProvider.getDatabaseConnection();
    if (db) repo = buildPresenceClaimRepository(db);
  } catch (err) {
    log.debug("[session.focus] Failed to resolve presence-claim repository", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (!repo) {
    return {
      success: false,
      sessionId,
      message: "Could not build presence-claim repository -- cannot resolve stored attachments.",
    };
  }

  const attachments = await listLiveSessionAttachments(repo, sessionId);

  if (attachments.length === 0) {
    return {
      success: false,
      sessionId,
      message: `Nothing attached to session ${sessionId} -- no live terminal to go to.`,
    };
  }

  let target: SessionAttachment | undefined;
  if (attachments.length === 1) {
    target = attachments[0];
  } else {
    const selector = params.attachment as string | undefined;
    if (!selector) {
      return {
        success: false,
        sessionId,
        message:
          `Session ${sessionId} has ${attachments.length} live attachments -- pass ` +
          `--attachment <id> to choose one: ${attachments.map(describeAttachment).join("; ")}.`,
        attachments,
      };
    }
    target = attachments.find((a) => a.id === selector);
    if (!target) {
      return {
        success: false,
        sessionId,
        message: `No attachment with id "${selector}" for session ${sessionId}. Known: ${attachments
          .map((a) => a.id)
          .join(", ")}`,
        attachments,
      };
    }
  }

  if (!target) {
    // Unreachable given the branches above; keeps TS control-flow analysis happy
    // without an assertion (noUncheckedIndexedAccess widens attachments[0]).
    return {
      success: false,
      sessionId,
      message: `Could not resolve an attachment to focus for session ${sessionId}.`,
      attachments,
    };
  }

  const executor = getFocusExecutor?.();
  const result = await focusAttachment(target, executor ? { executor } : {});

  return {
    success: result.kind === "focused" || result.kind === "degraded-app-raised",
    sessionId,
    message: result.message,
    outcomeKind: result.kind,
    adapter: result.adapter,
  };
}

export function createSessionFocusCommand(
  getDeps: LazySessionDeps,
  getPersistenceProvider?: () => PersistenceProvider | undefined,
  getFocusExecutor?: () => CommandExecutor | undefined
): CommandDefinition {
  return {
    id: "session.focus",
    category: CommandCategory.SESSION,
    name: "focus",
    description: FOCUS_DESCRIPTION,
    parameters: sessionFocusCommandParams,
    execute: withErrorLogging("session.focus", (params: Record<string, unknown>) =>
      executeSessionFocus(params, getDeps, getPersistenceProvider, getFocusExecutor)
    ),
  };
}

export function createSessionGotoCommand(
  getDeps: LazySessionDeps,
  getPersistenceProvider?: () => PersistenceProvider | undefined,
  getFocusExecutor?: () => CommandExecutor | undefined
): CommandDefinition {
  return {
    id: "session.goto",
    category: CommandCategory.SESSION,
    name: "goto",
    description: `${FOCUS_DESCRIPTION} (alias of \`session focus\`)`,
    parameters: sessionFocusCommandParams,
    execute: withErrorLogging("session.goto", (params: Record<string, unknown>) =>
      executeSessionFocus(params, getDeps, getPersistenceProvider, getFocusExecutor)
    ),
  };
}
