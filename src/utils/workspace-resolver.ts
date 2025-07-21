/**
 * IMPROVED: Workspace resolution using enhanced TaskService
 * Eliminates TaskBackendRouter complexity and provides cleaner workspace resolution
 */
import { TaskService } from "../domain/tasks/taskService";
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
 * Enhanced workspace resolution using improved TaskService
 * Replaces the complex TaskBackendRouter pattern with simple enhanced TaskService
 */
export async function resolveTaskWorkspacePath(options: WorkspaceResolverOptions = {}): Promise<string> {
  const { backend = "markdown", repoUrl } = options;

  // For markdown backend, use enhanced TaskService with workspace resolution
  if (backend === "markdown") {
    if (repoUrl) {
      // Use repo-based creation
      const taskService = await TaskService.createMarkdownWithRepo({ repoUrl });
      return taskService.getWorkspacePath();
    } else {
      // Try to resolve repo URL, fall back to auto-detection
      try {
        const effectiveRepoUrl = await resolveRepoPath({});
        const taskService = await TaskService.createMarkdownWithRepo({ repoUrl: effectiveRepoUrl });
        return taskService.getWorkspacePath();
      } catch (error) {
        // Fall back to auto-detection if repo resolution fails
        const taskService = await TaskService.createMarkdownWithAutoDetection();
        return taskService.getWorkspacePath();
      }
    }
  }

  // For other backends, use current directory
  return process.cwd();
}
