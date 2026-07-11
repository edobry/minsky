/**
 * Basic Session Commands
 *
 * Factories for basic session operations (list, get, start, dir, search).
 */
import { CommandCategory, type CommandDefinition } from "../../command-registry";
import { type LazySessionDeps, withErrorLogging } from "./types";
import type {
  PersistenceProvider,
  SqlCapablePersistenceProvider,
} from "@minsky/domain/persistence/types";
import { log } from "@minsky/shared/logger";
import {
  sessionListCommandParams,
  sessionGetCommandParams,
  sessionStartCommandParams,
  sessionDirCommandParams,
  sessionSearchCommandParams,
  sessionExecCommandParams,
} from "./session-parameters";

export function createSessionListCommand(
  getDeps: LazySessionDeps,
  getPersistenceProvider?: () => PersistenceProvider | undefined
): CommandDefinition {
  return {
    id: "session.list",
    category: CommandCategory.SESSION,
    name: "list",
    description: "List all sessions",
    // Served entirely from the central session DB — works from any directory,
    // no project init required (mt#1428).
    requiresSetup: false,
    parameters: sessionListCommandParams,
    execute: withErrorLogging("session.list", async (params: Record<string, unknown>) => {
      const { SessionService } = await import("@minsky/domain/session/session-service");
      const { parseTime } = await import("../../../../utils/result-handling/filters");
      const deps = await getDeps();
      const service = new SessionService(deps);

      const verbose = params.verbose as boolean | undefined;
      const allProjects = params.allProjects as boolean | undefined;

      // Parse since/until into ISO strings so the storage layer can apply the
      // window directly (otherwise pagination + post-filter would silently
      // drop matches that fell outside the first page).
      const sinceTs = parseTime(params.since as string | undefined);
      const untilTs = parseTime(params.until as string | undefined);

      // ADR-021 / mt#2416: resolve project scope so list returns only this
      // project's sessions by default. When allProjects=true, skip scope
      // resolution and let the repository return all rows.
      //
      // mt#2697: also skip project-scope resolution when a task filter is
      // supplied. `session_list task:"mt#X"` is the collision-probe predicate
      // (session_start / tasks_dispatch's "is this task already in use" check
      // consults sessionDB.listSessions({ taskId }) UNSCOPED by project — see
      // start-session-operations.ts). Applying project scope on top of an
      // explicit task filter would make session_list silently disagree with
      // that check for any session whose project_id doesn't match the caller's
      // current project scope (including legitimately unstamped rows), which is
      // exactly the divergence that broke the probe protocol during the
      // 2026-07-08 incident. A task-filtered query is already maximally
      // specific — project scoping adds no precision, only a false-negative risk.
      const hasTaskFilter = typeof params.task === "string" && params.task.length > 0;
      let projectScope: string | undefined;
      if (!allProjects && !hasTaskFilter) {
        const provider = getPersistenceProvider?.();
        const sqlProvider = provider as SqlCapablePersistenceProvider | undefined;
        if (sqlProvider?.getDatabaseConnection) {
          try {
            const { resolveProjectIdentity } = await import("@minsky/domain/project/identity");
            const { resolveProjectScope } = await import("@minsky/domain/project/scope-resolver");
            const identity = resolveProjectIdentity({ repoPath: process.cwd() });
            if (identity.kind === "resolved") {
              const db = await sqlProvider.getDatabaseConnection();
              if (db) {
                const scope = await resolveProjectScope(identity, db);
                // Only pass a uuid scope; ALL_PROJECTS (sentinel) means no filter — omit it
                const { isAllProjects } = await import("@minsky/domain/project/scope");
                if (!isAllProjects(scope)) {
                  projectScope = scope;
                }
              }
            }
          } catch (err: unknown) {
            log.debug(
              "[session.list] Project scope resolution failed; defaulting to all projects",
              {
                error: err instanceof Error ? err.message : String(err),
              }
            );
          }
        }
      }

      let sessions = await service.list({
        repo: params.repo as string | undefined,
        json: params.json as boolean | undefined,
        task: params.task as string | undefined,
        limit: params.limit as number | undefined,
        offset: params.offset as number | undefined,
        since: sinceTs !== null ? new Date(sinceTs).toISOString() : undefined,
        until: untilTs !== null ? new Date(untilTs).toISOString() : undefined,
        projectScope,
      });

      // Lean-output by default — strip the heavy nested PR payload that drives
      // most of the per-row response size. Callers who want full records pass
      // --verbose.
      if (!verbose) {
        sessions = sessions.map(({ pullRequest: _pr, prState: _ps, ...rest }) => rest);
      }

      return { success: true, sessions, verbose };
    }),
  };
}

