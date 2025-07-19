/**
 * Simple workspace resolution for task operations
 * Uses TaskBackendRouter to determine appropriate workspace based on backend and context
 */
import { TaskBackendRouter } from "../domain/tasks/task-backend-router";
import { resolveRepoPath } from "../domain/repo-utils";
import { createMarkdownTaskBackend } from "../domain/tasks/markdownTaskBackend";
import { createJsonFileTaskBackend } from "../domain/tasks/jsonFileTaskBackend";

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
 * Context-aware workspace resolution using TaskBackendRouter
 * Replaces hardcoded logic with proper backend routing
 */
export async function resolveTaskWorkspacePath(options: WorkspaceResolverOptions = {}): Promise<string> {
  const { backend = "markdown", repoUrl } = options;

  // Create appropriate backend instance for routing decision
  let taskBackend;
  const currentDir = process.cwd();

  if (backend === "markdown") {
    taskBackend = createMarkdownTaskBackend({
      name: "markdown",
      workspacePath: currentDir
    });
  } else if (backend === "json-file") {
    taskBackend = createJsonFileTaskBackend({
      name: "json-file",
      workspacePath: currentDir
    });
  } else {
    // For unknown backends, default to current directory
    return currentDir;
  }

  // Use TaskBackendRouter to make context-aware routing decision
  const effectiveRepoUrl = repoUrl || await resolveRepoPath({});
  const router = await TaskBackendRouter.createWithRepo(effectiveRepoUrl);
  const routingInfo = router.getBackendRoutingInfo(taskBackend);

  if (routingInfo.requiresSpecialWorkspace) {
    // Use special workspace
    return await router.getInTreeWorkspacePath();
  } else {
    // Use current workspace
    return currentDir;
  }
}
