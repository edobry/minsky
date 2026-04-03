import type { SessionStartParameters } from "../../../domain/schemas";
import { startSessionImpl } from "../start-session-operations";
import * as WorkspaceUtils from "../../workspace";
import { createSessionProvider } from "../session-db-adapter";
import { createGitService } from "../../git";
import { createConfiguredTaskService } from "../../tasks/taskService";
import { getRepositoryBackendFromConfig } from "../../session/repository-backend-detection";
import type { Session } from "../types";

/**
 * Starts a new session based on parameters
 * Using proper dependency injection for better testability
 */
export async function sessionStart(
  params: SessionStartParameters,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deps bag uses interface implementations with varying shapes (WorkspaceUtilsInterface vs module export)
  depsInput?: any
): Promise<Session> {
  // Delegate to domain implementation; adapter remains thin
  const taskService =
    depsInput?.taskService || (await createConfiguredTaskService({ workspacePath: process.cwd() }));
  const deps = {
    sessionDB: depsInput?.sessionDB || (await createSessionProvider()),
    gitService: depsInput?.gitService || createGitService(),
    taskService,
    workspaceUtils: depsInput?.workspaceUtils || WorkspaceUtils,
    getRepositoryBackend: depsInput?.getRepositoryBackend || getRepositoryBackendFromConfig,
  };

  return startSessionImpl(params, deps);
}
