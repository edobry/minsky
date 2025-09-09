import type { SessionStartParameters } from "../../../domain/schemas";
import { startSessionImpl } from "../start-session-operations";
import * as WorkspaceUtils from "../../workspace";
import { createSessionProvider } from "../session-db-adapter";
import { createGitService } from "../../git";
import { createConfiguredTaskService } from "../../tasks/taskService";
import { normalizeRepoName, resolveRepoPath } from "../../repo-utils";
import { resolveRepositoryAndBackend } from "../../session/repository-backend-detection";
import { createTaskFromDescription } from "../../templates/session-templates";
import { detectPackageManager, installDependencies } from "../../../utils/package-manager";
import { log } from "../../../utils/logger";
import { Session, SessionRecord, SessionCreateDependencies } from "../types";
import { MinskyError, ValidationError } from "../../errors/index";

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
    sessionDB: depsInput?.sessionDB || (await createSessionProvider()),
    gitService: depsInput?.gitService || createGitService(),
    taskService,
    workspaceUtils: depsInput?.workspaceUtils || WorkspaceUtils,
    resolveRepoPath: depsInput?.resolveRepoPath || resolveRepoPath,
    resolveRepositoryAndBackend:
      depsInput?.resolveRepositoryAndBackend || resolveRepositoryAndBackend,
  };

  return startSessionImpl(params, deps as any);
}
