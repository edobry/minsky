/**
 * Basic Session Commands
 *
 * Factories for basic session operations (list, get, start, dir, search).
 */
import { CommandCategory, type CommandDefinition } from "../../command-registry";
import { type LazySessionDeps, withErrorLogging } from "./types";
import {
  sessionListCommandParams,
  sessionGetCommandParams,
  sessionStartCommandParams,
  sessionDirCommandParams,
  sessionSearchCommandParams,
} from "./session-parameters";

export function createSessionListCommand(getDeps: LazySessionDeps): CommandDefinition {
  return {
    id: "session.list",
    category: CommandCategory.SESSION,
    name: "list",
    description: "List all sessions",
    parameters: sessionListCommandParams,
    execute: withErrorLogging("session.list", async (params: Record<string, unknown>) => {
      const { SessionService } = await import("../../../../domain/session/session-service");
      const deps = await getDeps();
      const service = new SessionService(deps);

      let sessions = await service.list({
        repo: params.repo as string | undefined,
        json: params.json as boolean | undefined,
      });

      try {
        const {
          parseTime,
          filterByTimeRange,
        } = require("../../../../utils/result-handling/filters");
        const sinceTs = parseTime(params.since as string | undefined);
        const untilTs = parseTime(params.until as string | undefined);
        sessions = filterByTimeRange(
          sessions.map((s) => ({ ...s, updatedAt: s.createdAt })),
          sinceTs,
          untilTs
        );
      } catch {
        // ignore
      }

      return { success: true, sessions };
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
      const { SessionService } = await import("../../../../domain/session/session-service");
      const deps = await getDeps();
      const service = new SessionService(deps);

      const session = await service.get({
        name: params.name as string | undefined,
        task: params.task as string | undefined,
        repo: params.repo as string | undefined,
        json: params.json as boolean | undefined,
      });

      if (!session) {
        const identifier = params.name || params.task || "unknown";
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

export function createSessionStartCommand(getDeps: LazySessionDeps): CommandDefinition {
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

      const { SessionService } = await import("../../../../domain/session/session-service");
      const deps = await getDeps();
      const service = new SessionService(deps);

      const session = await service.start({
        name: params.name as string | undefined,
        task: params.task as string | undefined,
        description: params.description as string | undefined,
        branch: params.branch as string | undefined,
        repo: params.repo as string | undefined,
        session: params.session as string | undefined,
        json: (params.json as boolean | undefined) ?? false,
        quiet: (params.quiet as boolean | undefined) ?? false,
        noStatusUpdate: (params.noStatusUpdate as boolean | undefined) ?? false,
        skipInstall: (params.skipInstall as boolean | undefined) ?? false,
        packageManager: params.packageManager as "bun" | "npm" | "yarn" | "pnpm" | undefined,
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
      const { SessionService } = await import("../../../../domain/session/session-service");
      const deps = await getDeps();
      const service = new SessionService(deps);

      const directory = await service.getDir({
        name: params.name as string | undefined,
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

      const { log } = await import("../../../../utils/logger");
      const deps = await getDeps();
      const sessions = await deps.sessionProvider.listSessions();

      const lowerQuery = query.toLowerCase();

      const matchingSessions = sessions.filter((session) => {
        return (
          session.session?.toLowerCase().includes(lowerQuery) ||
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