export function createSessionGetCommand(getDeps: LazySessionDeps): CommandDefinition {
  return {
    id: "session.get",
    category: CommandCategory.SESSION,
    name: "get",
    description: "Get details of a specific session",
    parameters: sessionGetCommandParams,
    execute: withErrorLogging("session.get", async (params: Record<string, unknown>) => {
      const { SessionService } = await import("@minsky/domain/session/session-service");
      const deps = await getDeps();
      const service = new SessionService(deps);

      const session = await service.get({
        sessionId: params.sessionId as string | undefined,
        task: params.task as string | undefined,
        repo: params.repo as string | undefined,
        json: params.json as boolean | undefined,
      });

      if (!session) {
        const identifier = params.sessionId || params.task || "unknown";
        throw new Error(`Session '${identifier}' not found`);
      }

      try {
        const {
          parseTime,
          filterByTimeRange,
        } = require("../../../../utils/result-handling/filters");
        const sinceTs = parseTime(params.since as string | undefined);
        const untilTs = parseTime(params.until as string | undefined);
        const [matched] = filterByTimeRange([{ updatedAt: session.createdAt }], sinceTs, untilTs);
        if ((sinceTs !== null || untilTs !== null) && !matched) {
          throw new Error("Session does not match time constraints");
        }
      } catch {
        // ignore
      }

      return { success: true, session };
    }),
  };
}

/**
 * Emit a `session.started` system event (best-effort, informational — mt#2487).
 *
 * Mirrors `emitTaskStatusChangedEvent` (mt#2340): resolves the DB from the
 * SQL-capable persistence provider and skips silently when none is available
 * (e.g., CLI without a DB) — never fabricating a provider (no DI fallback).
 * Never throws — event emission must not affect the session-start outcome.
 */
