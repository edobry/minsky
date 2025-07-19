/**
 * Simple workspace resolution for task operations
 * Determines whether to use special workspace or current directory based on backend type
 */
import { TaskBackendRouter } from "../domain/tasks/task-backend-router";
import { resolveRepoPath } from "../domain/repo-utils";

/**
 * Options for workspace resolution
 */
export interface WorkspaceResolverOptions {
  /** Backend name to use */
  backend?: string;
  /** Repository URL override */
  repoUrl?: string;
}

/**
 * Simple function that replaces resolveMainWorkspacePath in task commands
 * Uses special workspace for markdown backend, current directory for others
 */
export async function resolveTaskWorkspacePath(options: WorkspaceResolverOptions = {}): Promise<string> {
  const { backend = "markdown", repoUrl } = options;

  // For markdown backend, use special workspace
  if (backend === "markdown") {
    const effectiveRepoUrl = repoUrl || await resolveRepoPath({});
    const router = await TaskBackendRouter.createWithRepo(effectiveRepoUrl);
    return await router.getInTreeWorkspacePath();
  }

  // For other backends, use current directory
  return process.cwd();
}
