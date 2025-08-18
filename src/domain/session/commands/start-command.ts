import type { SessionStartParameters } from "../../../domain/schemas";
import { startSessionImpl } from "../start-session-operations";
import type { Session } from "../types";
import * as WorkspaceUtils from "../../workspace";
import { createSessionProvider } from "../../session";
import { createGitService } from "../../git";
import { createConfiguredTaskService } from "../../tasks/taskService";
import { resolveRepoPath } from "../../repo-utils";

/**
 * Starts a new session based on parameters
 * Using proper dependency injection for better testability
 */
export async function sessionStart(
  params: SessionStartParameters,
  depsInput?: any
): Promise<Session> {
  // Delegate to domain implementation; adapter remains thin
  const taskService = depsInput?.taskService || (await createConfiguredTaskService());
  const deps = {
    sessionDB: depsInput?.sessionDB || createSessionProvider(),
    gitService: depsInput?.gitService || createGitService(),
    taskService,
    workspaceUtils: depsInput?.workspaceUtils || WorkspaceUtils,
    resolveRepoPath: depsInput?.resolveRepoPath || resolveRepoPath,
  };

  return startSessionImpl(params, deps as any);
}