async function emitSessionStartedEvent(
  provider: PersistenceProvider | undefined,
  payload: { sessionId: string; taskId?: string }
): Promise<void> {
  try {
    const sqlProvider = provider as SqlCapablePersistenceProvider | undefined;
    if (!sqlProvider?.getDatabaseConnection) return;
    const db = await sqlProvider.getDatabaseConnection();
    if (!db) return;
    const { DrizzleEventEmitter } = await import("@minsky/domain/events/emitter");
    await new DrizzleEventEmitter(db).emit({
      eventType: "session.started",
      payload,
      relatedTaskId: payload.taskId,
      relatedSessionId: payload.sessionId,
    });
  } catch (err: unknown) {
    log.warn("session.started: event emission failed (best-effort, swallowed)", {
      sessionId: payload.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function createSessionStartCommand(
  getDeps: LazySessionDeps,
  getPersistenceProvider?: () => PersistenceProvider | undefined
): CommandDefinition {
  return {
    id: "session.start",
    category: CommandCategory.SESSION,
    name: "start",
    description: "Start a new session",
    parameters: sessionStartCommandParams,
    execute: withErrorLogging("session.start", async (params: Record<string, unknown>) => {
      if (!params.task && !params.description) {
        throw new Error(
          'Task association is required for proper tracking.\nPlease provide one of:\n  --task <id>           Associate with existing task\n  --description <text>  Create new task automatically\n\nExamples:\n  minsky session start --task 123\n  minsky session start --description "Fix login issue" my-session'
        );
      }

      const { SessionService } = await import("@minsky/domain/session/session-service");
      const baseDeps = await getDeps();

      // ADR-021 / mt#2416: resolve the DB so session.start can stamp project_id
      // on the new session row (mirrors session.list scope resolution above).
      // Best-effort: when the persistence provider is absent or returns no DB,
      // deps.db stays undefined and the stamping is silently skipped.
      let resolvedDb: import("@minsky/domain/project/scope-resolver").ScopeResolverDb | undefined;
      const provider = getPersistenceProvider?.();
      const sqlProvider = provider as SqlCapablePersistenceProvider | undefined;
      if (sqlProvider?.getDatabaseConnection) {
        try {
          const rawDb = await sqlProvider.getDatabaseConnection();
          if (rawDb) {
            resolvedDb = rawDb as import("@minsky/domain/project/scope-resolver").ScopeResolverDb;
          }
        } catch (err: unknown) {
          log.debug("[session.start] Failed to obtain DB for project-scope stamping", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const deps = resolvedDb ? { ...baseDeps, db: resolvedDb } : baseDeps;
      const service = new SessionService(deps);

      const session = await service.start({
        sessionId: params.sessionId as string | undefined,
        task: params.task as string | undefined,
        description: params.description as string | undefined,
        branch: params.branch as string | undefined,
        repo: params.repo as string | undefined,
        json: (params.json as boolean | undefined) ?? false,
        quiet: (params.quiet as boolean | undefined) ?? false,
        noStatusUpdate: (params.noStatusUpdate as boolean | undefined) ?? false,
        skipInstall: (params.skipInstall as boolean | undefined) ?? false,
        packageManager: params.packageManager as "bun" | "npm" | "yarn" | "pnpm" | undefined,
        // mt#2742: thread the declared `recover` flag to the domain — start-session-operations
        // honors it (delete a stale/orphaned session and start fresh). It was dropped here, so
        // `--recover` / recover:true never fired.
        recover: (params.recover as boolean | undefined) ?? false,
      });

      // Best-effort informational event (mt#2487). Never blocks session start.
      await emitSessionStartedEvent(getPersistenceProvider?.(), {
        sessionId: session.sessionId,
        taskId: session.taskId,
      });

      return {
        success: true,
        session,
        quiet: params.quiet,
        json: params.json,
      };
    }),
  };
}

export function createSessionDirCommand(getDeps: LazySessionDeps): CommandDefinition {
  return {
    id: "session.dir",
    category: CommandCategory.SESSION,
    name: "dir",
    description: "Get the directory of a session",
    parameters: sessionDirCommandParams,
    execute: withErrorLogging("session.dir", async (params: Record<string, unknown>) => {
      const { SessionService } = await import("@minsky/domain/session/session-service");
      const deps = await getDeps();
      const service = new SessionService(deps);

      const directory = await service.getDir({
        sessionId: params.sessionId as string | undefined,
        task: params.task as string | undefined,
        repo: params.repo as string | undefined,
        json: params.json as boolean | undefined,
      });

      return { success: true, directory };
    }),
  };
}

export function createSessionSearchCommand(getDeps: LazySessionDeps): CommandDefinition {
  return {
    id: "session.search",
    category: CommandCategory.SESSION,
    name: "search",
    description: "Search sessions by query string across multiple fields",
    parameters: sessionSearchCommandParams,
    execute: withErrorLogging("session.search", async (params: Record<string, unknown>) => {
      const query = params.query as string;
      const limit = params.limit as number | undefined;

      const { log } = await import("@minsky/shared/logger");
      const deps = await getDeps();
      const sessions = await deps.sessionProvider.listSessions();

      const lowerQuery = query.toLowerCase();

      const matchingSessions = sessions.filter((session) => {
        return (
          session.sessionId?.toLowerCase().includes(lowerQuery) ||
          session.repoName?.toLowerCase().includes(lowerQuery) ||
          session.repoUrl?.toLowerCase().includes(lowerQuery) ||
          session.taskId?.toLowerCase().includes(lowerQuery) ||
          session.prBranch?.toLowerCase().includes(lowerQuery) ||
          session.prState?.branchName?.toLowerCase().includes(lowerQuery)
        );
      });

      const limitedResults = matchingSessions.slice(0, limit);

      log.debug(`Session search found ${matchingSessions.length} matches for query: ${query}`, {
        totalSessions: sessions.length,
        matchCount: matchingSessions.length,
        limitedCount: limitedResults.length,
        limit,
      });

      return {
        success: true,
        sessions: limitedResults,
        query,
        totalMatches: matchingSessions.length,
        limitedCount: limitedResults.length,
        totalSessions: sessions.length,
        limit,
      };
    }),
  };
}

export function createSessionExecCommand(getDeps: LazySessionDeps): CommandDefinition {
  return {
    id: "session.exec",
    category: CommandCategory.SESSION,
    name: "exec",
    description:
      "Execute a shell command in a session's working directory. The session directory is " +
      "resolved automatically from `task` or `sessionId` — never substitute `git -C <path>` " +
      "or `cd <path> && cmd`. Use session_exec for commands that have no dedicated MCP tool " +
      "(build, test, format, custom scripts). For git operations there are dedicated MCP tools " +
      "(`git_log`, `git_diff`, `git_status`, `git_pull`, `git_stash`, `git_reset`, " +
      "`git_restore`, `session_commit`, `session_pr_merge`, etc.) — prefer those. The " +
      "block-git-gh-cli.ts PreToolUse hook denies most git/gh CLI invocations on session_exec " +
      "the same way it denies them on Bash (mt#1196). Inside a session, the carved-out " +
      "commands `git stash`, `git reset`, `git restore`, `git status` ARE permitted via " +
      "session_exec because they're the recommended escape hatch.",
    parameters: sessionExecCommandParams,
    execute: withErrorLogging("session.exec", async (params: Record<string, unknown>) => {
      const { executeCommand } = await import("@minsky/shared/exec");
      const { SessionService } = await import("@minsky/domain/session/session-service");
      const deps = await getDeps();
      const service = new SessionService(deps);

      const workdir = await service.getDir({
        sessionId: params.sessionId as string | undefined,
        task: params.task as string | undefined,
        repo: params.repo as string | undefined,
      });

      const timeout = Math.min((params.timeout as number | undefined) ?? 30000, 120000);

      try {
        const { stdout, stderr } = await executeCommand(params.command as string, {
          cwd: workdir,
          timeout,
        });
        return {
          success: true,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          workdir,
          exitCode: 0,
        };
      } catch (error) {
        const execError = error as { code?: number; stdout?: string; stderr?: string };
        return {
          success: false,
          stdout: (execError.stdout ?? "").trim(),
          stderr: (execError.stderr ?? "").trim(),
          exitCode: execError.code ?? 1,
          workdir,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  };
}
